import type { CircuitBreakerSnapshot } from './circuit-breaker.js';
import type { DriverHealth } from '../contracts/enums.js';
import { getOperationDefinition } from './operation-catalog.js';

// ── Router (per PRD §GW-004) ──

export interface RouterInput {
  operation: string;
  primary: string;
  fallback: string;
  health: Record<string, DriverHealth>;
  circuit: CircuitBreakerSnapshot;
}

export interface RouterResult {
  driver: string;
  isDegraded: boolean;
  reason?: string;
}

/**
 * Resolve which driver to use for an operation.
 * Decision factors (per PRD §7.3):
 * - Operation type (read vs write)
 * - Primary driver health
 * - Circuit state
 * - Session availability
 * - Write circuit state
 */
/**
 * Resolve a "meta-driver" name to a concrete driver.
 * `current_write_driver` → `rpa` (all writes route to RPA in current config)
 * Returns the input unchanged if it's already a concrete driver name.
 */
function resolveMetaDriver(name: string): string {
  if (name === 'current_write_driver') return 'rpa';
  return name;
}

export function resolveDriver(input: RouterInput): RouterResult {
  const operation = input.operation;
  const primary = resolveMetaDriver(input.primary);
  const fallback = resolveMetaDriver(input.fallback);
  const { health } = input;

  // Select primary if healthy
  const primaryHealth = health[primary] ?? 'healthy';
  if (primaryHealth === 'healthy') {
    return { driver: primary, isDegraded: false };
  }

  // Select fallback with degradation flag
  const fallbackHealth = health[fallback] ?? 'healthy';
  if (fallbackHealth === 'healthy') {
    return {
      driver: fallback,
      isDegraded: true,
      reason: `主 Driver ${primary} 不健康 (${primaryHealth})，回退到 ${fallback}`,
    };
  }

  // Both unhealthy — use human as last resort
  if (health['human'] === 'healthy') {
    return {
      driver: 'human',
      isDegraded: true,
      reason: `主 Driver ${primary} (${primaryHealth}) 和备用 ${fallback} (${fallbackHealth}) 均不可用，转人工`,
    };
  }

  // Everything is broken
  return {
    driver: 'human',
    isDegraded: true,
    reason: '所有 Driver 不可用',
  };
}

/**
 * Simple router that wraps resolveDriver with operation catalog lookup
 */
export function routeOperation(params: {
  operation: string;
  overrides?: { primary?: string; fallback?: string };
  health: Record<string, DriverHealth>;
  circuit: CircuitBreakerSnapshot;
}): RouterResult {
  const def = getOperationDefinition(params.operation);
  const primary = params.overrides?.primary ?? def.primary;
  const fallback = params.overrides?.fallback ?? def.fallback;

  return resolveDriver({
    operation: params.operation,
    primary,
    fallback,
    health: params.health,
    circuit: params.circuit,
  });
}
