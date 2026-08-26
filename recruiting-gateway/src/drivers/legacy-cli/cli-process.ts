import { spawn, type ChildProcess } from 'node:child_process';
import type { LegacyCliConfig } from '../../gateway/config.js';

// ── CLI Process Types ──

export interface CliProcessResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  errorCode?: string;
  /** Wall-clock duration in ms */
  durationMs: number;
}

export interface CliProcessOptions {
  /** Path or command name for boss-cli */
  executable: string;
  /** Subcommand (e.g. 'list', 'chat', 'search') */
  subcommand: string;
  /** Positional and flag arguments */
  args: string[];
  /** Timeout in ms */
  timeoutMs: number;
  /** Max stdout bytes */
  maxStdoutBytes: number;
  /** Max stderr bytes */
  maxStderrBytes: number;
  /** Working directory for the child process */
  cwd?: string;
}

// ── Core Spawn Logic ──

/**
 * Spawn a boss-cli child process, capture stdout/stderr, enforce timeout.
 *
 * The boss-cli writes business output to stdout and diagnostics to stderr.
 * Exit code 0 = success; anything else = failure.
 */
export async function spawnCliProcess(opts: CliProcessOptions): Promise<CliProcessResult> {
  const startTime = Date.now();
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  let totalStdout = 0;
  let totalStderr = 0;
  let killed = false;

  return new Promise((resolve) => {
    // Build argv: `node <executable> <subcommand> <args...>`
    // If executable looks like a .js path, prepend 'node'
    const isNodeScript = opts.executable.endsWith('.js') || opts.executable.endsWith('.mjs');
    const spawnCmd = isNodeScript ? 'node' : opts.executable;
    const spawnArgs = isNodeScript
      ? [opts.executable, opts.subcommand, ...opts.args]
      : [opts.subcommand, ...opts.args];

    let proc: ChildProcess;

    try {
      proc = spawn(spawnCmd, spawnArgs, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Do not auto-kill; we manage timeout ourselves
        timeout: undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        error: `无法启动 CLI 进程: ${message}`,
        errorCode: 'LEGACY_EXECUTABLE_NOT_FOUND',
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Timeout guard
    const timer = setTimeout(() => {
      if (!killed) {
        killed = true;
        // Best-effort kill
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        // Force kill after 3s if still alive
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
      }
    }, opts.timeoutMs);

    // Capture stdout
    proc.stdout?.on('data', (data: Buffer) => {
      if (killed) return;
      totalStdout += data.length;
      if (totalStdout <= opts.maxStdoutBytes) {
        chunks.push(data);
      }
    });

    // Capture stderr
    proc.stderr?.on('data', (data: Buffer) => {
      if (killed) return;
      totalStderr += data.length;
      if (totalStderr <= opts.maxStderrBytes) {
        errChunks.push(data);
      }
    });

    // Process error (e.g. executable not found, permission denied)
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (killed) return;
      clearTimeout(timer);
      killed = true;

      let errorCode = 'INTERNAL_ERROR';
      if (err.code === 'ENOENT') {
        errorCode = 'LEGACY_EXECUTABLE_NOT_FOUND';
      }

      resolve({
        success: false,
        stdout: Buffer.concat(chunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
        exitCode: null,
        signal: null,
        error: `CLI 进程异常: ${err.message}`,
        errorCode,
        durationMs: Date.now() - startTime,
      });
    });

    // Process exit
    proc.on('close', (exitCode, signal) => {
      if (killed) {
        // We killed it via timeout
        resolve({
          success: false,
          stdout: Buffer.concat(chunks).toString('utf-8'),
          stderr: Buffer.concat(errChunks).toString('utf-8'),
          exitCode: null,
          signal: 'SIGTERM',
          error: `CLI 进程超时 (${opts.timeoutMs}ms)`,
          errorCode: 'LEGACY_TIMEOUT',
          durationMs: Date.now() - startTime,
        });
        return;
      }

      clearTimeout(timer);
      killed = true;

      const stdout = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();

      if (exitCode === 0) {
        resolve({
          success: true,
          stdout,
          stderr,
          exitCode: 0,
          signal: null,
          durationMs: Date.now() - startTime,
        });
      } else {
        resolve({
          success: false,
          stdout,
          stderr,
          exitCode,
          signal,
          error: stderr || `CLI 进程退出码: ${exitCode}`,
          errorCode: signal ? `LEGACY_SIGNAL_${signal}` : 'LEGACY_OUTPUT_UNRECOGNIZED',
          durationMs: Date.now() - startTime,
        });
      }
    });
  });
}

// ── Health Check ──

export interface CliHealthResult {
  healthy: boolean;
  status: string;
  details: Record<string, unknown>;
}

/**
 * Check if the boss-cli executable is reachable.
 *
 * strategy: run `boss version` (fast, no browser needed) and check exit code.
 */
export async function checkCliHealth(
  executable: string,
  config: LegacyCliConfig,
): Promise<CliHealthResult> {
  const result = await spawnCliProcess({
    executable,
    subcommand: 'version',
    args: [],
    timeoutMs: 10000,
    maxStdoutBytes: config.max_stdout_bytes,
    maxStderrBytes: config.max_stderr_bytes,
  });

  if (result.success) {
    return {
      healthy: true,
      status: 'healthy',
      details: { version: result.stdout, command: executable },
    };
  }

  if (result.errorCode === 'LEGACY_EXECUTABLE_NOT_FOUND') {
    return {
      healthy: false,
      status: 'unavailable',
      details: { error: result.error, command: executable },
    };
  }

  return {
    healthy: false,
    status: 'degraded',
    details: { error: result.error, command: executable, exitCode: result.exitCode },
  };
}

// ── Mock Process Client (for testing) ──

export interface MockProcessScenario {
  /** Pre-configured stdout to return */
  stdout: string;
  /** Pre-configured stderr to return */
  stderr: string;
  /** exit code */
  exitCode: number;
  /** Optional signal */
  signal?: NodeJS.Signals | null;
  /** Simulated duration in ms */
  durationMs?: number;
}

export type MockProcessFactory = (subcommand: string, args: string[]) => MockProcessScenario;

/**
 * Build a mock process handler that returns pre-configured responses
 * based on the subcommand being invoked.
 */
export function createMockProcess(scenarios: Record<string, MockProcessScenario>): {
  execute(subcommand: string, args: string[], timeoutMs: number): Promise<CliProcessResult>;
} {
  return {
    async execute(subcommand: string, _args: string[], _timeoutMs: number): Promise<CliProcessResult> {
      const scenario = scenarios[subcommand];
      if (!scenario) {
        return {
          success: false,
          stdout: '',
          stderr: `未知命令: boss ${subcommand}`,
          exitCode: 1,
          signal: null,
          error: `Unknown subcommand: ${subcommand}`,
          errorCode: 'LEGACY_OPERATION_UNSUPPORTED',
          durationMs: 0,
        };
      }

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
    },
  };
}
