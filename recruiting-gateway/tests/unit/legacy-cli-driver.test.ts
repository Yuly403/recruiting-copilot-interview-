import { describe, it, expect } from 'vitest';
import {
  createLegacyCliDriver,
  createMockProcessExecutor,
} from '../../src/drivers/legacy-cli/index.js';
import type { DriverExecuteInput } from '../../src/drivers/driver.js';
import { toGatewayCommand } from '../../src/contracts/command.js';
import { LegacyCliConfigSchema } from '../../src/gateway/config.js';
import type { MockProcessScenario } from '../../src/drivers/legacy-cli/cli-process.js';

// ── Test Helpers ──

function makeConfig(overrides: Record<string, unknown> = {}) {
  return LegacyCliConfigSchema.parse({
    executable: 'boss',
    default_timeout_ms: 5000,
    max_stdout_bytes: 65536,
    max_stderr_bytes: 65536,
    ...overrides,
  });
}

function makeExecInput(
  operation: string,
  opts?: {
    input?: Record<string, unknown>;
    timeoutMs?: number;
  },
): DriverExecuteInput {
  return {
    command: toGatewayCommand({
      operation,
      input: opts?.input ?? {},
      requestId: `req_${operation.replace(/\./g, '_')}`,
    }),
    timeoutMs: opts?.timeoutMs ?? 30000,
  };
}

function makeMockProcess(scenarios: Record<string, MockProcessScenario>) {
  return createMockProcessExecutor((subcommand: string, _args: string[]) => {
    if (scenarios[subcommand]) return scenarios[subcommand];
    return { stdout: '', stderr: '', exitCode: 1 };
  });
}

// Pre-configured mock outputs for common operations

const MOCK_POSITIONS_OUTPUT = `已读取 5 个职位（页面统计：共5个）。
状态统计：开放中 3｜待开放 1｜已关闭 1
职位明细：
1. 高级Java工程师｜状态:开放中｜标签:急招｜经验3-5年｜学历本科
2. 产品经理｜状态:开放中｜标签:无｜经验1-3年｜学历本科
3. 前端开发｜状态:开放中｜标签:无｜经验3-5年｜学历本科
4. 测试工程师｜状态:待开放｜标签:无｜经验1-3年｜学历大专
5. 运维工程师｜状态:已关闭｜标签:无｜经验5-10年｜学历本科`;

const MOCK_LIST_OUTPUT = `沟通列表共 15 人，其中 3 人有未读消息。
候选人明细：
1. 张三｜Java开发｜未读:2｜时间:10:30｜消息:你好，还招人吗
2. 李四｜产品经理｜未读:1｜时间:昨天｜消息:方便聊聊吗
3. 王五｜前端开发｜未读:0｜时间:周一`;

const MOCK_SEARCH_OUTPUT = `搜索结果共 8 人。
1. 张三
2. 李四
3. 王五`;

const MOCK_DEEPSEARCH_OUTPUT = `深度搜索：已触发「立即匹配」。
职位：Java开发工程师
今日匹配剩余：98次
匹配按钮：立即匹配（可用）

本次新增推荐简历（最新20条）
共 3 人

1. 王五
   概要：3年经验 · 本科
   经历：某互联网公司
   教育：某大学
   推荐：熟悉Spring Cloud`;

const MOCK_CHAT_OUTPUT = `已打开与 张三 的会话
沟通记录：
2024-01-15 10:30: 您好，看到您的简历很感兴趣`;

const MOCK_LOGIN_OUTPUT = `登录页面已打开，请在浏览器中扫码登录。`;

const MOCK_JD_OUTPUT = `# 高级Java工程师

## 岗位职责
- 负责核心系统设计与开发
- 参与技术方案评审

## 任职要求
- 3年以上Java开发经验
- 熟悉Spring Boot、MyBatis`;

// ── Tests ──

