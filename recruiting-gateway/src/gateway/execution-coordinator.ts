import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GatewayCommand } from '../contracts/command.js';
import type { GatewayResult } from '../contracts/result.js';
import { deniedResult, pausedResult, failedResult, successResult } from '../contracts/result.js';
import type { Driver } from '../drivers/driver.js';
import type { GatewayConfig } from './config.js';
import { evaluatePolicy } from './policy-engine.js';
import { routeOperation } from './router.js';
import { getOperationDefinition, isIrreversibleWrite } from './operation-catalog.js';
import type { CircuitBreakerState, CircuitBreakerConfig } from './circuit-breaker.js';
import { recordFailure, recordSuccess, snapshot } from './circuit-breaker.js';
import { validateApproval, validateActionPlanIntegrity } from './approval-service.js';
import type { RuntimePaths } from '../runtime/paths.js';
import { validatePath } from '../runtime/paths.js';
import type { ActionPlan } from '../contracts/action-plan.js';
import { ActionPlanSchema } from '../contracts/action-plan.js';
import { issueRunnerExecutionTicket, type RunnerExecutionTicket } from '../runtime/runner-ticket.js';

// ── Execution Coordinator (per PRD §GW-004, §11, §15) ──

export interface ExecutionContext {
  config: GatewayConfig;
  circuitBreaker: CircuitBreakerState;
  drivers: Record<string, Driver>;
  idempotency: ReturnType<typeof import('./idempotency-store.js')['createIdempotencyStore']>;
  actionStore: ReturnType<typeof import('../runtime/action-store.js')['createActionStore']>;
  approvalStore: ReturnType<typeof import('../runtime/approval-store.js')['createApprovalStore']>;
  auditLog: ReturnType<typeof import('./audit-log.js')['createAuditLog']>;
  runtimePaths: RuntimePaths;
  getLock: () => ReturnType<typeof import('./session-lock.js')['createSessionLock']>;
}

/**
 * Load an ActionPlan from the given file path or action store.
 * Accepts either a full file path (relative to workspace or absolute)
 * or an actionId to look up in the action store.
 */
