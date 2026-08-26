import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import {
  RPA_SCHEMA_VERSION,
  type RpaRequest,
  type RpaResponse,
} from '../drivers/rpa/named-pipe-client.js';
import type { RunnerOutcome } from './contracts.js';

export const RUNNER_MAX_REQUEST_BYTES = 256 * 1024;

export interface RunnerHandler {
  execute(request: RpaRequest): Promise<RunnerOutcome>;
  stop(): void;
}

function pipePath(endpoint: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${endpoint}` : `/tmp/${endpoint}.sock`;
}

function protocolFailure(requestId: string, message: string): RpaResponse {
  return {
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId,
    status: 'failed',
    error: { code: 'INTERNAL_ERROR', message },
  };
}

function isRequest(value: unknown): value is RpaRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.schemaVersion === RPA_SCHEMA_VERSION
    && typeof request.requestId === 'string'
    && request.requestId.length > 0
    && typeof request.flow === 'string'
    && typeof request.deadlineAt === 'string'
    && !!request.payload
    && typeof request.payload === 'object'
    && !Array.isArray(request.payload);
}

function response(requestId: string, outcome: RunnerOutcome): RpaResponse {
  return {
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId,
    status: outcome.status,
    observations: outcome.observations,
    error: outcome.error,
  };
}

/** A local, single-flight server. Gateway owns authorization; Runner owns browser safety checks. */
export class LocalRunnerServer {
  private server: net.Server | undefined;
  private active = false;
  private readonly sockets = new Set<net.Socket>();

  public constructor(
    private readonly endpoint: string,
    private readonly handler: RunnerHandler,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => this.handleSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipePath(this.endpoint), () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.handler.stop();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await fs.rm(pipePath(this.endpoint), { force: true });
  }

  private handleSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    let buffer = '';
    let bytes = 0;
    let handled = false;

    socket.on('data', async (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.byteLength;
      if (bytes > RUNNER_MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify(protocolFailure('unknown', `请求超过 ${RUNNER_MAX_REQUEST_BYTES} 字节限制`))}\n`);
        return;
      }
      buffer += chunk.toString('utf-8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;

      let request: unknown;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        socket.end(`${JSON.stringify(protocolFailure('unknown', 'Runner 收到非 JSON 请求'))}\n`);
        return;
      }
      if (!isRequest(request)) {
        const requestId = typeof (request as { requestId?: unknown })?.requestId === 'string'
          ? (request as { requestId: string }).requestId
          : 'unknown';
        socket.end(`${JSON.stringify(protocolFailure(requestId, 'Runner 请求不符合协议'))}\n`);
        return;
      }

      if (request.flow === 'boss.stop') {
        this.handler.stop();
        socket.end(`${JSON.stringify(response(request.requestId, { status: 'succeeded', observations: { stopRequested: true } }))}\n`);
        return;
      }
      if (this.active) {
        socket.end(`${JSON.stringify(response(request.requestId, {
          status: 'paused',
          error: { code: 'RPA_UNAVAILABLE', message: 'Runner 正在执行另一项任务，请等待或停止当前任务' },
        }))}\n`);
        return;
      }

      this.active = true;
      try {
        const result = await this.handler.execute(request);
        socket.end(`${JSON.stringify(response(request.requestId, result))}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify(protocolFailure(request.requestId, error instanceof Error ? error.message : 'Runner 未处理异常'))}\n`);
      } finally {
        this.active = false;
      }
    });
  }
}
