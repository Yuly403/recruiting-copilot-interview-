import { z } from 'zod';
import {
  OperationSchema,
  ApprovalAssuranceSchema,
  ApprovalScopeSchema,
  ActionStatusSchema,
  LocatorSourceSchema,
} from './enums.js';

// ── Candidate Locator (per PRD §11.3) ──

export const CandidateLocatorSchema = z.object({
  platform: z.literal('boss'),
  source: LocatorSourceSchema,
  /** Job reference slug */
  jobRef: z.string(),
  /** Displayed name on BOSS (may be masked) */
  displayedName: z.string(),
  /** Current company (辅助信号) */
  currentCompany: z.string().optional(),
  /** Current title (辅助信号) */
  currentTitle: z.string().optional(),
  /** City (辅助信号) */
  city: z.string().optional(),
  /** Education text (辅助信号) */
  education: z.string().optional(),
  /** Salary text (辅助信号) */
  salaryText: z.string().optional(),
  /** Hash of the list context where this candidate was found */
  listContextHash: z.string(),
  /** When this locator was captured */
  capturedAt: z.string(),
  /** When this locator expires (typically 30 min after capture) */
  expiresAt: z.string(),
});

export type CandidateLocator = z.infer<typeof CandidateLocatorSchema>;

// ── Action Plan (per PRD §12.1) ──

export const ActionPlanApprovalSchema = z.object({
  required: z.boolean(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  approvedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  assurance: ApprovalAssuranceSchema,
  scope: ApprovalScopeSchema,
});

export type ActionPlanApproval = z.infer<typeof ActionPlanApprovalSchema>;

export const ActionPlanPayloadSchema = z.object({
  /** Relative path to the message payload file */
  messageFile: z.string(),
  /** SHA-256 hash of the message content */
  messageHash: z.string(),
  /** Template identifier */
  templateId: z.string().optional(),
});

export type ActionPlanPayload = z.infer<typeof ActionPlanPayloadSchema>;

export const ActionPlanSchema = z.object({
  schemaVersion: z.literal('1.0'),
  /** Unique action ID */
  actionId: z.string(),
  /** Workspace hash for scoping */
  workspaceId: z.string(),
  /** Operation to perform */
  operation: OperationSchema,
  /** Platform */
  platform: z.literal('boss'),
  /** Local candidate UUID */
  candidateKey: z.string(),
  /** Locator for re-identifying the candidate on the BOSS page */
  candidateLocator: CandidateLocatorSchema,
  /** Operation payload */
  payload: ActionPlanPayloadSchema,
  /** Approval record */
  approval: ActionPlanApprovalSchema,
  /** Idempotency key — format: boss:<operation>:<candidateKey>:<jobRef>:<messageHash> */
  idempotencyKey: z.string(),
  /** When this plan was created */
  createdAt: z.string(),
  /** Current execution status */
  status: ActionStatusSchema.default('created'),
});

export type ActionPlan = z.infer<typeof ActionPlanSchema>;

// ── Helper: build idempotency key ──

export function buildIdempotencyKey(params: {
  operation: string;
  candidateKey: string;
  jobRef: string;
  messageHash: string;
}): string {
  return `boss:${params.operation}:${params.candidateKey}:${params.jobRef}:${params.messageHash}`;
}

// ── Helper: check if approval is still valid ──

export function isApprovalValid(approval: ActionPlanApproval): boolean {
  if (approval.status !== 'approved') return false;
  if (!approval.expiresAt) return true;
  return new Date(approval.expiresAt) > new Date();
}

// ── Helper: check if locator is still valid ──

export function isLocatorValid(locator: CandidateLocator): boolean {
  return new Date(locator.expiresAt) > new Date();
}
