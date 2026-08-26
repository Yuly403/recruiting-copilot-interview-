import * as path from 'node:path';
import { toGatewayCommand, type GatewayCommand } from '../contracts/command.js';
import type { GatewayResult } from '../contracts/result.js';
import { successResult, failedResult } from '../contracts/result.js';
import type { Driver } from '../drivers/driver.js';
import type { GatewayConfig } from './config.js';
import { GatewayConfigSchema } from './config.js';
import { createCircuitBreaker, snapshot, type CircuitBreakerState, type CircuitBreakerSnapshot } from './circuit-breaker.js';
import { createIdempotencyStore } from './idempotency-store.js';
import { createActionStore } from '../runtime/action-store.js';
import { createApprovalStore } from '../runtime/approval-store.js';
import { createAuditLog } from './audit-log.js';
import { resolveRuntimePaths, ensureRuntimeDirs, type RuntimePaths } from '../runtime/paths.js';
import { createSessionLock } from './session-lock.js';
import { executeCommand, type ExecutionContext } from './execution-coordinator.js';
import { createHumanDriver } from '../drivers/human/index.js';
import { createRpaDriver } from '../drivers/rpa/index.js';
import { createLegacyCliDriver } from '../drivers/legacy-cli/index.js';

// ── Gateway Top-Level API ──

export interface GatewayInstance {
  /** Execute a command through the full pipeline. Accepts raw input, normalizes to GatewayCommand internally. */
  execute(command: { operation: string; input: Record<string, unknown>; requestId?: string }): Promise<GatewayResult>;

  /** Check health of all drivers */
  health(): Promise<Record<string, { healthy: boolean; status: string }>>;

  /** Stop all active drivers */
  stop(): Promise<void>;

  /** Access the execution context (for debugging) */
  readonly ctx: ExecutionContext;

  /** Access individual drivers */
  readonly drivers: Record<string, Driver>;
}

export interface GatewayOptions {
  /** Pre-built drivers to inject (for testing) */
  drivers?: Record<string, Driver>;
  /** Skip runtime dir creation (for testing) */
  skipInit?: boolean;
  /** Custom logger */
  log?: (msg: string, level: 'debug' | 'info' | 'warn' | 'error') => void;
}

// ── Gateway Local Driver ──
// Handles session.status and execution.stop operations that run entirely within the gateway

