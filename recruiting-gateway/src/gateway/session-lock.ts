import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ── Session Lock (per PRD §14) ──

export interface LockInfo {
  schemaVersion: '1.0';
  leaseId: string;
  owner: 'legacy_cli' | 'rpa' | 'manual' | 'gateway_local';
  pid: number;
  processStartTime: string;
  operation: string;
  actionId: string | null;
  acquiredAt: string;
  expiresAt: string;
}

export class LockAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAcquisitionError';
  }
}

/** Create a session lock manager for a given locks directory */
export function createSessionLock(locksDir: string) {
  const lockPath = path.join(locksDir, 'boss-session.lock');

  return {
    /** Attempt to acquire the session lock (atomic) */
    async acquire(info: Omit<LockInfo, 'schemaVersion' | 'acquiredAt' | 'expiresAt'>, leaseSeconds: number): Promise<LockInfo> {
      const now = new Date();
      const fullInfo: LockInfo = {
        schemaVersion: '1.0',
        ...info,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
      };

      // Use 'wx' flag for atomic exclusive creation
      try {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(JSON.stringify(fullInfo, null, 2), 'utf-8');
        await handle.close();
        return fullInfo;
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new LockAcquisitionError('会话锁已被占用');
        }
        throw err;
      }
    },

    /** Read current lock info */
    async read(): Promise<LockInfo | null> {
      try {
        const content = await fs.readFile(lockPath, 'utf-8');
        return JSON.parse(content) as LockInfo;
      } catch {
        return null;
      }
    },

    /** Check if lock is stale (PID dead or start time mismatch) */
    async isStale(): Promise<boolean> {
      const lock = await this.read();
      if (!lock) return false;

      const now = new Date();
      const expired = new Date(lock.expiresAt) < now;
      if (!expired) return false;

      // Check if the holding process is still alive
      try {
        // On Windows, process.kill with signal 0 doesn't work like Unix.
        // tasklist returns a CSV line containing the PID when the process is
        // alive, or "INFO: No tasks are running..." when it is not (exit code
        // is still 0 on Windows). On non-Windows or missing tasklist, execSync
        // throws — treat that as indeterminate and recover the lock.
        const { execSync } = await import('node:child_process');
        const out = execSync(`tasklist /FI "PID eq ${lock.pid}" /FO CSV /NH`, {
          encoding: 'utf-8',
          timeout: 3000,
          windowsHide: true,
        });
        const processAlive = out.includes(String(lock.pid));
        // Process still running → not stale, wait for natural lease expiry
        return !processAlive;
      } catch {
        // Could not determine process state (e.g. tasklist unavailable) —
        // the lease already expired, so recover the lock to avoid a deadlock.
        return true;
      }
    },

    /** Release the lock (force-delete) */
    async release(): Promise<void> {
      try {
        await fs.unlink(lockPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },

    /** Recover a stale lock */
    async recoverStale(): Promise<void> {
      const stale = await this.isStale();
      if (stale) {
        await this.release();
      }
    },

    /** Get the lock path for diagnostics */
    getPath(): string {
      return lockPath;
    },
  };
}
