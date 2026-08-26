import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Imports ──
import { getOperationDefinition, getAllOperations, isReadOperation, isWriteOperation, isIrreversibleWrite } from '../../src/gateway/operation-catalog.js';
import { GatewayConfigSchema, defaultRoutesConfig, RouteEntrySchema } from '../../src/gateway/config.js';
import { evaluatePolicy } from '../../src/gateway/policy-engine.js';
import { resolveDriver, routeOperation } from '../../src/gateway/router.js';
import { createCircuitBreaker, recordFailure, recordSuccess, snapshot, closeWriteCircuit, setLoginRequired } from '../../src/gateway/circuit-breaker.js';
import { validateApproval, checkApprovalBinding } from '../../src/gateway/approval-service.js';
import { createIdempotencyStore } from '../../src/gateway/idempotency-store.js';
import { createSessionLock } from '../../src/gateway/session-lock.js';
import { toGatewayCommand } from '../../src/contracts/command.js';
import type { GatewayConfig } from '../../src/gateway/config.js';

// ── Helpers ──
const testConfig: GatewayConfig = GatewayConfigSchema.parse({
  version: '1',
  workspace_root: '.',
  boss: {
    circuit_breaker: { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true },
  },
});

const healthyHealth = {
  legacy_cli: 'healthy' as const,
  rpa: 'healthy' as const,
  human: 'healthy' as const,
  gateway_local: 'healthy' as const,
};

const cleanCircuitSnapshot = {
  driverHealth: { ...healthyHealth },
  writeCircuitOpen: false,
  verificationPageOpen: false,
  loginRequired: false,
};

// ── Operation Catalog ──
describe('OperationCatalog', () => {
  it('has all 22 operations', () => {
    expect(getAllOperations().length).toBe(22);
  });

  it('every operation has valid primary and fallback drivers', () => {
    const validDrivers = new Set(['legacy_cli', 'rpa', 'human', 'gateway_local', 'current_write_driver']);
    for (const op of getAllOperations()) {
      expect(validDrivers.has(op.primary), `${op.operation}: primary=${op.primary}`).toBe(true);
      expect(validDrivers.has(op.fallback), `${op.operation}: fallback=${op.fallback}`).toBe(true);
    }
  });

  it('markNotFit automation_allowed is false', () => {
    const def = getOperationDefinition('candidate.markNotFit');
    expect(def.automationAllowed).toBe(false);
    expect(def.primary).toBe('human');
  });

  it('irreversible writes have retryWhenResultUnknown=false', () => {
    const ops = ['message.commit', 'greeting.commit', 'attachment.request', 'contact.exchange'];
    for (const op of ops) {
      const def = getOperationDefinition(op);
      expect(def.retryWhenResultUnknown, op).toBe(false);
      expect(def.autoRetry, op).toBe(false);
    }
  });

  it('reads classify correctly', () => {
    expect(isReadOperation('read')).toBe(true);
    expect(isReadOperation('read_navigation')).toBe(true);
    expect(isReadOperation('reversible_write')).toBe(false);
  });

  it('writes classify correctly', () => {
    expect(isWriteOperation('reversible_write')).toBe(true);
    expect(isWriteOperation('irreversible_write')).toBe(true);
    expect(isWriteOperation('read')).toBe(false);
  });

  it('irreversible detection works', () => {
    expect(isIrreversibleWrite('irreversible_write')).toBe(true);
    expect(isIrreversibleWrite('state_write')).toBe(false);
  });
});

