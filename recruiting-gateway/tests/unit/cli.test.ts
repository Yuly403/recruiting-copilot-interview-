/**
 * CLI entry tests — recruitctl argument parsing, output formatting,
 * and main() flow with mocked gateway dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks (hoisted by Vitest) ──

const mockExecute = vi.fn();
const mockStop = vi.fn();
const mockHealth = vi.fn();

vi.mock('../../src/gateway/index.js', () => ({
  createGateway: vi.fn(() =>
    Promise.resolve({
      execute: mockExecute,
      stop: mockStop,
      health: mockHealth,
    }),
  ),
}));

vi.mock('../../src/doctor/index.js', () => ({
  runDoctor: vi.fn(() =>
    Promise.resolve({
      healthy: true,
      checks: [
        { name: 'config', status: 'ok' },
        { name: 'runtime_dir', status: 'ok' },
      ],
      summary: 'All checks passed',
    }),
  ),
  formatDoctorReport: vi.fn((report: any) => `HEALTH: ${report.healthy ? 'OK' : 'FAIL'}`),
}));

// Static imports — vi.mock hoisting ensures mocks take effect first
import { parseArgs, formatResult, main } from '../../src/cli/index.js';

// ── Helpers ──

function makeSuccessResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    requestId: 'req_test_abc123',
    operation: 'candidates.search',
    status: 'succeeded',
    driver: 'legacy_cli',
    data: { count: 5 },
    warnings: [],
    error: null,
    startedAt: '2026-07-22T10:00:00.000Z',
    finishedAt: '2026-07-22T10:00:02.000Z',
    ...overrides,
  };
}

function makeFailedResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    requestId: 'req_test_abc123',
    operation: 'candidates.search',
    status: 'failed',
    driver: 'legacy_cli',
    data: {},
    warnings: [],
    error: { code: 'EXECUTION_FAILED', message: 'Process crashed' },
    startedAt: '2026-07-22T10:00:00.000Z',
    finishedAt: '2026-07-22T10:00:02.000Z',
    ...overrides,
  };
}

function makeDeniedResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    requestId: 'req_test_abc123',
    operation: 'message.commit',
    status: 'denied',
    driver: 'gateway_local',
    data: {},
    warnings: [],
    error: { code: 'APPROVAL_MISSING', message: '审批未完成' },
    startedAt: '2026-07-22T10:00:00.000Z',
    finishedAt: '2026-07-22T10:00:00.000Z',
    ...overrides,
  };
}

function makePausedResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    requestId: 'req_test_abc123',
    operation: 'session.login',
    status: 'paused',
    driver: 'human',
    data: {},
    warnings: [],
    error: { code: 'HUMAN_REQUIRED', message: '需要人工处理' },
    startedAt: '2026-07-22T10:00:00.000Z',
    finishedAt: '2026-07-22T10:00:00.000Z',
    ...overrides,
  };
}

// ── parseArgs tests ──

describe('parseArgs', () => {
  it('parses a simple operation', () => {
    const args = parseArgs(['node', 'recruitctl', 'session.login']);
    expect(args.operation).toBe('session.login');
    expect(args.options).toEqual({});
    expect(args.help).toBe(false);
    expect(args.version).toBe(false);
  });

  it('recognizes --help / -h', () => {
    expect(parseArgs(['node', 'recruitctl', '--help']).help).toBe(true);
    expect(parseArgs(['node', 'recruitctl', '-h']).help).toBe(true);
  });

  it('recognizes --version / -V', () => {
    expect(parseArgs(['node', 'recruitctl', '--version']).version).toBe(true);
    expect(parseArgs(['node', 'recruitctl', '-V']).version).toBe(true);
  });

  it('parses --config / -c', () => {
    const a = parseArgs(['node', 'recruitctl', '--config', '/path/to/config.json', 'op']);
    expect(a.configPath).toBe('/path/to/config.json');
    expect(a.operation).toBe('op');

    const b = parseArgs(['node', 'recruitctl', '-c', '/other.json', 'op']);
    expect(b.configPath).toBe('/other.json');
  });

  it('parses --workspace / -w', () => {
    expect(
      parseArgs(['node', 'recruitctl', '--workspace', '/my/ws', 'op']).workspace,
    ).toBe('/my/ws');
    expect(
      parseArgs(['node', 'recruitctl', '-w', '/other/ws', 'op']).workspace,
    ).toBe('/other/ws');
  });

  it('parses --format json|text', () => {
    expect(
      parseArgs(['node', 'recruitctl', '--format', 'json', 'op']).format,
    ).toBe('json');
    expect(
      parseArgs(['node', 'recruitctl', '--format', 'text', 'op']).format,
    ).toBe('text');
    // invalid format falls back to default
    expect(
      parseArgs(['node', 'recruitctl', '--format', 'yaml', 'op']).format,
    ).toBe('json');
  });

  it('parses boolean flags (--unread, --match)', () => {
    const args = parseArgs(['node', 'recruitctl', 'candidates.list', '--unread']);
    expect(args.options.unread).toBe(true);
    expect(args.options.match).toBeUndefined();
  });

  it('parses key=value options (--name, --job, --query)', () => {
    const args = parseArgs([
      'node', 'recruitctl', 'candidates.search',
      '--name', '张三', '--job', 'job-001', '--query', '前端 3年',
    ]);
    expect(args.options.name).toBe('张三');
    expect(args.options.job).toBe('job-001');
    expect(args.options.query).toBe('前端 3年');
  });

  it('converts kebab-case option keys to camelCase', () => {
    const args = parseArgs([
      'node', 'recruitctl', 'candidate.preview',
      '--displayed-name', '张三丰', '--payload-file', './msg.txt',
    ]);
    expect(args.options.displayedName).toBe('张三丰');
    expect(args.options.payloadFile).toBe('./msg.txt');
  });

  it('defaults workspace to "."', () => {
    const args = parseArgs(['node', 'recruitctl', 'session.status']);
    expect(args.workspace).toBe('.');
  });

  it('defaults format to "json"', () => {
    const args = parseArgs(['node', 'recruitctl', 'session.status']);
    expect(args.format).toBe('json');
  });

  it('handles mixed flags and options around the operation', () => {
    const args = parseArgs([
      'node', 'recruitctl', '--config', '/c.json',
      'candidates.search', '--query', '后端',
      '--unread', '--match', '--name', '李四',
    ]);
    expect(args.configPath).toBe('/c.json');
    expect(args.operation).toBe('candidates.search');
    expect(args.options.query).toBe('后端');
    expect(args.options.unread).toBe(true);
    expect(args.options.match).toBe(true);
    expect(args.options.name).toBe('李四');
  });

  it('treats first non-option arg as operation', () => {
    const args = parseArgs(['node', 'recruitctl', '--unread', 'positions.list']);
    // --unread is a boolean flag, not an operation
    expect(args.operation).toBe('positions.list');
    expect(args.options.unread).toBe(true);
  });
});

// ── formatResult tests ──

describe('formatResult', () => {
  it('formats success result as JSON', () => {
    const result = makeSuccessResult();
    const output = formatResult(result, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('succeeded');
    expect(parsed.operation).toBe('candidates.search');
    expect(parsed.data.count).toBe(5);
  });

  it('formats success result as text', () => {
    const result = makeSuccessResult();
    const output = formatResult(result, 'text');
    expect(output).toContain('操作: candidates.search');
    expect(output).toContain('状态: succeeded');
    expect(output).toContain('驱动器: legacy_cli');
    expect(output).toContain('请求ID: req_test_abc123');
    expect(output).toContain('数据:');
  });

  it('includes error in text format', () => {
    const result = makeFailedResult();
    const output = formatResult(result, 'text');
    expect(output).toContain('错误: [EXECUTION_FAILED] Process crashed');
  });

  it('includes warnings in text format', () => {
    const result = makeSuccessResult({
      warnings: [
        { code: 'WARN_DEPRECATED', message: 'API version deprecated' },
        { code: 'WARN_SLOW', message: 'Response took 5s' },
      ],
    });
    const output = formatResult(result, 'text');
    expect(output).toContain('警告:');
    expect(output).toContain('[WARN_DEPRECATED] API version deprecated');
    expect(output).toContain('[WARN_SLOW] Response took 5s');
  });

  it('handles data with special characters in text format', () => {
    const result = makeSuccessResult({
      data: { name: '张三', tags: ['前端', 'React'], nested: { key: '中文' } },
    });
    const output = formatResult(result, 'text');
    expect(output).toContain('张三');
    expect(output).toContain('前端');
    expect(output).toContain('中文');
  });

  it('handles non-object data gracefully in text', () => {
    const result = makeSuccessResult({ data: 'plain string' });
    const output = formatResult(result, 'text');
    // data is not an object with keys, so no "数据:" section
    expect(output).not.toContain('数据:');
  });

  it('handles empty object data in text', () => {
    const result = makeSuccessResult({ data: {} });
    const output = formatResult(result, 'text');
    expect(output).not.toContain('数据:');
  });

  it('formats failed result as JSON', () => {
    const result = makeFailedResult();
    const output = formatResult(result, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('failed');
    expect(parsed.error.code).toBe('EXECUTION_FAILED');
  });
});

// ── main() integration tests ──

describe('main()', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Only clear call history, preserve mock implementations set per-test
    mockExecute.mockClear();
    mockStop.mockClear();
    mockHealth.mockClear();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ── help / version ──

  it('prints help and returns 0 for --help', async () => {
    const code = await main(['node', 'recruitctl', '--help']);
    expect(code).toBe(0);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('recruitctl');
    expect(output).toContain('用法');
    expect(output).toContain('--help');
    expect(output).toContain('--version');
  });

  it('prints help and returns 0 for -h', async () => {
    const code = await main(['node', 'recruitctl', '-h']);
    expect(code).toBe(0);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('recruitctl');
  });

  it('prints version and returns 0 for --version', async () => {
    const code = await main(['node', 'recruitctl', '--version']);
    expect(code).toBe(0);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('recruitctl v');
  });

  it('prints version and returns 0 for -V', async () => {
    const code = await main(['node', 'recruitctl', '-V']);
    expect(code).toBe(0);
  });

  // ── missing operation ──

  it('returns 1 when no operation is given', async () => {
    const code = await main(['node', 'recruitctl']);
    expect(code).toBe(1);
    const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('请指定操作');
  });

  // ── invalid operation ──

  it('returns 1 for an invalid operation', async () => {
    const code = await main(['node', 'recruitctl', 'nonexistent.op']);
    expect(code).toBe(1);
    const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('无效的操作');
    expect(output).toContain('nonexistent.op');
  });

  // ── normal execution flows ──

  it('executes a read operation and returns 0 on success (JSON)', async () => {
    mockExecute.mockResolvedValueOnce(makeSuccessResult());

    const code = await main([
      'node', 'recruitctl', 'candidates.search', '--query', '前端',
    ]);

    expect(code).toBe(0);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // gw.stop() is only called on error/failure paths, not on success

    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('succeeded');
  });

  it('executes a read operation and returns 0 on success (text)', async () => {
    mockExecute.mockResolvedValueOnce(makeSuccessResult());

    const code = await main([
      'node', 'recruitctl', '--format', 'text', 'candidates.search', '--query', 'test',
    ]);

    expect(code).toBe(0);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('操作: candidates.search');
    expect(output).toContain('状态: succeeded');
    expect(output).toContain('驱动器: legacy_cli');
  });

  it('returns 2 for failed execution', async () => {
    mockExecute.mockResolvedValueOnce(makeFailedResult());

    const code = await main([
      'node', 'recruitctl', 'candidates.search', '--query', 'test',
    ]);

    expect(code).toBe(2);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('failed');
  });

  it('returns 3 for denied execution', async () => {
    mockExecute.mockResolvedValueOnce(makeDeniedResult());

    const code = await main([
      'node', 'recruitctl', 'message.commit', '--name', '张三', '--plan', './plan.json',
    ]);

    expect(code).toBe(3);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('denied');
  });

  it('returns 4 for paused execution', async () => {
    mockExecute.mockResolvedValueOnce(makePausedResult());

    const code = await main(['node', 'recruitctl', 'session.login']);

    expect(code).toBe(4);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('paused');
  });

  it('passes camelCase options from CLI to gateway command input', async () => {
    mockExecute.mockResolvedValueOnce(makeSuccessResult());

    const code = await main([
      'node', 'recruitctl', 'candidate.preview',
      '--name', '张三', '--displayed-name', '张三丰',
    ]);

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'candidate.preview',
        input: expect.objectContaining({
          name: '张三',
          displayedName: '张三丰',
        }),
      }),
    );
  });

  // ── gateway init failure ──

  it('returns 1 when gateway initialization fails', async () => {
    const { createGateway } = await import('../../src/gateway/index.js');
    (createGateway as any).mockRejectedValueOnce(new Error('Init failed'));

    const code = await main(['node', 'recruitctl', 'candidates.list']);
    expect(code).toBe(1);
    const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('网关初始化失败');
    expect(output).toContain('Init failed');
  });

  // ── execution exception ──

  it('returns 1 and calls gw.stop() on execution exception', async () => {
    mockExecute.mockRejectedValueOnce(new Error('Boom'));
    mockStop.mockResolvedValueOnce(undefined);

    const code = await main(['node', 'recruitctl', 'candidates.list']);

    expect(code).toBe(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
    const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('执行异常');
    expect(output).toContain('Boom');
  });

  // ── doctor command ──

  it('runs doctor and prints JSON report on success', async () => {
    const code = await main(['node', 'recruitctl', 'doctor']);
    expect(code).toBe(0);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.healthy).toBe(true);
    expect(parsed.checks).toBeDefined();
  });

  it('runs doctor and prints text report when --format text', async () => {
    const code = await main([
      'node', 'recruitctl', 'doctor', '--format', 'text',
    ]);
    expect(code).toBe(0);
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('HEALTH: OK');
  });

  it('returns 1 when doctor reports unhealthy', async () => {
    const { runDoctor } = await import('../../src/doctor/index.js');
    (runDoctor as any).mockResolvedValueOnce({
      healthy: false,
      checks: [{ name: 'config', status: 'fail', error: 'Missing config' }],
      summary: 'Health check failed',
    });

    const code = await main(['node', 'recruitctl', 'doctor']);
    expect(code).toBe(1);
  });

  it('returns 1 when doctor throws', async () => {
    const { runDoctor } = await import('../../src/doctor/index.js');
    (runDoctor as any).mockRejectedValueOnce(new Error('Doctor crashed'));

    const code = await main(['node', 'recruitctl', 'doctor']);
    expect(code).toBe(1);
    const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('doctor 检查失败');
    expect(output).toContain('Doctor crashed');
  });

  it('passes custom config path to doctor', async () => {
    const { runDoctor } = await import('../../src/doctor/index.js');
    (runDoctor as any).mockResolvedValueOnce({
      healthy: true,
      checks: [],
      summary: 'OK',
    });

    await main([
      'node', 'recruitctl', 'doctor', '--config', '/custom/gateway.json',
    ]);

    expect(runDoctor).toHaveBeenCalledWith(
      expect.stringContaining('/custom/gateway.json'),
    );
  });
});
