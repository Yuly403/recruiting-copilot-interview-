// ── Integration tests: Gateway end-to-end flows ──
// Tests Gateway with mocked drivers to verify the full pipeline:
// Command → Gateway router → Policy engine → Execution coordinator → Driver → Result
//
// PRD §21.3: Integration Tests

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createGateway,
  type GatewayInstance,
} from '../../src/gateway/index.js';
import { createMockPipeClient } from '../../src/drivers/rpa/named-pipe-client.js';
import { createRpaDriver } from '../../src/drivers/rpa/index.js';
import { createLegacyCliDriver } from '../../src/drivers/legacy-cli/index.js';
import type { GatewayConfig } from '../../src/gateway/config.js';
import type { Driver } from '../../src/drivers/driver.js';
import type { ActionPlan } from '../../src/contracts/action-plan.js';
import { resolveRuntimePaths, ensureRuntimeDirs } from '../../src/runtime/paths.js';

// ── Helpers ──

let tempDir: string;
const TEST_PAYLOAD = 'integration test payload';
const TEST_PAYLOAD_HASH = `sha256:${crypto.createHash('sha256').update(TEST_PAYLOAD).digest('hex')}`;

function makePlanFile(overrides: Partial<ActionPlan> & { actionId: string; operation: string }): ActionPlan {
  const now = new Date().toISOString();
  return {
    schemaVersion: '1.0' as const,
    actionId: overrides.actionId,
    workspaceId: `sha256:${crypto.createHash('sha256').update(path.resolve(BASE_CONFIG.workspace_root)).digest('hex')}`,
    operation: overrides.operation as ActionPlan['operation'],
    platform: 'boss' as const,
    candidateKey: 'candidate-001',
    candidateLocator: {
      platform: 'boss' as const,
      source: 'search_results' as const,
      jobRef: 'test-job',
      displayedName: '候选人甲（虚构）',
      listContextHash: 'abc123',
      capturedAt: now,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    payload: {
      messageFile: 'test-msg.txt',
      messageHash: TEST_PAYLOAD_HASH,
    },
    approval: {
      required: true,
      status: 'approved' as const,
      approvedAt: now,
      assurance: 'interactive' as const,
      scope: 'single_action' as const,
    },
    idempotencyKey: `boss:${overrides.operation}:candidate-001:test-job:${TEST_PAYLOAD_HASH}`,
    createdAt: now,
    status: 'approved' as const,
    ...overrides,
  };
}

const BASE_CONFIG: GatewayConfig = {
  version: '1',
  workspace_root: path.join(os.tmpdir(), 'test-gateway'),
  runtime_dir: path.join(os.tmpdir(), 'test-gateway', 'runtime'),
  boss: {
    legacy_cli: {
      executable: 'boss',
      default_timeout_ms: 30000,
      max_stdout_bytes: 2_097_152,
      max_stderr_bytes: 262_144,
    },
    rpa: {
      adapter: 'mock',
      allow_mock_writes: true,
      endpoint: 'mock-pipe',
      default_timeout_ms: 30000,
    },
    locking: {
      lease_seconds: 180,
    },
    approvals: {
      default_ttl_minutes: 30,
    },
    circuit_breaker: {
      identity_failures: 3,
      unknown_write_results: 1,
      verification_page_immediate_open: false,
    },
  },
  logging: {
    level: 'debug',
    redact_payloads: false,
    persist_screenshots: false,
  },
};

function mockLegacyCli(): Driver {
  return createLegacyCliDriver({
    config: BASE_CONFIG.boss.legacy_cli,
    processExecutor: async (_subcommand: string, _args: string[], _timeoutMs: number) => ({
      success: true,
      exitCode: 0,
      stdout: '[mock] completed successfully',
      stderr: '',
      signal: null,
      durationMs: 50,
    }),
  });
}

function mockRpa(): Driver {
  const mockPipe = createMockPipeClient('success');
  return createRpaDriver({
    config: BASE_CONFIG.boss.rpa,
    pipeClient: mockPipe,
  });
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-test-'));
  BASE_CONFIG.workspace_root = tempDir;
  BASE_CONFIG.runtime_dir = 'runtime';
  // Ensure runtime dirs exist (normally done inside createGateway, skipped by skipInit)
  const runtimePaths = await resolveRuntimePaths(BASE_CONFIG);
  // Clean up stale files from previous test runs
  try { await fs.rm(path.join(runtimePaths.root, 'idempotency.jsonl'), { force: true }); } catch {}
  try { await fs.rm(path.join(runtimePaths.locks, 'boss-session.lock'), { force: true }); } catch {}
  await ensureRuntimeDirs(runtimePaths);
});

afterEach(async () => {
  try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
});

// ── Read operations ──

describe('Gateway integration — read operations', () => {
  let gateway: GatewayInstance;

  beforeEach(async () => {
    gateway = await createGateway(BASE_CONFIG, {
      skipInit: true,
      drivers: {
        legacy_cli: mockLegacyCli(),
        rpa: mockRpa(),
      },
    });
  });

  it('executes session.login via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'session.login',
      input: {},
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes positions.list via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'positions.list',
      input: { name: '' },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes jd.get via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'jd.get',
      input: { name: '前端开发工程师' },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes candidates.list via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'candidates.list',
      input: { name: '' },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes candidates.search via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'candidates.search',
      input: { name: '', query: 'React 前端' },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes candidates.recommend via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'candidates.recommend',
      input: { name: '' },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes candidate.preview via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'candidate.preview',
      input: { name: '候选人甲（虚构）' },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes conversation.open via legacy_cli driver', async () => {
    const result = await gateway.execute({
      operation: 'conversation.open',
      input: { name: '候选人甲（虚构）' },
    });
    expect(result.status).toBe('succeeded');
  });
});