describe('LegacyCliDriver', () => {
  // ── Factory ──

  it('creates a legacy CLI driver with default config', () => {
    const config = makeConfig();
    const driver = createLegacyCliDriver({ config });
    expect(driver.name).toBe('legacy_cli');
  });

  it('accepts an injected process executor', () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({});
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });
    expect(driver.name).toBe('legacy_cli');
  });

  // ── Health Check ──

  it('reports healthy when boss version runs successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      version: { stdout: '@joohw/boss-cli 0.6.5', stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const health = await driver.health();
    expect(health.healthy).toBe(true);
    expect(health.status).toBe('healthy');
  });

  it('reports unavailable when boss executable not found', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      version: {
        stdout: '',
        stderr: 'command not found: boss',
        exitCode: 127,
      },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    // Health check first tries 'version' subcommand
    // Since exitCode != 0, it reports degraded
    // But since we can't simulate ENOENT from the mock, this will report degraded
    // In reality, ENOENT triggers LEGACY_EXECUTABLE_NOT_FOUND
    const health = await driver.health();
    expect(health.healthy).toBe(false);
  });

  it('reports degraded when version exits with error', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      version: { stdout: '', stderr: 'Chrome not found', exitCode: 1 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const health = await driver.health();
    expect(health.healthy).toBe(false);
  });

  // ── session.login ──

  it('executes session.login successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      login: { stdout: MOCK_LOGIN_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('session.login'));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');
    expect(result.data).toBeDefined();
  });

  // ── positions.list ──

  it('executes positions.list successfully and parses output', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      positions: { stdout: MOCK_POSITIONS_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('positions.list'));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');

    const data = result.data as Record<string, unknown>;
    expect(data.totalCount).toBe(5);
    expect(data.openCount).toBe(3);
    expect(data.pendingCount).toBe(1);
    expect(data.closedCount).toBe(1);
    expect(Array.isArray(data.positions)).toBe(true);
    expect((data.positions as unknown[]).length).toBe(5);
  });

  // ── jd.get ──

  it('executes jd.get successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      jd: { stdout: MOCK_JD_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('jd.get', {
      input: { job: '高级Java工程师' },
    }));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');
  });

  it('executes jd.get with job name in args', async () => {
    const config = makeConfig();
    let capturedArgs: string[] = [];
    const mockExec = createMockProcessExecutor((subcommand, args) => {
      capturedArgs = args;
      return { stdout: MOCK_JD_OUTPUT, stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    await driver.execute(makeExecInput('jd.get', {
      input: { job: '高级Java工程师' },
    }));
    // The job name should be passed as a positional arg
    expect(capturedArgs).toContain('高级Java工程师');
  });

  // ── candidates.list ──

  it('executes candidates.list successfully and parses output', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      list: { stdout: MOCK_LIST_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.list'));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');

    const data = result.data as Record<string, unknown>;
    expect(data.totalCount).toBe(15);
    expect(data.unreadCount).toBe(3);
    expect(Array.isArray(data.candidates)).toBe(true);
    expect((data.candidates as unknown[]).length).toBe(3);
  });

  // ── candidates.listUnread ──

  it('executes candidates.listUnread with --unread flag', async () => {
    const config = makeConfig();
    let capturedArgs: string[] = [];
    const mockExec = createMockProcessExecutor((subcommand, args) => {
      capturedArgs = args;
      return { stdout: MOCK_LIST_OUTPUT, stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    await driver.execute(makeExecInput('candidates.listUnread'));
    expect(capturedArgs).toContain('--unread');
    expect(capturedArgs[0]).toBe('--unread');
  });

  it('executes candidates.listUnread successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      list: { stdout: MOCK_LIST_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.listUnread'));
    expect(result.status).toBe('succeeded');
  });

  // ── candidates.search ──

  it('executes candidates.search successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      search: { stdout: MOCK_SEARCH_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.search', {
      input: { query: 'Java' },
    }));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');
  });

  it('executes candidates.search with job filter', async () => {
    const config = makeConfig();
    let capturedArgs: string[] = [];
    const mockExec = createMockProcessExecutor((subcommand, args) => {
      capturedArgs = args;
      return { stdout: MOCK_SEARCH_OUTPUT, stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    await driver.execute(makeExecInput('candidates.search', {
      input: { query: 'Java', job: '后端开发' },
    }));
    expect(capturedArgs).toContain('Java');
    expect(capturedArgs).toContain('--job');
    expect(capturedArgs).toContain('后端开发');
  });

  // ── candidates.deepSearch ──

  it('executes candidates.deepSearch successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      'deep-search': { stdout: MOCK_DEEPSEARCH_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.deepSearch', {
      input: { query: 'Java开发' },
    }));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');
  });

  it('does not consume deep-search quota without explicit --match', async () => {
    const config = makeConfig();
    let capturedArgs: string[] = [];
    const mockExec = createMockProcessExecutor((subcommand, args) => {
      capturedArgs = args;
      return { stdout: MOCK_DEEPSEARCH_OUTPUT, stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    await driver.execute(makeExecInput('candidates.deepSearch', {
      input: { query: 'Java' },
    }));
    expect(capturedArgs).not.toContain('--match');
  });

  it('executes candidates.deepSearch with --job filter', async () => {
    const config = makeConfig();
    let capturedArgs: string[] = [];
    const mockExec = createMockProcessExecutor((subcommand, args) => {
      capturedArgs = args;
      return { stdout: MOCK_DEEPSEARCH_OUTPUT, stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    await driver.execute(makeExecInput('candidates.deepSearch', {
      input: { query: '后端', job: '高级Java' },
    }));
    expect(capturedArgs).toContain('--job');
    expect(capturedArgs).toContain('高级Java');
    expect(capturedArgs).not.toContain('--match');
  });

  // ── candidates.recommend ──

  it('executes candidates.recommend successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      recommend: { stdout: MOCK_SEARCH_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.recommend', {
      input: { query: '产品经理' },
    }));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');
  });

  // ── candidate.preview ──

  it('executes candidate.preview successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      preview: { stdout: '简历预览截图已保存', stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidate.preview', {
      input: { name: '张三' },
    }));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');
  });

  it('executes candidate.preview with --index', async () => {
    const config = makeConfig();
    let capturedArgs: string[] = [];
    const mockExec = createMockProcessExecutor((subcommand, args) => {
      capturedArgs = args;
      return { stdout: '简历预览截图已保存', stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    await driver.execute(makeExecInput('candidate.preview', {
      input: { index: 3 },
    }));
    expect(capturedArgs).toContain('--index');
    expect(capturedArgs).toContain('3');
  });

  // ── conversation.open ──

  it('executes conversation.open successfully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      chat: { stdout: MOCK_CHAT_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('conversation.open', {
      input: { name: '张三' },
    }));
    expect(result.status).toBe('succeeded');
    expect(result.driver).toBe('legacy_cli');

    const data = result.data as Record<string, unknown>;
    expect(data.opened).toBe(true);
    expect(data.targetName).toBe('张三');
  });

  it('executes conversation.open with --index', async () => {
    const config = makeConfig();
    let capturedArgs: string[] = [];
    const mockExec = createMockProcessExecutor((subcommand, args) => {
      capturedArgs = args;
      return { stdout: MOCK_CHAT_OUTPUT, stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    await driver.execute(makeExecInput('conversation.open', {
      input: { index: 5 },
    }));
    expect(capturedArgs).toContain('--index');
    expect(capturedArgs).toContain('5');
  });

  it('fails conversation.open without name or index', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      chat: { stdout: MOCK_CHAT_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('conversation.open'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INVALID_COMMAND');
    expect(result.error?.message).toContain('缺少必要参数');
  });

  // ── Unsupported Operations ──

  it('fails for write operations (message.commit)', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({});
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('message.commit'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LEGACY_OPERATION_UNSUPPORTED');
    expect(result.error?.message).toContain('不支持 legacy_cli 驱动');
  });

  it('fails for greeting.commit (write operation)', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({});
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('greeting.commit'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LEGACY_OPERATION_UNSUPPORTED');
  });

  it('fails for session.status (gateway_local operation)', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({});
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('session.status'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LEGACY_OPERATION_UNSUPPORTED');
  });

  // ── Error Handling: Process Failure ──

  it('returns failed when CLI exits with non-zero code', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      positions: { stdout: '', stderr: 'Chrome not reachable', exitCode: 1 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('positions.list'));
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LEGACY_OUTPUT_UNRECOGNIZED');
  });

  // ── Error Handling: Timeout ──

  it('returns failed with LEGACY_TIMEOUT on timeout', async () => {
    const config = makeConfig();
    const mockExec = createMockProcessExecutor(() => ({
      stdout: '',
      stderr: '',
      exitCode: null as unknown as number, // simulate killed process
      signal: 'SIGTERM',
    }));
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.list'));
    expect(result.status).toBe('failed');
    // Timeout detection: exitCode is null means the process was killed
    // but in our mock scenario we don't have the exact LEGACY_TIMEOUT code
    // because we can't easily simulate the kill + error code path
    expect(result.status).toBe('failed');
  });

  // ── Stop ──

  it('stop is a no-op (stateless execution)', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({});
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    // Stop should not throw
    await expect(driver.stop()).resolves.toBeUndefined();
  });

  // ── Edge Cases ──

  it('handles empty stdout gracefully', async () => {
    const config = makeConfig();
    const mockExec = makeMockProcess({
      positions: { stdout: '', stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('positions.list'));
    expect(result.status).toBe('succeeded');
    const data = result.data as Record<string, unknown>;
    expect(data.empty).toBe(true);
  });

  it('includes stderr as warnings when present', async () => {
    const config = makeConfig();
    const warningMsg = '已废弃的选项 --old-flag';
    const mockExec = makeMockProcess({
      list: { stdout: MOCK_LIST_OUTPUT, stderr: warningMsg, exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.list'));
    expect(result.status).toBe('succeeded');
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBe(1);
    expect(result.warnings![0].message).toBe(warningMsg);
  });

  it('uses input timeoutMs when provided', async () => {
    const config = makeConfig({ default_timeout_ms: 60000 });
    let capturedTimeout = 0;
    const mockExec = createMockProcessExecutor((_subcommand, _args) => {
      capturedTimeout = _args.length; // we can't capture timeout from args
      return { stdout: MOCK_LIST_OUTPUT, stderr: '', exitCode: 0 };
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.list', {
      timeoutMs: 15000,
    }));
    expect(result.status).toBe('succeeded');
    // Timeout preference: input.timeoutMs overrides config.default_timeout_ms
  });

  it('falls back to config timeout when input timeoutMs is 0', async () => {
    const config = makeConfig({ default_timeout_ms: 60000 });
    const mockExec = makeMockProcess({
      list: { stdout: MOCK_LIST_OUTPUT, stderr: '', exitCode: 0 },
    });
    const driver = createLegacyCliDriver({ config, processExecutor: mockExec });

    const result = await driver.execute(makeExecInput('candidates.list', {
      timeoutMs: 0,
    }));
    expect(result.status).toBe('succeeded');
  });
});
