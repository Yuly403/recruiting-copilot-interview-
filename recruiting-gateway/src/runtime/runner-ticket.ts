import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionPlan } from '../contracts/action-plan.js';

export interface RunnerExecutionTicket {
  schemaVersion: '1.0';
  actionId: string;
  requestId: string;
  operation: string;
  candidateKey: string;
  payloadHash: string;
  deadlineAt: string;
  issuedAt: string;
  signature: string;
}

function stableJson(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function keyPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, '.rpa-runner-ticket-key');
}

function claimPath(runtimeRoot: string, signature: string): string {
  const claimId = crypto.createHash('sha256').update(signature, 'utf-8').digest('hex');
  return path.join(runtimeRoot, '.rpa-runner-ticket-claims', claimId);
}

async function loadOrCreateKey(runtimeRoot: string): Promise<Buffer> {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const filePath = keyPath(runtimeRoot);
  try {
    return Buffer.from((await fs.readFile(filePath, 'utf-8')).trim(), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    try {
      await fs.writeFile(filePath, key.toString('hex'), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      return key;
    } catch {
      return Buffer.from((await fs.readFile(filePath, 'utf-8')).trim(), 'hex');
    }
  }
}

function unsigned(ticket: Omit<RunnerExecutionTicket, 'signature'>): string {
  return stableJson(ticket);
}

async function sign(runtimeRoot: string, ticket: Omit<RunnerExecutionTicket, 'signature'>): Promise<string> {
  return crypto.createHmac('sha256', await loadOrCreateKey(runtimeRoot)).update(unsigned(ticket), 'utf-8').digest('hex');
}

export async function issueRunnerExecutionTicket(params: {
  runtimeRoot: string;
  plan: ActionPlan;
  requestId: string;
  deadlineAt: string;
}): Promise<RunnerExecutionTicket> {
  const unsignedTicket: Omit<RunnerExecutionTicket, 'signature'> = {
    schemaVersion: '1.0',
    actionId: params.plan.actionId,
    requestId: params.requestId,
    operation: params.plan.operation,
    candidateKey: params.plan.candidateKey,
    payloadHash: params.plan.payload.messageHash,
    deadlineAt: params.deadlineAt,
    issuedAt: new Date().toISOString(),
  };
  return { ...unsignedTicket, signature: await sign(params.runtimeRoot, unsignedTicket) };
}

export async function verifyRunnerExecutionTicket(params: {
  runtimeRoot: string;
  ticket: unknown;
  requestId: string;
  operation: string;
  actionId: string;
  candidateKey: string;
  payloadHash: string;
  deadlineAt: string;
}): Promise<{ valid: true } | { valid: false; reason: string }> {
  const ticket = params.ticket as Partial<RunnerExecutionTicket> | null;
  if (!ticket || typeof ticket !== 'object' || typeof ticket.signature !== 'string') {
    return { valid: false, reason: '缺少 Runner 执行票据' };
  }
  const { signature, ...base } = ticket as RunnerExecutionTicket;
  if (
    base.schemaVersion !== '1.0'
    || base.requestId !== params.requestId
    || base.operation !== params.operation
    || base.actionId !== params.actionId
    || base.candidateKey !== params.candidateKey
    || base.payloadHash !== params.payloadHash
    || base.deadlineAt !== params.deadlineAt
    || !base.issuedAt
  ) {
    return { valid: false, reason: 'Runner 执行票据与当前任务不匹配' };
  }
  const deadlineMs = Date.parse(base.deadlineAt);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) return { valid: false, reason: 'Runner 执行票据已过期' };
  let expected: string;
  try {
    expected = await sign(params.runtimeRoot, base);
  } catch {
    return { valid: false, reason: '无法验证 Runner 执行票据' };
  }
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(signature, 'hex');
  if (expectedBytes.length !== actualBytes.length || !crypto.timingSafeEqual(expectedBytes, actualBytes)) {
    return { valid: false, reason: 'Runner 执行票据签名无效' };
  }
  return { valid: true };
}

/**
 * Atomically consume a verified ticket. The marker is intentionally persisted
 * under the shared runtime root so restarting the local Runner cannot turn a
 * short-lived write ticket into a replayable command.
 */
export async function claimRunnerExecutionTicket(params: {
  runtimeRoot: string;
  ticket: unknown;
  requestId: string;
  operation: string;
  actionId: string;
  candidateKey: string;
  payloadHash: string;
  deadlineAt: string;
}): Promise<{ valid: true } | { valid: false; reason: string }> {
  const verified = await verifyRunnerExecutionTicket(params);
  if (!verified.valid) return verified;

  const ticket = params.ticket as RunnerExecutionTicket;
  const target = claimPath(params.runtimeRoot, ticket.signature);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const handle = await fs.open(target, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ actionId: ticket.actionId, requestId: ticket.requestId, deadlineAt: ticket.deadlineAt }));
    await handle.close();
    return { valid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { valid: false, reason: 'Runner 执行票据已被使用，拒绝重复外发' };
    }
    return { valid: false, reason: '无法领取 Runner 执行票据' };
  }
}
