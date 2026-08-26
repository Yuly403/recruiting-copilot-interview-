import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionPlan } from '../../src/contracts/action-plan.js';
import { claimRunnerExecutionTicket, issueRunnerExecutionTicket, verifyRunnerExecutionTicket } from '../../src/runtime/runner-ticket.js';

const plan: ActionPlan = {
  schemaVersion: '1.0',
  actionId: 'ticket-action-001',
  workspaceId: 'sha256:workspace',
  operation: 'message.commit',
  platform: 'boss',
  candidateKey: 'candidate-001',
  candidateLocator: {
    platform: 'boss', source: 'recommended_feed', jobRef: 'ai-product-manager', displayedName: '合成候选人甲',
    listContextHash: 'sha256:context', capturedAt: '2026-08-26T00:00:00.000Z', expiresAt: '2099-08-26T00:30:00.000Z',
  },
  payload: { messageFile: 'message.txt', messageHash: 'sha256:payload' },
  approval: { required: true, status: 'approved', assurance: 'interactive', scope: 'single_action', expiresAt: '2099-08-26T00:30:00.000Z' },
  idempotencyKey: 'boss:message.commit:candidate-001:ai-product-manager:sha256:payload',
  createdAt: '2026-08-26T00:00:00.000Z',
  status: 'approved',
};

describe('Runner execution ticket', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

  it('binds a local Runner request to one approved plan, request, payload, and deadline', async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-ticket-'));
    roots.push(runtimeRoot);
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = await issueRunnerExecutionTicket({ runtimeRoot, plan, requestId: 'req-001', deadlineAt });

    await expect(verifyRunnerExecutionTicket({
      runtimeRoot, ticket, requestId: 'req-001', operation: 'message.commit', actionId: plan.actionId,
      candidateKey: plan.candidateKey, payloadHash: plan.payload.messageHash, deadlineAt,
    })).resolves.toEqual({ valid: true });

    await expect(verifyRunnerExecutionTicket({
      runtimeRoot, ticket, requestId: 'req-other', operation: 'message.commit', actionId: plan.actionId,
      candidateKey: plan.candidateKey, payloadHash: plan.payload.messageHash, deadlineAt,
    })).resolves.toMatchObject({ valid: false });
  });

  it('persists a claim so a Runner restart cannot replay the same write ticket', async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-ticket-'));
    roots.push(runtimeRoot);
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = await issueRunnerExecutionTicket({ runtimeRoot, plan, requestId: 'req-001', deadlineAt });
    const params = {
      runtimeRoot, ticket, requestId: 'req-001', operation: 'message.commit', actionId: plan.actionId,
      candidateKey: plan.candidateKey, payloadHash: plan.payload.messageHash, deadlineAt,
    };

    await expect(claimRunnerExecutionTicket(params)).resolves.toEqual({ valid: true });
    await expect(claimRunnerExecutionTicket(params)).resolves.toEqual({ valid: false, reason: 'Runner 执行票据已被使用，拒绝重复外发' });
  });
});
