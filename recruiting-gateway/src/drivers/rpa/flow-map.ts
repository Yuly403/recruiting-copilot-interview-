import type { GatewayCommand } from '../../contracts/command.js';
import type { ActionPlan } from '../../contracts/action-plan.js';
import type { RpaRequest } from './named-pipe-client.js';
import { RPA_SCHEMA_VERSION } from './named-pipe-client.js';
import type { RunnerExecutionTicket } from '../../runtime/runner-ticket.js';

// ── RPA Flow Map (per PRD §10.2, §10.5) ──

/**
 * RPA flow names are stable identifiers that the RPA Runner understands.
 * They differ from Gateway operations to decouple the two systems.
 */
export const RPA_FLOW = {
  HEALTH: 'health',
  INSPECT_CONTEXT: 'boss.inspect_context',
  OPEN_CANDIDATE: 'boss.open_candidate',
  READ_CONVERSATION: 'boss.read_conversation',
  STAGE_MESSAGE: 'boss.stage_message',
  COMMIT_MESSAGE: 'boss.commit_message',
  COMMIT_GREETING: 'boss.commit_greeting',
  REQUEST_ATTACHMENT: 'boss.request_attachment',
  ACCEPT_ATTACHMENT: 'boss.accept_attachment',
  UPDATE_REMARK: 'boss.update_remark',
  EXCHANGE_CONTACT: 'boss.exchange_contact',
  VERIFY: 'boss.verify',
  STOP: 'boss.stop',
} as const;

export type RpaFlow = (typeof RPA_FLOW)[keyof typeof RPA_FLOW];

/**
 * Map a Gateway operation to its corresponding RPA flow.
 * Returns null if the operation cannot be executed by RPA.
 */
export function mapOperationToFlow(operation: string): RpaFlow | null {
  const mapping: Record<string, RpaFlow> = {
    'conversation.read': RPA_FLOW.READ_CONVERSATION,
    'conversation.open': RPA_FLOW.OPEN_CANDIDATE,
    'message.stage': RPA_FLOW.STAGE_MESSAGE,
    'message.commit': RPA_FLOW.COMMIT_MESSAGE,
    'greeting.commit': RPA_FLOW.COMMIT_GREETING,
    'attachment.request': RPA_FLOW.REQUEST_ATTACHMENT,
    'attachment.accept': RPA_FLOW.ACCEPT_ATTACHMENT,
    'remark.update': RPA_FLOW.UPDATE_REMARK,
    'contact.exchange': RPA_FLOW.EXCHANGE_CONTACT,
    'execution.verify': RPA_FLOW.VERIFY,
  };

  return mapping[operation] ?? null;
}

/**
 * Build the RPA request payload from a Gateway command and optional ActionPlan.
 */
export function buildRpaPayload(
  command: GatewayCommand,
  actionPlan: ActionPlan | null,
  executionTicket?: RunnerExecutionTicket,
): Record<string, unknown> {
  const base: Record<string, unknown> = {};

  // The Runner is local but separate from Gateway. Send only the minimum binding it
  // needs to fail closed on an expired or mismatched write; Gateway remains the
  // authority that verifies the signed approval record.
  if (actionPlan) {
    base.actionId = actionPlan.actionId;
    base.candidateKey = actionPlan.candidateKey;
    base.operation = actionPlan.operation;
    base.approvalExpiresAt = actionPlan.approval.expiresAt;
    if (executionTicket) base.executionTicket = executionTicket;
  }

  switch (command.operation) {
    case 'conversation.open':
    case 'conversation.read':
      // Open/read candidate conversation
      if (actionPlan?.candidateLocator) {
        base.candidateLocator = actionPlan.candidateLocator;
      }
      // Read-only navigation may use direct display context.
      if (command.input.displayedName) {
        base.displayedName = command.input.displayedName;
      }
      if (command.input.index !== undefined) {
        base.listIndex = command.input.index;
      }
      break;

    case 'message.stage':
    case 'message.commit': {
      if (actionPlan) {
        base.candidateLocator = actionPlan.candidateLocator;
        base.messageFile = actionPlan.payload?.messageFile;
        base.messageHash = actionPlan.payload?.messageHash;
        base.templateId = actionPlan.payload?.templateId;
      }
      break;
    }

    case 'greeting.commit': {
      if (actionPlan) {
        base.candidateLocator = actionPlan.candidateLocator;
        base.messageFile = actionPlan.payload?.messageFile;
        base.messageHash = actionPlan.payload?.messageHash;
      }
      if (command.input.jobRef) base.jobRef = command.input.jobRef;
      break;
    }

    case 'attachment.request':
    case 'attachment.accept':
      if (actionPlan?.candidateLocator) {
        base.candidateLocator = actionPlan.candidateLocator;
      }
      if (command.operation === 'attachment.request' && actionPlan) {
        base.messageFile = actionPlan.payload.messageFile;
        base.messageHash = actionPlan.payload.messageHash;
      }
      break;

    case 'remark.update':
      if (actionPlan?.candidateLocator) {
        base.candidateLocator = actionPlan.candidateLocator;
      }
      if (command.input.remark) base.remark = command.input.remark;
      break;

    case 'contact.exchange':
      if (actionPlan?.candidateLocator) {
        const loc = actionPlan.candidateLocator;
        base.candidateLocator = {
          source: loc.source,
          jobRef: loc.jobRef,
          displayedName: loc.displayedName,
          listContextHash: loc.listContextHash,
        };
      }
      if (actionPlan) {
        base.messageFile = actionPlan.payload.messageFile;
        base.messageHash = actionPlan.payload.messageHash;
      }
      break;

    case 'execution.verify':
      if (actionPlan) {
        base.actionId = actionPlan.actionId;
        base.operation = actionPlan.operation;
        base.candidateKey = actionPlan.candidateKey;
      }
      break;
  }

  return base;
}

/**
 * Build a complete RPA request from a Gateway command.
 */
export function buildRpaRequest(
  command: GatewayCommand,
  actionPlan: ActionPlan | null,
  timeoutMs: number,
  executionTicket?: RunnerExecutionTicket,
): RpaRequest {
  const flow = mapOperationToFlow(command.operation);
  if (!flow) {
    throw new Error(`Operation "${command.operation}" has no RPA flow mapping`);
  }

  const deadlineAt = executionTicket?.deadlineAt ?? new Date(Date.now() + timeoutMs).toISOString();
  return {
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId: command.requestId,
    flow,
    deadlineAt,
    payload: buildRpaPayload(command, actionPlan, executionTicket),
  };
}
