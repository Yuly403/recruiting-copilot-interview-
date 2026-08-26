import type { DriverHealth } from '../contracts/enums.js';

// ── Circuit Breaker (per PRD §GW-007) ──

export interface CircuitBreakerState {
  /** Per-driver circuit state */
  drivers: Record<string, DriverHealth>;
  /** BOSS write-level circuit */
  writeCircuitOpen: boolean;
  /** Verification page detected */
  verificationPageOpen: boolean;
  /** Consecutive identity failures per driver */
  identityFailures: Record<string, number>;
  /** Consecutive unknown write results */
  unknownWriteResults: number;
  /** Login state */
  loginRequired: boolean;
}

export interface CircuitBreakerConfig {
  identity_failures: number;
  unknown_write_results: number;
  verification_page_immediate_open: boolean;
}

export interface CircuitBreakerSnapshot {
  driverHealth: Record<string, DriverHealth>;
  writeCircuitOpen: boolean;
  verificationPageOpen: boolean;
  loginRequired: boolean;
}

/** Create a fresh circuit breaker */
export function createCircuitBreaker(config: CircuitBreakerConfig): CircuitBreakerState {
  return {
    drivers: {
      legacy_cli: 'healthy',
      rpa: 'healthy',
      human: 'healthy',
      gateway_local: 'healthy',
    },
    writeCircuitOpen: false,
    verificationPageOpen: false,
    identityFailures: {},
    unknownWriteResults: 0,
    loginRequired: false,
  };
}

/** Record a driver failure */
export function recordFailure(
  state: CircuitBreakerState,
  driver: string,
  errorCode: string,
  config: CircuitBreakerConfig,
): void {
  // Track identity failures
  if (errorCode === 'CANDIDATE_AMBIGUOUS' || errorCode === 'CANDIDATE_MISMATCH') {
    state.identityFailures[driver] = (state.identityFailures[driver] || 0) + 1;
    if (state.identityFailures[driver] >= config.identity_failures) {
      state.drivers[driver] = 'circuit_open';
    }
  }

  // Verification page
  if (errorCode === 'VERIFICATION_REQUIRED') {
    state.verificationPageOpen = true;
    if (config.verification_page_immediate_open) {
      state.writeCircuitOpen = true;
    }
  }

  // Login required
  if (errorCode === 'LOGIN_REQUIRED') {
    state.loginRequired = true;
  }

  // Unknown write result
  if (errorCode === 'RESULT_UNKNOWN') {
    state.unknownWriteResults++;
    if (state.unknownWriteResults >= config.unknown_write_results) {
      state.writeCircuitOpen = true;
    }
  }

  // RPA-specific failures
  if (errorCode === 'RPA_UNAVAILABLE' || errorCode === 'RPA_WINDOW_NOT_FOUND') {
    state.drivers['rpa'] = 'degraded';
  }

  // Legacy output unrecognized
  if (errorCode === 'LEGACY_OUTPUT_UNRECOGNIZED') {
    state.drivers['legacy_cli'] = 'degraded';
  }
}

/** Record a driver success (reset counters) */
export function recordSuccess(state: CircuitBreakerState, driver: string): void {
  // Reset identity failures for this driver on success
  state.identityFailures[driver] = 0;
  if (state.drivers[driver] === 'degraded') {
    state.drivers[driver] = 'healthy';
  }
  // Don't auto-close circuit — requires manual or doctor intervention
}

/** Set login state */
export function setLoginRequired(state: CircuitBreakerState, required: boolean): void {
  state.loginRequired = required;
  if (!required) {
    state.drivers['legacy_cli'] = 'healthy';
  }
}

/** Get a snapshot for policy evaluation */
export function snapshot(state: CircuitBreakerState): CircuitBreakerSnapshot {
  return {
    driverHealth: { ...state.drivers },
    writeCircuitOpen: state.writeCircuitOpen,
    verificationPageOpen: state.verificationPageOpen,
    loginRequired: state.loginRequired,
  };
}

/** Manually close the write circuit (e.g., after manual takeover resolves) */
export function closeWriteCircuit(state: CircuitBreakerState): void {
  state.writeCircuitOpen = false;
  state.unknownWriteResults = 0;
}

/** Clear verification page flag */
export function clearVerificationPage(state: CircuitBreakerState): void {
  state.verificationPageOpen = false;
}
