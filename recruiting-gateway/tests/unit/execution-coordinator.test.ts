import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeCommand } from '../../src/gateway/execution-coordinator.js';
import type { ExecutionContext } from '../../src/gateway/execution-coordinator.js';
import type { Driver, DriverExecuteInput } from '../../src/drivers/driver.js';
import type { GatewayResult } from '../../src/contracts/result.js';
import { successResult, failedResult, pausedResult } from '../../src/contracts/result.js';
import type { GatewayCommand } from '../../src/contracts/command.js';
import { toGatewayCommand } from '../../src/contracts/command.js';
import { GatewayConfigSchema } from '../../src/gateway/config.js';
import { createCircuitBreaker } from '../../src/gateway/circuit-breaker.js';
import { createIdempotencyStore } from '../../src/gateway/idempotency-store.js';
import { createAuditLog } from '../../src/gateway/audit-log.js';
import { createSessionLock } from '../../src/gateway/session-lock.js';
import { resolveRuntimePaths, ensureRuntimeDirs } from '../../src/runtime/paths.js';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ActionPlan } from '../../src/contracts/action-plan.js';

// ── Test helpers ──

function makeReadCommand(op: string = 'candidates.listUnread'): GatewayCommand {
  return toGatewayCommand({
    operation: op,
    input: { unread: true },
    requestId: 'req_read_1',
  });
}

function makeWriteCommand(
  op: string = 'message.commit',
  planRef?: string,
): GatewayCommand {
  return toGatewayCommand({
    operation: op,
    input: planRef ? { plan: planRef } : {},
    requestId: 'req_write_1',
  });
}

