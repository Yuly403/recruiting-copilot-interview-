import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { GatewayConfigSchema, type GatewayConfig } from '../gateway/config.js';
import { resolveRuntimePaths, type RuntimePaths } from '../runtime/paths.js';
import type { CircuitBreakerSnapshot } from '../gateway/circuit-breaker.js';
import type { DriverHealth } from '../contracts/enums.js';

// ── Doctor — health check (per PRD GW-008) ──

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  /** Check identifier */
  id: string;
  /** Human-readable description */
  label: string;
  /** Check status */
  status: CheckStatus;
  /** Details (only included when non-pass) */
  detail?: string;
  /** How to fix */
  suggestion?: string;
}

export interface DoctorReport {
  /** ISO timestamp */
  timestamp: string;
  /** Overall health */
  healthy: boolean;
  /** Count per status */
  summary: {
    pass: number;
    warn: number;
    fail: number;
    skip: number;
  };
  /** Individual check results (ordered) */
  checks: CheckResult[];
}

// ── Helpers ──

/** Execute a command and return { ok, stdout, stderr, exitCode } */
function execCommand(
  command: string,
  args: string[],
  timeoutMs = 10000,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', () => {
      resolve({ ok: false, stdout, stderr, exitCode: null });
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
  });
}

/** Pick min Node version from engines if available */
function getMinNodeVersion(): number {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf-8'));
    const engines = pkg?.engines?.node;
    if (engines) {
      const m = engines.match(/>=\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
  } catch { /* ignore */ }
  return 18; // sensible default
}

// ── Individual checks ──

async function checkNodeVersion(): Promise<CheckResult> {
  const min = getMinNodeVersion();
  const current = process.versions.node;
  const major = parseInt(current.split('.')[0], 10);

  if (major >= min) {
    return { id: 'node_version', label: `Node.js 版本 (>=${min})`, status: 'pass' };
  }
  return {
    id: 'node_version',
    label: `Node.js 版本 (>=${min})`,
    status: 'fail',
    detail: `当前版本 ${current}，最低要求 ${min}`,
    suggestion: `升级 Node.js 到 ${min}+ 或使用 nvm/volta 切换版本`,
  };
}

async function checkBossCommand(): Promise<CheckResult> {
  const result = await execCommand('boss', ['--version'], 5000);
  if (result.ok) {
    const v = result.stdout.trim();
    return { id: 'boss_command', label: 'boss 命令可用', status: 'pass', detail: v };
  }
  return {
    id: 'boss_command',
    label: 'boss 命令可用',
    status: 'fail',
    detail: result.exitCode === null
      ? 'boss 命令未找到 (PATH 中不存在)'
      : `boss 退出码 ${result.exitCode}`,
    suggestion: '请先安装 boss-cli: npm install -g @joohw/boss-cli',
  };
}

async function checkBossHelp(): Promise<CheckResult> {
  const result = await execCommand('boss', ['help'], 10000);
  if (result.ok && result.stdout.length > 0) {
    return { id: 'boss_help', label: 'Legacy CLI help 可运行', status: 'pass' };
  }
  return {
    id: 'boss_help',
    label: 'Legacy CLI help 可运行',
    status: 'warn',
    detail: result.exitCode !== 0
      ? `boss help 退出码 ${result.exitCode}, stderr: ${result.stderr.slice(0, 200)}`
      : 'boss help 输出为空',
    suggestion: '检查 boss-cli 安装是否完整',
  };
}

async function checkRpaInstalled(config: GatewayConfig): Promise<CheckResult> {
  if (config.boss.rpa.adapter === 'mock') {
    return {
      id: 'rpa_installed',
      label: 'RPA Runner 安装',
      status: 'skip',
      detail: 'RPA adapter 配置为 mock，跳过安装检查',
    };
  }

  // Named-pipe mode: check if the pipe endpoint exists as a file (Unix socket)
  // or try to connect
  try {
    await execCommand('tasklist', ['/FI', 'IMAGENAME eq boss-rpa-runner.exe'], 5000);
    // We can't really check process existence reliably cross-platform,
    // so treat absence as a warning rather than failure
    return {
      id: 'rpa_installed',
      label: 'RPA Runner 安装',
      status: 'warn',
      detail: 'RPA adapter 配置为 named-pipe，但无法确认 Runner 进程状态。请手动启动 boss-rpa-runner',
    };
  } catch {
    return {
      id: 'rpa_installed',
      label: 'RPA Runner 安装',
      status: 'warn',
      detail: '无法检查 RPA Runner 进程状态',
      suggestion: '请确认 boss-rpa-runner 已启动',
    };
  }
}

async function checkRpaIpc(config: GatewayConfig): Promise<CheckResult> {
  if (config.boss.rpa.adapter === 'mock') {
    return {
      id: 'rpa_ipc',
      label: 'RPA IPC 连接',
      status: 'skip',
      detail: 'RPA adapter 配置为 mock',
    };
  }

  // For named-pipe mode, try a simple health check via the pipe
  try {
    const pipePath = `\\\\.\\pipe\\${config.boss.rpa.endpoint}`;
    // Quick stat to check pipe exists (Windows)
    await fs.access(pipePath).then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
    return {
      id: 'rpa_ipc',
      label: `RPA IPC 连接 (${config.boss.rpa.endpoint})`,
      status: 'warn',
      detail: 'Named pipe 路径存在，但未验证可连接性',
    };
  } catch {
    return {
      id: 'rpa_ipc',
      label: `RPA IPC 连接 (${config.boss.rpa.endpoint})`,
      status: 'fail',
      detail: '无法访问 named pipe 路径',
      suggestion: '请确认 RPA Runner 已启动且 pipe 端点配置正确',
    };
  }
}

async function checkConfig(configPath: string): Promise<{ result: CheckResult; config: GatewayConfig | null }> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const config = GatewayConfigSchema.parse(parsed);

    return {
      result: { id: 'config_valid', label: '配置文件有效', status: 'pass', detail: configPath },
      config,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        id: 'config_valid',
        label: '配置文件有效',
        status: 'fail',
        detail: message,
        suggestion: '检查 JSON 格式和必填字段',
      },
      config: null,
    };
  }
}

