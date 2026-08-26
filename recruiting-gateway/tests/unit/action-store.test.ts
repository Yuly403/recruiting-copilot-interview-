import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fs/promises inline (vi.mock is hoisted, so factory must be self-contained) ──

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import * as mockFs from 'node:fs/promises';
import type { RuntimePaths } from '../../src/runtime/paths.js';
import type { ActionPlan } from '../../src/contracts/action-plan.js';
import { createActionStore } from '../../src/runtime/action-store.js';

// ── Helpers ──

/** Normalize Windows backslash paths to forward slash for cross-platform assertions */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function mockStoredPlan(status: ActionPlan['status'] = 'approved'): void {
  (mockFs.readFile as any).mockResolvedValueOnce(JSON.stringify(makePlan({ status })));
}

function expectStatusWrite(subdir: string, status: ActionPlan['status']): void {
  const call = (mockFs.writeFile as any).mock.calls.find((item: any[]) => norm(item[0]).includes(`actions/${subdir}/`));
  expect(call).toBeDefined();
  expect(JSON.parse(call[1]).status).toBe(status);
}

function makeRuntimePaths(): RuntimePaths {
  return {
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
}

function makePlan(overrides: Partial<ActionPlan> = {}): ActionPlan {
  return {
    schemaVersion: '1.0',
    actionId: 'action-001',
    workspaceId: 'ws-001',
    operation: 'message.commit',
    platform: 'boss',
    candidateKey: 'candidate-abc',
    candidateLocator: {
      platform: 'boss',
      source: 'search_results',
      jobRef: 'job-backend-eng',
      displayedName: '张*三',
      listContextHash: 'hash-123',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    payload: {
      messageFile: 'payloads/msg-001.json',
      messageHash: 'abc123def',
    },
    approval: {
      required: true,
      status: 'approved',
      assurance: 'conversation',
      scope: 'single_action',
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    idempotencyKey: 'boss:message.commit:candidate-abc:job-backend-eng:abc123def',
    createdAt: new Date().toISOString(),
    status: 'approved',
    ...overrides,
  } as ActionPlan;
}

// ── Tests ──

describe('createActionStore', () => {
  let store: ReturnType<typeof createActionStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset implementations to ensure mockRejectedValueOnce from previous tests don't leak
    (mockFs.mkdir as any).mockReset().mockResolvedValue(undefined);
    (mockFs.writeFile as any).mockReset().mockResolvedValue(undefined);
    (mockFs.rename as any).mockReset().mockResolvedValue(undefined);
    (mockFs.unlink as any).mockReset().mockResolvedValue(undefined);
    (mockFs.readFile as any).mockReset();
    (mockFs.readdir as any).mockReset();
    store = createActionStore(makeRuntimePaths());
  });

  // ── createPending ──

  describe('createPending', () => {
    it('writes plan to pending directory', async () => {
      const plan = makePlan();
      await store.createPending(plan);

      expect(mockFs.mkdir).toHaveBeenCalled();
      const fileArg = (mockFs.writeFile as any).mock.calls[0][0];
      expect(norm(fileArg)).toContain('actions/pending/action-001.json');
      expect((mockFs.writeFile as any).mock.calls[0][2]).toEqual({ encoding: 'utf-8', mode: 0o600 });
    });

    it('writes formatted JSON', async () => {
      const plan = makePlan({ actionId: 'test-json' });
      await store.createPending(plan);

      const content = (mockFs.writeFile as any).mock.calls[0][1];
      const parsed = JSON.parse(content);
      expect(parsed.actionId).toBe('test-json');
      expect(parsed.operation).toBe('message.commit');
    });
  });

  // ── markRunning ──

  describe('markRunning', () => {
    it('writes the executing state into running', async () => {
      mockStoredPlan();
      await store.markRunning('action-001');
      expectStatusWrite('running', 'executing');
    });

    it('reads a paused record when pending is absent', async () => {
      (mockFs.readFile as any)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(JSON.stringify(makePlan({ status: 'paused_for_manual_takeover' })));
      await store.markRunning('action-001');
      expectStatusWrite('running', 'executing');
    });

    it('does nothing when no stored plan exists', async () => {
      (mockFs.readFile as any).mockRejectedValue(new Error('ENOENT'));
      await store.markRunning('action-001');
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });

  // ── markCompleted ──

  describe('markCompleted', () => {
    it('writes succeeded state to completed', async () => {
      mockStoredPlan('executing');
      await store.markCompleted('action-001');
      expectStatusWrite('completed', 'succeeded');
    });
  });

  // ── markPaused ──

  describe('markPaused', () => {
    it('writes a concrete paused state', async () => {
      mockStoredPlan('executing');
      await store.markPaused('action-001');
      expectStatusWrite('paused', 'paused_for_manual_takeover');
    });

    it('does nothing when no stored plan exists', async () => {
      (mockFs.readFile as any).mockRejectedValue(new Error('ENOENT'));
      await store.markPaused('action-001');
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });

  // ── markUnknown ──

  describe('markUnknown', () => {
    it('writes result_unknown state to unknown', async () => {
      mockStoredPlan('executing');
      await store.markUnknown('action-001');
      expectStatusWrite('unknown', 'result_unknown');
    });
  });

  // ── read ──

  describe('read', () => {
    it('reads plan from pending dir', async () => {
      const plan = makePlan({ actionId: 'find-me' });
      (mockFs.readFile as any).mockResolvedValueOnce(JSON.stringify(plan));

      const result = await store.read('find-me');
      expect(result).not.toBeNull();
      expect(result!.actionId).toBe('find-me');
    });

    it('tries multiple subdirs when first fails', async () => {
      const plan = makePlan({ actionId: 'in-running' });
      (mockFs.readFile as any)
        .mockRejectedValueOnce(new Error('ENOENT')) // pending
        .mockResolvedValueOnce(JSON.stringify(plan)); // running

      const result = await store.read('in-running');
      expect(result).not.toBeNull();
      expect(mockFs.readFile).toHaveBeenCalledTimes(2);
    });

    it('returns null when not found in any subdir', async () => {
      (mockFs.readFile as any).mockRejectedValue(new Error('ENOENT'));

      const result = await store.read('not-found');
      expect(result).toBeNull();
      expect(mockFs.readFile).toHaveBeenCalledTimes(5);
    });

    it('handles invalid JSON gracefully', async () => {
      (mockFs.readFile as any)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce('not-valid-json');

      const result = await store.read('bad-data');
      // Should continue trying other subdirs after parse failure
      expect(mockFs.readFile).toHaveBeenCalledTimes(5);
      expect(result).toBeNull();
    });
  });

  // ── updateStatus ──

  describe('updateStatus', () => {
    beforeEach(() => {
      const plan = makePlan({ actionId: 'to-update', status: 'executing' });
      (mockFs.readFile as any).mockResolvedValue(JSON.stringify(plan));
    });

    it('writes succeeded to completed dir', async () => {
      await store.updateStatus('to-update', 'succeeded');
      const calls = (mockFs.writeFile as any).mock.calls;
      const completedCall = calls.find((c: any[]) => c[0].includes('completed'));
      expect(completedCall).toBeDefined();
    });

    it('writes failed_before_commit to completed dir', async () => {
      await store.updateStatus('to-update', 'failed_before_commit');
      const calls = (mockFs.writeFile as any).mock.calls;
      const completedCall = calls.find((c: any[]) => c[0].includes('completed'));
      expect(completedCall).toBeDefined();
    });

    it('writes result_unknown to unknown dir', async () => {
      await store.updateStatus('to-update', 'result_unknown');
      const calls = (mockFs.writeFile as any).mock.calls;
      const unknownCall = calls.find((c: any[]) => c[0].includes('unknown'));
      expect(unknownCall).toBeDefined();
    });

    it('writes paused status to paused dir', async () => {
      await store.updateStatus('to-update', 'paused_for_candidate_identity');
      const calls = (mockFs.writeFile as any).mock.calls;
      const pausedCall = calls.find((c: any[]) => c[0].includes('paused'));
      expect(pausedCall).toBeDefined();
    });

    it('writes executing to running dir', async () => {
      await store.updateStatus('to-update', 'executing');
      const calls = (mockFs.writeFile as any).mock.calls;
      const runningCall = calls.find((c: any[]) => c[0].includes('running'));
      expect(runningCall).toBeDefined();
    });

    it('writes waiting_for_lock to running dir', async () => {
      await store.updateStatus('to-update', 'waiting_for_lock');
      const calls = (mockFs.writeFile as any).mock.calls;
      const runningCall = calls.find((c: any[]) => c[0].includes('running'));
      expect(runningCall).toBeDefined();
    });

    it('falls back to pending for unknown status', async () => {
      await store.updateStatus('to-update', 'created');
      const calls = (mockFs.writeFile as any).mock.calls;
      const pendingCall = calls.find((c: any[]) => c[0].includes('pending'));
      expect(pendingCall).toBeDefined();
    });

    it('cleans up old files before writing new', async () => {
      await store.updateStatus('to-update', 'succeeded');
      // Destination is preserved; stale copies are removed from the other four subdirs.
      expect(mockFs.unlink).toHaveBeenCalledTimes(4);
    });

    it('does nothing when plan not found', async () => {
      (mockFs.readFile as any).mockRejectedValue(new Error('ENOENT'));
      await store.updateStatus('not-found', 'succeeded');
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });

  // ── listSubdir ──

  describe('listSubdir', () => {
    it('returns action IDs from a subdir', async () => {
      (mockFs.readdir as any).mockResolvedValue(['a.json', 'b.json', 'notes.txt']);

      const ids = await store.listSubdir('pending');
      expect(ids).toEqual(['a', 'b']);
    });

    it('returns empty array on read error', async () => {
      (mockFs.readdir as any).mockRejectedValue(new Error('ENOENT'));

      const ids = await store.listSubdir('nonexistent');
      expect(ids).toEqual([]);
    });
  });

  // ── getIncompleteActionIds ──

  describe('getIncompleteActionIds', () => {
    it('collects action IDs from incomplete subdirs', async () => {
      (mockFs.readdir as any)
        .mockResolvedValueOnce(['a.json', 'b.json']) // pending
        .mockResolvedValueOnce(['c.json']) // running
        .mockResolvedValueOnce([]) // paused
        .mockResolvedValueOnce(['d.json']); // unknown

      const ids = await store.getIncompleteActionIds();
      expect(ids).toEqual(['a', 'b', 'c', 'd']);
    });

    it('handles readdir errors gracefully in any subdir', async () => {
      (mockFs.readdir as any)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(['x.json']);

      const ids = await store.getIncompleteActionIds();
      expect(ids).toContain('x');
    });
  });
});
