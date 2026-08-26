import { describe, it, expect } from 'vitest';
import { createRpaDriver } from '../../src/drivers/rpa/index.js';
import { createMockPipeClient } from '../../src/drivers/rpa/named-pipe-client.js';
import type { DriverExecuteInput } from '../../src/drivers/driver.js';
import { toGatewayCommand } from '../../src/contracts/command.js';
import { RpaConfigSchema } from '../../src/gateway/config.js';

// ── Test helpers ──

function makeConfig(adapter: 'named-pipe' | 'mock' = 'mock') {
  return RpaConfigSchema.parse({ adapter, endpoint: 'test-pipe', default_timeout_ms: 5000, allow_mock_writes: true });
}

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
      jobRef: 'product-manager',
      displayedName: '张**',
      currentCompany: '合成科技',
      currentTitle: '高级产品经理',
      listContextHash: 'sha256:abc',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    payload: {
      messageFile: 'runtime/payloads/act_test_1.txt',
      messageHash: 'sha256:def',
      templateId: 'initial-contact-v1',
    },
    approval: {
      required: true,
      status: 'approved' as const,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      assurance: 'conversation' as const,
      scope: 'single_action' as const,
    },
    idempotencyKey: 'boss:message.commit:cand_1:pm:sha256:def',
    createdAt: new Date().toISOString(),
    status: 'approved' as const,
    ...overrides,
  };
}

function makeExecInput(
  operation: string,
  opts?: { actionPlan?: ReturnType<typeof makeActionPlan>; timeoutMs?: number },
): DriverExecuteInput {
  return {
    command: toGatewayCommand({
      operation,
      input: {},
      requestId: `req_${operation.replace(/\./g, '_')}`,
    }),
    actionPlan: opts?.actionPlan,
    timeoutMs: opts?.timeoutMs ?? 30000,
  };
}

// ── Tests ──

describe('RpaDriver', () => {
  // ── Factory ──

  it('creates an RPA driver with mock adapter', () => {
    const config = makeConfig('mock');
    const driver = createRpaDriver({ config });
    expect(driver.name).toBe('rpa');
  });

  it('creates an RPA driver with named-pipe adapter', () => {
    const config = makeConfig('named-pipe');
    const driver = createRpaDriver({ config });
    expect(driver.name).toBe('rpa');
  });

  it('accepts an injected pipe client', () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });
    expect(driver.name).toBe('rpa');
  });

  // ── Health Check ──

  it('reports healthy when mock pipe is available', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const health = await driver.health();
    expect(health.healthy).toBe(true);
    expect(health.status).toBe('healthy');
  });

  it('reports unhealthy when mock pipe is unavailable', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('unavailable');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const health = await driver.health();
    expect(health.healthy).toBe(false);
    expect(health.status).toBe('unavailable');
  });

  // ── Unsupported Operations ──

  it('fails for operations without RPA flow mapping', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const result = await driver.execute(makeExecInput('candidates.listUnread'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LEGACY_OPERATION_UNSUPPORTED');
    expect(result.error?.message).toContain('不支持 RPA 执行');
  });

  it('fails for session.login (not RPA-mapped)', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const result = await driver.execute(makeExecInput('session.login'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LEGACY_OPERATION_UNSUPPORTED');
  });

  // ── message.commit (primary RPA write path) ──

  it('executes message.commit successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan();
    const result = await driver.execute(makeExecInput('message.commit', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('rpa');
    expect(result.data).toBeDefined();
  });

  it('executes message.commit with failure scenario', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('failure');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan();
    const result = await driver.execute(makeExecInput('message.commit', { actionPlan: plan }));

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INTERNAL_ERROR');
    expect(result.error?.message).toContain('Mock flow failed');
  });

  it('executes message.commit with result_unknown scenario', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('result_unknown');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan();
    const result = await driver.execute(makeExecInput('message.commit', { actionPlan: plan }));

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RESULT_UNKNOWN');
    expect(result.error?.message).toContain('无法确认');
  });

  it('executes message.commit with paused scenario (candidate ambiguous)', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('paused');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan();
    const result = await driver.execute(makeExecInput('message.commit', { actionPlan: plan }));

    expect(result.status).toBe('paused');
    expect(result.error?.code).toBe('CANDIDATE_AMBIGUOUS');
    expect(result.error?.message).toContain('不唯一');
  });

  it('executes message.commit with RPA unavailable scenario', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('unavailable');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan();
    const result = await driver.execute(makeExecInput('message.commit', { actionPlan: plan }));

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RPA_UNAVAILABLE');
  });

  // ── greeting.commit ──

  it('executes greeting.commit successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'greeting.commit' });
    const result = await driver.execute(makeExecInput('greeting.commit', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('rpa');
  });

  // ── conversation.read ──

  it('executes conversation.read successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'conversation.read' });
    const result = await driver.execute(makeExecInput('conversation.read', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('rpa');
  });

  // ── message.stage ──

  it('executes message.stage successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'message.stage' });
    const result = await driver.execute(makeExecInput('message.stage', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('rpa');
  });

  // ── Other RPA-mapped operations ──

  it('executes attachment.request successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'attachment.request' });
    const result = await driver.execute(makeExecInput('attachment.request', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
  });

  it('executes attachment.accept successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'attachment.accept' });
    const result = await driver.execute(makeExecInput('attachment.accept', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
  });

  it('executes remark.update successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'remark.update' });
    const result = await driver.execute(makeExecInput('remark.update', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
  });

  it('executes contact.exchange successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'contact.exchange' });
    const result = await driver.execute(makeExecInput('contact.exchange', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
  });

  it('executes conversation.open successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'conversation.open' });
    const result = await driver.execute(makeExecInput('conversation.open', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
  });

  // ── execution.verify ──

  it('executes execution.verify successfully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const plan = makeActionPlan({ operation: 'execution.verify' });
    const result = await driver.execute(makeExecInput('execution.verify', { actionPlan: plan }));

    expect(result.status).toBe('succeeded');
  });

  // ── Error Handling ──

  it('throws on unsupported operation', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    const result = await driver.execute(makeExecInput('candidates.search'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LEGACY_OPERATION_UNSUPPORTED');
  });

  // ── Stop ──

  it('stop sends a stop command to the runner', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    // Stop should not throw
    await expect(driver.stop()).resolves.toBeUndefined();
  });

  // ── No ActionPlan ──

  it('handles execute without actionPlan gracefully', async () => {
    const config = makeConfig('mock');
    const mockPipe = createMockPipeClient('success');
    const driver = createRpaDriver({ config, pipeClient: mockPipe });

    // conversation.read can work without actionPlan if command.input has data
    const input: DriverExecuteInput = {
      command: toGatewayCommand({
        operation: 'conversation.read',
        input: { displayedName: '张**' },
        requestId: 'req_no_plan',
      }),
      timeoutMs: 30000,
    };

    const result = await driver.execute(input);
    expect(result.status).toBe('succeeded');
  });
});
