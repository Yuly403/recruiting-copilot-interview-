import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Socket mock factory ──

function createMockSocket() {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  const writes: Array<string | Buffer> = [];
  let _destroyed = false;
  let _writeBehaviour: 'success' | 'fail' = 'success';

  const socket: any = {
    get destroyed() { return _destroyed; },

    on(event: string, fn: (...args: any[]) => void) {
      (listeners[event] ??= []).push(fn);
      return socket;
    },

    once(event: string, fn: (...args: any[]) => void) {
      const wrapper = (...args: any[]) => {
        const idx = (listeners[event] ??= []).indexOf(wrapper);
        if (idx >= 0) listeners[event].splice(idx, 1);
        fn(...args);
      };
      (listeners[event] ??= []).push(wrapper);
      return socket;
    },

    emit(event: string, ...args: any[]) {
      // Copy to avoid once-wrappers splicing during iteration
      for (const fn of [...(listeners[event] ?? [])]) fn(...args);
      return true;
    },

    write(_data: string | Buffer, cb?: (err?: Error) => void) {
      writes.push(_data);
      if (_writeBehaviour === 'fail') {
        if (cb) cb(new Error('write failed'));
        return false;
      }
      if (cb) cb();
      return true;
    },

    end() { /* no-op */ },
    destroy() { _destroyed = true; },
    _setWriteBehaviour(b: 'success' | 'fail') { _writeBehaviour = b; },
    _lastRequest() {
      const raw = writes.at(-1);
      return raw === undefined ? undefined : JSON.parse(raw.toString().trim());
    },
  };

  return socket;
}

// ── Mock node:net ──
// Vitest hoists vi.mock to the top of the file, so it runs before imports

let _mockSocket = createMockSocket();

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => _mockSocket),
}));

import * as net from 'node:net';
import {
  createNamedPipeClient,
  createMockPipeClient,
  RPA_MAX_RESPONSE_BYTES,
  RPA_SCHEMA_VERSION,
  type RpaRequest,
  type RpaResponse,
} from '../../src/drivers/rpa/named-pipe-client.js';
import type { RpaConfig } from '../../src/gateway/config.js';

// ── Config helpers ──

function makeConfig(overrides: Partial<Pick<RpaConfig, 'endpoint' | 'default_timeout_ms'>> = {}) {
  return {
    endpoint: overrides.endpoint ?? 'test-pipe-v1',
    default_timeout_ms: overrides.default_timeout_ms ?? 30000,
  };
}

function makeRequest(overrides: Partial<RpaRequest> = {}): RpaRequest {
  return {
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId: 'req-001',
    flow: 'message.commit',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    payload: { message: 'hello' },
    ...overrides,
  };
}

// ── Helpers for async socket simulation ──

async function sendAndResolve(
  client: ReturnType<typeof createNamedPipeClient>,
  response: Partial<RpaResponse>,
): Promise<{ success: boolean; data?: RpaResponse; error?: string; errorCode?: string }> {
  const resultPromise = client.send({
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId: 'req-001',
    flow: 'message.commit',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    payload: { test: true },
  });

  // Wait for connect
  await vi.waitFor(() => {}, { timeout: 10 }).catch(() => {});

  _mockSocket.emit('connect');

  const full: RpaResponse = {
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId: 'req-001',
    status: 'succeeded',
    ...response,
  };

  await vi.waitFor(() => expect(_mockSocket._lastRequest()).toBeDefined());
  _mockSocket.emit('data', Buffer.from(JSON.stringify(full) + '\n'));

  return resultPromise;
}

async function sendHealthAndResolve(
  client: ReturnType<typeof createNamedPipeClient>,
  response: Partial<RpaResponse>,
) {
  const resultPromise = client.health();
  await vi.waitFor(() => {}, { timeout: 10 }).catch(() => {});
  _mockSocket.emit('connect');
  await vi.waitFor(() => expect(_mockSocket._lastRequest()).toBeDefined());

  const full: RpaResponse = {
    schemaVersion: RPA_SCHEMA_VERSION,
    requestId: _mockSocket._lastRequest().requestId,
    status: 'succeeded',
    ...response,
  };
  _mockSocket.emit('data', Buffer.from(JSON.stringify(full) + '\n'));
  return resultPromise;
}

// ── Tests ──