// ── Router ──
describe('Router', () => {
  it('returns primary when healthy', () => {
    const result = resolveDriver({
      operation: 'candidates.listUnread',
      primary: 'legacy_cli',
      fallback: 'rpa',
      health: healthyHealth,
      circuit: cleanCircuitSnapshot,
    });
    expect(result.driver).toBe('legacy_cli');
    expect(result.isDegraded).toBe(false);
  });

  it('falls back when primary is degraded', () => {
    const result = resolveDriver({
      operation: 'candidates.listUnread',
      primary: 'legacy_cli',
      fallback: 'rpa',
      health: { ...healthyHealth, legacy_cli: 'circuit_open' },
      circuit: cleanCircuitSnapshot,
    });
    expect(result.driver).toBe('rpa');
    expect(result.isDegraded).toBe(true);
  });

  it('falls to human when both unhealthy', () => {
    const result = resolveDriver({
      operation: 'message.commit',
      primary: 'rpa',
      fallback: 'human',
      health: { ...healthyHealth, rpa: 'unavailable', human: 'healthy' },
      circuit: cleanCircuitSnapshot,
    });
    expect(result.driver).toBe('human');
    expect(result.isDegraded).toBe(true);
  });

  it('routes to human when primary and fallback both degraded but human healthy', () => {
    const result = resolveDriver({
      operation: 'message.commit',
      primary: 'rpa',
      fallback: 'legacy_cli',
      health: { ...healthyHealth, rpa: 'unavailable', legacy_cli: 'circuit_open', human: 'healthy' },
      circuit: cleanCircuitSnapshot,
    });
    expect(result.driver).toBe('human');
    expect(result.isDegraded).toBe(true);
    expect(result.reason).toContain('均不可用');
  });

  it('routes to human with "所有 Driver 不可用" when everything broken', () => {
    const result = resolveDriver({
      operation: 'message.commit',
      primary: 'rpa',
      fallback: 'legacy_cli',
      health: { rpa: 'unavailable', legacy_cli: 'circuit_open', human: 'unavailable' },
      circuit: cleanCircuitSnapshot,
    });
    expect(result.driver).toBe('human');
    expect(result.isDegraded).toBe(true);
    expect(result.reason).toBe('所有 Driver 不可用');
  });

  it('routeOperation uses catalog defaults', () => {
    const result = routeOperation({
      operation: 'jd.get',
      health: healthyHealth,
      circuit: cleanCircuitSnapshot,
    });
    expect(result.driver).toBe('legacy_cli');
  });
});

