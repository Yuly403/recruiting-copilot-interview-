import { describe, it, expect } from 'vitest';
import {
  GatewayCommandSchema,
  GatewayCommandInputSchema,
  toGatewayCommand,
  getOperationType,
} from '../../src/contracts/command.js';
import { OperationSchema } from '../../src/contracts/enums.js';
import {
  GatewayResultSchema,
  successResult,
  deniedResult,
  pausedResult,
  failedResult,
} from '../../src/contracts/result.js';
import {
  ActionPlanSchema,
  CandidateLocatorSchema,
  buildIdempotencyKey,
  isApprovalValid,
  isLocatorValid,
} from '../../src/contracts/action-plan.js';

// ── Operation validation ──
describe('OperationSchema', () => {
  it('accepts all 22 known operations', () => {
    const ops = OperationSchema.options;
    expect(ops).toContain('session.login');
    expect(ops).toContain('candidates.listUnread');
    expect(ops).toContain('message.commit');
    expect(ops).toContain('greeting.commit');
    expect(ops).toContain('candidate.markNotFit');
    expect(ops).toContain('execution.verify');
    expect(ops).toContain('execution.stop');
    expect(ops.length).toBe(22);
  });

  it('rejects unknown operations', () => {
    expect(() => OperationSchema.parse('boss.send')).toThrow();
    expect(() => OperationSchema.parse('unknown.op')).toThrow();
  });
});

// ── GatewayCommand ──
describe('toGatewayCommand', () => {
  it('builds a valid command from raw input', () => {
    const cmd = toGatewayCommand({
      operation: 'candidates.listUnread',
      input: { unread: true },
      requestId: 'req_test_001',
    });
    expect(cmd.schemaVersion).toBe('1.0');
    expect(cmd.operation).toBe('candidates.listUnread');
    expect(cmd.platform).toBe('boss');
    expect(cmd.input.unread).toBe(true);
  });

  it('throws on unknown operation', () => {
    expect(() =>
      toGatewayCommand({ operation: 'boss.fire_missile', input: {} }),
    ).toThrow('Unknown operation');
  });

  it('auto-generates requestId if omitted', () => {
    const cmd = toGatewayCommand({ operation: 'jd.get', input: { name: '产品经理' } });
    expect(cmd.requestId).toMatch(/^req_/);
  });
});

// ── Operation type classification ──
describe('getOperationType', () => {
  it('classifies reads correctly', () => {
    expect(getOperationType('positions.list')).toBe('read');
    expect(getOperationType('candidates.listUnread')).toBe('read');
    expect(getOperationType('candidates.search')).toBe('read_navigation');
    expect(getOperationType('candidates.deepSearch')).toBe('read_navigation_limited');
    expect(getOperationType('candidate.preview')).toBe('read_limited');
    expect(getOperationType('conversation.open')).toBe('navigation');
    expect(getOperationType('conversation.read')).toBe('read');
  });

  it('classifies writes correctly', () => {
    expect(getOperationType('message.stage')).toBe('reversible_write');
    expect(getOperationType('message.commit')).toBe('irreversible_write');
    expect(getOperationType('greeting.commit')).toBe('irreversible_write');
    expect(getOperationType('candidate.markNotFit')).toBe('irreversible_write');
    expect(getOperationType('remark.update')).toBe('state_write');
  });

  it('classifies session and control', () => {
    expect(getOperationType('session.login')).toBe('session');
    expect(getOperationType('session.status')).toBe('local_read');
    expect(getOperationType('execution.verify')).toBe('read_verification');
    expect(getOperationType('execution.stop')).toBe('control');
  });

  it('throws on truly unknown ops', () => {
    expect(() => getOperationType('not.a.real.op')).toThrow();
  });
});

// ── GatewayResult builders ──
describe('GatewayResult', () => {
  const now = new Date().toISOString();

  it('builds success result', () => {
    const r = successResult({
      requestId: 'req_1',
      operation: 'candidates.list',
      driver: 'legacy_cli',
      data: { items: [] },
      startedAt: now,
      finishedAt: now,
    });
    expect(r.status).toBe('succeeded');
    expect(r.error).toBeNull();
  });

  it('builds denied result', () => {
    const r = deniedResult({
      requestId: 'req_2',
      operation: 'message.commit',
      reason: '审批未通过',
    });
    expect(r.status).toBe('denied');
    expect(r.error!.code).toBe('APPROVAL_MISSING');
  });

  it('builds paused result', () => {
    const r = pausedResult({
      requestId: 'req_3',
      operation: 'message.commit',
      driver: 'rpa',
      reason: '候选人身份歧义',
      code: 'CANDIDATE_AMBIGUOUS',
      details: { matched: ['displayedName'], missing: ['currentCompany'] },
    });
    expect(r.status).toBe('paused');
    expect(r.error!.code).toBe('CANDIDATE_AMBIGUOUS');
  });

  it('builds failed result', () => {
    const r = failedResult({
      requestId: 'req_4',
      operation: 'candidates.search',
      driver: 'legacy_cli',
      errorCode: 'LEGACY_TIMEOUT',
      message: 'CLI 超时',
    });
    expect(r.status).toBe('failed');
    expect(r.error!.code).toBe('LEGACY_TIMEOUT');
  });

  it('all results follow schema', () => {
    const results = [
      successResult({ requestId: 'r1', operation: 'jd.get', driver: 'legacy_cli', startedAt: now, finishedAt: now }),
      deniedResult({ requestId: 'r2', operation: 'message.commit', reason: 'nope' }),
      pausedResult({ requestId: 'r3', operation: 'contact.exchange', driver: 'rpa', reason: 'paused' }),
      failedResult({ requestId: 'r4', operation: 'positions.list', driver: 'legacy_cli', errorCode: 'LEGACY_OUTPUT_UNRECOGNIZED', message: 'bad output' }),
    ];
    for (const r of results) {
      expect(() => GatewayResultSchema.parse(r)).not.toThrow();
    }
  });
});

