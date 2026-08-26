import { z } from 'zod';

// ── Operations (per PRD §7.1) ──
export const OperationSchema = z.enum([
  'session.login',
  'session.status',
  'positions.list',
  'jd.get',
  'candidates.list',
  'candidates.listUnread',
  'candidates.search',
  'candidates.deepSearch',
  'candidates.recommend',
  'candidate.preview',
  'conversation.open',
  'conversation.read',
  'message.stage',
  'message.commit',
  'greeting.commit',
  'attachment.request',
  'attachment.accept',
  'remark.update',
  'contact.exchange',
  'candidate.markNotFit',
  'execution.verify',
  'execution.stop',
]);

export type Operation = z.infer<typeof OperationSchema>;

// ── Driver types ──
export const DriverTypeSchema = z.enum([
  'gateway_local',
  'legacy_cli',
  'rpa',
  'human',
  'current_write_driver',
]);

export type DriverType = z.infer<typeof DriverTypeSchema>;

// ── Action statuses (per PRD §13.1) ──
export const ActionStatusSchema = z.enum([
  'created',
  'planned',
  'awaiting_approval',
  'approved',
  'denied',
  'waiting_for_lock',
  'executing',
  'verifying',
  'succeeded',
  'failed_before_commit',
  'result_unknown',
  'paused_for_candidate_identity',
  'paused_for_verification',
  'paused_for_login',
  'paused_for_manual_takeover',
  'cancelled',
]);

export type ActionStatus = z.infer<typeof ActionStatusSchema>;

// ── Driver health statuses (per PRD §13.3) ──
export const DriverHealthSchema = z.enum([
  'healthy',
  'degraded',
  'unavailable',
  'circuit_open',
  'manual_only',
]);

export type DriverHealth = z.infer<typeof DriverHealthSchema>;

// ── BOSS channel statuses (per PRD §13.4) ──
export const BossChannelStatusSchema = z.enum([
  'idle',
  'legacy_reading',
  'awaiting_approval',
  'rpa_executing',
  'verifying',
  'manual_takeover',
  'write_circuit_open',
  'session_unavailable',
]);

export type BossChannelStatus = z.infer<typeof BossChannelStatusSchema>;

// ── Operation types (for routing) ──
export const OperationTypeSchema = z.enum([
  'session',
  'local_read',
  'read',
  'read_navigation',
  'read_navigation_limited',
  'read_limited',
  'navigation',
  'reversible_write',
  'irreversible_write',
  'state_write',
  'read_verification',
  'control',
]);

export type OperationType = z.infer<typeof OperationTypeSchema>;

// ── Approval assurance ──
export const ApprovalAssuranceSchema = z.enum([
  'conversation',
  'interactive',
]);

export type ApprovalAssurance = z.infer<typeof ApprovalAssuranceSchema>;

// ── Approval scope ──
export const ApprovalScopeSchema = z.enum([
  'single_action',
  'explicit_batch',
]);

export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

// ── Gateway execution status ──
export const ExecutionStatusSchema = z.enum([
  'succeeded',
  'denied',
  'failed',
  'paused',
  'already_completed',
  'conflict_in_progress',
  'result_unknown',
  'cancelled',
]);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

// ── Standardized error codes (per PRD §15.1) ──
export const ErrorCodeSchema = z.enum([
  'LEGACY_EXECUTABLE_NOT_FOUND',
  'LEGACY_TIMEOUT',
  'LEGACY_OUTPUT_UNRECOGNIZED',
  'RPA_UNAVAILABLE',
  'RPA_WINDOW_NOT_FOUND',
  'CANDIDATE_AMBIGUOUS',
  'CANDIDATE_MISMATCH',
  'APPROVAL_MISSING',
  'APPROVAL_EXPIRED',
  'APPROVAL_DENIED',
  'PAYLOAD_HASH_MISMATCH',
  'PLAN_NOT_FOUND',
  'IDEMPOTENCY_BLOCKED',
  'LOCK_CONFLICT',
  'SESSION_LOCKED',
  'VERIFICATION_REQUIRED',
  'LOGIN_REQUIRED',
  'QUOTA_OR_PAYWALL',
  'RESULT_UNKNOWN',
  'TIMEOUT',
  'USER_STOPPED',
  'LEGACY_OPERATION_UNSUPPORTED',
  'INVALID_COMMAND',
  'CONFIG_INVALID',
  'INTERNAL_ERROR',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ── Candidate locator source ──
export const LocatorSourceSchema = z.enum([
  'inbound_chat',
  'recommended_feed',
  'search_results',
  'deep_search',
]);

export type LocatorSource = z.infer<typeof LocatorSourceSchema>;
