#!/usr/bin/env node

/**
 * recruitctl — BOSS 多执行器混合网关 CLI
 *
 * Usage:
 *   recruitctl <operation> [options]
 *   recruitctl --config <path> <operation> [options]
 *   recruitctl --help
 *   recruitctl --version
 *
 * Examples:
 *   recruitctl session.login
 *   recruitctl session.status
 *   recruitctl candidates.list --job my-job-ref
 *   recruitctl candidates.search --query "前端 3年"
 *   recruitctl candidates.listUnread
 *   recruitctl candidates.deepSearch --query "后端 北京" --match
 *   recruitctl candidates.recommend
 *   recruitctl candidate.preview --name "张三" --displayed-name "张三丰"
 *   recruitctl conversation.open --name "张三"
 *   recruitctl conversation.read --name "张三" --index 0
 *   recruitctl message.stage --name "张三" --plan ./plan.json --payload-file ./msg.txt
 *   recruitctl message.commit --name "张三" --plan ./plan.json --payload-file ./msg.txt
 *   recruitctl greeting.commit --name "张三" --plan ./plan.json --payload-file ./msg.txt
 *   recruitctl attachment.request --name "张三" --plan ./plan.json --payload-file ./msg.txt
 *   recruitctl attachment.accept --name "张三" --plan ./plan.json
 *   recruitctl remark.update --name "张三" --remark "疑似猎头"
 *   recruitctl contact.exchange --name "张三" --plan ./plan.json --payload-file ./msg.txt
 *   recruitctl execution.verify --plan ./plan.json
 *   recruitctl execution.stop
 *   recruitctl jd.get --job my-job-ref
 *   recruitctl positions.list
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { toGatewayCommand, type GatewayCommand } from '../contracts/command.js';
import { ActionPlanSchema, type ActionPlan } from '../contracts/action-plan.js';
import type { GatewayResult } from '../contracts/result.js';
import { GatewayConfigSchema, type GatewayConfig } from '../gateway/config.js';
import { createGateway, type GatewayInstance } from '../gateway/index.js';
import { validateActionPlanIntegrity } from '../gateway/approval-service.js';
import { runDoctor, formatDoctorReport } from '../doctor/index.js';
import { createApprovalStore } from '../runtime/approval-store.js';
import { ensureRuntimeDirs, resolveRuntimePaths, validatePath } from '../runtime/paths.js';

// ── CLI Arguments ──

interface CliArgs {
  operation: string;
  options: Record<string, string | boolean>;
  configPath: string | null;
  workspace: string;
  format: 'json' | 'text';
  help: boolean;
  version: boolean;
}

const BOOLEAN_OPTIONS = new Set(['unread', 'match', 'help', 'version', 'stdin']);

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    operation: '',
    options: {},
    configPath: null,
    workspace: '.',
    format: 'json',
    help: false,
    version: false,
  };

  let i = 2; // skip node and script name
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      i++;
      continue;
    }

    if (arg === '--version' || arg === '-V') {
      args.version = true;
      i++;
      continue;
    }

    if (arg === '--config' || arg === '-c') {
      args.configPath = argv[++i] ?? '';
      i++;
      continue;
    }

    if (arg === '--workspace' || arg === '-w') {
      args.workspace = argv[++i] ?? '.';
      i++;
      continue;
    }

    if (arg === '--format') {
      const fmt = argv[++i] ?? 'json';
      if (fmt === 'text' || fmt === 'json') {
        args.format = fmt;
      }
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const kebabKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

      if (BOOLEAN_OPTIONS.has(kebabKey)) {
        args.options[kebabKey] = true;
        i++;
      } else {
        args.options[kebabKey] = argv[++i] ?? '';
        i++;
      }
      continue;
    }

    // First non-option arg is the operation
    if (!args.operation) {
      args.operation = arg;
      i++;
      continue;
    }

    i++;
  }

  return args;
}

// ── Stdin payload support (per PRD §GW-002) ──

/**
 * If the user passed `--payload-file -` or `--stdin`, read the entire stdin
 * stream and materialize it to a temp file, then rewrite `payloadFile` to that
 * path so downstream drivers behave exactly as if a real file was given.
 * This keeps the message text out of argv (avoids leaking secrets in `ps`).
 */
