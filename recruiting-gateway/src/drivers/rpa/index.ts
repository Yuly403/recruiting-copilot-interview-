import type { Driver, DriverExecuteInput, DriverHealthCheck } from '../driver.js';
import type { GatewayResult } from '../../contracts/result.js';
import { successResult, failedResult, pausedResult } from '../../contracts/result.js';
import type { RpaConfig } from '../../gateway/config.js';
import type { ActionPlan } from '../../contracts/action-plan.js';
import {
  type NamedPipeClient,
  createNamedPipeClient,
  createMockPipeClient,
  type RpaResponse,
} from './named-pipe-client.js';
import { buildRpaRequest, mapOperationToFlow } from './flow-map.js';

// ── RPA Driver (per PRD §10) ──

/** Possible RPA adapter modes */
type RpaAdapterMode = 'named-pipe' | 'mock';

/**
 * Translate an RPA Runner response to a GatewayResult.
 */
function rpaResponseToResult(
  response: RpaResponse,
  requestId: string,
  operation: string,
  driverName: string,
): GatewayResult {
  const now = new Date().toISOString();

  switch (response.status) {
    case 'succeeded':
      return successResult({
        requestId,
        operation,
        driver: driverName,
        data: response.observations ?? {},
        startedAt: now,
        finishedAt: now,
      });

    case 'paused':
      return pausedResult({
        requestId,
        operation,
        driver: driverName,
        reason: response.error?.message ?? 'RPA 操作已暂停',
        code: response.error?.code,
        details: response.observations ?? undefined,
      });

    case 'result_unknown':
      return failedResult({
        requestId,
        operation,
        driver: driverName,
        errorCode: 'RESULT_UNKNOWN',
        message: response.error?.message ?? 'RPA 执行结果不确定',
        details: { observations: response.observations, originalError: response.error },
      });

    case 'failed':
    default:
      return failedResult({
        requestId,
        operation,
        driver: driverName,
        errorCode: response.error?.code ?? 'INTERNAL_ERROR',
        message: response.error?.message ?? 'RPA 执行失败',
        details: response.observations ?? undefined,
      });
  }
}

/**
 * Create a Named Pipe client based on config adapter mode.
 */
function createPipeClient(config: RpaConfig): NamedPipeClient {
  if (config.adapter === 'mock') {
    return createMockPipeClient('success');
  }
  return createNamedPipeClient(config);
}

// ── RPA Driver Factory ──

export interface RpaDriverOptions {
  config: RpaConfig;
  /** Optional: inject a custom pipe client (testing) */
  pipeClient?: NamedPipeClient;
}

export function createRpaDriver(options: RpaDriverOptions): Driver {
  const { config } = options;
  const pipeClient = options.pipeClient ?? createPipeClient(config);
  const driverName = 'rpa';

  return {
    name: driverName,

    async health(): Promise<DriverHealthCheck> {
      if (config.adapter === 'mock' && !config.allow_mock_writes) {
        return {
          healthy: false,
          status: 'unavailable',
          details: { error: 'mock RPA is test-only; set allow_mock_writes only in isolated tests' },
        };
      }
      const result = await pipeClient.health();
      if (result.success && result.data) {
        return {
          healthy: result.data.healthy,
          status: result.data.healthy ? 'healthy' : (result.data.status === 'unavailable' ? 'unavailable' : 'degraded'),
          details: result.data.details,
        };
      }
      return {
        healthy: false,
        status: 'unavailable',
        details: { error: result.error, errorCode: result.errorCode },
      };
    },

    async execute(input: DriverExecuteInput): Promise<GatewayResult> {
      const { command, timeoutMs } = input;
      const actionPlan = input.actionPlan as ActionPlan | null | undefined;

      if (config.adapter === 'mock' && !config.allow_mock_writes) {
        return failedResult({
          requestId: command.requestId,
          operation: command.operation,
          driver: driverName,
          errorCode: 'CONFIG_INVALID',
          message: 'mock RPA 仅用于隔离测试，生产写操作必须连接真实且可验证的 RPA Runner',
        });
      }

      // Validate that this operation has an RPA flow mapping
      const flow = mapOperationToFlow(command.operation);
      if (!flow) {
        return failedResult({
          requestId: command.requestId,
          operation: command.operation,
          driver: driverName,
          errorCode: 'LEGACY_OPERATION_UNSUPPORTED',
          message: `操作 "${command.operation}" 不支持 RPA 执行`,
        });
      }

      // Build the RPA request
      try {
        const request = buildRpaRequest(command, actionPlan ?? null, timeoutMs, input.executionTicket);

        // Send to RPA Runner
        const pipeResult = await pipeClient.send(request);

        if (!pipeResult.success) {
          return failedResult({
            requestId: command.requestId,
            operation: command.operation,
            driver: driverName,
            errorCode: pipeResult.errorCode ?? 'RPA_UNAVAILABLE',
            message: pipeResult.error ?? 'RPA 通信失败',
          });
        }

        // Translate response to GatewayResult
        return rpaResponseToResult(
          pipeResult.data!,
          command.requestId,
          command.operation,
          driverName,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errCode = (err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined);
        return failedResult({
          requestId: command.requestId,
          operation: command.operation,
          driver: driverName,
          errorCode: errCode ?? 'INTERNAL_ERROR',
          message: message || 'RPA 执行异常',
        });
      }
    },

    async stop(): Promise<void> {
      try {
        const stopRequest = {
          schemaVersion: '1.0' as const,
          requestId: `stop_${Date.now()}`,
          flow: 'boss.stop' as const,
          deadlineAt: new Date(Date.now() + 10000).toISOString(),
          payload: {},
        };
        await pipeClient.send(stopRequest);
      } catch {
        // Stop is best-effort
      }
    },
  };
}
