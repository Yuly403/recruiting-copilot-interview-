import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ActionPlanSchema, type ActionPlan } from '../contracts/action-plan.js';
import type { ActionStatus } from '../contracts/enums.js';
import type { RuntimePaths } from './paths.js';

const ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeActionId(actionId: string): void {
  if (!ACTION_ID_RE.test(actionId)) {
    throw new Error(`非法 actionId: ${actionId}`);
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

function statusDirectory(paths: RuntimePaths, status: ActionStatus): string {
  if (status === 'succeeded' || status === 'failed_before_commit' || status === 'cancelled' || status === 'denied') {
    return paths.actions.completed;
  }
  if (status === 'result_unknown') return paths.actions.unknown;
  if (status.startsWith('paused_')) return paths.actions.paused;
  if (status === 'executing' || status === 'waiting_for_lock' || status === 'verifying') {
    return paths.actions.running;
  }
  return paths.actions.pending;
}

export function createActionStore(paths: RuntimePaths) {
  const actionDirs = [
    paths.actions.pending,
    paths.actions.running,
    paths.actions.completed,
    paths.actions.paused,
    paths.actions.unknown,
  ];

  function actionPath(dir: string, actionId: string): string {
    assertSafeActionId(actionId);
    return path.join(dir, `${actionId}.json`);
  }

  async function readAction(actionId: string): Promise<ActionPlan | null> {
    assertSafeActionId(actionId);
    for (const dir of actionDirs) {
      try {
        const raw = await fs.readFile(actionPath(dir, actionId), 'utf-8');
        const parsed = ActionPlanSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
        // Continue: a malformed or missing state file must not hide a valid copy in another state dir.
      }
    }
    return null;
  }

  async function listSubdir(subdir: keyof RuntimePaths['actions'] | string): Promise<string[]> {
    const dir = (paths.actions as unknown as Record<string, string>)[subdir];
    if (!dir) return [];
    try {
      const entries = await fs.readdir(dir);
      return entries.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    } catch {
      return [];
    }
  }

  async function setStatus(actionId: string, status: ActionStatus): Promise<void> {
    const current = await readAction(actionId);
    if (!current) return;
    const next = { ...current, status };
    const destination = statusDirectory(paths, status);
    await atomicWriteJson(actionPath(destination, actionId), next);
    await Promise.all(actionDirs
      .filter((dir) => dir !== destination)
      .map((dir) => fs.unlink(actionPath(dir, actionId)).catch(() => {})));
  }

  return {
    async createPending(plan: ActionPlan): Promise<void> {
      const parsed = ActionPlanSchema.parse(plan);
      await atomicWriteJson(actionPath(paths.actions.pending, parsed.actionId), parsed);
    },

    async markRunning(actionId: string): Promise<void> {
      await setStatus(actionId, 'executing');
    },

    async markCompleted(actionId: string): Promise<void> {
      await setStatus(actionId, 'succeeded');
    },

    async markPaused(actionId: string): Promise<void> {
      await setStatus(actionId, 'paused_for_manual_takeover');
    },

    async markUnknown(actionId: string): Promise<void> {
      await setStatus(actionId, 'result_unknown');
    },

    async read(actionId: string): Promise<ActionPlan | null> {
      return readAction(actionId);
    },

    async updateStatus(actionId: string, status: ActionStatus): Promise<void> {
      await setStatus(actionId, status);
    },

    async listSubdir(subdir: keyof RuntimePaths['actions'] | string): Promise<string[]> {
      return listSubdir(subdir);
    },

    async getIncompleteActionIds(): Promise<string[]> {
      const groups = await Promise.all([
        listSubdir('pending'),
        listSubdir('running'),
        listSubdir('paused'),
        listSubdir('unknown'),
      ]);
      return [...new Set(groups.flat())];
    },
  };
}
