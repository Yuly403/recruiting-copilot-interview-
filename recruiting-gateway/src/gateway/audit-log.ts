import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ── Audit Log (per PRD §16.3) ──

export interface AuditEvent {
  timestamp: string;
  event: string;
  actionId?: string;
  operation?: string;
  driver?: string;
  candidateKey?: string;
  jobRef?: string;
  payloadHash?: string;
  approvalAssurance?: string;
  result?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Create an audit logger writing JSONL to a directory */
export function createAuditLog(auditDir: string) {
  function todayFile(): string {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(auditDir, `${date}.jsonl`);
  }

  async function write(event: AuditEvent): Promise<void> {
    const file = todayFile();
    const line = JSON.stringify({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, line + '\n', 'utf-8');
  }

  return {
    /** Log an action start */
    async actionStarted(params: {
      actionId: string;
      operation: string;
      driver: string;
      candidateKey?: string;
      jobRef?: string;
      payloadHash?: string;
      approvalAssurance?: string;
    }): Promise<void> {
      await write({
        timestamp: new Date().toISOString(),
        event: 'action.started',
        ...params,
      });
    },

    /** Log an action success */
    async actionSucceeded(params: {
      actionId: string;
      operation: string;
      driver: string;
      candidateKey?: string;
      jobRef?: string;
      payloadHash?: string;
      approvalAssurance?: string;
    }): Promise<void> {
      await write({
        timestamp: new Date().toISOString(),
        event: 'action.succeeded',
        result: 'succeeded',
        ...params,
      });
    },

    /** Log an action failure */
    async actionFailed(params: {
      actionId: string;
      operation: string;
      driver: string;
      candidateKey?: string;
      errorCode: string;
      errorMessage: string;
    }): Promise<void> {
      await write({
        timestamp: new Date().toISOString(),
        event: 'action.failed',
        result: 'failed',
        ...params,
      });
    },

    /** Log an action denied */
    async actionDenied(params: {
      actionId: string;
      operation: string;
      reason: string;
    }): Promise<void> {
      await write({
        timestamp: new Date().toISOString(),
        event: 'action.denied',
        result: 'denied',
        errorMessage: params.reason,
        ...params,
      });
    },

    /** Log an action paused */
    async actionPaused(params: {
      actionId: string;
      operation: string;
      driver: string;
      reason: string;
      errorCode?: string;
    }): Promise<void> {
      await write({
        timestamp: new Date().toISOString(),
        event: 'action.paused',
        result: 'paused',
        ...params,
      });
    },

    /** Log a circuit event */
    async circuitEvent(params: {
      event: string;
      driver?: string;
      message: string;
    }): Promise<void> {
      await write({
        timestamp: new Date().toISOString(),
        ...params,
      });
    },

    /** Log a session lock event */
    async lockEvent(params: {
      event: string;
      owner?: string;
      operation?: string;
    }): Promise<void> {
      await write({
        timestamp: new Date().toISOString(),
        ...params,
      });
    },
  };
}
