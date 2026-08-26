/**
 * cli-process unit tests — spawn timeout handling, signal propagation,
 * stdout/stderr capture, and mock process factory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mocks ──

const mockProc = new EventEmitter();
mockProc.stdout = new EventEmitter();
mockProc.stderr = new EventEmitter();
(mockProc as any).kill = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockProc),
}));

import { spawn } from 'node:child_process';
import { spawnCliProcess, checkCliHealth, createMockProcess } from '../../src/drivers/legacy-cli/cli-process.js';
import type { CliProcessResult } from '../../src/drivers/legacy-cli/cli-process.js';

// ── Helpers ──

function defaultOpts(overrides: Partial<{
  executable: string;
  subcommand: string;
  args: string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  cwd: string;
}> = {}) {
  return {
    executable: 'boss',
    subcommand: 'list',
    args: ['--job', 'test-job'],
    timeoutMs: 5000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    cwd: '/tmp/test',
    ...overrides,
  };
}

function emitStdout(data: string) {
  mockProc.stdout!.emit('data', Buffer.from(data, 'utf-8'));
}

function emitStderr(data: string) {
  mockProc.stderr!.emit('data', Buffer.from(data, 'utf-8'));
}

function emitExit(code: number, signal: NodeJS.Signals | null = null) {
  // Use nextTick to let any pending data handlers run first
  setImmediate(() => mockProc.emit('close', code, signal));
}

function emitError(err: NodeJS.ErrnoException) {
  mockProc.emit('error', err);
}

function resetMocks() {
  mockProc.removeAllListeners();
  mockProc.stdout!.removeAllListeners();
  mockProc.stderr!.removeAllListeners();
  (mockProc as any).kill.mockClear();
  vi.mocked(spawn).mockClear();
}

// ── spawnCliProcess tests ──

describe('spawnCliProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── success ──

  it('resolves success when process exits with code 0', async () => {
    const promise = spawnCliProcess(defaultOpts());

    emitStdout('{"candidates": [{"name": "张三"}]}');
    emitExit(0);

    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('张三');
    expect(result.stderr).toBe('');
    expect(result.signal).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes correct arguments to spawn for non-js executable', async () => {
    const promise = spawnCliProcess(defaultOpts({ executable: 'boss', subcommand: 'search', args: ['--query', '前端'] }));
    emitExit(0);
    vi.runAllTimers();
    await promise;

    expect(spawn).toHaveBeenCalledWith('boss', ['search', '--query', '前端'], expect.any(Object));
  });

  it('prepends node for .js executables', async () => {
    const promise = spawnCliProcess(defaultOpts({ executable: 'boss-cli.js', subcommand: 'list', args: [] }));
    emitExit(0);
    vi.runAllTimers();
    await promise;

    expect(spawn).toHaveBeenCalledWith('node', ['boss-cli.js', 'list'], expect.any(Object));
  });

  it('prepends node for .mjs executables', async () => {
    const promise = spawnCliProcess(defaultOpts({ executable: 'boss-cli.mjs', subcommand: 'list', args: [] }));
    emitExit(0);
    vi.runAllTimers();
    await promise;

    expect(spawn).toHaveBeenCalledWith('node', ['boss-cli.mjs', 'list'], expect.any(Object));
  });

  it('passes cwd to spawn options', async () => {
    const promise = spawnCliProcess(defaultOpts({ cwd: '/custom/dir' }));
    emitExit(0);
    vi.runAllTimers();
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      'boss', ['list', '--job', 'test-job'],
      expect.objectContaining({ cwd: '/custom/dir' }),
    );
  });

  // ── failure with non-zero exit code ──

  it('resolves failure when process exits with non-zero code', async () => {
    const promise = spawnCliProcess(defaultOpts());
    emitStderr('Error: boss not logged in');
    emitExit(1);
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not logged in');
    expect(result.error).toContain('not logged in');
    expect(result.errorCode).toBe('LEGACY_OUTPUT_UNRECOGNIZED');
  });

  it('sets errorCode based on signal when process is killed by signal', async () => {
    const promise = spawnCliProcess(defaultOpts());
    emitStderr('');
    emitExit(null, 'SIGTERM');
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.signal).toBe('SIGTERM');
    expect(result.errorCode).toBe('LEGACY_SIGNAL_SIGTERM');
  });

  // ── spawn error ──

  it('resolves failure when spawn throws synchronously', async () => {
    (spawn as any).mockImplementationOnce(() => { throw new Error('ENOENT'); });

    const result = await spawnCliProcess(defaultOpts());

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('LEGACY_EXECUTABLE_NOT_FOUND');
    expect(result.error).toContain('无法启动');
    expect(result.stdout).toBe('');
  });

  it('resolves failure when process emits error event (ENOENT)', async () => {
    const promise = spawnCliProcess(defaultOpts());

    emitError(Object.assign(new Error('spawn boss ENOENT'), { code: 'ENOENT' }));
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('LEGACY_EXECUTABLE_NOT_FOUND');
    expect(result.error).toContain('CLI 进程异常');
  });

  it('resolves failure when process emits non-ENOENT error', async () => {
    const promise = spawnCliProcess(defaultOpts());

    emitError(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INTERNAL_ERROR');
    expect(result.error).toContain('Permission denied');
  });

  // ── timeout ──

  it('resolves failure when timeout is exceeded', async () => {
    const promise = spawnCliProcess(defaultOpts({ timeoutMs: 1000 }));

    emitStdout('partial output...');
    // Advance time past the timeout
    vi.advanceTimersByTime(1100);
    // Simulate process closing after kill
    mockProc.emit('close', null, 'SIGTERM');
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('LEGACY_TIMEOUT');
    expect(result.signal).toBe('SIGTERM');
    expect(result.stdout).toContain('partial output');
    expect(result.error).toContain('超时');
  });

  it('calls proc.kill with SIGTERM on timeout', async () => {
    const promise = spawnCliProcess(defaultOpts({ timeoutMs: 500 }));

    vi.advanceTimersByTime(600);
    // Simulate process closing after kill
    mockProc.emit('close', null, 'SIGTERM');
    vi.runAllTimers();
    await promise;

    expect((mockProc as any).kill).toHaveBeenCalledWith('SIGTERM');
  });

  // ── stdout/stderr truncation ──

  it('truncates stdout beyond maxStdoutBytes', async () => {
    const promise = spawnCliProcess(defaultOpts({ maxStdoutBytes: 10 }));

    emitStdout('abcde');       // 5 bytes, fits within 10
    emitStdout('fghijklm');    // 8 bytes, total 13 > 10, dropped
    emitExit(0);
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('abcde');
    expect(result.stdout).not.toContain('fghijklm');
  });

  it('truncates stderr beyond maxStderrBytes', async () => {
    const promise = spawnCliProcess(defaultOpts({ maxStderrBytes: 5 }));

    emitStderr('err');   // 3 bytes, fits within 5
    emitStderr('orXX');  // 4 bytes, total 7 > 5, dropped
    emitExit(1);
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.stderr).toBe('err');
  });

  // ── data after kill is ignored ──

  it('ignores stdout data after process is killed by timeout', async () => {
    const promise = spawnCliProcess(defaultOpts({ timeoutMs: 100 }));

    vi.advanceTimersByTime(200);
    // Data arrives after kill
    emitStdout('late-data');
    // Process closes
    mockProc.emit('close', null, 'SIGTERM');
    vi.runAllTimers();
    const result = await promise;

    expect(result.stdout).not.toContain('late-data');
  });

  // ── process error after kill ──

  it('ignores process error event after kill', async () => {
    const promise = spawnCliProcess(defaultOpts({ timeoutMs: 100 }));

    vi.advanceTimersByTime(200);
    // Error arrives after kill
    emitError(Object.assign(new Error('late error'), { code: 'ECONNRESET' }));
    // Process closes
    mockProc.emit('close', null, 'SIGTERM');
    vi.runAllTimers();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('LEGACY_TIMEOUT'); // timeout wins, not the late error
  });
});

// ── checkCliHealth tests ──

describe('checkCliHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns healthy when version command succeeds', async () => {
    const promise = checkCliHealth('boss', {
      executable: 'boss',
      default_timeout_ms: 60000,
      max_stdout_bytes: 65536,
      max_stderr_bytes: 65536,
    });

    emitStdout('boss-cli v1.2.3');
    emitExit(0);
    vi.runAllTimers();
    const result = await promise;

    expect(result.healthy).toBe(true);
    expect(result.status).toBe('healthy');
    expect(result.details.version).toContain('v1.2.3');
  });

  it('returns unavailable when executable not found', async () => {
    (spawn as any).mockImplementationOnce(() => { throw new Error('ENOENT'); });

    const result = await checkCliHealth('boss', {
      executable: 'boss',
      default_timeout_ms: 60000,
      max_stdout_bytes: 65536,
      max_stderr_bytes: 65536,
    });

    expect(result.healthy).toBe(false);
    expect(result.status).toBe('unavailable');
    expect(result.details.error).toContain('无法启动');
  });

  it('returns degraded for non-zero exit code', async () => {
    const promise = checkCliHealth('boss', {
      executable: 'boss',
      default_timeout_ms: 60000,
      max_stdout_bytes: 65536,
      max_stderr_bytes: 65536,
    });

    emitStderr('version check failed');
    emitExit(1);
    vi.runAllTimers();
    const result = await promise;

    expect(result.healthy).toBe(false);
    expect(result.status).toBe('degraded');
    expect(result.details.exitCode).toBe(1);
  });
});

// ── createMockProcess tests ──

describe('createMockProcess', () => {
  it('returns success for a subcommand with exitCode 0', async () => {
    const mock = createMockProcess({
      list: { stdout: '[{"name":"张三"}]', stderr: '', exitCode: 0 },
    });

    const result = await mock.execute('list', [], 5000);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('[{"name":"张三"}]');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(100); // default
  });

  it('returns failure for a subcommand with non-zero exitCode', async () => {
    const mock = createMockProcess({
      search: { stdout: '', stderr: '无结果', exitCode: 1 },
    });

    const result = await mock.execute('search', ['--query', 'xyz'], 5000);

    expect(result.success).toBe(false);
    expect(result.stderr).toBe('无结果');
    expect(result.errorCode).toBe('LEGACY_OUTPUT_UNRECOGNIZED');
  });

  it('returns error for unknown subcommand', async () => {
    const mock = createMockProcess({});

    const result = await mock.execute('nonexistent', [], 5000);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('LEGACY_OPERATION_UNSUPPORTED');
    expect(result.stderr).toContain('未知命令');
  });

  it('uses passed durationMs from scenario', async () => {
    const mock = createMockProcess({
      list: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 250 },
    });

    const result = await mock.execute('list', [], 5000);
    expect(result.durationMs).toBe(250);
  });

  it('defaults signal to null', async () => {
    const mock = createMockProcess({
      list: { stdout: 'ok', stderr: '', exitCode: 0 },
    });

    const result = await mock.execute('list', [], 5000);
    expect(result.signal).toBeNull();
  });

  it('preserves explicit signal value', async () => {
    const mock = createMockProcess({
      list: { stdout: '', stderr: 'killed', exitCode: null as any, signal: 'SIGTERM' },
    });

    const result = await mock.execute('list', [], 5000);
    expect(result.signal).toBe('SIGTERM');
  });
});
