import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionPlan } from '../../src/contracts/action-plan.js';
import { toGatewayCommand } from '../../src/contracts/command.js';
import { validateActionPlanIntegrity } from '../../src/gateway/approval-service.js';
import { GatewayConfigSchema } from '../../src/gateway/config.js';
import { createApprovalStore } from '../../src/runtime/approval-store.js';
import { ensureRuntimeDirs, resolveRuntimePaths } from '../../src/runtime/paths.js';

describe('approval integrity boundary', () => {
  let workspace: string;
  let payloadPath: string;
  let plan: ActionPlan;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-integrity-'));
    payloadPath = path.join(workspace, 'message.txt');
    const payload = '你好，这是一条测试消息。';
    await fs.writeFile(payloadPath, payload, 'utf-8');
    const hash = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const now = new Date();
    plan = {
      schemaVersion: '1.0',
      actionId: 'action-integrity-1',
      workspaceId: `sha256:${crypto.createHash('sha256').update(path.resolve(workspace)).digest('hex')}`,
      operation: 'message.commit',
      platform: 'boss',
      candidateKey: 'candidate-1',
      candidateLocator: {
        platform: 'boss',
        source: 'inbound_chat',
        jobRef: 'job-1',
        displayedName: '候选人甲（虚构）',
        listContextHash: 'list-hash',
        capturedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      },
      payload: { messageFile: payloadPath, messageHash: hash },
      approval: {
        required: true,
        status: 'approved',
        approvedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 20 * 60_000).toISOString(),
        assurance: 'interactive',
        scope: 'single_action',
      },
      idempotencyKey: `boss:message.commit:candidate-1:job-1:${hash}`,
      createdAt: now.toISOString(),
      status: 'approved',
    };
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function command(payloadFile = payloadPath) {
    return toGatewayCommand({
      operation: 'message.commit',
      input: { plan: 'plan.json', payloadFile, name: '候选人甲（虚构）', jobRef: 'job-1' },
    });
  }

  it('accepts only the payload bytes bound to the plan', async () => {
    const result = await validateActionPlanIntegrity({ plan, command: command(), workspaceRoot: workspace });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload changed after approval', async () => {
    await fs.writeFile(payloadPath, '被替换的内容', 'utf-8');
    const result = await validateActionPlanIntegrity({ plan, command: command(), workspaceRoot: workspace });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('PAYLOAD_HASH_MISMATCH');
  });

  it('rejects payload paths outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    await fs.writeFile(outside, 'outside', 'utf-8');
    try {
      const result = await validateActionPlanIntegrity({ plan, command: command(outside), workspaceRoot: workspace });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.code).toBe('INVALID_COMMAND');
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('rejects a plan copied from a different workspace', async () => {
    const copied = { ...plan, workspaceId: 'sha256:not-this-workspace' };
    const result = await validateActionPlanIntegrity({ plan: copied, command: command(), workspaceRoot: workspace });
    expect(result.valid).toBe(false);
  });

  it('creates a signed record and rejects later plan mutation', async () => {
    const config = GatewayConfigSchema.parse({ version: '1', workspace_root: workspace, runtime_dir: 'runtime' });
    const paths = await resolveRuntimePaths(config);
    await ensureRuntimeDirs(paths);
    const store = createApprovalStore(paths);
    await store.issue(plan, 30);
    expect((await store.validate(plan)).valid).toBe(true);

    const changed = { ...plan, candidateKey: 'candidate-2' };
    const result = await store.validate(changed);
    expect(result.valid).toBe(false);
  });

  it('fails closed when no independent approval record exists', async () => {
    const config = GatewayConfigSchema.parse({ version: '1', workspace_root: workspace, runtime_dir: 'runtime' });
    const paths = await resolveRuntimePaths(config);
    await ensureRuntimeDirs(paths);
    const result = await createApprovalStore(paths).validate(plan);
    expect(result.valid).toBe(false);
  });

  it('refuses to sign a conversation-only or self-declared approval', async () => {
    const config = GatewayConfigSchema.parse({ version: '1', workspace_root: workspace, runtime_dir: 'runtime' });
    const paths = await resolveRuntimePaths(config);
    await ensureRuntimeDirs(paths);
    const unconfirmed = {
      ...plan,
      approval: { ...plan.approval, assurance: 'conversation' as const },
    };
    await expect(createApprovalStore(paths).issue(unconfirmed, 30)).rejects.toThrow('交互确认');
  });
});