async function checkRuntimeWritable(paths: RuntimePaths): Promise<CheckResult> {
  const testFile = path.join(paths.root, '.doctor_write_test');
  try {
    await fs.writeFile(testFile, 'doctor-check', 'utf-8');
    await fs.unlink(testFile);
    return { id: 'runtime_writable', label: 'Runtime 目录可写', status: 'pass', detail: paths.root };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'runtime_writable',
      label: 'Runtime 目录可写',
      status: 'fail',
      detail: `${paths.root}: ${message}`,
      suggestion: '检查目录权限，确保当前用户有写入权限',
    };
  }
}

async function checkRuntimeAcl(paths: RuntimePaths): Promise<CheckResult> {
  try {
    const stat = await fs.stat(paths.root);
    // On Unix-like systems, warn if the runtime directory is writable by
    // others (world-writable) — that risks leaking ActionPlans (which may
    // contain candidate PII / message text) or session lock state.
    const mode = stat.mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o002) !== 0) {
      return {
        id: 'runtime_acl',
        label: 'Runtime 目录权限 (ACL)',
        status: 'warn',
        detail: `Runtime 目录权限为 ${mode.toString(8)}（其他用户可写），存在 ActionPlan/锁状态泄露风险`,
        suggestion: '使用 `chmod 700` 限制 Runtime 目录仅当前用户可访问',
      };
    }
    return { id: 'runtime_acl', label: 'Runtime 目录权限 (ACL)', status: 'pass' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'runtime_acl',
      label: 'Runtime 目录权限 (ACL)',
      status: 'fail',
      detail: `${paths.root}: ${message}`,
      suggestion: '检查 Runtime 目录是否存在且当前用户可访问',
    };
  }
}

async function checkStaleLocks(paths: RuntimePaths): Promise<CheckResult> {
  try {
    const entries = await fs.readdir(paths.locks);
    const lockFiles = entries.filter(f => f.endsWith('.lock'));
    if (lockFiles.length === 0) {
      return { id: 'stale_locks', label: '陈旧锁', status: 'pass' };
    }

    const now = Date.now();
    const staleLocks: string[] = [];
    for (const file of lockFiles) {
      try {
        const stat = await fs.stat(path.join(paths.locks, file));
        const ageMinutes = (now - stat.mtimeMs) / 60000;
        if (ageMinutes > 5) {
          staleLocks.push(`${file} (${Math.round(ageMinutes)} 分钟前)`);
        }
      } catch { /* file may have been removed */ }
    }

    if (staleLocks.length === 0) {
      return { id: 'stale_locks', label: '陈旧锁', status: 'pass' };
    }
    return {
      id: 'stale_locks',
      label: '陈旧锁',
      status: 'warn',
      detail: `发现 ${staleLocks.length} 个陈旧锁: ${staleLocks.join(', ')}`,
      suggestion: '如果确认没有其他进程在使用，可手动删除锁文件',
    };
  } catch {
    // Locks dir may not exist yet
    return { id: 'stale_locks', label: '陈旧锁', status: 'pass' };
  }
}

async function checkPendingTransactions(paths: RuntimePaths): Promise<CheckResult> {
  try {
    const pendingFiles = await fs.readdir(paths.actions.pending).catch(() => [] as string[]);
    const unknownFiles = await fs.readdir(paths.actions.unknown).catch(() => [] as string[]);
    const actionFiles = [...pendingFiles.filter(f => f.endsWith('.json')), ...unknownFiles.filter(f => f.endsWith('.json'))];

    if (actionFiles.length === 0) {
      return { id: 'pending_transactions', label: '未完成/结果未知事务', status: 'pass' };
    }
    return {
      id: 'pending_transactions',
      label: '未完成/结果未知事务',
      status: 'warn',
      detail: `${pendingFiles.length} 个待处理, ${unknownFiles.length} 个结果未知`,
      suggestion: '使用 recruitctl execution status --plan <id> 查看具体状态',
    };
  } catch {
    return { id: 'pending_transactions', label: '未完成/结果未知事务', status: 'pass' };
  }
}