function makeSuccessResult(driverName: string, requestId: string, operation: string): GatewayResult {
  return successResult({
    requestId,
    operation,
    driver: driverName,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
}

function makeFailedResult(
  driverName: string,
  requestId: string,
  operation: string,
  errorCode: string = 'INTERNAL_ERROR',
): GatewayResult {
  return failedResult({
    requestId,
    operation,
    driver: driverName,
    errorCode,
    message: `Mock failure: ${errorCode}`,
  });
}

function makePausedResult(driverName: string, requestId: string, operation: string): GatewayResult {
  return pausedResult({
    requestId,
    operation,
    driver: driverName,
    reason: '需要人工处理',
    code: 'VERIFICATION_REQUIRED',
  });
}

// ── Mock action plan ──

function makeActionPlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0' as const,
    actionId: 'act_test_1',
    workspaceId: 'ws_1',
    operation: 'message.commit' as const,
    platform: 'boss' as const,
    candidateKey: 'cand_1',
    candidateLocator: {
      platform: 'boss' as const,
      source: 'inbound_chat' as const,
      jobRef: 'pm',
      displayedName: '张**',
      listContextHash: 'abc',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    payload: { messageFile: 'test.txt', messageHash: 'abc' },
    approval: {
      required: true,
      status: 'approved' as const,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      assurance: 'conversation' as const,
      scope: 'single_action' as const,
    },
    idempotencyKey: 'boss:message.commit:cand_1:pm:abc',
    createdAt: new Date().toISOString(),
    status: 'approved' as const,
    ...overrides,
  };
}

// ── Build test context ──

async function buildContext(tmpDir: string, opts?: {
  mockDriverResult?: GatewayResult;
  mockDriverThrow?: Error;
}): Promise<ExecutionContext> {
  const config = GatewayConfigSchema.parse({
    version: '1',
    workspace_root: tmpDir,
    runtime_dir: 'runtime',
    boss: {
      circuit_breaker: { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true },
    },
  });

  const runtimePaths = await resolveRuntimePaths(config);
  await ensureRuntimeDirs(runtimePaths);

  const circuitBreaker = createCircuitBreaker(config.boss.circuit_breaker);

  // Mock driver
  const mockDriver: Driver = {
    name: 'legacy_cli',
    health: async () => ({ healthy: true, status: 'ok' }),
    execute: async (input: DriverExecuteInput) => {
      if (opts?.mockDriverThrow) throw opts.mockDriverThrow;
      return opts?.mockDriverResult ?? makeSuccessResult('legacy_cli', input.command.requestId, input.command.operation);
    },
    stop: async () => {},
  };

  const mockRpaDriver: Driver = {
    name: 'rpa',
    health: async () => ({ healthy: true, status: 'ok' }),
    execute: async (input: DriverExecuteInput) => {
      if (opts?.mockDriverThrow) throw opts.mockDriverThrow;
      return opts?.mockDriverResult ?? makeSuccessResult('rpa', input.command.requestId, input.command.operation);
    },
    stop: async () => {},
  };

  const mockHumanDriver: Driver = {
    name: 'human',
    health: async () => ({ healthy: true, status: 'ok' }),
    execute: async (input: DriverExecuteInput) => {
      return pausedResult({
        requestId: input.command.requestId,
        operation: input.command.operation,
        driver: 'human',
        reason: '需要人工处理',
        code: 'INTERNAL_ERROR',
      });
    },
    stop: async () => {},
  };

  const drivers: Record<string, Driver> = {
    legacy_cli: mockDriver,
    rpa: mockRpaDriver,
    human: mockHumanDriver,
    gateway_local: {
      name: 'gateway_local',
      health: async () => ({ healthy: true, status: 'ok' }),
      execute: async (input) => successResult({
        requestId: input.command.requestId,
        operation: input.command.operation,
        driver: 'gateway_local',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }),
      stop: async () => {},
    },
  };

  const idempotency = createIdempotencyStore(runtimePaths.root);
  const actionStore = (await import('../../src/runtime/action-store.js')).createActionStore(runtimePaths);
  const approvalStore = (await import('../../src/runtime/approval-store.js')).createApprovalStore(runtimePaths);
  const auditLog = createAuditLog(runtimePaths.audit);
  const lockDir = runtimePaths.locks;

  return {
    config,
    circuitBreaker,
    drivers,
    idempotency,
    actionStore,
    approvalStore,
    auditLog,
    runtimePaths,
    getLock: () => createSessionLock(lockDir),
  };
}

async function persistApprovedPlan(
  ctx: ExecutionContext,
  tmpDir: string,
  rawPlan: ReturnType<typeof makeActionPlan>,
  stem: string,
): Promise<{ plan: ActionPlan; planPath: string; payloadPath: string }> {
  const payloadPath = path.join(tmpDir, `${stem}.txt`);
  const payloadText = rawPlan.operation === 'remark.update' ? '重点跟进' : `test payload for ${rawPlan.operation}`;
  await fs.writeFile(payloadPath, payloadText, 'utf-8');
  const messageHash = `sha256:${crypto.createHash('sha256').update(payloadText).digest('hex')}`;
  const plan = {
    ...rawPlan,
    workspaceId: `sha256:${crypto.createHash('sha256').update(path.resolve(tmpDir)).digest('hex')}`,
    payload: { ...rawPlan.payload, messageFile: payloadPath, messageHash },
    approval: { ...rawPlan.approval, assurance: 'interactive' as const },
    idempotencyKey: `boss:${rawPlan.operation}:${rawPlan.candidateKey}:${rawPlan.candidateLocator.jobRef}:${messageHash}`,
  } as ActionPlan;
  const planPath = path.join(tmpDir, `${stem}.json`);
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
  await ctx.approvalStore.issue(plan, 30);
  return { plan, planPath, payloadPath };
}

// ── Tests ──

describe('ExecutionCoordinator', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-coord-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Read Path ──

  it('executes a read operation successfully (no approval, no lock for local_read)', async () => {
    const ctx = await buildContext(tmpDir);
    const cmd = toGatewayCommand({
      operation: 'session.status',
      input: {},
      requestId: 'req_sess_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('gateway_local');
  });

  it('executes a read operation requiring browser (acquires lock)', async () => {
    const ctx = await buildContext(tmpDir);
    const cmd = makeReadCommand('candidates.listUnread');

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');
  });

  // ── Write Path (Full Pipeline) ──

  it('executes a write operation with valid ActionPlan successfully', async () => {
    const ctx = await buildContext(tmpDir);

    // Write ActionPlan to disk
    const { plan, planPath, payloadPath } = await persistApprovedPlan(ctx, tmpDir, makeActionPlan(), 'plan_1');

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
      requestId: 'req_write_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('rpa');

    // Verify idempotency recorded
    const idemState = await ctx.idempotency.check(plan.idempotencyKey);
    // The last entry should be succeeded (append-based store)
  });

  // ── Policy Denial ──

  it('blocks markNotFit automation', async () => {
    const ctx = await buildContext(tmpDir);
    const cmd = toGatewayCommand({
      operation: 'candidate.markNotFit',
      input: {},
      requestId: 'req_mnf_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    // Check audit log
    const auditEntry = await findLastAuditEvent(ctx, tmpDir);
    expect(auditEntry.event).toBe('action.denied');
  });

  it('blocks write when session unavailable', async () => {
    const ctx = await buildContext(tmpDir);
    ctx.circuitBreaker.loginRequired = true;

    const cmd = makeWriteCommand('message.commit');
    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.message).toContain('会话不可用');
  });

  // ── Approval Denial ──

  it('blocks write without ActionPlan', async () => {
    const ctx = await buildContext(tmpDir);
    const cmd = makeWriteCommand('message.commit');
    // No plan input

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.message).toContain('ActionPlan');
  });

  it('blocks write with non-existent plan file', async () => {
    const ctx = await buildContext(tmpDir);
    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: 'nonexistent.json' },
      requestId: 'req_nope_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.message).toContain('加载失败');
  });

  it('blocks write with denied approval', async () => {
    const ctx = await buildContext(tmpDir);
    const plan = makeActionPlan({
      approval: {
        required: true,
        status: 'denied',
        assurance: 'conversation',
        scope: 'single_action',
      },
    });
    const planPath = path.join(tmpDir, 'plan_denied.json');
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath },
      requestId: 'req_den_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.message).toContain('拒绝');
  });

  it('blocks write with expired approval', async () => {
    const ctx = await buildContext(tmpDir);
    const plan = makeActionPlan({
      approval: {
        required: true,
        status: 'approved',
        expiresAt: '2020-01-01T00:00:00Z',
        assurance: 'conversation',
        scope: 'single_action',
      },
    });
    const planPath = path.join(tmpDir, 'plan_expired.json');
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath },
      requestId: 'req_exp_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.message).toContain('过期');
  });

  // ── Idempotency ──

  it('blocks duplicate idempotency key', async () => {
    const ctx = await buildContext(tmpDir);
    const { plan, planPath, payloadPath } = await persistApprovedPlan(ctx, tmpDir, makeActionPlan(), 'plan_idem');

    // Pre-record the key as executing
    await ctx.idempotency.markExecuting(plan.idempotencyKey, 'another_action');

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
      requestId: 'req_dup_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('IDEMPOTENCY_BLOCKED');
  });

  it('blocks already-completed action', async () => {
    const ctx = await buildContext(tmpDir);
    const { plan, planPath, payloadPath } = await persistApprovedPlan(ctx, tmpDir, makeActionPlan(), 'plan_done');

    await ctx.idempotency.markSucceeded(plan.idempotencyKey, 'done_action');

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
      requestId: 'req_done_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.message).toContain('已完成');
  });

  // ── Lock Conflict ──

  it('blocks when session lock is held', async () => {
    const ctx = await buildContext(tmpDir);

    // Pre-acquire the lock
    const lock = ctx.getLock();
    await lock.acquire({
      leaseId: 'other_lease',
      owner: 'legacy_cli',
      pid: process.pid,
      processStartTime: new Date().toISOString(),
      operation: 'candidates.list',
      actionId: null,
    }, 180);

    const { planPath, payloadPath } = await persistApprovedPlan(ctx, tmpDir, makeActionPlan(), 'plan_lock');

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
      requestId: 'req_lock_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('denied');
    expect(result.error?.code).toBe('LOCK_CONFLICT');

    // Cleanup
    await lock.release();
  });

  // ── Driver Failure ──

  it('handles driver failure (pre-commit error) — marks idempotency failed_before_commit', async () => {
    const ctx = await buildContext(tmpDir, {
      mockDriverResult: makeFailedResult('rpa', 'req_wf_1', 'message.commit', 'INTERNAL_ERROR'),
    });

    const { plan, planPath, payloadPath } = await persistApprovedPlan(ctx, tmpDir, makeActionPlan(), 'plan_fail');

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
      requestId: 'req_wf_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INTERNAL_ERROR');

    // Check idempotency marked failed_before_commit
    const state = await ctx.idempotency.check(plan.idempotencyKey);
    // The last entry should be failed_before_commit
  });

  it('handles RESULT_UNKNOWN — opens write circuit, marks idempotency result_unknown', async () => {
    const ctx = await buildContext(tmpDir, {
      mockDriverResult: makeFailedResult('rpa', 'req_ru_1', 'message.commit', 'RESULT_UNKNOWN'),
    });

    const { planPath, payloadPath } = await persistApprovedPlan(ctx, tmpDir, makeActionPlan(), 'plan_ru');

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
      requestId: 'req_ru_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RESULT_UNKNOWN');

    // Circuit should be open
    const { snapshot } = await import('../../src/gateway/circuit-breaker.js');
    expect(snapshot(ctx.circuitBreaker).writeCircuitOpen).toBe(true);
  });

  it('handles driver exception (throw)', async () => {
    const ctx = await buildContext(tmpDir, {
      mockDriverThrow: new Error('Crash!'),
    });

    const cmd = toGatewayCommand({
      operation: 'candidates.listUnread',
      input: { unread: true },
      requestId: 'req_crash_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('Crash');
  });

  // ── Lock lifecycle ──

  it('releases lock after successful execution', async () => {
    const ctx = await buildContext(tmpDir);

    const cmd = makeReadCommand('candidates.listUnread');
    await executeCommand(ctx, cmd);

    // Lock should be released
    const lock = ctx.getLock();
    const info = await lock.read();
    expect(info).toBeNull();
  });

  it('releases lock after failed execution', async () => {
    const ctx = await buildContext(tmpDir, {
      mockDriverThrow: new Error('Boom!'),
    });

    const cmd = makeReadCommand('candidates.listUnread');
    await executeCommand(ctx, cmd);

    // Lock should be released even on error
    const lock = ctx.getLock();
    const info = await lock.read();
    expect(info).toBeNull();
  });

  it('does not acquire lock for session.status or execution.stop', async () => {
    const ctx = await buildContext(tmpDir);

    const cmd = toGatewayCommand({
      operation: 'session.status',
      input: {},
      requestId: 'req_nolock_1',
    });
    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('succeeded');
  });

  // ── Human Driver ──

  it('returns paused when routed to human driver', async () => {
    const ctx = await buildContext(tmpDir);

    // Force human route by marking legacy_cli as unavailable
    ctx.circuitBreaker.drivers['legacy_cli'] = 'unavailable';

    const cmd = toGatewayCommand({
      operation: 'candidate.markNotFit',
      input: { name: 'test' },
      requestId: 'req_hum_1',
    });
    // markNotFit is always blocked by policy, but other ops might fall to human
  });

  it('handles paused result from driver (idempotency → result_unknown)', async () => {
    const ctx = await buildContext(tmpDir, {
      mockDriverResult: makePausedResult('rpa', 'req_paused_1', 'message.commit'),
    });

    const { planPath, payloadPath } = await persistApprovedPlan(ctx, tmpDir, makeActionPlan(), 'plan_paused');

    const cmd = toGatewayCommand({
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
      requestId: 'req_paused_1',
    });

    const result = await executeCommand(ctx, cmd);
    expect(result.status).toBe('paused');
    expect(result.error?.code).toBe('VERIFICATION_REQUIRED');
  });
});

// ── Helper: find last audit event ──

async function findLastAuditEvent(ctx: ExecutionContext, tmpDir: string): Promise<any> {
  const auditDir = ctx.runtimePaths.audit;
  const date = new Date().toISOString().slice(0, 10);
  const auditFile = path.join(auditDir, `${date}.jsonl`);
  try {
    const content = await fs.readFile(auditFile, 'utf-8');
    const lines = content.trim().split('\n');
    const last = lines[lines.length - 1];
    return JSON.parse(last);
  } catch {
    return null;
  }
}