function createGatewayLocalDriver(ctx: ExecutionContext): Driver {
  return {
    name: 'gateway_local',

    async health() {
      return { healthy: true, status: 'available' };
    },

    async execute(input) {
      const { operation, requestId } = input.command;
      const startedAt = new Date().toISOString();

      if (operation === 'session.status') {
        const lock = ctx.getLock();
        const lockInfo = await lock.read();
        const healthSnapshot = snapshot(ctx.circuitBreaker);

        const finishedAt = new Date().toISOString();
        return successResult({
          requestId,
          operation,
          driver: 'gateway_local',
          startedAt,
          finishedAt,
          data: {
            loggedIn: !healthSnapshot.loginRequired,
            sessionLocked: lockInfo !== null,
            lockOwner: lockInfo?.owner ?? null,
            lockOperation: lockInfo?.operation ?? null,
            lockExpiresAt: lockInfo?.expiresAt ?? null,
            circuitBreaker: {
              writeCircuitOpen: healthSnapshot.writeCircuitOpen,
              verificationPageOpen: healthSnapshot.verificationPageOpen,
              loginRequired: healthSnapshot.loginRequired,
              driverHealth: healthSnapshot.driverHealth,
            },
          },
        });
      }

      if (operation === 'execution.stop') {
        // Forward stop to all drivers
        const stopResults: Record<string, string> = {};
        for (const [name, driver] of Object.entries(ctx.drivers)) {
          if (name === 'gateway_local') continue;
          try {
            await driver.stop();
            stopResults[name] = 'stopped';
          } catch (err) {
            stopResults[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        const finishedAt = new Date().toISOString();
        return successResult({
          requestId,
          operation,
          driver: 'gateway_local',
          startedAt,
          finishedAt,
          data: { stopped: stopResults },
        });
      }

      return failedResult({
        requestId,
        operation,
        driver: 'gateway_local',
        errorCode: 'INTERNAL_ERROR',
        message: `gateway_local 不支持操作: ${operation}`,
      });
    },

    async stop() {
      // No-op
    },
  };
}

// ── Gateway Factory ──

/**
 * Create a fully wired Gateway instance.
 *
 * ```ts
 * const gw = await createGateway({ workspace_root: './my-project' });
 * const result = await gw.execute(toGatewayCommand({
 *   operation: 'candidates.list',
 *   input: { job: 'my-job-ref' },
 * }));
 * ```
 */
export async function createGateway(
  configOrRaw: GatewayConfig | Record<string, unknown>,
  options: GatewayOptions = {},
): Promise<GatewayInstance> {
  const log = options.log ?? (() => {});
  const config: GatewayConfig = GatewayConfigSchema.parse(
    configOrRaw && 'version' in configOrRaw ? configOrRaw : { ...configOrRaw, version: '1' },
  );

  // Resolve & create runtime directories
  const runtimePaths = await resolveRuntimePaths(config);
  if (!options.skipInit) {
    await ensureRuntimeDirs(runtimePaths);
    log('Runtime directories initialized', 'debug');
  }

  // Create shared state
  const circuitBreaker = createCircuitBreaker(config.boss.circuit_breaker);
  const idempotency = createIdempotencyStore(runtimePaths.root);
  const actionStore = createActionStore(runtimePaths);
  const approvalStore = createApprovalStore(runtimePaths);
  const auditLog = createAuditLog(runtimePaths.audit);

  // Create drivers (respecting injected drivers for testing)
  const drivers: Record<string, Driver> = {
    human: options.drivers?.human ?? createHumanDriver(),
    rpa: options.drivers?.rpa ?? createRpaDriver({
      config: config.boss.rpa,
    }),
    legacy_cli: options.drivers?.legacy_cli ?? createLegacyCliDriver({
      config: config.boss.legacy_cli,
    }),
    // gateway_local placeholder — replaced below after ctx is built
    gateway_local: undefined!,
  };

  // Build shared context (used by gateway_local driver and executeCommand)
  const ctx: ExecutionContext = {
    config,
    circuitBreaker,
    drivers,
    idempotency,
    actionStore,
    approvalStore,
    auditLog,
    runtimePaths,
    getLock: () => createSessionLock(runtimePaths.locks),
  };

  // Now create the real gateway_local driver with context access
  drivers.gateway_local = options.drivers?.gateway_local ?? createGatewayLocalDriver(ctx);

  log(`Gateway initialized (workspace: ${config.workspace_root})`, 'info');

  return {
    async execute(raw: { operation: string; input: Record<string, unknown>; requestId?: string }): Promise<GatewayResult> {
      const command = toGatewayCommand(raw);
      return executeCommand(ctx, command);
    },

    async health(): Promise<Record<string, { healthy: boolean; status: string }>> {
      const results: Record<string, { healthy: boolean; status: string }> = {};
      for (const [name, driver] of Object.entries(drivers)) {
        try {
          const h = await driver.health();
          results[name] = { healthy: h.healthy, status: h.status };
        } catch (err) {
          results[name] = { healthy: false, status: err instanceof Error ? err.message : String(err) };
        }
      }
      return results;
    },

    async stop(): Promise<void> {
      for (const driver of Object.values(drivers)) {
        try { await driver.stop(); } catch { /* best-effort */ }
      }
    },

    get ctx(): ExecutionContext { return ctx; },
    get drivers(): Record<string, Driver> { return { ...drivers }; },
  };
}
