import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionPlan } from '../contracts/action-plan.js';
import type { RuntimePaths } from './paths.js';

export interface StoredApproval {
  schemaVersion: '1.0';
  actionId: string;
  operation: string;
  candidateKey: string;
  jobRef: string;
  payloadHash: string;
  planDigest: string;
  issuedAt: string;
  expiresAt: string;
  assurance: 'interactive';
  signature: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestActionPlan(plan: ActionPlan): string {
  return `sha256:${crypto.createHash('sha256').update(stableJson(plan), 'utf-8').digest('hex')}`;
}

function unsignedRecord(record: Omit<StoredApproval, 'signature'>): string {
  return stableJson(record);
}

export function createApprovalStore(paths: RuntimePaths) {
  const keyPath = path.join(paths.approvals, '.approval-key');

  async function loadOrCreateKey(): Promise<Buffer> {
    await fs.mkdir(paths.approvals, { recursive: true });
    try {
      return Buffer.from((await fs.readFile(keyPath, 'utf-8')).trim(), 'hex');
    } catch {
      const key = crypto.randomBytes(32);
      try {
        await fs.writeFile(keyPath, key.toString('hex'), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        return key;
      } catch {
        return Buffer.from((await fs.readFile(keyPath, 'utf-8')).trim(), 'hex');
      }
    }
  }

  async function sign(record: Omit<StoredApproval, 'signature'>): Promise<string> {
    const key = await loadOrCreateKey();
    return crypto.createHmac('sha256', key).update(unsignedRecord(record), 'utf-8').digest('hex');
  }

  function approvalPath(actionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(actionId)) {
      throw new Error(`非法 actionId: ${actionId}`);
    }
    return path.join(paths.approvals, `${actionId}.json`);
  }

  return {
    async issue(plan: ActionPlan, ttlMinutes: number): Promise<StoredApproval> {
      const issuedAt = new Date();
      if (
        !plan.approval.required ||
        plan.approval.status !== 'approved' ||
        plan.approval.assurance !== 'interactive' ||
        plan.approval.scope !== 'single_action'
      ) {
        throw new Error('只有经过单次交互确认的 approved ActionPlan 才能签发审批记录');
      }
      if (new Date(plan.candidateLocator.expiresAt).getTime() <= issuedAt.getTime()) {
        throw new Error('候选人定位器已过期，不能签发审批记录');
      }
      const planExpiry = plan.approval.expiresAt ? new Date(plan.approval.expiresAt).getTime() : Number.POSITIVE_INFINITY;
      if (planExpiry <= issuedAt.getTime()) {
        throw new Error('ActionPlan 审批已过期，不能签发审批记录');
      }
      const configuredExpiry = issuedAt.getTime() + ttlMinutes * 60_000;
      const expiresAt = new Date(Math.min(planExpiry, configuredExpiry)).toISOString();
      const base: Omit<StoredApproval, 'signature'> = {
        schemaVersion: '1.0',
        actionId: plan.actionId,
        operation: plan.operation,
        candidateKey: plan.candidateKey,
        jobRef: plan.candidateLocator.jobRef,
        payloadHash: plan.payload.messageHash,
        planDigest: digestActionPlan(plan),
        issuedAt: issuedAt.toISOString(),
        expiresAt,
        assurance: 'interactive',
      };
      const record: StoredApproval = { ...base, signature: await sign(base) };
      const filePath = approvalPath(plan.actionId);
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tempPath, filePath);
      return record;
    },

    async validate(plan: ActionPlan): Promise<{ valid: true } | { valid: false; reason: string }> {
      let record: StoredApproval;
      try {
        record = JSON.parse(await fs.readFile(approvalPath(plan.actionId), 'utf-8')) as StoredApproval;
      } catch {
        return { valid: false, reason: '缺少独立的交互式审批记录，请先运行 recruitctl approve' };
      }

      const { signature, ...base } = record;
      const expectedSignature = await sign(base);
      const actual = Buffer.from(signature || '', 'hex');
      const expected = Buffer.from(expectedSignature, 'hex');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return { valid: false, reason: '审批记录签名无效或已被修改' };
      }
      if (new Date(record.expiresAt).getTime() <= Date.now()) {
        return { valid: false, reason: '交互式审批已过期' };
      }
      if (
        record.actionId !== plan.actionId ||
        record.operation !== plan.operation ||
        record.candidateKey !== plan.candidateKey ||
        record.jobRef !== plan.candidateLocator.jobRef ||
        record.payloadHash !== plan.payload.messageHash ||
        record.planDigest !== digestActionPlan(plan)
      ) {
        return { valid: false, reason: '审批记录与当前 ActionPlan 不匹配' };
      }
      return { valid: true };
    },
  };
}