// ── ActionPlan ──
describe('ActionPlan', () => {
  const validPlan = {
    schemaVersion: '1.0' as const,
    actionId: 'act_test_001',
    workspaceId: 'ws_hash',
    operation: 'message.commit' as const,
    platform: 'boss' as const,
    candidateKey: 'cand_uuid_123',
    candidateLocator: {
      platform: 'boss' as const,
      source: 'inbound_chat' as const,
      jobRef: 'product-manager',
      displayedName: '张**',
      currentCompany: '合成科技',
      currentTitle: '高级产品经理',
      listContextHash: 'sha256:abc',
      capturedAt: '2026-07-22T09:00:00+08:00',
      expiresAt: '2026-07-22T09:30:00+08:00',
    },
    payload: {
      messageFile: 'runtime/execution/payloads/act_test_001.txt',
      messageHash: 'sha256:def',
      templateId: 'initial-contact-v1',
    },
    approval: {
      required: true,
      status: 'approved' as const,
      approvedAt: '2026-07-22T09:05:00+08:00',
      expiresAt: '2026-07-22T09:35:00+08:00',
      assurance: 'conversation' as const,
      scope: 'single_action' as const,
    },
    idempotencyKey: 'boss:message.commit:cand_uuid_123:product-manager:sha256:def',
    createdAt: '2026-07-22T09:04:00+08:00',
  };

  it('validates a complete ActionPlan', () => {
    expect(() => ActionPlanSchema.parse(validPlan)).not.toThrow();
  });

  it('defaults status to created', () => {
    const plan = ActionPlanSchema.parse(validPlan);
    expect(plan.status).toBe('created');
  });

  it('builds idempotency keys consistently', () => {
    const key = buildIdempotencyKey({
      operation: 'greeting.commit',
      candidateKey: 'cand_1',
      jobRef: 'pm',
      messageHash: 'sha256:abc',
    });
    expect(key).toBe('boss:greeting.commit:cand_1:pm:sha256:abc');
  });

  it('checks approval validity', () => {
    const validApproval = { ...validPlan.approval, status: 'approved' as const, expiresAt: '2099-01-01T00:00:00Z' };
    expect(isApprovalValid(validApproval)).toBe(true);

    const expiredApproval = { ...validPlan.approval, status: 'approved' as const, expiresAt: '2020-01-01T00:00:00Z' };
    expect(isApprovalValid(expiredApproval)).toBe(false);

    const deniedApproval = { ...validPlan.approval, status: 'denied' as const };
    expect(isApprovalValid(deniedApproval)).toBe(false);
  });
});

// ── CandidateLocator ──
describe('CandidateLocator', () => {
  it('validates a complete locator', () => {
    const locator = {
      platform: 'boss' as const,
      source: 'search_results' as const,
      jobRef: 'pm',
      displayedName: '候选人乙（虚构）',
      currentCompany: '云帆科技（虚构）',
      listContextHash: 'sha256:xyz',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    expect(() => CandidateLocatorSchema.parse(locator)).not.toThrow();
  });

  it('accepts locator with minimal fields', () => {
    const locator = {
      platform: 'boss' as const,
      source: 'inbound_chat' as const,
      jobRef: 'eng',
      displayedName: '王**',
      listContextHash: 'sha256:min',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    expect(() => CandidateLocatorSchema.parse(locator)).not.toThrow();
  });

  it('checks locator expiry', () => {
    const valid = {
      platform: 'boss' as const,
      source: 'inbound_chat' as const,
      jobRef: 'pm',
      displayedName: '赵**',
      listContextHash: 'sha256:v',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
    expect(isLocatorValid(valid)).toBe(true);

    const expired = { ...valid, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(isLocatorValid(expired)).toBe(false);
  });
});