async function resolveStdinPayload(args: CliArgs, config: GatewayConfig): Promise<void> {
  const useStdin = args.options.payloadFile === '-' || args.options.stdin === true;
  if (!useStdin) return;

  if (process.stdin.isTTY) {
    throw new Error('未从 stdin 接收到数据：--payload-file - / --stdin 需在管道中使用（如 `cat msg.txt | recruitctl ... --payload-file -`）');
  }

  // Read all of stdin — Node API doesn't support readFile(fd) cross-platform
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const content = Buffer.concat(chunks).toString('utf-8');

  const runtimePaths = await resolveRuntimePaths(config);
  await ensureRuntimeDirs(runtimePaths);
  const tmp = path.join(runtimePaths.payloads, `stdin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await fsp.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  args.options.payloadFile = tmp;
}

// ── Config loading ──

async function loadConfig(args: CliArgs): Promise<GatewayConfig> {
  const defaults: Record<string, unknown> = {
    version: '1',
    workspace_root: args.workspace,
    runtime_dir: 'runtime/execution',
    boss: {
      legacy_cli: { executable: 'boss', default_timeout_ms: 60000 },
      rpa: { adapter: 'named-pipe', endpoint: 'recruiting-copilot-boss-rpa-v1', default_timeout_ms: 90000, allow_mock_writes: false },
      locking: { lease_seconds: 180 },
      approvals: { default_ttl_minutes: 30 },
      circuit_breaker: { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true },
    },
    logging: { level: 'info', redact_payloads: true, persist_screenshots: false },
  };

  if (args.configPath) {
    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(path.resolve(args.configPath), 'utf-8');
      const userConfig = JSON.parse(content);
      return GatewayConfigSchema.parse({ ...defaults, ...userConfig });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Failed to load config from ${args.configPath}: ${message}`);
      console.error('Using default configuration.');
    }
  }

  return GatewayConfigSchema.parse(defaults);
}

// ── Output formatting ──

