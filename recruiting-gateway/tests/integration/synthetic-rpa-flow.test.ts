import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionPlan } from '../../src/contracts/action-plan.js';
import type { Driver } from '../../src/drivers/driver.js';
import {
  RPA_SCHEMA_VERSION,
  type RpaRequest,
  type RpaResponse,
} from '../../src/drivers/rpa/named-pipe-client.js';
import type { GatewayConfig } from '../../src/gateway/config.js';
import { createGateway, type GatewayInstance } from '../../src/gateway/index.js';

interface SyntheticRunner {
  endpoint: string;
  requests: RpaRequest[];
  close(): Promise<void>;
}

function pipePath(endpoint: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${endpoint}`
    : `/tmp/${endpoint}.sock`;
}

async function startSyntheticRunner(
  status: RpaResponse['status'],
): Promise<SyntheticRunner> {
  const endpoint = `recruiting-copilot-synthetic-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const address = pipePath(endpoint);
  const requests: RpaRequest[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;

      const request = JSON.parse(buffer.slice(0, newline)) as RpaRequest;
      requests.push(request);
      const response: RpaResponse = {
        schemaVersion: RPA_SCHEMA_VERSION,
        requestId: request.requestId,
        status,
        observations: {
          runner: 'synthetic-local-ipc',
          candidateVerified: true,
          messageStaged: true,
          commitObserved: status === 'succeeded',
        },
        ...(status === 'result_unknown'
          ? { error: { code: 'RESULT_UNKNOWN', message: 'Synthetic runner could not confirm commit' } }
          : {}),
      };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });

  return {
    endpoint,
    requests,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') await fs.rm(address, { force: true });
    },
  };
}

function healthyLegacyDriver(): Driver {
  return {
    name: 'legacy_cli',
    async health() {
      return { healthy: true, status: 'available' };
    },
    async execute(input) {
      throw new Error(`Synthetic test did not expect legacy execution: ${input.command.operation}`);
    },
    async stop() {},
  };
}

describe('synthetic RPA flow over operating-system IPC', () => {
  let workspaceRoot: string;
  let runner: SyntheticRunner | null;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recruiting-synthetic-ipc-'));
    runner = null;
  });

  afterEach(async () => {
    if (runner) await runner.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function prepare(status: RpaResponse['status']): Promise<{
    gateway: GatewayInstance;
    plan: ActionPlan;
    planPath: string;
    payloadPath: string;
  }> {
    runner = await startSyntheticRunner(status);
    const config: GatewayConfig = {
      version: '1',
      workspace_root: workspaceRoot,
      runtime_dir: 'runtime',
      boss: {
        legacy_cli: {
          executable: 'unused-in-synthetic-test',
          default_timeout_ms: 1000,
          max_stdout_bytes: 2_097_152,
          max_stderr_bytes: 262_144,
        },
        rpa: {
          adapter: 'named-pipe',
          allow_mock_writes: false,
          endpoint: runner.endpoint,
          default_timeout_ms: 2000,
        },
        locking: { lease_seconds: 30 },
        approvals: { default_ttl_minutes: 30 },
        circuit_breaker: {
          identity_failures: 2,
          unknown_write_results: 1,
          verification_page_immediate_open: true,
        },
      },
      logging: {
        level: 'debug',
        redact_payloads: true,
        persist_screenshots: false,
      },
    };
    const gateway = await createGateway(config, {
      drivers: { legacy_cli: healthyLegacyDriver() },
    });

    const message = '你好，这是一条仅用于本地合成验收的沟通草稿。';
    const payloadPath = path.join(workspaceRoot, 'synthetic-message.txt');
    const payloadHash = `sha256:${crypto.createHash('sha256').update(message).digest('hex')}`;
    await fs.writeFile(payloadPath, message, 'utf-8');

    const now = new Date();
    const plan: ActionPlan = {
      schemaVersion: '1.0',
      actionId: `synthetic-${status}`,
      workspaceId: `sha256:${crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex')}`,
      operation: 'message.commit',
      platform: 'boss',
      candidateKey: 'synthetic-candidate-001',
      candidateLocator: {
        platform: 'boss',
        source: 'search_results',
        jobRef: 'synthetic-ai-product-manager',
        displayedName: '合成候选人甲',
        currentCompany: '示例科技',
        currentTitle: 'AI 产品经理',
        listContextHash: 'synthetic-list-context-v1',
        capturedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      },
      payload: {
        messageFile: path.basename(payloadPath),
        messageHash: payloadHash,
        templateId: 'synthetic-uat-v1',
      },
      approval: {
        required: true,
        status: 'approved',
        approvedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 20 * 60_000).toISOString(),
        assurance: 'interactive',
        scope: 'single_action',
      },
      idempotencyKey: `boss:message.commit:synthetic-candidate-001:synthetic-ai-product-manager:${payloadHash}`,
      createdAt: now.toISOString(),
      status: 'approved',
    };
    const planPath = path.join(workspaceRoot, `${plan.actionId}.json`);
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
    await gateway.ctx.actionStore.createPending(plan);
    // Test-only authority: production approval remains restricted to the interactive TTY CLI.
    await gateway.ctx.approvalStore.issue(plan, 30);

    return { gateway, plan, planPath, payloadPath };
  }

  it('executes an approved synthetic write and persists success', async () => {
    const { gateway, plan, planPath, payloadPath } = await prepare('succeeded');
    const result = await gateway.execute({
      requestId: 'synthetic-success-request',
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
    });

    expect(result.status).toBe('succeeded');
    expect(runner?.requests).toHaveLength(1);
    expect(runner?.requests[0]).toMatchObject({
      schemaVersion: RPA_SCHEMA_VERSION,
      requestId: 'synthetic-success-request',
      flow: 'boss.commit_message',
      payload: {
        executionTicket: expect.objectContaining({
          actionId: plan.actionId,
          requestId: 'synthetic-success-request',
          payloadHash: plan.payload.messageHash,
        }),
        messageFile: payloadPath,
        messageHash: plan.payload.messageHash,
        templateId: 'synthetic-uat-v1',
      },
    });
    expect((await gateway.ctx.actionStore.read(plan.actionId))?.status).toBe('succeeded');

    const auditFiles = await fs.readdir(gateway.ctx.runtimePaths.audit);
    const audit = await fs.readFile(path.join(gateway.ctx.runtimePaths.audit, auditFiles[0]), 'utf-8');
    expect(audit).toContain('"event":"action.started"');
    expect(audit).toContain('"event":"action.succeeded"');
    expect(audit).not.toContain(messageFromFileLeakMarker(payloadPath));
  });

  it('does not retry an uncertain commit and persists result_unknown', async () => {
    const { gateway, plan, planPath, payloadPath } = await prepare('result_unknown');
    const result = await gateway.execute({
      requestId: 'synthetic-unknown-request',
      operation: 'message.commit',
      input: { plan: planPath, payloadFile: payloadPath },
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('RESULT_UNKNOWN');
    expect(runner?.requests).toHaveLength(1);
    expect((await gateway.ctx.actionStore.read(plan.actionId))?.status).toBe('result_unknown');
  });
});

function messageFromFileLeakMarker(payloadPath: string): string {
  // The audit may contain the approved hash/path metadata, but never the message body.
  void payloadPath;
  return '你好，这是一条仅用于本地合成验收的沟通草稿。';
}
