import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { RpaRequest } from '../drivers/rpa/named-pipe-client.js';
import { claimRunnerExecutionTicket } from '../runtime/runner-ticket.js';
import type {
  BossBrowserFactory,
  BossBrowserSession,
  CandidateSnapshot,
  RunnerErrorCode,
  RunnerOutcome,
  RunnerTaskPayload,
} from './contracts.js';

const WRITE_FLOWS = new Set(['boss.stage_message', 'boss.commit_message', 'boss.commit_greeting']);

function normalize(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

function outcomePaused(code: RunnerErrorCode, message: string, details?: Record<string, unknown>): RunnerOutcome {
  return { status: 'paused', error: { code, message, details } };
}

function outcomeFailed(code: RunnerErrorCode, message: string, details?: Record<string, unknown>): RunnerOutcome {
  return { status: 'failed', error: { code, message, details } };
}

function isCandidateMatch(expected: NonNullable<RunnerTaskPayload['candidateLocator']>, actual: CandidateSnapshot): boolean {
  if (normalize(actual.displayedName) !== normalize(expected.displayedName)) return false;
  const evidence = normalize([actual.currentCompany, actual.currentTitle, actual.rawText].filter(Boolean).join(' '));
  if (expected.currentCompany && !evidence.includes(normalize(expected.currentCompany))) return false;
  if (expected.currentTitle && !evidence.includes(normalize(expected.currentTitle))) return false;
  return true;
}

async function readAndVerifyMessage(payload: RunnerTaskPayload): Promise<{ message: string } | RunnerOutcome> {
  if (!payload.messageFile || !payload.messageHash) {
    return outcomeFailed('PAYLOAD_HASH_MISMATCH', '写操作缺少消息文件或消息摘要');
  }
  let message: string;
  try {
    message = await fs.readFile(payload.messageFile, 'utf-8');
  } catch {
    return outcomeFailed('PAYLOAD_HASH_MISMATCH', '无法读取已审批的消息文件');
  }
  const actual = `sha256:${crypto.createHash('sha256').update(message, 'utf-8').digest('hex')}`;
  if (actual !== payload.messageHash) {
    return outcomeFailed('PAYLOAD_HASH_MISMATCH', '消息内容在审批后发生变化');
  }
  if (!message.trim()) {
    return outcomeFailed('PAYLOAD_HASH_MISMATCH', '消息内容不能为空');
  }
  return { message };
}

export class BossFlowExecutor {
  private stopped = false;
  private deadlineMs = 0;

  public constructor(
    private readonly browserFactory: BossBrowserFactory,
    private readonly options: {
      enableCommit: boolean;
      enableNativeGreeting?: boolean;
      ticketRuntimeDir?: string;
      verifyTicket?: (request: RpaRequest, payload: RunnerTaskPayload) => Promise<{ valid: true } | { valid: false; reason: string }>;
    } = { enableCommit: false },
  ) {}

  public stop(): void {
    this.stopped = true;
  }

  public async health(): Promise<RunnerOutcome> {
    try {
      const session = await this.browserFactory.connect();
      try {
        const state = await session.inspect();
        return {
          status: 'succeeded',
          observations: {
            browserConnected: true,
            url: state.url,
            loginRequired: state.loginRequired,
            verificationRequired: state.verificationRequired,
          },
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      return outcomeFailed('RPA_UNAVAILABLE', error instanceof Error ? error.message : '无法连接招聘专用浏览器');
    }
  }

  public async execute(request: RpaRequest): Promise<RunnerOutcome> {
    if (request.flow === 'health') return this.health();
    if (request.flow === 'boss.stop') {
      this.stop();
      return { status: 'succeeded', observations: { stopped: true } };
    }
    const deadlineMs = Date.parse(request.deadlineAt);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
      return outcomeFailed('APPROVAL_EXPIRED', '任务已过期，未连接浏览器');
    }
    this.deadlineMs = deadlineMs;
    const initiallyStopped = this.consumeStop();
    if (initiallyStopped) return initiallyStopped;

    // Do not start a write flow unless there is enough budget left for the
    // candidate-identity check and the final pre-click guard. This check is
    // intentionally before any asynchronous validation or browser activity:
    // a Gateway timeout must never leave the Runner free to begin a send.
    if (WRITE_FLOWS.has(request.flow)) {
      const deadline = this.requireTime(3_000);
      if (deadline) {
        this.deadlineMs = 0;
        return deadline;
      }
    }

    const payload = request.payload as RunnerTaskPayload;
    if (WRITE_FLOWS.has(request.flow)) {
      if (!payload.actionId || !payload.candidateKey || !payload.candidateLocator || !payload.approvalExpiresAt) {
        return outcomeFailed('APPROVAL_EXPIRED', '写操作缺少 Gateway 审批绑定信息');
      }
      if (Date.parse(payload.approvalExpiresAt) <= Date.now()) {
        return outcomeFailed('APPROVAL_EXPIRED', 'Gateway 审批已过期');
      }
      const ticketCheck = await this.verifyTicket(request, payload);
      if (!ticketCheck.valid) {
        this.deadlineMs = 0;
        return outcomeFailed('APPROVAL_EXPIRED', ticketCheck.reason);
      }
    }

    let session: BossBrowserSession | undefined;
    try {
      session = await this.browserFactory.connect();
      const safety = await this.inspectSafety(session);
      if (safety) return safety;

      switch (request.flow) {
        case 'boss.open_candidate':
          return this.openCandidate(session, payload);
        case 'boss.read_conversation':
          return this.readConversation(session, payload);
        case 'boss.stage_message':
          return this.stageMessage(session, payload);
        case 'boss.commit_message':
          return this.commitMessage(session, payload);
        case 'boss.commit_greeting':
          return this.commitGreeting(session, payload);
        case 'boss.verify':
          return { status: 'succeeded', observations: { verification: 'manual_or_flow_specific_required' } };
        default:
          return outcomeFailed('INTERNAL_ERROR', `Runner 暂不支持流程: ${request.flow}`);
      }
    } catch (error) {
      return outcomeFailed('INTERNAL_ERROR', error instanceof Error ? error.message : 'RPA 执行异常');
    } finally {
      if (session) await session.close().catch(() => undefined);
      this.deadlineMs = 0;
    }
  }

  private async inspectSafety(session: BossBrowserSession): Promise<RunnerOutcome | null> {
    const state = await session.inspect();
    if (state.verificationRequired) return outcomePaused('VERIFICATION_REQUIRED', '检测到平台验证页面，已暂停');
    if (state.loginRequired) return outcomePaused('LOGIN_REQUIRED', '招聘专用浏览器未登录，请由 HR 登录');
    if (state.paywallVisible) return outcomePaused('QUOTA_OR_PAYWALL', '检测到额度或付费提示，已暂停');
    if (!/^https:\/\/([^/]+\.)?zhipin\.com\//i.test(state.url)) {
      return outcomePaused('RPA_WINDOW_NOT_FOUND', '当前不是 BOSS 招聘页面，未执行任何动作', { url: state.url });
    }
    return null;
  }

  private async verifyCandidate(session: BossBrowserSession, payload: RunnerTaskPayload): Promise<RunnerOutcome | null> {
    const locator = payload.candidateLocator;
    if (!locator) return outcomeFailed('CANDIDATE_MISMATCH', '任务缺少候选人定位信息');
    const matches = (await session.findCandidates(locator)).filter((candidate) => isCandidateMatch(locator, candidate));
    if (matches.length === 0) return outcomePaused('CANDIDATE_MISMATCH', '页面中没有找到可核验的目标候选人');
    if (matches.length > 1) return outcomePaused('CANDIDATE_AMBIGUOUS', '页面中存在多个相同候选人，已暂停');
    return null;
  }

  private async openCandidate(session: BossBrowserSession, payload: RunnerTaskPayload): Promise<RunnerOutcome> {
    const verification = await this.verifyCandidate(session, payload);
    if (verification) return verification;
    const stopped = this.consumeStop();
    if (stopped) return stopped;
    const deadline = this.requireTime(1_000);
    if (deadline) return deadline;
    await session.openCandidate(payload.candidateLocator!);
    if (!(await session.assertActiveCandidate(payload.candidateLocator!))) {
      return outcomePaused('CANDIDATE_MISMATCH', '打开候选人后，聊天头部身份无法与审批目标一致');
    }
    return { status: 'succeeded', observations: { candidateVerified: true, conversationOpened: true } };
  }

  private async readConversation(session: BossBrowserSession, payload: RunnerTaskPayload): Promise<RunnerOutcome> {
    if (!payload.candidateLocator) {
      return outcomePaused('CANDIDATE_MISMATCH', '读取会话必须绑定候选人定位信息，拒绝读取当前任意页面');
    }
    if (!(await session.assertActiveCandidate(payload.candidateLocator))) {
      return outcomePaused('CANDIDATE_MISMATCH', '当前会话头部身份无法与目标候选人一致');
    }
    return { status: 'succeeded', observations: { conversation: await session.readConversation(), candidateVerified: true } };
  }

  private async stageMessage(session: BossBrowserSession, payload: RunnerTaskPayload): Promise<RunnerOutcome> {
    const message = await readAndVerifyMessage(payload);
    if ('status' in message) return message;
    const candidate = await this.verifyCandidate(session, payload);
    if (candidate) return candidate;
    const stopped = this.consumeStop();
    if (stopped) return stopped;
    const deadline = this.requireTime(1_000);
    if (deadline) return deadline;
    await session.openCandidate(payload.candidateLocator!);
    if (!(await session.assertActiveCandidate(payload.candidateLocator!))) {
      return outcomePaused('CANDIDATE_MISMATCH', '打开候选人后，聊天头部身份无法与审批目标一致');
    }
    await session.stageMessage(message.message);
    if ((await session.readStagedMessage()) !== message.message) {
      return outcomeFailed('PAYLOAD_HASH_MISMATCH', '消息未能完整写入输入框');
    }
    return { status: 'succeeded', observations: { messageStaged: true } };
  }

  private async commitMessage(session: BossBrowserSession, payload: RunnerTaskPayload): Promise<RunnerOutcome> {
    const message = await readAndVerifyMessage(payload);
    if ('status' in message) return message;
    const candidate = await this.verifyCandidate(session, payload);
    if (candidate) return candidate;
    const stopped = this.consumeStop();
    if (stopped) return stopped;
    const deadline = this.requireTime(3_000);
    if (deadline) return deadline;
    await session.openCandidate(payload.candidateLocator!);
    if (!(await session.assertActiveCandidate(payload.candidateLocator!))) {
      return outcomePaused('CANDIDATE_MISMATCH', '打开候选人后，聊天头部身份无法与审批目标一致');
    }
    // A commit must be self-contained: the prior preview/stage may have been lost after a page refresh.
    await session.stageMessage(message.message);
    if ((await session.readStagedMessage()) !== message.message) {
      return outcomePaused('CANDIDATE_MISMATCH', '发送前消息框内容与已审批内容不一致');
    }
    if (!this.options.enableCommit) {
      return outcomePaused('USER_STOPPED', 'Runner 当前处于演练模式；设置 BOSS_RPA_ENABLE_COMMIT=true 后才允许真实发送');
    }
    const stoppedBeforeCommit = this.consumeStop() ?? this.requireTime(2_000);
    if (stoppedBeforeCommit) return stoppedBeforeCommit;
    try {
      // From this exact point onward the browser may have accepted the action.
      await session.commitMessage();
      const verification = await session.verifyMessageCommit(message.message);
      if (verification === 'confirmed') return { status: 'succeeded', observations: { candidateVerified: true, commitObserved: true } };
      return this.resultUnknown('已尝试发送，但页面未能提供明确成功证据；禁止自动重试');
    } catch {
      return this.resultUnknown('发送动作已开始，但浏览器异常中断；禁止自动重试');
    }
  }

  private async commitGreeting(session: BossBrowserSession, payload: RunnerTaskPayload): Promise<RunnerOutcome> {
    const message = await readAndVerifyMessage(payload);
    if ('status' in message) return message;
    const candidate = await this.verifyCandidate(session, payload);
    if (candidate) return candidate;
    if (!this.options.enableCommit) {
      return outcomePaused('USER_STOPPED', 'Runner 当前处于演练模式；设置 BOSS_RPA_ENABLE_COMMIT=true 后才允许真实发送');
    }
    if (!this.options.enableNativeGreeting) {
      return outcomePaused('USER_STOPPED', '平台原生“打招呼”的实际文案尚未在受监督环境核验；首版请使用 message.commit，或由维护人员显式开启原生打招呼');
    }
    const stoppedBeforeCommit = this.consumeStop() ?? this.requireTime(2_000);
    if (stoppedBeforeCommit) return stoppedBeforeCommit;
    try {
      await session.commitGreeting(payload.candidateLocator!);
      const verification = await session.verifyGreetingCommit(payload.candidateLocator!);
      if (verification === 'confirmed') return { status: 'succeeded', observations: { candidateVerified: true, commitObserved: true } };
      return this.resultUnknown('已点击打招呼，但页面未能提供明确成功证据；禁止自动重试');
    } catch {
      return this.resultUnknown('打招呼动作已开始，但浏览器异常中断；禁止自动重试');
    }
  }

  private consumeStop(): RunnerOutcome | null {
    if (!this.stopped) return null;
    this.stopped = false;
    return outcomePaused('USER_STOPPED', 'HR 已停止当前自动化任务');
  }

  private requireTime(minimumMs: number): RunnerOutcome | null {
    if (!this.deadlineMs || this.deadlineMs - Date.now() >= minimumMs) return null;
    return outcomePaused('TIMEOUT', '任务剩余时间不足，已在外发前安全停止');
  }

  private resultUnknown(message: string): RunnerOutcome {
    return {
      status: 'result_unknown',
      observations: { candidateVerified: true, commitObserved: false },
      error: { code: 'RESULT_UNKNOWN', message },
    };
  }

  private async verifyTicket(request: RpaRequest, payload: RunnerTaskPayload): Promise<{ valid: true } | { valid: false; reason: string }> {
    if (this.options.verifyTicket) return this.options.verifyTicket(request, payload);
    const runtimeRoot = this.options.ticketRuntimeDir ?? process.env.BOSS_RPA_RUNTIME_DIR?.trim();
    if (!runtimeRoot) return { valid: false, reason: 'Runner 未配置 BOSS_RPA_RUNTIME_DIR，拒绝执行写操作' };
    return claimRunnerExecutionTicket({
      runtimeRoot,
      ticket: payload.executionTicket,
      requestId: request.requestId,
      operation: String(payload.operation ?? ''),
      actionId: String(payload.actionId ?? ''),
      candidateKey: String(payload.candidateKey ?? ''),
      payloadHash: String(payload.messageHash ?? ''),
      deadlineAt: request.deadlineAt,
    });
  }
}
