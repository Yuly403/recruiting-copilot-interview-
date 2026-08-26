import type { Driver, DriverExecuteInput, DriverHealthCheck } from '../driver.js';
import type { GatewayResult } from '../../contracts/result.js';
import { successResult, failedResult } from '../../contracts/result.js';
import type { LegacyCliConfig } from '../../gateway/config.js';
import {
  spawnCliProcess,
  type CliProcessResult,
  type MockProcessFactory,
} from './cli-process.js';
import {
  mapOperationToCli,
  isSupportedByLegacyCli,
} from './command-map.js';
import { parseCliOutput } from './output-parser.js';

// ── Legacy CLI Driver (per PRD §9) ──

/**
 * Convert a CliProcessResult to a GatewayResult.
 */
function cliResultToGatewayResult(
  result: CliProcessResult,
  requestId: string,
  operation: string,
  driverName: string,
): GatewayResult {
  const now = new Date().toISOString();

  if (result.success) {
    const parsed = parseCliOutput(operation, result.stdout);
    return successResult({
      requestId,
      operation,
      driver: driverName,
      data: {
        ...parsed.parsed,
        rawOutput: parsed.rawOutput,
        fullyParsed: parsed.fullyParsed,
        durationMs: result.durationMs,
      },
      warnings: result.stderr ? [{ code: 'LEGACY_STDERR', message: result.stderr }] : [],
      startedAt: now,
      finishedAt: now,
    });
  }

  // Timeout
  if (result.errorCode === 'LEGACY_TIMEOUT') {
    return failedResult({
      requestId,
      operation,
      driver: driverName,
      errorCode: 'LEGACY_TIMEOUT',
      message: result.error ?? `CLI 进程超时`,
      details: {
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      },
    });
  }

  // Executable not found
  if (result.errorCode === 'LEGACY_EXECUTABLE_NOT_FOUND') {
    return failedResult({
      requestId,
      operation,
      driver: driverName,
      errorCode: 'LEGACY_EXECUTABLE_NOT_FOUND',
      message: result.error ?? 'boss-cli 可执行文件未找到',
      details: { stderr: result.stderr },
    });
  }

  // CLI returned non-zero exit code
  if (result.exitCode !== null && result.exitCode !== 0) {
    return failedResult({
      requestId,
      operation,
      driver: driverName,
      errorCode: result.errorCode ?? 'LEGACY_OUTPUT_UNRECOGNIZED',
      message: result.error ?? `CLI 进程退出码: ${result.exitCode}`,
      details: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
      },
    });
  }

  // Unknown failure
  return failedResult({
    requestId,
    operation,
    driver: driverName,
    errorCode: 'INTERNAL_ERROR',
    message: result.error ?? 'CLI 进程未知错误',
    details: {
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    },
  });
}

// ── Execute function type (for dependency injection) ──

type ProcessExecutor = (
  subcommand: string,
  args: string[],
  timeoutMs: number,
) => Promise<CliProcessResult>;

// ── Driver Factory ──

export interface LegacyCliDriverOptions {
  config: LegacyCliConfig;
  /** Optional: inject a mock process executor (testing) */
  processExecutor?: ProcessExecutor;
  /** Optional: working directory for the child process */
  cwd?: string;
}

export function createLegacyCliDriver(options: LegacyCliDriverOptions): Driver {
  const { config, cwd } = options;
  const driverName = 'legacy_cli';

  // If a mock executor is provided, use it; otherwise use real spawn
  const executeProcess: ProcessExecutor = options.processExecutor
    ?? (async (subcommand, args, timeoutMs) => {
      const processOpts = {
        executable: config.executable,
        subcommand,
        args,
        timeoutMs,
        maxStdoutBytes: config.max_stdout_bytes,
        maxStderrBytes: config.max_stderr_bytes,
        cwd,
      };
      return spawnCliProcess(processOpts);
    });

  return {
    name: driverName,

    async health(): Promise<DriverHealthCheck> {
      try {
        // Use the injected executor if available, otherwise use real spawn
        const result = await executeProcess('version', [], 10000);

        if (result.success) {
          return {
            healthy: true,
            status: 'healthy',
            details: { version: result.stdout, command: config.executable },
          };
        }

        if (result.errorCode === 'LEGACY_EXECUTABLE_NOT_FOUND') {
          return {
            healthy: false,
            status: 'unavailable',
            details: { error: result.error, command: config.executable },
          };
        }

        return {
          healthy: false,
          status: 'degraded',
          details: { error: result.error, command: config.executable, exitCode: result.exitCode },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          healthy: false,
          status: 'unavailable',
          details: { error: message },
        };
      }
    },

    async execute(input: DriverExecuteInput): Promise<GatewayResult> {
      const { command, timeoutMs } = input;

      // Check if this operation is supported by legacy_cli
      if (!isSupportedByLegacyCli(command.operation)) {
        return failedResult({
          requestId: command.requestId,
          operation: command.operation,
          driver: driverName,
          errorCode: 'LEGACY_OPERATION_UNSUPPORTED',
          message: `操作 "${command.operation}" 不支持 legacy_cli 驱动`,
        });
      }

      // Map operation to CLI command
      const mapping = mapOperationToCli(command);
      if (!mapping) {
        return failedResult({
          requestId: command.requestId,
          operation: command.operation,
          driver: driverName,
          errorCode: 'INVALID_COMMAND',
          message: `无法将操作 "${command.operation}" 映射到 boss-cli 命令（缺少必要参数）`,
        });
      }

      // Use the configured timeout or the input timeout override
      const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : config.default_timeout_ms;

      try {
        const result = await executeProcess(
          mapping.subcommand,
          mapping.args,
          effectiveTimeoutMs,
        );

        return cliResultToGatewayResult(
          result,
          command.requestId,
          command.operation,
          driverName,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failedResult({
          requestId: command.requestId,
          operation: command.operation,
          driver: driverName,
          errorCode: 'INTERNAL_ERROR',
          message: message || 'legacy_cli 驱动执行异常',
        });
      }
    },

    async stop(): Promise<void> {
      // Legacy CLI driver doesn't maintain long-running processes;
      // each command spawns a new child process that exits on its own.
      // No explicit stop needed for stateless execution.
    },
  };
}

// ── Test Helpers ──

/**
 * Create a process executor from a mock process factory.
 * Use in tests to simulate boss-cli output.
 */
export function createMockProcessExecutor(
  factory: MockProcessFactory,
): ProcessExecutor {
  return async (subcommand: string, args: string[], _timeoutMs: number) => {
    const scenario = factory(subcommand, args);
    return {
      success: scenario.exitCode === 0,
      stdout: scenario.stdout,
      stderr: scenario.stderr,
      exitCode: scenario.exitCode,
      signal: scenario.signal ?? null,
      error: scenario.exitCode !== 0
        ? (scenario.stderr || `Exit code ${scenario.exitCode}`)
        : undefined,
      errorCode: scenario.exitCode !== 0 ? 'LEGACY_OUTPUT_UNRECOGNIZED' : undefined,
      durationMs: scenario.durationMs ?? 100,
    };
  };
}