function formatResult(result: GatewayResult, format: 'json' | 'text'): string {
  if (format === 'text') {
    const lines: string[] = [];
    lines.push(`操作: ${result.operation}`);
    lines.push(`状态: ${result.status}`);
    lines.push(`驱动器: ${result.driver}`);
    lines.push(`请求ID: ${result.requestId}`);
    lines.push(`开始时间: ${result.startedAt}`);
    lines.push(`结束时间: ${result.finishedAt}`);

    if (result.error) {
      lines.push(`错误: [${result.error.code}] ${result.error.message}`);
    }

    if (result.warnings.length > 0) {
      lines.push('警告:');
      for (const w of result.warnings) {
        lines.push(`  [${w.code}] ${w.message}`);
      }
    }

    if (result.data && typeof result.data === 'object' && Object.keys(result.data as object).length > 0) {
      lines.push('数据:');
      lines.push(JSON.stringify(result.data, null, 2).split('\n').map(l => '  ' + l).join('\n'));
    }

    return lines.join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ── Help text ──

function printHelp(): void {
  console.log(`recruitctl — BOSS 多执行器混合网关 CLI

用法:
  recruitctl <操作> [选项]
  recruitctl doctor [--config <路径>] [--format json|text]
  recruitctl plan.create --operation <写操作> --candidate-key <本地ID> --name <显示名> --job-ref <岗位> --source <来源> --list-context-hash <哈希> --payload-file <路径> [--out <路径>]
  recruitctl approve --plan <路径> --payload-file <路径>
  recruitctl --config <路径> <操作> [选项]
  recruitctl --help
  recruitctl --version

可用的顶层命令:
  doctor                           运行健康检查诊断
  plan.create                      从当前候选人定位信息和载荷生成待审批计划
  approve                          在交互终端核对并签署单次写操作
  会话管理
    session.login                    登录 BOSS
    session.status                   查看会话状态

  职位浏览
    positions.list                   查看在招职位列表
    jd.get                         查看职位详情

  候选人
    candidates.list                  搜索在招候选人
    candidates.listUnread            只看未读
    candidates.search              按关键词搜索
    candidates.deepSearch           深度搜索（支持 --match 精准匹配）
    candidates.recommend            推荐候选人
    candidate.preview               预览候选人聊天
    candidate.markNotFit            仅返回拒绝；请在浏览器中人工标记

  聊天
    conversation.open                打开与候选人的聊天
    conversation.read                读取聊天记录

  消息（写操作，需 --plan 和审批）
    message.stage                    暂存消息
    message.commit                  发送消息
    greeting.commit                 发送招呼
    attachment.request              请求附件
    attachment.accept                接收附件
    remark.update                   更新备注标签
    contact.exchange                交换联系方式

  执行管理
    execution.verify                 验证执行结果
    execution.stop                  停止所有执行

常用选项:
  --name <名称>              候选人姓名
  --job <职位引用>           职位引用标识
  --query <查询词>           搜索关键词
  --unread                   只看未读（布尔标志）
  --match                    精准匹配（布尔标志）
  --plan <路径>              操作计划文件路径
  --payload-file <路径>      消息文件路径
  --displayed-name <名称>    候选人显示名称
  --index <数字>             聊天索引
  --remark <内容>            备注内容
  --action <标识>            操作标识

全局选项:
  --config, -c <路径>        配置文件路径 (JSON)
  --workspace, -w <路径>     工作区根目录（默认 .）
  --format <json|text>       输出格式（默认 json）
  --help, -h                 显示帮助
  --version, -V              显示版本`);
}

async function atomicWritePlan(filePath: string, plan: ActionPlan): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await fsp.rename(tempPath, filePath);
}

function safeTerminalPreview(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const PLANNABLE_WRITES = new Set([
  'message.stage',
  'message.commit',
  'greeting.commit',
  'attachment.request',
  'attachment.accept',
  'remark.update',
  'contact.exchange',
]);

async function createPlan(args: CliArgs, config: GatewayConfig): Promise<number> {
  const intendedOperation = typeof args.options.operation === 'string' ? args.options.operation : '';
  const candidateKey = typeof args.options.candidateKey === 'string' ? args.options.candidateKey.trim() : '';
  const displayedName = typeof args.options.name === 'string' ? args.options.name.trim() : '';
  const jobRef = typeof args.options.jobRef === 'string' ? args.options.jobRef.trim() : '';
  const source = typeof args.options.source === 'string' ? args.options.source.trim() : '';
  const listContextHash = typeof args.options.listContextHash === 'string' ? args.options.listContextHash.trim() : '';
  const payloadArg = typeof args.options.payloadFile === 'string' ? args.options.payloadFile : '';
  if (!PLANNABLE_WRITES.has(intendedOperation)) {
    console.error('错误: --operation 必须是 Gateway 支持的写操作；candidate.markNotFit 只能人工处理。');
    return 1;
  }
  if (!candidateKey || !displayedName || !jobRef || !source || !listContextHash || !payloadArg) {
    console.error('错误: plan.create 需要 --operation、--candidate-key、--name、--job-ref、--source、--list-context-hash 和 --payload-file。');
    return 1;
  }

  const workspaceRoot = path.resolve(config.workspace_root);
  const payloadPath = path.isAbsolute(payloadArg) ? path.resolve(payloadArg) : path.resolve(workspaceRoot, payloadArg);
  if (!validatePath(payloadPath, [workspaceRoot])) {
    console.error('错误: payload 文件必须位于工作区内。');
    return 1;
  }
  let payload: Buffer;
  try {
    payload = await fsp.readFile(payloadPath);
  } catch (err) {
    console.error(`错误: 无法读取 payload 文件: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (payload.toString('utf-8').trim().length === 0 && intendedOperation !== 'attachment.accept') {
    console.error('错误: 写操作 payload 不能为空。');
    return 1;
  }

  const now = new Date();
  const messageHash = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
  const actionId = `act_${crypto.randomUUID()}`;
  let plan: ActionPlan;
  try {
    plan = ActionPlanSchema.parse({
      schemaVersion: '1.0',
      actionId,
      workspaceId: `sha256:${crypto.createHash('sha256').update(workspaceRoot).digest('hex')}`,
      operation: intendedOperation,
      platform: 'boss',
      candidateKey,
      candidateLocator: {
        platform: 'boss',
        source,
        jobRef,
        displayedName,
        listContextHash,
        capturedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + config.boss.approvals.default_ttl_minutes * 60_000).toISOString(),
      },
      payload: { messageFile: payloadPath, messageHash },
      approval: {
        required: true,
        status: 'pending',
        assurance: 'conversation',
        scope: 'single_action',
      },
      idempotencyKey: `boss:${intendedOperation}:${candidateKey}:${jobRef}:${messageHash}`,
      createdAt: now.toISOString(),
      status: 'awaiting_approval',
    });
  } catch (err) {
    console.error(`错误: 候选人定位信息无效: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const runtimePaths = await resolveRuntimePaths(config);
  await ensureRuntimeDirs(runtimePaths);
  const outArg = typeof args.options.out === 'string' ? args.options.out : '';
  const outPath = outArg
    ? (path.isAbsolute(outArg) ? path.resolve(outArg) : path.resolve(workspaceRoot, outArg))
    : path.join(runtimePaths.actions.pending, `${actionId}.json`);
  if (!validatePath(outPath, [workspaceRoot])) {
    console.error('错误: 计划输出路径必须位于工作区内。');
    return 1;
  }
  try {
    await fsp.access(outPath);
    console.error('错误: 计划输出文件已存在；为避免覆盖审批材料，请换一个 --out 路径。');
    return 1;
  } catch {
    // Expected: the new plan path does not exist.
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await atomicWritePlan(outPath, plan);
  console.log(JSON.stringify({ status: 'awaiting_approval', actionId, plan: outPath, payloadHash: messageHash }, null, 2));
  return 0;
}

async function approvePlan(args: CliArgs, config: GatewayConfig): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('错误: approve 必须在真实交互终端中执行，不能通过管道或后台任务代替人工确认。');
    return 1;
  }
  const planArg = typeof args.options.plan === 'string' ? args.options.plan : '';
  const payloadFile = typeof args.options.payloadFile === 'string' ? args.options.payloadFile : '';
  if (!planArg || !payloadFile) {
    console.error('错误: approve 需要 --plan 和 --payload-file。');
    return 1;
  }

  const workspaceRoot = path.resolve(config.workspace_root);
  const planPath = path.isAbsolute(planArg) ? path.resolve(planArg) : path.resolve(workspaceRoot, planArg);
  if (!validatePath(planPath, [workspaceRoot])) {
    console.error('错误: ActionPlan 必须位于工作区内。');
    return 1;
  }

  let pendingPlan: ActionPlan;
  try {
    pendingPlan = ActionPlanSchema.parse(JSON.parse(await fsp.readFile(planPath, 'utf-8')));
  } catch (err) {
    console.error(`错误: 无法读取有效 ActionPlan: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!pendingPlan.approval.required || pendingPlan.approval.status === 'denied') {
    console.error('错误: 该计划不是可审批的待确认写操作。');
    return 1;
  }

  const now = new Date();
  const configuredExpiry = now.getTime() + config.boss.approvals.default_ttl_minutes * 60_000;
  const locatorExpiry = new Date(pendingPlan.candidateLocator.expiresAt).getTime();
  const expiresAt = new Date(Math.min(configuredExpiry, locatorExpiry)).toISOString();
  const approvedPlan = ActionPlanSchema.parse({
    ...pendingPlan,
    approval: {
      ...pendingPlan.approval,
      required: true,
      status: 'approved',
      approvedAt: now.toISOString(),
      expiresAt,
      assurance: 'interactive',
      scope: 'single_action',
    },
    status: 'approved',
  });

  const command = toGatewayCommand({
    operation: approvedPlan.operation,
    input: {
      plan: planPath,
      payloadFile,
      name: approvedPlan.candidateLocator.displayedName,
      jobRef: approvedPlan.candidateLocator.jobRef,
    },
  });
  const integrity = await validateActionPlanIntegrity({ plan: approvedPlan, command, workspaceRoot });
  if (!integrity.valid) {
    console.error(`错误: 审批绑定校验失败: ${integrity.reason}`);
    return 1;
  }

  console.log('\n即将批准一次不可复用的招聘平台写操作：');
  console.log(`  actionId: ${approvedPlan.actionId}`);
  console.log(`  操作: ${approvedPlan.operation}`);
  console.log(`  候选人: ${approvedPlan.candidateLocator.displayedName} (${approvedPlan.candidateKey})`);
  console.log(`  岗位: ${approvedPlan.candidateLocator.jobRef}`);
  console.log(`  载荷哈希: ${integrity.payloadHash}`);
  console.log(`  失效时间: ${expiresAt}`);
  console.log('  载荷预览:');
  console.log(safeTerminalPreview(integrity.payloadText).split(/\r?\n/).map(line => `    ${line}`).join('\n'));

  const phrase = `APPROVE ${approvedPlan.actionId}`;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    answer = await prompt.question(`\n请输入“${phrase}”确认: `);
  } finally {
    prompt.close();
  }
  if (answer.trim() !== phrase) {
    console.error('审批已取消：确认短语不匹配。');
    return 1;
  }

  const runtimePaths = await resolveRuntimePaths(config);
  await ensureRuntimeDirs(runtimePaths);
  await atomicWritePlan(planPath, approvedPlan);
  const record = await createApprovalStore(runtimePaths).issue(
    approvedPlan,
    config.boss.approvals.default_ttl_minutes,
  );
  console.log(JSON.stringify({ status: 'approved', actionId: record.actionId, expiresAt: record.expiresAt }, null, 2));
  return 0;
}

function printVersion(): void {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    console.log(`recruitctl v${pkg.version}`);
  } catch {
    console.log('recruitctl v0.1.0');
  }
}

// ── Main ──

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // Handle special flags
  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.version) {
    printVersion();
    return 0;
  }

  // Validate operation
  if (!args.operation) {
    console.error('错误: 请指定操作。使用 --help 查看可用操作。');
    return 1;
  }

  // ── Doctor command (doesn't go through Gateway pipeline) ──
  if (args.operation === 'doctor') {
    const configPath = args.configPath ?? path.join(args.workspace, 'gateway.json');
    try {
      const report = await runDoctor(configPath);
      if (args.format === 'json') {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatDoctorReport(report));
      }
      return report.healthy ? 0 : 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`错误: doctor 检查失败: ${message}`);
      return 1;
    }
  }

  // Load config
  const config = await loadConfig(args);

  // Resolve stdin payload (if --payload-file - / --stdin)
  try {
    await resolveStdinPayload(args, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误: stdin 输入失败: ${message}`);
    return 1;
  }

  if (args.operation === 'approve') {
    try {
      return await approvePlan(args, config);
    } catch (err) {
      console.error(`错误: 审批失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (args.operation === 'plan.create') {
    try {
      return await createPlan(args, config);
    } catch (err) {
      console.error(`错误: 创建计划失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // Build command
  let command: GatewayCommand;
  try {
    command = toGatewayCommand({
      operation: args.operation,
      input: args.options,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误: 无效的操作 "${args.operation}": ${message}`);
    return 1;
  }

  // Create gateway
  let gw: GatewayInstance;
  try {
    gw = await createGateway(config, {
      log: config.logging.level === 'debug'
        ? (msg, level) => console.error(`[gateway:${level}] ${msg}`)
        : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误: 网关初始化失败: ${message}`);
    return 1;
  }

  // Execute
  let result: GatewayResult | undefined;
  try {
    result = await gw.execute(command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误: 执行异常: ${message}`);
    return 1; // finally will handle cleanup
  } finally {
    if (!result) await gw.stop();
  }

  // Output result
  console.log(formatResult(result, args.format));

  // Exit code based on status
  if (result.status === 'failed') return 2;
  if (result.status === 'denied') return 3;
  if (result.status === 'paused') return 4;
  return 0;
}

// ── Exports for testing ──
export { parseArgs, formatResult, main, safeTerminalPreview };

// ── Entry point (only runs when executed directly, not when imported) ──
if (!process.env.VITEST) {
  main(process.argv).then(code => {
    // Small delay to let async handles settle
    setTimeout(() => process.exit(code), 50);
  }).catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`致命错误: ${message}`);
    process.exit(99);
  });
}
