import type { GatewayCommand } from '../contracts/command.js';
import type { GatewayConfig } from './config.js';
import { getOperationDefinition } from './operation-catalog.js';
import type { CircuitBreakerSnapshot } from './circuit-breaker.js';
import type { DriverHealth } from '../contracts/enums.js';

// ── Policy Engine (per PRD §GW-004, §7.3) ──

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
  primaryDriver: string;
  fallbackDriver: string;
  approvalRequired: boolean;
  autoRetry: boolean;
}

export interface PolicyInput {
  command: GatewayCommand;
  config: GatewayConfig;
  circuitSnapshot: CircuitBreakerSnapshot;
  driverHealth: Record<string, DriverHealth>;
  isWriteCircuitOpen: boolean;
  sessionUnavailable: boolean;
}

/** Evaluate whether a command is allowed and select driver policy */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { command, circuitSnapshot, driverHealth, isWriteCircuitOpen, sessionUnavailable } = input;

  const def = getOperationDefinition(command.operation);

  // ── Hard blocks ──

  // Block 1: markNotFit can NEVER be automated
  if (command.operation === 'candidate.markNotFit' && !def.automationAllowed) {
    return {
      allowed: false,
      reason: 'candidate.markNotFit 禁止自动执行，必须人工操作',
      primaryDriver: 'human',
      fallbackDriver: 'human',
      approvalRequired: true,
      autoRetry: false,
    };
  }

  // Block 2: Session unavailable blocks all except session.login and session.status
  if (sessionUnavailable && command.operation !== 'session.login' && command.operation !== 'session.status') {
    return {
      allowed: false,
      reason: 'BOSS 会话不可用，请先登录',
      primaryDriver: 'human',
      fallbackDriver: 'human',
      approvalRequired: false,
      autoRetry: false,
    };
  }

  // Block 3: Write circuit open blocks all writes
  if (isWriteCircuitOpen && (def.type.includes('write'))) {
    return {
      allowed: false,
      reason: 'BOSS 写操作已熔断，需要人工处理',
      primaryDriver: 'human',
      fallbackDriver: 'human',
      approvalRequired: false,
      autoRetry: false,
    };
  }

  // Block 4: Verification page blocks writes
  if (circuitSnapshot.verificationPageOpen && def.type.includes('write')) {
    return {
      allowed: false,
      reason: '检测到验证页面，所有写操作已暂停',
      primaryDriver: 'human',
      fallbackDriver: 'human',
      approvalRequired: false,
      autoRetry: false,
    };
  }

  // ── Build policy result ──

  // Resolve primary driver: if circuit is open for primary, use fallback
  let primaryDriver = def.primary;
  const primaryHealth = driverHealth[primaryDriver];
  if (primaryHealth === 'circuit_open' || primaryHealth === 'unavailable') {
    primaryDriver = def.fallback;
  }

  const requiresApproval = typeof def.approvalRequired === 'boolean'
    ? def.approvalRequired
    : def.approvalRequired === 'when_match'
      ? (command.input.match ?? false)
      : (def.approvalRequired === 'manual_login' || def.approvalRequired === 'policy');

  return {
    allowed: true,
    primaryDriver,
    fallbackDriver: def.fallback,
    approvalRequired: requiresApproval,
    autoRetry: def.autoRetry,
  };
}