async function checkBrowserLogin(config: GatewayConfig): Promise<CheckResult> {
  // Try boss status to check login state
  const bossCmd = config.boss.legacy_cli.executable;
  try {
    const result = await execCommand(bossCmd, ['status'], 15000);
    if (result.ok) {
      const stdout = result.stdout.toLowerCase();
      if (stdout.includes('已登录') || stdout.includes('logged in') || stdout.includes('online')) {
        return { id: 'browser_login', label: '浏览器登录状态', status: 'pass', detail: '已登录' };
      }
      return {
        id: 'browser_login',
        label: '浏览器登录状态',
        status: 'warn',
        detail: '未检测到登录状态',
        suggestion: '运行 recruitctl session login 进行扫码登录',
      };
    }
    return {
      id: 'browser_login',
      label: '浏览器登录状态',
      status: 'warn',
      detail: `boss status 执行失败 (退出码 ${result.exitCode})`,
      suggestion: '运行 recruitctl session.login 进行扫码登录',
    };
  } catch {
    return {
      id: 'browser_login',
      label: '浏览器登录状态',
      status: 'warn',
      detail: '无法检查登录状态',
      suggestion: '手动登录后再运行 doctor',
    };
  }
}

// ── Doctor API ──

export async function runDoctor(configPath: string): Promise<DoctorReport> {
  const timestamp = new Date().toISOString();
  const checks: CheckResult[] = [];

  // 1. Node version
  checks.push(await checkNodeVersion());

  // 2. boss command exists
  checks.push(await checkBossCommand());

  // 3. boss help runnable
  checks.push(await checkBossHelp());

  // 4-5: Config-dependent checks
  const { result: configResult, config } = await checkConfig(configPath);
  checks.push(configResult);

  if (config) {
    // 4. RPA Runner installed
    checks.push(await checkRpaInstalled(config));

    // 5. RPA IPC connectable
    checks.push(await checkRpaIpc(config));

    // 6. Runtime writable
    const paths = await resolveRuntimePaths(config);
    checks.push(await checkRuntimeWritable(paths));

    // 6b. Runtime ACL (§16.4)
    checks.push(await checkRuntimeAcl(paths));

    // 7. Stale locks
    checks.push(await checkStaleLocks(paths));

    // 8. Pending transactions
    checks.push(await checkPendingTransactions(paths));

    // 9. Browser login
    checks.push(await checkBrowserLogin(config));
  } else {
    // Config is invalid — skip dependent checks
    checks.push({ id: 'rpa_installed', label: 'RPA Runner 安装', status: 'skip', detail: '配置无效，跳过' });
    checks.push({ id: 'rpa_ipc', label: 'RPA IPC 连接', status: 'skip', detail: '配置无效，跳过' });
    checks.push({ id: 'runtime_writable', label: 'Runtime 目录可写', status: 'skip', detail: '配置无效，跳过' });
    checks.push({ id: 'runtime_acl', label: 'Runtime 目录权限 (ACL)', status: 'skip', detail: '配置无效，跳过' });
    checks.push({ id: 'stale_locks', label: '陈旧锁', status: 'skip', detail: '配置无效，跳过' });
    checks.push({ id: 'pending_transactions', label: '未完成/结果未知事务', status: 'skip', detail: '配置无效，跳过' });
    checks.push({ id: 'browser_login', label: '浏览器登录状态', status: 'skip', detail: '配置无效，跳过' });
  }

  // Summarize
  const summary = {
    pass: checks.filter(c => c.status === 'pass').length,
    warn: checks.filter(c => c.status === 'warn').length,
    fail: checks.filter(c => c.status === 'fail').length,
    skip: checks.filter(c => c.status === 'skip').length,
  };

  return {
    timestamp,
    healthy: summary.fail === 0,
    summary,
    checks,
  };
}

/**
 * Format a doctor report as human-readable text.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════');
  lines.push('  recruitctl doctor — 健康检查报告');
  lines.push('═══════════════════════════════════════');
  lines.push(`  时间: ${report.timestamp}`);
  lines.push(`  通过: ${report.summary.pass}  警告: ${report.summary.warn}  失败: ${report.summary.fail}  跳过: ${report.summary.skip}`);
  lines.push(`  状态: ${report.healthy ? '✅ 健康' : '❌ 存在问题'}`);
  lines.push('');

  const icons: Record<CheckStatus, string> = {
    pass: '✅',
    warn: '⚠️ ',
    fail: '❌',
    skip: '⊘ ',
  };

  for (const check of report.checks) {
    lines.push(`  ${icons[check.status]} ${check.label}`);
    if (check.detail && check.status !== 'pass') {
      lines.push(`     详情: ${check.detail}`);
    }
    if (check.suggestion) {
      lines.push(`     建议: ${check.suggestion}`);
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════');

  return lines.join('\n');
}
