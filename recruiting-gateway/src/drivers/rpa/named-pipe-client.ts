import * as net from 'node:net';
import type { RpaConfig } from '../../gateway/config.js';

// ── RPA Named Pipe Protocol (per PRD §10.4) ──

export const RPA_SCHEMA_VERSION = '1.0';
export const RPA_MAX_RESPONSE_BYTES = 1024 * 1024;

const RPA_RESPONSE_STATUSES = new Set<RpaResponse['status']>([
  'succeeded',
  'failed',
  'paused',
  'result_unknown',
]);

/** Request sent to RPA Runner */
export interface RpaRequest {
  schemaVersion: string;
  requestId: string;
  flow: string;
  deadlineAt: string;
  payload: Record<string, unknown>;
}

/** Expected response from RPA Runner */
export interface RpaResponse {
  schemaVersion: string;
  requestId: string;
  status: 'succeeded' | 'failed' | 'paused' | 'result_unknown';
  observations?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Health check response */
export interface RpaHealthResponse {
  healthy: boolean;
  status: string;
  details?: Record<string, unknown>;
}

/** Result from a pipe call */
export interface PipeResult<T = RpaResponse> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

// ── Named Pipe Client ──

export interface NamedPipeClient {
  health(): Promise<PipeResult<RpaHealthResponse>>;
  send(request: RpaRequest): Promise<PipeResult<RpaResponse>>;
  close(): void;
}

/**
 * Build the full named pipe path.
 * On Windows: \\.\pipe\<endpoint>
 * On other platforms (mock/testing): use a Unix socket path
 */
function buildPipePath(endpoint: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${endpoint}`;
  }
  // For testing on non-Windows: use a temporary Unix socket
  return `/tmp/${endpoint}.sock`;
}

function validateResponse(value: unknown, requestId: string): value is RpaResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const response = value as Record<string, unknown>;
  if (response.schemaVersion !== RPA_SCHEMA_VERSION) return false;
  if (response.requestId !== requestId) return false;
  if (!RPA_RESPONSE_STATUSES.has(response.status as RpaResponse['status'])) return false;

  if (
    response.observations !== undefined
    && (!response.observations || typeof response.observations !== 'object' || Array.isArray(response.observations))
  ) return false;

  if (response.error !== undefined) {
    if (!response.error || typeof response.error !== 'object' || Array.isArray(response.error)) return false;
    const error = response.error as Record<string, unknown>;
    if (typeof error.code !== 'string' || typeof error.message !== 'string') return false;
    if (
      error.details !== undefined
      && (!error.details || typeof error.details !== 'object' || Array.isArray(error.details))
    ) return false;
  }

  return true;
}

function remainingTimeoutMs(deadlineAt: string, configuredTimeoutMs: number): number | null {
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return null;
  return Math.min(configuredTimeoutMs, Math.floor(deadlineMs - Date.now()));
}

/**
 * Create a real Named Pipe client (Windows only).
 */
export function createNamedPipeClient(config: Pick<RpaConfig, 'endpoint' | 'default_timeout_ms'>): NamedPipeClient {
  const endpoint = config.endpoint ?? 'recruiting-copilot-boss-rpa-v1';
  const defaultTimeoutMs = config.default_timeout_ms ?? 90000;
  const pipePath = buildPipePath(endpoint);

  const activeSockets = new Set<net.Socket>();

  function connect(timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Named pipe connection timeout to ${pipePath} (${timeoutMs}ms)`));
      }, timeoutMs);

      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve(socket);
      });

      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async function sendRaw(request: RpaRequest, timeoutMs: number): Promise<PipeResult<RpaResponse>> {
    const initialTimeoutMs = remainingTimeoutMs(request.deadlineAt, timeoutMs);
    if (initialTimeoutMs === null) {
      return {
        success: false,
        error: `Invalid RPA deadline: ${request.deadlineAt}`,
        errorCode: 'RPA_DEADLINE_INVALID',
      };
    }
    if (initialTimeoutMs <= 0) {
      return {
        success: false,
        error: `RPA request deadline already expired: ${request.deadlineAt}`,
        errorCode: 'RPA_DEADLINE_EXPIRED',
      };
    }

    try {
      const socket = await connect(initialTimeoutMs);
      activeSockets.add(socket);

      const responseTimeoutMs = remainingTimeoutMs(request.deadlineAt, timeoutMs);
      if (responseTimeoutMs === null || responseTimeoutMs <= 0) {
        socket.destroy();
        activeSockets.delete(socket);
        return {
          success: false,
          error: `RPA request deadline expired before write: ${request.deadlineAt}`,
          errorCode: 'RPA_DEADLINE_EXPIRED',
        };
      }

      const payload = JSON.stringify(request) + '\n';

      return new Promise((resolve) => {
        let buffer = '';
        let bufferBytes = 0;
        let settled = false;

        const settle = (result: PipeResult<RpaResponse>, destroy = false): void => {
          if (settled) return;
          settled = true;
          clearTimeout(resultTimeout);
          activeSockets.delete(socket);
          if (destroy) socket.destroy();
          else socket.end();
          resolve(result);
        };

        const resultTimeout = setTimeout(() => {
          settle({
            success: false,
            error: `RPA response timeout (${responseTimeoutMs}ms)`,
            errorCode: 'RPA_TIMEOUT',
          }, true);
        }, responseTimeoutMs);

        socket.on('data', (chunk: Buffer) => {
          if (settled) return;
          bufferBytes += chunk.byteLength;
          if (bufferBytes > RPA_MAX_RESPONSE_BYTES) {
            settle({
              success: false,
              error: `RPA response exceeded ${RPA_MAX_RESPONSE_BYTES} bytes`,
              errorCode: 'RPA_OUTPUT_TOO_LARGE',
            }, true);
            return;
          }

          buffer += chunk.toString('utf-8');
          // Check for complete JSON line
          const newlineIdx = buffer.indexOf('\n');
          if (newlineIdx >= 0) {
            const line = buffer.substring(0, newlineIdx).trim();
            try {
              const response: unknown = JSON.parse(line);
              if (!validateResponse(response, request.requestId)) {
                settle({
                  success: false,
                  error: 'RPA response failed schema, version, or request binding validation',
                  errorCode: 'RPA_PROTOCOL_ERROR',
                }, true);
                return;
              }
              settle({ success: true, data: response });
            } catch {
              settle({
                success: false,
                error: 'Invalid JSON from RPA Runner',
                errorCode: 'RPA_OUTPUT_UNRECOGNIZED',
              }, true);
            }
          }
        });

        socket.on('error', (err) => {
          settle({
            success: false,
            error: err.message,
            errorCode: 'RPA_IO_ERROR',
          }, true);
        });

        socket.on('close', () => {
          settle({
            success: false,
            error: 'RPA connection closed without complete response',
            errorCode: 'RPA_CONNECTION_CLOSED',
          });
        });

        socket.write(payload, (err) => {
          if (err) {
            settle({
              success: false,
              error: `RPA write error: ${err.message}`,
              errorCode: 'RPA_WRITE_ERROR',
            }, true);
          }
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errCode = (err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined);
      return {
        success: false,
        error: message || 'RPA connection failed',
        errorCode: errCode === 'ENOENT' ? 'RPA_UNAVAILABLE' : 'RPA_CONNECTION_FAILED',
      };
    }
  }

  const client: NamedPipeClient = {
    async health(): Promise<PipeResult<RpaHealthResponse>> {
      try {
        const result = await sendRaw(
          {
            schemaVersion: RPA_SCHEMA_VERSION,
            requestId: `health_${Date.now()}`,
            flow: 'health',
            deadlineAt: new Date(Date.now() + 5000).toISOString(),
            payload: {},
          },
          5000,
        );

        if (result.success && result.data) {
          return {
            success: true,
            data: {
              healthy: result.data.status === 'succeeded',
              status: result.data.status ?? 'unknown',
              details: result.data.observations,
            },
          };
        }
        return { success: false, error: result.error, errorCode: result.errorCode };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, errorCode: 'RPA_UNAVAILABLE' };
      }
    },

    async send(request: RpaRequest): Promise<PipeResult<RpaResponse>> {
      return sendRaw(request, defaultTimeoutMs);
    },

    close(): void {
      for (const socket of activeSockets) {
        if (!socket.destroyed) socket.destroy();
      }
      activeSockets.clear();
    },
  };

  return client;
}

/**
 * Create a mock Named Pipe client for testing.
 * Returns canned responses based on the flow name.
 */
export function createMockPipeClient(
  scenario: 'success' | 'failure' | 'result_unknown' | 'paused' | 'unavailable' = 'success',
): NamedPipeClient {
  const healthResponse: RpaHealthResponse = scenario === 'unavailable'
    ? {
        healthy: false,
        status: 'unavailable',
        details: { runner: 'mock', error: 'Mock runner unavailable' },
      }
    : {
        healthy: true,
        status: 'healthy',
        details: { runner: 'mock', version: '0.1.0' },
      };

  function getFlowResponse(flow: string, requestId: string): RpaResponse {
    switch (scenario) {
      case 'failure':
        return {
          schemaVersion: RPA_SCHEMA_VERSION,
          requestId,
          status: 'failed',
          error: { code: 'INTERNAL_ERROR', message: 'Mock flow failed' },
        };
      case 'result_unknown':
        return {
          schemaVersion: RPA_SCHEMA_VERSION,
          requestId,
          status: 'result_unknown',
          observations: { candidateVerified: true, messageStaged: true, commitObserved: false },
          error: { code: 'RESULT_UNKNOWN', message: '提交后连接断开，无法确认结果' },
        };
      case 'paused':
        return {
          schemaVersion: RPA_SCHEMA_VERSION,
          requestId,
          status: 'paused',
          observations: { candidateVerified: true, messageStaged: true },
          error: { code: 'CANDIDATE_AMBIGUOUS', message: '候选人身份不唯一' },
        };
      case 'unavailable':
        return {
          schemaVersion: RPA_SCHEMA_VERSION,
          requestId,
          status: 'failed',
          error: { code: 'RPA_UNAVAILABLE', message: 'RPA Runner 不可用' },
        };
      case 'success':
      default:
        return {
          schemaVersion: RPA_SCHEMA_VERSION,
          requestId,
          status: 'succeeded',
          observations: { candidateVerified: true, flowCompleted: true },
        };
    }
  }

  return {
    async health(): Promise<PipeResult<RpaHealthResponse>> {
      return { success: true, data: healthResponse };
    },

    async send(request: RpaRequest): Promise<PipeResult<RpaResponse>> {
      const response = getFlowResponse(request.flow, request.requestId);
      return { success: true, data: response };
    },

    close(): void {
      // No-op for mock
    },
  };
}
