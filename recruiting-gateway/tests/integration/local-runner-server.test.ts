import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createNamedPipeClient, RPA_SCHEMA_VERSION } from '../../src/drivers/rpa/named-pipe-client.js';
import { LocalRunnerServer } from '../../src/rpa-runner/server.js';

describe('LocalRunnerServer', () => {
  const servers: LocalRunnerServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('serves health and carries an approved request over the production named-pipe client', async () => {
    const endpoint = `recruiting-copilot-runner-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const seen: string[] = [];
    const server = new LocalRunnerServer(endpoint, {
      async execute(request) {
        seen.push(request.flow);
        return { status: 'succeeded', observations: { handled: request.flow } };
      },
      stop() {},
    });
    servers.push(server);
    await server.start();

    const client = createNamedPipeClient({ endpoint, default_timeout_ms: 2_000 });
    const health = await client.health();
    const result = await client.send({
      schemaVersion: RPA_SCHEMA_VERSION,
      requestId: 'runner-server-request',
      flow: 'boss.open_candidate',
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
      payload: {},
    });

    expect(health).toMatchObject({ success: true, data: { healthy: true } });
    expect(result).toMatchObject({ success: true, data: { status: 'succeeded', observations: { handled: 'boss.open_candidate' } } });
    expect(seen).toEqual(['health', 'boss.open_candidate']);
    client.close();
  });

  it('stops the active executor through the dedicated control flow', async () => {
    const endpoint = `recruiting-copilot-runner-stop-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let stopped = 0;
    const server = new LocalRunnerServer(endpoint, {
      async execute() { return { status: 'succeeded' }; },
      stop() { stopped += 1; },
    });
    servers.push(server);
    await server.start();
    const client = createNamedPipeClient({ endpoint, default_timeout_ms: 2_000 });

    const result = await client.send({
      schemaVersion: RPA_SCHEMA_VERSION,
      requestId: 'runner-stop-request',
      flow: 'boss.stop',
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
      payload: {},
    });

    expect(result).toMatchObject({ success: true, data: { status: 'succeeded', observations: { stopRequested: true } } });
    expect(stopped).toBe(1);
    client.close();
  });
});
