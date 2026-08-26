import type { CandidateLocator } from '../contracts/action-plan.js';

/** A runner receives only a Gateway-approved, single-candidate action. */
export interface RunnerTaskPayload {
  actionId?: string;
  candidateKey?: string;
  operation?: string;
  candidateLocator?: CandidateLocator;
  messageFile?: string;
  messageHash?: string;
  templateId?: string;
  /** Gateway has already verified this. Runner uses it as a short-lived fail-closed guard. */
  approvalExpiresAt?: string;
  executionTicket?: unknown;
}

export type RunnerErrorCode =
  | 'RPA_WINDOW_NOT_FOUND'
  | 'LOGIN_REQUIRED'
  | 'VERIFICATION_REQUIRED'
  | 'QUOTA_OR_PAYWALL'
  | 'CANDIDATE_AMBIGUOUS'
  | 'CANDIDATE_MISMATCH'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'APPROVAL_EXPIRED'
  | 'USER_STOPPED'
  | 'RESULT_UNKNOWN'
  | 'TIMEOUT'
  | 'RPA_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type RunnerResponseStatus = 'succeeded' | 'failed' | 'paused' | 'result_unknown';

export interface RunnerError {
  code: RunnerErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface RunnerOutcome {
  status: RunnerResponseStatus;
  observations?: Record<string, unknown>;
  error?: RunnerError;
}

export interface CandidateSnapshot {
  displayedName: string;
  currentCompany?: string;
  currentTitle?: string;
  /** Visible card text used only for local, in-memory identity comparison. */
  rawText?: string;
}

export interface BrowserPageState {
  url: string;
  title: string;
  loginRequired: boolean;
  verificationRequired: boolean;
  paywallVisible: boolean;
}

/** Browser-specific details stay behind this interface so the flow engine is fully unit-testable. */
export interface BossBrowserSession {
  inspect(): Promise<BrowserPageState>;
  findCandidates(locator: CandidateLocator): Promise<CandidateSnapshot[]>;
  openCandidate(locator: CandidateLocator): Promise<void>;
  assertActiveCandidate(locator: CandidateLocator): Promise<boolean>;
  readConversation(): Promise<string>;
  stageMessage(message: string): Promise<void>;
  readStagedMessage(): Promise<string>;
  commitMessage(): Promise<void>;
  commitGreeting(locator: CandidateLocator): Promise<void>;
  verifyMessageCommit(message: string): Promise<'confirmed' | 'not_confirmed' | 'uncertain'>;
  verifyGreetingCommit(locator: CandidateLocator): Promise<'confirmed' | 'not_confirmed' | 'uncertain'>;
  close(): Promise<void>;
}

export interface BossBrowserFactory {
  connect(): Promise<BossBrowserSession>;
}
