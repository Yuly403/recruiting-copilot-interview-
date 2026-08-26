import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateLocator } from '../../src/contracts/action-plan.js';
import { RPA_SCHEMA_VERSION, type RpaRequest } from '../../src/drivers/rpa/named-pipe-client.js';
import { BossFlowExecutor } from '../../src/rpa-runner/flow-executor.js';
import type { BossBrowserFactory, BossBrowserSession, CandidateSnapshot } from '../../src/rpa-runner/contracts.js';

const locator: CandidateLocator = {
  platform: 'boss',
  source: 'recommended_feed',
  jobRef: 'ai-product-manager',
  displayedName: '合成候选人甲',
  currentCompany: '示例科技',
  currentTitle: 'AI 产品经理',
  listContextHash: 'synthetic-context',
  capturedAt: '2026-08-26T00:00:00.000Z',
  expiresAt: '2099-08-26T00:30:00.000Z',
};

class FakeSession implements BossBrowserSession {
  public candidates: CandidateSnapshot[] = [{ displayedName: '合成候选人甲', currentCompany: '示例科技', currentTitle: 'AI 产品经理' }];
  public staged = '';
  public opened = 0;
  public committed = 0;
  public activeCandidate = true;
  public throwAfterCommitStart = false;
  public messageVerification: 'confirmed' | 'not_confirmed' | 'uncertain' = 'confirmed';

  async inspect() {
    return { url: 'https://www.zhipin.com/web/chat/recommend', title: 'BOSS', loginRequired: false, verificationRequired: false, paywallVisible: false };
  }
  async findCandidates() { return this.candidates; }
  async openCandidate() { this.opened += 1; }
  async assertActiveCandidate() { return this.activeCandidate; }
  async readConversation() { return ''; }
  async stageMessage(message: string) { this.staged = message; }
  async readStagedMessage() { return this.staged; }
  async commitMessage() {
    this.committed += 1;
    this.staged = '';
    if (this.throwAfterCommitStart) throw new Error('browser disconnected after click');
  }
  async commitGreeting() { this.committed += 1; }
  async verifyMessageCommit() { return this.messageVerification; }
  async verifyGreetingCommit() { return this.messageVerification; }
  async close() {}
}

function factory(session: FakeSession): BossBrowserFactory {
  return { async connect() { return session; } };
}

function executor(session: FakeSession, options: { enableCommit?: boolean; enableNativeGreeting?: boolean } = {}): BossFlowExecutor {
  return new BossFlowExecutor(factory(session), {
    enableCommit: options.enableCommit ?? false,
    enableNativeGreeting: options.enableNativeGreeting,
    verifyTicket: async () => ({ valid: true }),
  });
}

function request(payload: Record<string, unknown>): RpaRequest {
  return {
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId: 'runner-flow-test',
    flow: 'boss.commit_message',
    deadlineAt: '2099-08-26T00:30:00.000Z',
    payload,
  };
}

