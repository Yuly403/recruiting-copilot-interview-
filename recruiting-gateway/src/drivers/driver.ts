import type { GatewayCommand } from '../contracts/command.js';
import type { GatewayResult } from '../contracts/result.js';
import type { RunnerExecutionTicket } from '../runtime/runner-ticket.js';

// ── Driver Interface (per PRD §9, §10) ──

export interface DriverHealthCheck {
  healthy: boolean;
  status: string;
  details?: Record<string, unknown>;
}

export interface DriverExecuteInput {
  command: GatewayCommand;
  /** Optional ActionPlan for write operations */
  actionPlan?: unknown;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Short-lived signed ticket for a real local RPA write. */
  executionTicket?: RunnerExecutionTicket;
}

export interface Driver {
  /** Unique driver name */
  readonly name: string;

  /** Health check */
  health(): Promise<DriverHealthCheck>;

  /** Execute a command */
  execute(input: DriverExecuteInput): Promise<GatewayResult>;

  /** Stop current execution */
  stop(): Promise<void>;
}
