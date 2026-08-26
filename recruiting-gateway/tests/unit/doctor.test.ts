import { describe, it, expect } from 'vitest';
import { runDoctor, formatDoctorReport, type DoctorReport } from '../../src/doctor/index.js';

describe('Doctor', () => {
  it('runs doctor and returns a valid report structure', async () => {
    // Use a minimal temp config that won't need real boss CLI
    const report = await runDoctor('nonexistent-config.json');

    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('healthy');
    expect(report).toHaveProperty('summary');
    expect(report).toHaveProperty('checks');
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);

    // With a nonexistent config, should have fail for config_valid and skips
    expect(report.healthy).toBe(false);
    expect(report.summary.fail).toBeGreaterThan(0);
  });

  it('formats a report as readable text', () => {
    const report: DoctorReport = {
      timestamp: '2026-07-22T12:00:00.000Z',
      healthy: true,
      summary: { pass: 10, warn: 0, fail: 0, skip: 0 },
      checks: [
        { id: 'node_version', label: 'Node.js 版本', status: 'pass' },
        { id: 'boss_command', label: 'boss 命令可用', status: 'pass', detail: 'v0.6.5' },
        { id: 'rpa_ipc', label: 'RPA IPC 连接', status: 'skip', detail: 'RPA adapter 配置为 mock' },
      ],
    };

    const text = formatDoctorReport(report);
    expect(text).toContain('健康检查报告');
    expect(text).toContain('通过: 10');
    expect(text).toContain('✅ Node.js 版本');
    expect(text).toContain('✅ boss 命令可用');
    expect(text).toContain('⊘  RPA IPC 连接');
  });
});
