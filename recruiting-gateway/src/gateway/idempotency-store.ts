import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ── Idempotency Store (per PRD §12.4) ──

export type IdempotencyState =
  | 'succeeded'
  | 'executing'
  | 'result_unknown'
  | 'failed_before_commit';

interface IdempotencyRecord {
  key: string;
  state: IdempotencyState;
  actionId: string;
  updatedAt: string;
}

/** File-based idempotency store using JSONL */
export function createIdempotencyStore(dataDir: string) {
  const storePath = path.join(dataDir, 'idempotency.jsonl');
  // In-memory cache of key → state to avoid full-file reads on every check.
  // Safe because the gateway enforces a single active session via session-lock.
  const cache = new Map<string, IdempotencyState>();

  async function readAll(): Promise<Map<string, IdempotencyRecord>> {
    const map = new Map<string, IdempotencyRecord>();
    try {
      const content = await fs.readFile(storePath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record: IdempotencyRecord = JSON.parse(line);
          map.set(record.key, record);
          cache.set(record.key, record.state);
        } catch { /* skip corrupt lines */ }
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
    return map;
  }

  async function append(record: IdempotencyRecord): Promise<void> {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.appendFile(storePath, JSON.stringify(record) + '\n', 'utf-8');
    cache.set(record.key, record.state);
  }

  return {
    /** Check the state of a key */
    async check(key: string): Promise<IdempotencyState | null> {
      if (cache.has(key)) return cache.get(key)!;
      await readAll();
      return cache.has(key) ? cache.get(key)! : null;
    },

    /** Mark a key as executing */
    async markExecuting(key: string, actionId: string): Promise<void> {
      await append({
        key,
        state: 'executing',
        actionId,
        updatedAt: new Date().toISOString(),
      });
    },

    /** Mark a key as succeeded */
    async markSucceeded(key: string, actionId: string): Promise<void> {
      await append({
        key,
        state: 'succeeded',
        actionId,
        updatedAt: new Date().toISOString(),
      });
    },

    /** Mark a key as result_unknown */
    async markResultUnknown(key: string, actionId: string): Promise<void> {
      await append({
        key,
        state: 'result_unknown',
        actionId,
        updatedAt: new Date().toISOString(),
      });
    },

    /** Mark a key as failed_before_commit */
    async markFailedBeforeCommit(key: string, actionId: string): Promise<void> {
      await append({
        key,
        state: 'failed_before_commit',
        actionId,
        updatedAt: new Date().toISOString(),
      });
    },

    /** Validate idempotency before execution (per PRD §12.4) */
    async validateBeforeExecution(key: string, actionId: string): Promise<
      { allowed: true } | { allowed: false; reason: string }
    > {
      const state = await this.check(key);
      if (state === null) {
        // Never seen — allow
        await this.markExecuting(key, actionId);
        return { allowed: true };
      }
      if (state === 'succeeded') {
        return { allowed: false, reason: 'already_completed' };
      }
      if (state === 'executing') {
        return { allowed: false, reason: 'conflict_in_progress' };
      }
      if (state === 'result_unknown') {
        return { allowed: false, reason: 'result_unknown — 必须验证后再决定' };
      }
      if (state === 'failed_before_commit') {
        // Allow retry if approval is still valid
        await this.markExecuting(key, actionId);
        return { allowed: true };
      }
      return { allowed: false, reason: 'unknown state' };
    },
  };
}
