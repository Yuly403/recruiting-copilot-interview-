import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildIdempotencyKey,
  isLocatorValid,
  type ActionPlan,
  type ActionPlanApproval,
} from '../contracts/action-plan.js';
import type { GatewayCommand } from '../contracts/command.js';
import type { ApprovalAssurance } from '../contracts/enums.js';
import { validatePath } from '../runtime/paths.js';

// ── Approval Service (per PRD §12) ──

export interface ApprovalRecord {
  actionId: string;
  operation: string;
  candidateKey: string;
  jobRef: string;
  payloadHash: string;
  status: 'approved' | 'denied' | 'expired';
  assurance: ApprovalAssurance;
  approvedAt?: string;
  expiresAt: string;
  scope: 'single_action' | 'explicit_batch';
}

/** Validate that an ActionPlan's approval is still effective */
export function validateApproval(plan: ActionPlan): { valid: true } | { valid: false; reason: string } {
  const { approval } = plan;

  if (!approval.required) {
    // This operation doesn't need approval
    return { valid: true };
  }

  if (approval.status === 'denied') {
    return { valid: false, reason: '审批已被拒绝' };
  }

  if (approval.status === 'expired') {
    return { valid: false, reason: '审批已过期' };
  }

  if (approval.status !== 'approved') {
    return { valid: false, reason: `审批状态异常: ${approval.status}` };
  }

  if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
    return { valid: false, reason: '审批已过期' };
  }

  return { valid: true };
}

/** Check if approval parameters match (per PRD §12.2) */
export function checkApprovalBinding(
  plan: ActionPlan,
  params: { operation: string; candidateKey: string; jobRef: string; payloadHash: string },
): { valid: true } | { valid: false; reason: string } {
  if (plan.operation !== params.operation) {
    return { valid: false, reason: 'operation 不匹配' };
  }
  if (plan.candidateKey !== params.candidateKey) {
    return { valid: false, reason: 'candidateKey 不匹配' };
  }
  if (plan.candidateLocator.jobRef !== params.jobRef) {
    return { valid: false, reason: 'jobRef 不匹配' };
  }
  if (plan.payload.messageHash !== params.payloadHash) {
    return { valid: false, reason: 'payload hash 不匹配' };
  }
  return { valid: true };
}

const OPERATIONS_REQUIRING_PAYLOAD_ARGUMENT = new Set([
  'message.stage',
  'message.commit',
  'greeting.commit',
  'attachment.request',
  'remark.update',
  'contact.exchange',
]);

function normalizedSha256(value: string): string {
  const raw = value.trim().toLowerCase();
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
}

async function fileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function resolveWorkspaceFile(workspaceRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspaceRoot, filePath);
}

export type PlanIntegrityResult =
  | { valid: true; payloadPath: string; payloadHash: string; payloadText: string }
  | { valid: false; reason: string; code: 'APPROVAL_DENIED' | 'PAYLOAD_HASH_MISMATCH' | 'INVALID_COMMAND' };

/**
 * Bind the actual command and payload bytes to the approved plan.
 * A JSON field that merely says "approved" is not enough: the operation, target, job,
 * locator lifetime, idempotency key and on-disk payload must all still be the same.
 */
