import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import {
  resolveRuntimePaths,
  ensureRuntimeDirs,
  validatePath,
  type RuntimePaths,
} from '../../src/runtime/paths.js';
import type { GatewayConfig } from '../../src/gateway/config.js';

// ── Helpers ──

function makeConfig(overrides: Partial<Pick<GatewayConfig, 'workspace_root' | 'runtime_dir'>> = {}): GatewayConfig {
  return {
    workspace_root: overrides.workspace_root ?? '/test/workspace',
    runtime_dir: overrides.runtime_dir ?? '.recruiting-gateway',
    bosscli_path: '/mock/bosscli',
    rpa: {
      endpoint: 'test-pipe',
      default_timeout_ms: 30000,
    },
    default_driver: 'legacy_cli',
    approval: {
      default_expiry_minutes: 30,
      human_timeout_ms: 300000,
    },
    human_fallback: false,
  };
}

// ── resolveRuntimePaths ──

describe('resolveRuntimePaths', () => {
  it('resolves root from workspace_root and runtime_dir', async () => {
    const config = makeConfig({
      workspace_root: '/home/user/project',
      runtime_dir: '.gateway-runtime',
    });

    const paths = await resolveRuntimePaths(config);

    const expectedRoot = path.resolve('/home/user/project', '.gateway-runtime');
    expect(paths.root).toBe(expectedRoot);
  });

  it('creates correct actions sub-paths', async () => {
    const config = makeConfig();
    const paths = await resolveRuntimePaths(config);

    const actions = paths.actions;
    expect(actions.root).toContain('actions');
    expect(actions.pending).toContain(path.join('actions', 'pending'));
    expect(actions.running).toContain(path.join('actions', 'running'));
    expect(actions.completed).toContain(path.join('actions', 'completed'));
    expect(actions.paused).toContain(path.join('actions', 'paused'));
    expect(actions.unknown).toContain(path.join('actions', 'unknown'));
  });

  it('creates other runtime dirs', async () => {
    const config = makeConfig();
    const paths = await resolveRuntimePaths(config);

    expect(paths.config).toContain('config');
    expect(paths.payloads).toContain('payloads');
    expect(paths.locks).toContain('locks');
    expect(paths.audit).toContain('audit');
    expect(paths.diagnostics).toContain('diagnostics');
  });
});

// ── ensureRuntimeDirs ──

describe('ensureRuntimeDirs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls mkdir for all runtime directories', async () => {
    const paths: RuntimePaths = {
      root: '/test/.gateway-runtime',
      config: '/test/.gateway-runtime/config',
      actions: {
        root: '/test/.gateway-runtime/actions',
        pending: '/test/.gateway-runtime/actions/pending',
        running: '/test/.gateway-runtime/actions/running',
        completed: '/test/.gateway-runtime/actions/completed',
        paused: '/test/.gateway-runtime/actions/paused',
        unknown: '/test/.gateway-runtime/actions/unknown',
      },
      payloads: '/test/.gateway-runtime/payloads',
      approvals: '/test/.gateway-runtime/approvals',
      locks: '/test/.gateway-runtime/locks',
      audit: '/test/.gateway-runtime/audit',
      diagnostics: '/test/.gateway-runtime/diagnostics',
    };

    await ensureRuntimeDirs(paths);

    expect(fs.mkdir).toHaveBeenCalledTimes(13);
    // Verify some key directories
    const calls = (fs.mkdir as any).mock.calls.flat();
    expect(calls).toContain('/test/.gateway-runtime/actions/pending');
    expect(calls).toContain('/test/.gateway-runtime/locks');
  });

  it('uses recursive: true for all mkdir calls', async () => {
    const paths: RuntimePaths = {
      root: '/test/a',
      config: '/test/a/config',
      actions: {
        root: '/test/a/actions',
        pending: '/test/a/actions/pending',
        running: '/test/a/actions/running',
        completed: '/test/a/actions/completed',
        paused: '/test/a/actions/paused',
        unknown: '/test/a/actions/unknown',
      },
      payloads: '/test/a/payloads',
      approvals: '/test/a/approvals',
      locks: '/test/a/locks',
      audit: '/test/a/audit',
      diagnostics: '/test/a/diagnostics',
    };

    await ensureRuntimeDirs(paths);

    for (const call of (fs.mkdir as any).mock.calls) {
      expect(call[1]).toEqual({ recursive: true });
    }
  });
});

// ── validatePath ──

describe('validatePath', () => {
  const allowed = ['/safe/data', '/safe/workspace'];

  it('returns true when path is within allowed root', () => {
    expect(validatePath('/safe/data/sub/file.json', allowed)).toBe(true);
  });

  it('returns true when path is within second allowed root', () => {
    expect(validatePath('/safe/workspace/output/result.txt', allowed)).toBe(true);
  });

  it('returns true when path has .. but resolved path is within root', () => {
    // '/safe/data/sub/../other/file.json' → '/safe/data/other/file.json'
    expect(validatePath('/safe/data/sub/../other/file.json', allowed)).toBe(true);
  });

  it('returns false when path has .. and resolves outside allowed roots', () => {
    expect(validatePath('/safe/data/../../../etc/passwd', allowed)).toBe(false);
  });

  it('returns false when path is outside allowed roots', () => {
    expect(validatePath('/etc/passwd', allowed)).toBe(false);
  });

  it('returns true for exact root match', () => {
    expect(validatePath('/safe/data', allowed)).toBe(true);
  });

  it('handles Windows-style paths', () => {
    // On non-Windows, path.resolve won't add drive letters
    // Just verify it doesn't throw
    expect(() => validatePath('C:\\safe\\data\\file.txt', ['C:\\safe\\data'])).not.toThrow();
  });
});
