import { describe, it, expect, vi } from 'vitest';
import {
  validateApproval,
  checkApprovalBinding,
  toApprovalRecord,
  type ApprovalRecord,
} from '../../src/gateway/approval-service.js';
import type { ActionPlan, ActionPlanApproval } from '../../src/contracts/action-plan.js';
import { isApprovalValid } from '../../src/contracts/action-plan.js';

// ── Helpers ──

function makeApproval(overrides: Partial<ActionPlanApproval> = {}): ActionPlanApproval {
  return {
    required: true,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    assurance: 'conversation',
    scope: 'single_action',
    ...overrides,
  };
}

function makePlan(overrides: Partial<ActionPlan> & { approvalOverrides?: Partial<ActionPlanApproval> } = {}): ActionPlan {
  const { approvalOverrides, ...rest } = overrides;
  return {
    schemaVersion: '1.0',
    actionId: 'action-001',
    workspaceId: 'ws-001',
    operation: 'message.commit',
    platform: 'boss',
    candidateKey: 'candidate-abc',
    candidateLocator: {
      platform: 'boss',
      source: 'search_results',
      jobRef: 'job-backend-eng',
      displayedName: '张*三',
      listContextHash: 'hash-123',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    payload: {
      messageFile: 'payloads/msg-001.json',
      messageHash: 'abc123def',
    },
    approval: makeApproval(approvalOverrides),
    idempotencyKey: 'boss:message.commit:candidate-abc:job-backend-eng:abc123def',
    createdAt: new Date().toISOString(),
    status: 'approved',
    ...rest,
  } as ActionPlan;
}

// ── validateApproval ──

describe('validateApproval', () => {
  it('returns valid when approval is not required', () => {
    const plan = makePlan({
      approvalOverrides: { required: false, status: 'pending' },
    });
    const result = validateApproval(plan);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when status is denied', () => {
    const plan = makePlan({ approvalOverrides: { status: 'denied' } });
    const result = validateApproval(plan);
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('拒绝');
  });

  it('returns invalid when status is expired', () => {
    const plan = makePlan({ approvalOverrides: { status: 'expired' } });
    const result = validateApproval(plan);
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('过期');
  });

  it('returns invalid for unknown status', () => {
    const plan = makePlan({ approvalOverrides: { status: 'pending' as any } });
    const result = validateApproval(plan);
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('异常');
  });

  it('returns valid when approved and not expired', () => {
    const plan = makePlan({
      approvalOverrides: {
        status: 'approved',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    const result = validateApproval(plan);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when approved but expiresAt is in the past', () => {
    const plan = makePlan({
      approvalOverrides: {
        status: 'approved',
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
      },
    });
    const result = validateApproval(plan);
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('过期');
  });

  it('returns valid when approved with no expiresAt', () => {
    const plan = makePlan({
      approvalOverrides: { status: 'approved', expiresAt: undefined },
    });
    const result = validateApproval(plan);
    expect(result.valid).toBe(true);
  });
});

// ── checkApprovalBinding ──

describe('checkApprovalBinding', () => {
  const validParams = {
    operation: 'message.commit',
    candidateKey: 'candidate-abc',
    jobRef: 'job-backend-eng',
    payloadHash: 'abc123def',
  };

  it('returns valid when all params match', () => {
    const plan = makePlan();
    const result = checkApprovalBinding(plan, validParams);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when operation differs', () => {
    const plan = makePlan();
    const result = checkApprovalBinding(plan, {
      ...validParams,
      operation: 'greeting.commit',
    });
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('operation');
  });

  it('returns invalid when candidateKey differs', () => {
    const plan = makePlan();
    const result = checkApprovalBinding(plan, {
      ...validParams,
      candidateKey: 'candidate-xyz',
    });
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('candidateKey');
  });

  it('returns invalid when jobRef differs', () => {
    const plan = makePlan();
    const result = checkApprovalBinding(plan, {
      ...validParams,
      jobRef: 'job-frontend',
    });
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('jobRef');
  });

  it('returns invalid when payloadHash differs', () => {
    const plan = makePlan();
    const result = checkApprovalBinding(plan, {
      ...validParams,
      payloadHash: 'different-hash',
    });
    expect(result.valid).toBe(false);
    expect((result as any).reason).toContain('payload');
  });
});

// ── toApprovalRecord ──

describe('toApprovalRecord', () => {
  it('converts approved plan to record with approved status', () => {
    const plan = makePlan({
      approvalOverrides: { status: 'approved', approvedAt: '2024-01-15T10:00:00Z' },
    });
    const record = toApprovalRecord(plan);
    expect(record.actionId).toBe('action-001');
    expect(record.operation).toBe('message.commit');
    expect(record.candidateKey).toBe('candidate-abc');
    expect(record.jobRef).toBe('job-backend-eng');
    expect(record.payloadHash).toBe('abc123def');
    expect(record.status).toBe('approved');
    expect(record.assurance).toBe('conversation');
    expect(record.approvedAt).toBe('2024-01-15T10:00:00Z');
    expect(record.scope).toBe('single_action');
  });

  it('converts denied plan to record with denied status', () => {
    const plan = makePlan({ approvalOverrides: { status: 'denied' } });
    const record = toApprovalRecord(plan);
    expect(record.status).toBe('denied');
  });

  it('converts expired/pending plan to record with expired status', () => {
    const plan = makePlan({ approvalOverrides: { status: 'pending' as any } });
    const record = toApprovalRecord(plan);
    expect(record.status).toBe('expired');
  });

  it('falls back to default expiresAt (30min) when not provided', () => {
    const now = Date.now();
    const plan = makePlan({ approvalOverrides: { expiresAt: undefined } });
    const record = toApprovalRecord(plan);
    const expiresMs = new Date(record.expiresAt).getTime();
    // Should be approximately 30 minutes from now
    expect(expiresMs).toBeGreaterThan(now);
    expect(expiresMs).toBeLessThan(now + 31 * 60 * 1000);
  });
});