export async function validateActionPlanIntegrity(params: {
  plan: ActionPlan;
  command: GatewayCommand;
  workspaceRoot: string;
}): Promise<PlanIntegrityResult> {
  const { plan, command } = params;
  const workspaceRoot = path.resolve(params.workspaceRoot);

  const expectedWorkspaceId = `sha256:${crypto.createHash('sha256').update(workspaceRoot).digest('hex')}`;
  if (plan.workspaceId !== expectedWorkspaceId) {
    return { valid: false, reason: 'ActionPlan 不属于当前工作区', code: 'APPROVAL_DENIED' };
  }

  if (plan.operation !== command.operation) {
    return { valid: false, reason: 'ActionPlan operation 与当前命令不匹配', code: 'APPROVAL_DENIED' };
  }
  if (!isLocatorValid(plan.candidateLocator)) {
    return { valid: false, reason: '候选人定位器已过期，必须重新读取当前列表并生成计划', code: 'APPROVAL_DENIED' };
  }

  const commandName = command.input.name?.trim();
  if (
    commandName &&
    commandName !== plan.candidateKey &&
    commandName !== plan.candidateLocator.displayedName
  ) {
    return { valid: false, reason: '命令中的候选人与 ActionPlan 不匹配', code: 'APPROVAL_DENIED' };
  }
  const commandJob = (command.input.jobRef ?? command.input.job)?.trim();
  if (commandJob && commandJob !== plan.candidateLocator.jobRef) {
    return { valid: false, reason: '命令中的岗位与 ActionPlan 不匹配', code: 'APPROVAL_DENIED' };
  }

  const expectedIdempotencyKey = buildIdempotencyKey({
    operation: plan.operation,
    candidateKey: plan.candidateKey,
    jobRef: plan.candidateLocator.jobRef,
    messageHash: plan.payload.messageHash,
  });
  if (plan.idempotencyKey !== expectedIdempotencyKey) {
    return { valid: false, reason: 'ActionPlan idempotencyKey 与绑定字段不一致', code: 'APPROVAL_DENIED' };
  }

  const planPayloadPath = resolveWorkspaceFile(workspaceRoot, plan.payload.messageFile);
  if (!validatePath(planPayloadPath, [workspaceRoot])) {
    return { valid: false, reason: 'ActionPlan payload 路径越出工作区', code: 'INVALID_COMMAND' };
  }

  const requiresExplicitPayload = OPERATIONS_REQUIRING_PAYLOAD_ARGUMENT.has(command.operation);
  if (requiresExplicitPayload && !command.input.payloadFile) {
    return { valid: false, reason: '该写操作必须显式提供 --payload-file', code: 'INVALID_COMMAND' };
  }
  const commandPayloadPath = command.input.payloadFile
    ? resolveWorkspaceFile(workspaceRoot, command.input.payloadFile)
    : planPayloadPath;
  if (!validatePath(commandPayloadPath, [workspaceRoot])) {
    return { valid: false, reason: '命令 payload 路径越出工作区', code: 'INVALID_COMMAND' };
  }

  let planHash: string;
  let commandHash: string;
  let payloadText: string;
  try {
    [planHash, commandHash, payloadText] = await Promise.all([
      fileSha256(planPayloadPath),
      fileSha256(commandPayloadPath),
      fs.readFile(commandPayloadPath, 'utf-8'),
    ]);
  } catch {
    return { valid: false, reason: '无法读取或校验 payload 文件', code: 'INVALID_COMMAND' };
  }

  const approvedHash = normalizedSha256(plan.payload.messageHash);
  if (planHash !== approvedHash || commandHash !== approvedHash) {
    return { valid: false, reason: 'payload 文件内容与 ActionPlan messageHash 不匹配', code: 'PAYLOAD_HASH_MISMATCH' };
  }
  if (requiresExplicitPayload && payloadText.trim().length === 0) {
    return { valid: false, reason: '写操作 payload 不能为空', code: 'INVALID_COMMAND' };
  }

  const binding = checkApprovalBinding(plan, {
    operation: command.operation,
    candidateKey: plan.candidateKey,
    jobRef: plan.candidateLocator.jobRef,
    payloadHash: plan.payload.messageHash,
  });
  if (!binding.valid) {
    return { valid: false, reason: binding.reason, code: 'APPROVAL_DENIED' };
  }

  return {
    valid: true,
    payloadPath: commandPayloadPath,
    payloadHash: commandHash,
    payloadText,
  };
}

/** Build an approval record from an ActionPlan */
export function toApprovalRecord(plan: ActionPlan): ApprovalRecord {
  return {
    actionId: plan.actionId,
    operation: plan.operation,
    candidateKey: plan.candidateKey,
    jobRef: plan.candidateLocator.jobRef,
    payloadHash: plan.payload.messageHash,
    status: plan.approval.status === 'approved' ? 'approved'
      : plan.approval.status === 'denied' ? 'denied'
      : 'expired',
    assurance: plan.approval.assurance,
    approvedAt: plan.approval.approvedAt,
    expiresAt: plan.approval.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    scope: plan.approval.scope,
  };
}