// ── Policy Engine ──
describe('PolicyEngine', () => {
  it('blocks markNotFit automation', () => {
    const cmd = toGatewayCommand({ operation: 'candidate.markNotFit', input: {} });
    const result = evaluatePolicy({
      command: cmd,
      config: testConfig,
      circuitSnapshot: cleanCircuitSnapshot,
      driverHealth: healthyHealth,
      isWriteCircuitOpen: false,
      sessionUnavailable: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('禁止自动执行');
  });

  it('blocks writes when session unavailable', () => {
    const cmd = toGatewayCommand({ operation: 'message.commit', input: { plan: 'test.json' } });
    const result = evaluatePolicy({
      command: cmd,
      config: testConfig,
      circuitSnapshot: cleanCircuitSnapshot,
      driverHealth: healthyHealth,
      isWriteCircuitOpen: false,
      sessionUnavailable: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('会话不可用');
  });

  it('allows session.status even when session unavailable', () => {
    const cmd = toGatewayCommand({ operation: 'session.status', input: {} });
    const result = evaluatePolicy({
      command: cmd,
      config: testConfig,
      circuitSnapshot: cleanCircuitSnapshot,
      driverHealth: healthyHealth,
      isWriteCircuitOpen: false,
      sessionUnavailable: true,
    });
    expect(result.allowed).toBe(true);
  });

  it('blocks writes when write circuit is open', () => {
    const cmd = toGatewayCommand({ operation: 'greeting.commit', input: {} });
    const result = evaluatePolicy({
      command: cmd,
      config: testConfig,
      circuitSnapshot: cleanCircuitSnapshot,
      driverHealth: healthyHealth,
      isWriteCircuitOpen: true,
      sessionUnavailable: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('熔断');
  });

  it('blocks writes when verification page is detected', () => {
    const cmd = toGatewayCommand({ operation: 'message.commit', input: { plan: 'test.json' } });
    const result = evaluatePolicy({
      command: cmd,
      config: testConfig,
      circuitSnapshot: { ...cleanCircuitSnapshot, verificationPageOpen: true },
      driverHealth: healthyHealth,
      isWriteCircuitOpen: false,
      sessionUnavailable: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('验证页面');
  });

  it('allows reads with no restrictions', () => {
    const cmd = toGatewayCommand({ operation: 'candidates.listUnread', input: { unread: true } });
    const result = evaluatePolicy({
      command: cmd,
      config: testConfig,
      circuitSnapshot: cleanCircuitSnapshot,
      driverHealth: healthyHealth,
      isWriteCircuitOpen: false,
      sessionUnavailable: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.approvalRequired).toBe(false);
  });

  it('requires approval for irreversible writes', () => {
    const cmd = toGatewayCommand({ operation: 'message.commit', input: {} });
    const result = evaluatePolicy({
      command: cmd,
      config: testConfig,
      circuitSnapshot: cleanCircuitSnapshot,
      driverHealth: healthyHealth,
      isWriteCircuitOpen: false,
      sessionUnavailable: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.approvalRequired).toBe(true);
  });
});

// ── Circuit Breaker ──
describe('CircuitBreaker', () => {
  let cb: ReturnType<typeof createCircuitBreaker>;

  beforeEach(() => {
    cb = createCircuitBreaker({ identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
  });

  it('starts healthy', () => {
    const snap = snapshot(cb);
    expect(snap.writeCircuitOpen).toBe(false);
    expect(snap.driverHealth['legacy_cli']).toBe('healthy');
  });

  it('opens circuit on unknown write result', () => {
    recordFailure(cb, 'rpa', 'RESULT_UNKNOWN', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    const snap = snapshot(cb);
    expect(snap.writeCircuitOpen).toBe(true);
  });

  it('opens circuit on verification page', () => {
    recordFailure(cb, 'rpa', 'VERIFICATION_REQUIRED', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    const snap = snapshot(cb);
    expect(snap.verificationPageOpen).toBe(true);
    expect(snap.writeCircuitOpen).toBe(true);
  });

  it('sets login required on LOGIN_REQUIRED', () => {
    recordFailure(cb, 'legacy_cli', 'LOGIN_REQUIRED', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    expect(snapshot(cb).loginRequired).toBe(true);
  });

  it('resets login state', () => {
    setLoginRequired(cb, true);
    expect(snapshot(cb).loginRequired).toBe(true);
    setLoginRequired(cb, false);
    expect(snapshot(cb).loginRequired).toBe(false);
  });

  it('closes write circuit manually', () => {
    recordFailure(cb, 'rpa', 'RESULT_UNKNOWN', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    expect(snapshot(cb).writeCircuitOpen).toBe(true);
    closeWriteCircuit(cb);
    expect(snapshot(cb).writeCircuitOpen).toBe(false);
  });

  it('opens driver circuit on identity failures', () => {
    recordFailure(cb, 'rpa', 'CANDIDATE_AMBIGUOUS', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    expect(snapshot(cb).driverHealth['rpa']).toBe('healthy'); // Only 1 failure
    recordFailure(cb, 'rpa', 'CANDIDATE_MISMATCH', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    expect(snapshot(cb).driverHealth['rpa']).toBe('circuit_open'); // 2 failures — circuit open
  });

  it('success resets identity failures', () => {
    recordFailure(cb, 'rpa', 'CANDIDATE_AMBIGUOUS', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    recordSuccess(cb, 'rpa');
    // After success, the counter is reset
    // Should no longer be at risk of opening
    recordFailure(cb, 'rpa', 'CANDIDATE_AMBIGUOUS', { identity_failures: 2, unknown_write_results: 1, verification_page_immediate_open: true });
    expect(snapshot(cb).driverHealth['rpa']).toBe('healthy'); // Counter reset, only 1 again
  });
});

// ── Approval Service ──
describe('ApprovalService', () => {
  it('validates approved plan', () => {
    const result = validateApproval({
      schemaVersion: '1.0',
      actionId: 'act_1',
      workspaceId: 'ws',
      operation: 'message.commit',
      platform: 'boss',
      candidateKey: 'cand_1',
      candidateLocator: {
        platform: 'boss',
        source: 'inbound_chat',
        jobRef: 'pm',
        displayedName: '张**',
        listContextHash: 'abc',
        capturedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      payload: { messageFile: 'test.txt', messageHash: 'abc' },
      approval: {
        required: true,
        status: 'approved',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        assurance: 'conversation',
        scope: 'single_action',
      },
      idempotencyKey: 'key',
      createdAt: new Date().toISOString(),
    });
    expect(result.valid).toBe(true);
  });

  it('rejects denied plan', () => {
    const result = validateApproval({
      ...getValidPlan(),
      approval: { required: true, status: 'denied', assurance: 'conversation', scope: 'single_action' },
    } as any);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('拒绝');
  });

  it('rejects expired plan', () => {
    const result = validateApproval({
      ...getValidPlan(),
      approval: { required: true, status: 'approved', expiresAt: '2020-01-01T00:00:00Z', assurance: 'conversation', scope: 'single_action' },
    } as any);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('过期');
  });

  it('checks binding — operation mismatch', () => {
    const plan = getValidPlan();
    const result = checkApprovalBinding(plan, {
      operation: 'greeting.commit',
      candidateKey: plan.candidateKey,
      jobRef: plan.candidateLocator.jobRef,
      payloadHash: plan.payload.messageHash,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('operation');
  });

  it('checks binding — all match', () => {
    const plan = getValidPlan();
    const result = checkApprovalBinding(plan, {
      operation: plan.operation,
      candidateKey: plan.candidateKey,
      jobRef: plan.candidateLocator.jobRef,
      payloadHash: plan.payload.messageHash,
    });
    expect(result.valid).toBe(true);
  });
});

function getValidPlan() {
  return {
    schemaVersion: '1.0' as const,
    actionId: 'act_test',
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
  };
}

// ── Idempotency Store ──
describe('IdempotencyStore', () => {
  let tmpDir: string;
  let store: ReturnType<typeof createIdempotencyStore>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-idempotency-'));
    store = createIdempotencyStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('allows first execution', async () => {
    const result = await store.validateBeforeExecution('key_1', 'act_1');
    expect(result.allowed).toBe(true);
  });

  it('blocks already succeeded action', async () => {
    await store.markSucceeded('key_1', 'act_1');
    const result = await store.validateBeforeExecution('key_1', 'act_2');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('already_completed');
  });

  it('blocks executing action', async () => {
    await store.markExecuting('key_1', 'act_1');
    const result = await store.validateBeforeExecution('key_1', 'act_2');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('conflict_in_progress');
  });

  it('blocks result_unknown action', async () => {
    await store.markResultUnknown('key_1', 'act_1');
    const result = await store.validateBeforeExecution('key_1', 'act_2');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('result_unknown');
  });

  it('allows retry after failed_before_commit', async () => {
    await store.markFailedBeforeCommit('key_1', 'act_1');
    const result = await store.validateBeforeExecution('key_1', 'act_2');
    expect(result.allowed).toBe(true);
  });
});

// ── Session Lock ──
describe('SessionLock', () => {
  let tmpDir: string;
  let lock: ReturnType<typeof createSessionLock>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-lock-'));
    lock = createSessionLock(tmpDir);
  });

  afterEach(async () => {
    await lock.release();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases lock', async () => {
    const info = await lock.acquire({
      leaseId: 'lease_1',
      owner: 'legacy_cli',
      pid: process.pid,
      processStartTime: new Date().toISOString(),
      operation: 'candidates.list',
      actionId: null,
    }, 180);
    expect(info.leaseId).toBe('lease_1');

    // Read back
    const read = await lock.read();
    expect(read).not.toBeNull();
    expect(read!.leaseId).toBe('lease_1');

    // Release
    await lock.release();
    expect(await lock.read()).toBeNull();
  });

  it('prevents double acquisition', async () => {
    await lock.acquire({
      leaseId: 'lease_1',
      owner: 'legacy_cli',
      pid: process.pid,
      processStartTime: new Date().toISOString(),
      operation: 'candidates.list',
      actionId: null,
    }, 180);

    await expect(lock.acquire({
      leaseId: 'lease_2',
      owner: 'rpa',
      pid: process.pid,
      processStartTime: new Date().toISOString(),
      operation: 'message.commit',
      actionId: 'act_1',
    }, 180)).rejects.toThrow('会话锁已被占用');
  });

  it('detects stale lock from dead PID', async () => {
    // Write a fake lock with a non-existent PID
    const lockPath = lock.getPath();
    const deadPidLock = {
      schemaVersion: '1.0',
      leaseId: 'dead_lease',
      owner: 'legacy_cli',
      pid: 99999,
      processStartTime: new Date(Date.now() - 3600000).toISOString(),
      operation: 'candidates.list',
      actionId: null,
      acquiredAt: new Date(Date.now() - 3600000).toISOString(),
      expiresAt: new Date(Date.now() - 1800000).toISOString(), // expired 30 min ago
    };
    await fs.writeFile(lockPath, JSON.stringify(deadPidLock, null, 2));

    const stale = await lock.isStale();
    expect(stale).toBe(true);

    // Should be able to recover
    await lock.recoverStale();
    expect(await lock.read()).toBeNull();
  });
});

// ── Config ──
describe('Config', () => {
  it('validates default routes', () => {
    const routes = defaultRoutesConfig();
    expect(routes.version).toBe('1');
    expect(Object.keys(routes.operations).length).toBe(22);
  });

  it('every route entry has valid driver types', () => {
    const routes = defaultRoutesConfig();
    for (const [op, entry] of Object.entries(routes.operations)) {
      expect(() => RouteEntrySchema.parse(entry)).not.toThrow();
    }
  });

  it('markNotFit has automation_allowed=false in routes', () => {
    const routes = defaultRoutesConfig();
    expect(routes.operations['candidate.markNotFit'].automation_allowed).toBe(false);
  });
});