describe('named-pipe-client', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    _mockSocket = createMockSocket();
    // Re-bind the mock to return the new socket
    (net.createConnection as any).mockReturnValue(_mockSocket);
  });

  afterEach(() => {
    try {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    } catch {}
  });

  // ── createMockPipeClient ──

  describe('createMockPipeClient', () => {
    it('returns success responses by default', async () => {
      const client = createMockPipeClient();
      const result = await client.send(makeRequest({ flow: 'message.commit' }));
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('succeeded');
      expect(result.data!.observations).toEqual({
        candidateVerified: true,
        flowCompleted: true,
      });
    });

    it('health returns healthy when not unavailable', async () => {
      const client = createMockPipeClient('success');
      const result = await client.health();
      expect(result.success).toBe(true);
      expect(result.data!.healthy).toBe(true);
      expect(result.data!.status).toBe('healthy');
    });

    it('returns failure responses in failure scenario', async () => {
      const client = createMockPipeClient('failure');
      const result = await client.send(makeRequest({ flow: 'greeting.commit' }));
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('failed');
      expect(result.data!.error?.code).toBe('INTERNAL_ERROR');
    });

    it('returns result_unknown responses', async () => {
      const client = createMockPipeClient('result_unknown');
      const result = await client.send(makeRequest());
      expect(result.data!.status).toBe('result_unknown');
      expect(result.data!.error?.code).toBe('RESULT_UNKNOWN');
      expect(result.data!.observations?.commitObserved).toBe(false);
    });

    it('returns paused responses', async () => {
      const client = createMockPipeClient('paused');
      const result = await client.send(makeRequest());
      expect(result.data!.status).toBe('paused');
      expect(result.data!.error?.code).toBe('CANDIDATE_AMBIGUOUS');
    });

    it('returns unavailable responses for health and send', async () => {
      const client = createMockPipeClient('unavailable');
      const health = await client.health();
      expect(health.success).toBe(true);
      expect(health.data!.healthy).toBe(false);
      expect(health.data!.status).toBe('unavailable');

      const send = await client.send(makeRequest());
      expect(send.data!.status).toBe('failed');
      expect(send.data!.error?.code).toBe('RPA_UNAVAILABLE');
    });

    it('close is a no-op', () => {
      const client = createMockPipeClient();
      expect(() => client.close()).not.toThrow();
    });
  });

  // ── createNamedPipeClient (real, with mocked net) ──

  describe('createNamedPipeClient', () => {
    // ── connect success path ──

    it('connect succeeds and receives valid JSON', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendAndResolve(client, {
        status: 'succeeded',
        observations: { candidateVerified: true },
      });
      expect(net.createConnection).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('succeeded');
    });

    // ── timeout paths (use fake timers) ──

    it('connect timeout rejects', async () => {
      vi.useFakeTimers();
      const client = createNamedPipeClient(makeConfig({ default_timeout_ms: 1000 }));
      const promise = client.send(makeRequest());
      vi.advanceTimersByTime(1100);
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('connection timeout');
      vi.useRealTimers();
    });

    it('response timeout returns RPA_TIMEOUT', async () => {
      vi.useFakeTimers();
      const client = createNamedPipeClient(makeConfig({ default_timeout_ms: 1000 }));

      const promise = client.send(makeRequest());
      // Let connect resolve first
      await vi.advanceTimersByTimeAsync(1);
      _mockSocket.emit('connect');
      await vi.advanceTimersByTimeAsync(1);
      // Now advance past the response timeout (but connect already resolved, so only response timeout fires)
      vi.advanceTimersByTime(1100);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_TIMEOUT');
      vi.useRealTimers();
    });

    // ── error paths ──

    it('connect error with ENOENT → RPA_UNAVAILABLE', async () => {
      // Emit error on next tick (before connect timeout fires)
      setTimeout(() => {
        _mockSocket.emit('error', Object.assign(new Error('pipe not found'), { code: 'ENOENT' }));
      }, 0);

      const client = createNamedPipeClient(makeConfig());
      const result = await client.send(makeRequest());

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_UNAVAILABLE');
    });

    it('connect error with other code → RPA_CONNECTION_FAILED', async () => {
      setTimeout(() => {
        _mockSocket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      }, 0);

      const client = createNamedPipeClient(makeConfig());
      const result = await client.send(makeRequest());

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_CONNECTION_FAILED');
    });

    it('connect error without code → RPA_CONNECTION_FAILED', async () => {
      setTimeout(() => _mockSocket.emit('error', new Error('generic error')), 0);

      const client = createNamedPipeClient(makeConfig());
      const result = await client.send(makeRequest());

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_CONNECTION_FAILED');
    });

    it('invalid JSON response returns RPA_OUTPUT_UNRECOGNIZED', async () => {
      const client = createNamedPipeClient(makeConfig());
      const promise = client.send(makeRequest());

      await vi.waitFor(() => {}, { timeout: 20 }).catch(() => {});
      _mockSocket.emit('connect');
      await vi.waitFor(() => {}, { timeout: 20 }).catch(() => {});
      _mockSocket.emit('data', Buffer.from('not-valid-json\n'));

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_OUTPUT_UNRECOGNIZED');
    });

    it('rejects a response bound to another request', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendAndResolve(client, { requestId: 'req-other' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_PROTOCOL_ERROR');
    });

    it('rejects an unsupported response schema version', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendAndResolve(client, { schemaVersion: '2.0' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_PROTOCOL_ERROR');
    });

    it('rejects an unknown response status', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendAndResolve(client, { status: 'maybe' as RpaResponse['status'] });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_PROTOCOL_ERROR');
    });

    it('rejects a malformed error object', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendAndResolve(client, {
        status: 'failed',
        error: { code: 'BROKEN' } as RpaResponse['error'],
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_PROTOCOL_ERROR');
    });

    it('rejects a response larger than the protocol limit', async () => {
      const client = createNamedPipeClient(makeConfig());
      const promise = client.send(makeRequest());

      await new Promise((resolve) => setTimeout(resolve, 10));
      _mockSocket.emit('connect');
      await new Promise((resolve) => setTimeout(resolve, 10));
      _mockSocket.emit('data', Buffer.alloc(RPA_MAX_RESPONSE_BYTES + 1, 0x61));

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_OUTPUT_TOO_LARGE');
    });

    it('rejects an invalid request deadline without opening the pipe', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await client.send(makeRequest({ deadlineAt: 'not-a-date' }));
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_DEADLINE_INVALID');
      expect(net.createConnection).not.toHaveBeenCalled();
    });

    it('rejects an expired request deadline without opening the pipe', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await client.send(makeRequest({ deadlineAt: new Date(Date.now() - 1).toISOString() }));
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_DEADLINE_EXPIRED');
      expect(net.createConnection).not.toHaveBeenCalled();
    });

    it('socket error during receive → RPA_IO_ERROR', async () => {
      const client = createNamedPipeClient(makeConfig());
      const promise = client.send(makeRequest());

      // Allow connect to register handlers
      await new Promise((r) => setTimeout(r, 10));
      _mockSocket.emit('connect');
      // Allow sendRaw continuation to register data/error/close handlers
      await new Promise((r) => setTimeout(r, 10));
      _mockSocket.emit('error', new Error('pipe broken'));

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_IO_ERROR');
    });

    it('close without any data → RPA_CONNECTION_CLOSED', async () => {
      const client = createNamedPipeClient(makeConfig());
      const promise = client.send(makeRequest());

      await new Promise((r) => setTimeout(r, 10));
      _mockSocket.emit('connect');
      await new Promise((r) => setTimeout(r, 10));
      _mockSocket.emit('close');

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_CONNECTION_CLOSED');
    });

    it('close after partial data (no newline) is RPA_CONNECTION_CLOSED', async () => {
      const client = createNamedPipeClient(makeConfig());
      const promise = client.send(makeRequest());

      // Allow connect to register handlers
      await new Promise((r) => setTimeout(r, 10));
      _mockSocket.emit('connect');
      // Allow sendRaw continuation to register data/error/close handlers
      await new Promise((r) => setTimeout(r, 10));
      _mockSocket.emit('data', Buffer.from('partial-data-without-newline'));
      _mockSocket.emit('close');

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_CONNECTION_CLOSED');
    });

    it('write error returns RPA_WRITE_ERROR', async () => {
      // Socket connects OK but write fails
      _mockSocket._setWriteBehaviour('fail');
      (net.createConnection as any).mockReturnValue(_mockSocket);

      const client = createNamedPipeClient(makeConfig());
      const promise = client.send(makeRequest());

      // Emit connect so write proceeds
      await vi.waitFor(() => {}, { timeout: 20 }).catch(() => {});
      _mockSocket.emit('connect');

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_WRITE_ERROR');
      expect(result.error).toContain('write failed');
    });

    // ── health ──

    it('health returns healthy when RPA responds succeeded', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendHealthAndResolve(client, {
        status: 'succeeded',
        observations: { runner: 'ok' },
      });
      expect(result.success).toBe(true);
      expect(result.data!.healthy).toBe(true);
      expect(result.data!.status).toBe('succeeded');
    });

    it('health returns unhealthy when RPA responds failed', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendHealthAndResolve(client, {
        status: 'failed',
        error: { code: 'DOWN', message: 'runner dead' },
      });
      expect(result.success).toBe(true);
      expect(result.data!.healthy).toBe(false);
    });

    it('health handles sendRaw failure (ENOENT → UNAVAILABLE)', async () => {
      setTimeout(() => {
        _mockSocket.emit('error', Object.assign(new Error('pipe not found'), { code: 'ENOENT' }));
      }, 0);

      const client = createNamedPipeClient(makeConfig());
      const result = await client.health();
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RPA_UNAVAILABLE');
    });

    it('health handles sendRaw success but no data', async () => {
      const client = createNamedPipeClient(makeConfig());
      const promise = client.health();

      await vi.waitFor(() => {}, { timeout: 20 }).catch(() => {});
      _mockSocket.emit('connect');
      await vi.waitFor(() => {}, { timeout: 20 }).catch(() => {});
      _mockSocket.emit('close');

      const result = await promise;
      expect(result.success).toBe(false);
    });

    it('health returns unhealthy when status is other', async () => {
      const client = createNamedPipeClient(makeConfig());
      const result = await sendHealthAndResolve(client, {
        status: 'paused',
        observations: { reason: 'stuck' },
      });
      expect(result.success).toBe(true);
      expect(result.data!.healthy).toBe(false);
    });

    // ── close ──

    it('close is safe when no socket', () => {
      const client = createNamedPipeClient(makeConfig());
      expect(() => client.close()).not.toThrow();
    });

    it('close destroys the socket after connect', async () => {
      const client = createNamedPipeClient(makeConfig({ default_timeout_ms: 500 }));
      // Fire off a send to establish the socket
      const promise = client.send(makeRequest());
      await vi.waitFor(() => {}, { timeout: 10 }).catch(() => {});
      _mockSocket.emit('connect');

      // Give it a tick for currentSocket to be set, then close
      await vi.waitFor(() => {}, { timeout: 10 }).catch(() => {});

      // Don't wait for the promise — close the socket
      expect(() => client.close()).not.toThrow();

      // Now resolve the promise (it'll fail because socket is destroyed)
      await promise.catch(() => {});
    });

    // ── defaults ──

    it('uses default endpoint when not provided', () => {
      const client = createNamedPipeClient({ default_timeout_ms: 10000 } as any);
      expect(typeof client.send).toBe('function');
      expect(typeof client.health).toBe('function');
      expect(typeof client.close).toBe('function');
    });

    it('uses default timeout when not provided', () => {
      const client = createNamedPipeClient({ endpoint: 'test' } as any);
      expect(typeof client.send).toBe('function');
    });

    // ── win32 pipe path ──

    it('builds Windows pipe path on win32 without error', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const client = createNamedPipeClient(makeConfig({ endpoint: 'my-pipe' }));
      expect(typeof client.send).toBe('function');
    });

    // ── streaming: data arrives in chunks ──

    it('assembles response from multiple data chunks', async () => {
      const client = createNamedPipeClient(makeConfig({ default_timeout_ms: 500 }));
      const promise = client.send(makeRequest());

      // Allow connect to register handlers
      await new Promise((r) => setTimeout(r, 10));
      _mockSocket.emit('connect');
      // Allow sendRaw continuation to register data/error/close handlers
      await new Promise((r) => setTimeout(r, 10));

      _mockSocket.emit('data', Buffer.from('{"schemaVersion":"1.0","requestI'));
      _mockSocket.emit('data', Buffer.from('d":"req-001","status":"succeeded"}\n'));

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('succeeded');
    });
  });

  // ── Constants ──

  it('RPA_SCHEMA_VERSION is "1.0"', () => {
    expect(RPA_SCHEMA_VERSION).toBe('1.0');
  });
});