describe('BossFlowExecutor', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function approvedPayload(message = '你好，想和你聊聊 AI 产品岗位。'): Promise<Record<string, unknown>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-runner-flow-'));
    temporaryRoots.push(root);
    const messageFile = path.join(root, 'message.txt');
    await fs.writeFile(messageFile, message, 'utf-8');
    const messageHash = `sha256:${crypto.createHash('sha256').update(message).digest('hex')}`;
    return {
      actionId: 'action-001',
      candidateKey: 'candidate-001',
      operation: 'message.commit',
      candidateLocator: locator,
      messageFile,
      messageHash,
      approvalExpiresAt: '2099-08-26T00:30:00.000Z',
    };
  }

  it('stages and commits only when explicit commit mode is enabled', async () => {
    const session = new FakeSession();
    const runner = executor(session, { enableCommit: true });
    const result = await runner.execute(request(await approvedPayload()));

    expect(result.status).toBe('succeeded');
    expect(result.observations).toMatchObject({ candidateVerified: true, commitObserved: true });
    expect(session.opened).toBe(1);
    expect(session.committed).toBe(1);
  });

  it('keeps the runner in drill mode by default and never clicks send', async () => {
    const session = new FakeSession();
    const runner = executor(session);
    const result = await runner.execute(request(await approvedPayload()));

    expect(result.status).toBe('paused');
    expect(result.error?.code).toBe('USER_STOPPED');
    expect(session.committed).toBe(0);
  });

  it('pauses instead of sending when candidate identity cannot be confirmed', async () => {
    const session = new FakeSession();
    session.candidates = [{ displayedName: '同名候选人', currentCompany: '示例科技', currentTitle: 'AI 产品经理' }];
    const runner = executor(session, { enableCommit: true });
    const result = await runner.execute(request(await approvedPayload()));

    expect(result.status).toBe('paused');
    expect(result.error?.code).toBe('CANDIDATE_MISMATCH');
    expect(session.committed).toBe(0);
  });

  it('returns result_unknown rather than retrying after an unconfirmed click', async () => {
    const session = new FakeSession();
    session.messageVerification = 'uncertain';
    const runner = executor(session, { enableCommit: true });
    const result = await runner.execute(request(await approvedPayload()));

    expect(result.status).toBe('result_unknown');
    expect(result.error?.code).toBe('RESULT_UNKNOWN');
    expect(session.committed).toBe(1);
  });

  it('returns result_unknown when a browser error happens after send has started', async () => {
    const session = new FakeSession();
    session.throwAfterCommitStart = true;
    const runner = executor(session, { enableCommit: true });
    const result = await runner.execute(request(await approvedPayload()));

    expect(result).toMatchObject({ status: 'result_unknown', error: { code: 'RESULT_UNKNOWN' } });
    expect(session.committed).toBe(1);
  });

  it('does not type or send when the opened conversation header cannot be verified', async () => {
    const session = new FakeSession();
    session.activeCandidate = false;
    const runner = executor(session, { enableCommit: true });
    const result = await runner.execute(request(await approvedPayload()));

    expect(result).toMatchObject({ status: 'paused', error: { code: 'CANDIDATE_MISMATCH' } });
    expect(session.committed).toBe(0);
  });

  it('does not enable platform-native greeting until its displayed copy is manually verified', async () => {
    const session = new FakeSession();
    const runner = executor(session, { enableCommit: true });
    const result = await runner.execute({
      ...request(await approvedPayload()),
      flow: 'boss.commit_greeting',
    });

    expect(result.status).toBe('paused');
    expect(session.committed).toBe(0);
  });

  it('honours a stop request before opening or sending to a candidate', async () => {
    const session = new FakeSession();
    const runner = executor(session, { enableCommit: true });
    runner.stop();
    const result = await runner.execute(request(await approvedPayload()));

    expect(result).toMatchObject({ status: 'paused', error: { code: 'USER_STOPPED' } });
    expect(session.opened).toBe(0);
    expect(session.committed).toBe(0);
  });

  it('refuses a write when the Gateway execution ticket is invalid', async () => {
    const session = new FakeSession();
    const runner = new BossFlowExecutor(factory(session), {
      enableCommit: true,
      verifyTicket: async () => ({ valid: false, reason: 'ticket signature invalid' }),
    });
    const result = await runner.execute(request(await approvedPayload()));

    expect(result).toMatchObject({ status: 'failed', error: { code: 'APPROVAL_EXPIRED' } });
    expect(session.opened).toBe(0);
    expect(session.committed).toBe(0);
  });

  it('stops before browser navigation when the deadline has no safe commit budget left', async () => {
    const session = new FakeSession();
    const runner = executor(session, { enableCommit: true });
    const result = await runner.execute({
      ...request(await approvedPayload()),
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    });

    expect(result).toMatchObject({ status: 'paused', error: { code: 'TIMEOUT' } });
    expect(session.opened).toBe(0);
    expect(session.committed).toBe(0);
  });
});