// ── Write operations ──

describe('Gateway integration — write operations', () => {
  let gateway: GatewayInstance;
  let planFiles: Record<string, string> = {};

  beforeEach(async () => {
    gateway = await createGateway(BASE_CONFIG, {
      skipInit: true,
      drivers: {
        legacy_cli: mockLegacyCli(),
        rpa: mockRpa(),
      },
    });

    // Create temp ActionPlan files for each write operation test
    const plans: Record<string, ActionPlan> = {
      'test-plan-msg': makePlanFile({ actionId: 'act-msg', operation: 'message.commit' }),
      'test-plan-greet': makePlanFile({ actionId: 'act-greet', operation: 'greeting.commit' }),
      'test-plan-stage': makePlanFile({ actionId: 'act-stage', operation: 'message.stage' }),
      'test-plan-remark': makePlanFile({ actionId: 'act-remark', operation: 'remark.update' }),
      'test-plan-contact': makePlanFile({ actionId: 'act-contact', operation: 'contact.exchange' }),
    };

    for (const [key, plan] of Object.entries(plans)) {
      const filePath = path.join(tempDir, `${key}.json`);
      const payloadPath = path.join(tempDir, 'test-msg.txt');
      await fs.writeFile(payloadPath, TEST_PAYLOAD, 'utf-8');
      await fs.writeFile(filePath, JSON.stringify(plan, null, 2));
      await gateway.ctx.approvalStore.issue(plan, 30);
      planFiles[key] = filePath;
    }
  });

  it('executes message.commit via rpa driver', async () => {
    const result = await gateway.execute({
      operation: 'message.commit',
      input: { name: '候选人甲（虚构）', plan: planFiles['test-plan-msg'], payloadFile: path.join(tempDir, 'test-msg.txt') },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes greeting.commit via rpa driver', async () => {
    const result = await gateway.execute({
      operation: 'greeting.commit',
      input: { name: '候选人甲（虚构）', plan: planFiles['test-plan-greet'], payloadFile: path.join(tempDir, 'test-msg.txt') },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes message.stage via rpa driver', async () => {
    const result = await gateway.execute({
      operation: 'message.stage',
      input: { name: '候选人甲（虚构）', plan: planFiles['test-plan-stage'], payloadFile: path.join(tempDir, 'test-msg.txt') },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes remark.update via rpa driver', async () => {
    const result = await gateway.execute({
      operation: 'remark.update',
      input: { name: '候选人甲（虚构）', plan: planFiles['test-plan-remark'], payloadFile: path.join(tempDir, 'test-msg.txt') },
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes contact.exchange via rpa driver', async () => {
    const result = await gateway.execute({
      operation: 'contact.exchange',
      input: { name: '候选人甲（虚构）', plan: planFiles['test-plan-contact'], payloadFile: path.join(tempDir, 'test-msg.txt') },
    });
    expect(result.status).toBe('succeeded');
  });
});

// ── Local operations ──

describe('Gateway integration — local operations', () => {
  let gateway: GatewayInstance;

  beforeEach(async () => {
    gateway = await createGateway(BASE_CONFIG, {
      skipInit: true,
      drivers: {
        legacy_cli: mockLegacyCli(),
        rpa: mockRpa(),
      },
    });
  });

  it('executes session.status via gateway_local driver', async () => {
    const result = await gateway.execute({
      operation: 'session.status',
      input: {},
    });
    expect(result.status).toBe('succeeded');
  });

  it('executes execution.stop via gateway_local driver', async () => {
    const result = await gateway.execute({
      operation: 'execution.stop',
      input: {},
    });
    expect(result.status).toBe('succeeded');
  });
});

// ── Health ──

describe('Gateway integration — health', () => {
  it('reports healthy when all drivers are healthy', async () => {
    const gateway = await createGateway(BASE_CONFIG, {
      skipInit: true,
      drivers: {
        legacy_cli: mockLegacyCli(),
        rpa: mockRpa(),
      },
    });
    const h = await gateway.health();
    expect(h).toHaveProperty('legacy_cli');
    expect(h).toHaveProperty('rpa');
    expect(h.legacy_cli).toHaveProperty('healthy');
    expect(h.rpa).toHaveProperty('healthy');
  });

  it('reports degraded driver state', async () => {
    const unhealthyRpa = createRpaDriver({
      config: BASE_CONFIG.boss.rpa,
      pipeClient: createMockPipeClient('unavailable'),
    });
    const gateway = await createGateway(BASE_CONFIG, {
      skipInit: true,
      drivers: {
        legacy_cli: mockLegacyCli(),
        rpa: unhealthyRpa,
      },
    });
    const h = await gateway.health();
    // unavailable RPA will show unhealthy
    expect(h.rpa.healthy).toBe(false);
  });
});