async function loadActionPlan(
  ctx: ExecutionContext,
  planRef: string,
): Promise<ActionPlan | null> {
  // Try action store first (look up by actionId)
  try {
    const byId = await ctx.actionStore.read(planRef);
    if (byId) return byId;
  } catch {
    // A path-like reference is not an action ID; continue with workspace file loading.
  }

  // Try as a file path
  try {
    const resolved = path.resolve(ctx.config.workspace_root, planRef);
    if (!validatePath(resolved, [ctx.config.workspace_root])) return null;
    const content = await fs.readFile(resolved, 'utf-8');
    return ActionPlanSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Execute a GatewayCommand through the full pipeline:
 * Policy → Router → Load Plan → Approval → Idempotency → Lock → Driver → Audit → State Update
 */
export async function executeCommand(
  ctx: ExecutionContext,
  command: GatewayCommand,
): Promise<GatewayResult> {
  const startedAt = new Date().toISOString();
  let effectiveCommand = command;

  // ── Step 1: Policy Evaluation ──
  const circuitSnap = snapshot(ctx.circuitBreaker);
  const driverHealth = circuitSnap.driverHealth;

  const policy = evaluatePolicy({
    command,
    config: ctx.config,
    circuitSnapshot: circuitSnap,
    driverHealth,
    isWriteCircuitOpen: circuitSnap.writeCircuitOpen,
    sessionUnavailable: circuitSnap.loginRequired,
  });

  if (!policy.allowed) {
    const result = deniedResult({
      requestId: command.requestId,
      operation: command.operation,
      reason: policy.reason ?? '策略拒绝',
    });
    await ctx.auditLog.actionDenied({
      actionId: command.requestId,
      operation: command.operation,
      reason: policy.reason ?? '策略拒绝',
    });
    return result;
  }

  // ── Step 2: Route to Driver ──
  const route = routeOperation({
    operation: command.operation,
    health: driverHealth,
    circuit: circuitSnap,
    overrides: {
      primary: policy.primaryDriver,
      fallback: policy.fallbackDriver,
    },
  });

  const driver = ctx.drivers[route.driver];
  if (!driver) {
    return failedResult({
      requestId: command.requestId,
      operation: command.operation,
      driver: route.driver,
      errorCode: 'INTERNAL_ERROR',
      message: `Driver ${route.driver} 未注册`,
    });
  }

  // ── Step 3: Load ActionPlan & Validate Approval ──
  const def = getOperationDefinition(command.operation);
  const isWrite = isIrreversibleWrite(def.type) || def.type === 'reversible_write' || def.type === 'state_write';

  let actionPlan: ActionPlan | null = null;

  if (isWrite || command.input.plan) {
    if (command.input.plan) {
      actionPlan = await loadActionPlan(ctx, command.input.plan);
      if (!actionPlan) {
        const result = deniedResult({
          requestId: command.requestId,
          operation: command.operation,
          reason: `ActionPlan 加载失败: ${command.input.plan}`,
          code: 'PLAN_NOT_FOUND',
        });
        await ctx.auditLog.actionDenied({
          actionId: command.requestId,
          operation: command.operation,
          reason: `ActionPlan 加载失败: ${command.input.plan}`,
        });
        return result;
      }

      // Read-only verification may inspect a prior write plan without re-authorizing it.
      // Every actual write still requires the full approval and payload binding below.
      if (isWrite) {
        if (policy.approvalRequired && !actionPlan.approval.required) {
          const reason = 'ActionPlan 不得关闭此写操作的审批要求';
          await ctx.auditLog.actionDenied({ actionId: command.requestId, operation: command.operation, reason });
          return deniedResult({
            requestId: command.requestId,
            operation: command.operation,
            reason,
            code: 'APPROVAL_DENIED',
          });
        }
        const approvalCheck = validateApproval(actionPlan);
        if (!approvalCheck.valid) {
          const result = deniedResult({
            requestId: command.requestId,
            operation: command.operation,
            reason: approvalCheck.reason,
            code: 'APPROVAL_DENIED',
          });
          await ctx.auditLog.actionDenied({
            actionId: command.requestId,
            operation: command.operation,
            reason: approvalCheck.reason,
          });
          return result;
        }

        const integrityCheck = await validateActionPlanIntegrity({
          plan: actionPlan,
          command,
          workspaceRoot: ctx.config.workspace_root,
        });
        if (!integrityCheck.valid) {
          await ctx.auditLog.actionDenied({
            actionId: command.requestId,
            operation: command.operation,
            reason: integrityCheck.reason,
          });
          return deniedResult({
            requestId: command.requestId,
            operation: command.operation,
            reason: integrityCheck.reason,
            code: integrityCheck.code,
          });
        }

        const externalApproval = await ctx.approvalStore.validate(actionPlan);
        if (!externalApproval.valid) {
          await ctx.auditLog.actionDenied({
            actionId: command.requestId,
            operation: command.operation,
            reason: externalApproval.reason,
          });
          return deniedResult({
            requestId: command.requestId,
            operation: command.operation,
            reason: externalApproval.reason,
            code: 'APPROVAL_DENIED',
          });
        }

        actionPlan = {
          ...actionPlan,
          payload: {
            ...actionPlan.payload,
            messageFile: integrityCheck.payloadPath,
            messageHash: integrityCheck.payloadHash,
          },
        };
        effectiveCommand = {
          ...command,
          input: {
            ...command.input,
            payloadFile: integrityCheck.payloadPath,
            messageFile: integrityCheck.payloadPath,
            messageHash: integrityCheck.payloadHash,
            ...(command.operation === 'remark.update' ? { remark: integrityCheck.payloadText.trim() } : {}),
          },
        };
      }
    } else if (isWrite && policy.approvalRequired) {
      const result = deniedResult({
        requestId: command.requestId,
        operation: command.operation,
        reason: '写操作需要 ActionPlan 审批',
        code: 'APPROVAL_MISSING',
      });
      await ctx.auditLog.actionDenied({
        actionId: command.requestId,
        operation: command.operation,
        reason: '写操作需要 ActionPlan 审批',
      });
      return result;
    }
  }

  // ── Step 4: Idempotency Check ──
  if (actionPlan && isWrite) {
    const idemCheck = await ctx.idempotency.validateBeforeExecution(
      actionPlan.idempotencyKey,
      actionPlan.actionId,
    );
    if (!idemCheck.allowed) {
      const reasonMap: Record<string, string> = {
        'already_completed': '该操作已完成（幂等拒绝）',
        'conflict_in_progress': '该操作正在由另一个请求执行中',
      };
      const reason = reasonMap[idemCheck.reason] ?? idemCheck.reason;

      const result = deniedResult({
        requestId: command.requestId,
        operation: command.operation,
        reason,
        code: 'IDEMPOTENCY_BLOCKED',
      });
      await ctx.auditLog.actionDenied({
        actionId: command.requestId,
        operation: command.operation,
        reason,
      });
      return result;
    }
  }

  // ── Step 5: Lock Acquisition ──
  const needsLock = !['session.status', 'execution.stop'].includes(command.operation) &&
    !def.type.includes('local');

  if (needsLock) {
    const lock = ctx.getLock();
    try {
      await lock.acquire({
        leaseId: command.requestId,
        owner: route.driver === 'rpa' ? 'rpa' :
               route.driver === 'legacy_cli' ? 'legacy_cli' :
               route.driver === 'human' ? 'manual' : 'gateway_local',
        pid: process.pid,
        processStartTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        operation: command.operation,
        actionId: actionPlan?.actionId ?? null,
      }, ctx.config.boss.locking.lease_seconds);

      await ctx.auditLog.lockEvent({
        event: 'lock.acquired',
        owner: route.driver,
        operation: command.operation,
      });
    } catch (lockErr: any) {
      const result = deniedResult({
        requestId: command.requestId,
        operation: command.operation,
        reason: `获取会话锁失败: ${lockErr.message}`,
        code: 'LOCK_CONFLICT',
      });
      await ctx.auditLog.lockEvent({
        event: 'lock.failed',
        owner: route.driver,
        operation: command.operation,
      });
      return result;
    }
  }

  // ── Step 6: Execute ──
  const timeoutMs = driver.name === 'rpa'
    ? ctx.config.boss.rpa.default_timeout_ms
    : ctx.config.boss.legacy_cli.default_timeout_ms;

  // Runner verifies this independent, short-lived ticket before any browser write.
  // It prevents a local process from treating a structurally similar pipe request as approved.
  let executionTicket: RunnerExecutionTicket | undefined;
  if (driver.name === 'rpa' && actionPlan && isWrite) {
    executionTicket = await issueRunnerExecutionTicket({
      runtimeRoot: ctx.runtimePaths.root,
      plan: actionPlan,
      requestId: command.requestId,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
  }

  // Update action plan status to executing
  if (actionPlan) {
    await ctx.actionStore.markRunning(actionPlan.actionId);
    await ctx.idempotency.markExecuting(actionPlan.idempotencyKey, actionPlan.actionId);
  }

  await ctx.auditLog.actionStarted({
    actionId: command.requestId,
    operation: command.operation,
    driver: driver.name,
    candidateKey: actionPlan?.candidateKey,
    jobRef: actionPlan?.candidateLocator?.jobRef,
    payloadHash: actionPlan?.payload?.messageHash,
    approvalAssurance: actionPlan?.approval?.assurance,
  });

  try {
    const result = await driver.execute({
      command: effectiveCommand,
      timeoutMs,
      actionPlan,
      executionTicket,
    });

    const finishedAt = new Date().toISOString();
    const finalResult: GatewayResult = {
      ...result,
      startedAt: result.startedAt || startedAt,
      finishedAt: result.finishedAt || finishedAt,
    };

    if (result.status === 'succeeded') {
      recordSuccess(ctx.circuitBreaker, driver.name);
      await ctx.auditLog.actionSucceeded({
        actionId: command.requestId,
        operation: command.operation,
        driver: driver.name,
        candidateKey: actionPlan?.candidateKey,
        jobRef: actionPlan?.candidateLocator?.jobRef,
        payloadHash: actionPlan?.payload?.messageHash,
        approvalAssurance: actionPlan?.approval?.assurance,
      });
      // Mark idempotency & action store
      if (actionPlan) {
        await ctx.idempotency.markSucceeded(actionPlan.idempotencyKey, actionPlan.actionId);
        await ctx.actionStore.markCompleted(actionPlan.actionId);
      }
    } else if (result.status === 'paused') {
      // Paused = human takeover or verification
      await ctx.auditLog.actionPaused({
        actionId: command.requestId,
        operation: command.operation,
        driver: driver.name,
        reason: result.error?.message ?? '操作已暂停',
        errorCode: result.error?.code,
      });
      if (actionPlan) {
        await ctx.idempotency.markResultUnknown(actionPlan.idempotencyKey, actionPlan.actionId);
        await ctx.actionStore.markPaused(actionPlan.actionId);
      }
    } else if (result.error) {
      const isCommitPhase = result.error.code === 'RESULT_UNKNOWN' ||
        result.error.code === 'VERIFICATION_REQUIRED' ||
        result.error.code === 'TIMEOUT';
      recordFailure(ctx.circuitBreaker, driver.name, result.error.code, ctx.config.boss.circuit_breaker);

      await ctx.auditLog.actionFailed({
        actionId: command.requestId,
        operation: command.operation,
        driver: driver.name,
        errorCode: result.error.code,
        errorMessage: result.error.message,
      });

      if (actionPlan) {
        if (isCommitPhase) {
          await ctx.idempotency.markResultUnknown(actionPlan.idempotencyKey, actionPlan.actionId);
          await ctx.actionStore.markUnknown(actionPlan.actionId);
        } else {
          await ctx.idempotency.markFailedBeforeCommit(actionPlan.idempotencyKey, actionPlan.actionId);
          await ctx.actionStore.updateStatus(actionPlan.actionId, 'failed_before_commit');
        }
      }
    }

    return finalResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = (err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined) ?? 'INTERNAL_ERROR';
    recordFailure(ctx.circuitBreaker, driver.name, errorCode, ctx.config.boss.circuit_breaker);

    const result = failedResult({
      requestId: command.requestId,
      operation: command.operation,
      driver: driver.name,
      errorCode,
      message: message || '执行异常',
    });

    await ctx.auditLog.actionFailed({
      actionId: command.requestId,
      operation: command.operation,
      driver: driver.name,
      errorCode,
      errorMessage: message || '执行异常',
    });

    if (actionPlan) {
      await ctx.idempotency.markFailedBeforeCommit(actionPlan.idempotencyKey, actionPlan.actionId);
      await ctx.actionStore.updateStatus(actionPlan.actionId, 'failed_before_commit');
    }

    return result;
  } finally {
    // Release lock if held
    if (needsLock) {
      try {
        const lock = ctx.getLock();
        await lock.release();
        await ctx.auditLog.lockEvent({
          event: 'lock.released',
          owner: route.driver,
          operation: command.operation,
        });
      } catch {
        // Lock release is best-effort
      }
    }
  }
}
