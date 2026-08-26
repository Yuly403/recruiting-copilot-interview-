import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionPlanSchema } from '../../src/contracts/action-plan.js';
import { main, safeTerminalPreview } from '../../src/cli/index.js';

describe('recruitctl plan.create', () => {
  let workspace: string;
  let payloadPath: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-cli-'));
    payloadPath = path.join(workspace, 'message.txt');
    await fs.writeFile(payloadPath, '测试消息', 'utf-8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('creates a pending plan bound to one candidate, job and payload', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => output.push(String(value)));
    const code = await main([
      'node',
      'recruitctl',
      'plan.create',
      '--workspace', workspace,
      '--operation', 'greeting.commit',
      '--candidate-key', 'candidate-001',
      '--name', '张三',
      '--job-ref', 'backend',
      '--source', 'recommended_feed',
      '--list-context-hash', 'sha256:list-state',
      '--payload-file', payloadPath,
    ]);

    expect(code).toBe(0);
    const result = JSON.parse(output.at(-1) ?? '{}') as { plan: string; actionId: string };
    const plan = ActionPlanSchema.parse(JSON.parse(await fs.readFile(result.plan, 'utf-8')));
    expect(plan.actionId).toBe(result.actionId);
    expect(plan.approval.status).toBe('pending');
    expect(plan.status).toBe('awaiting_approval');
    expect(plan.candidateKey).toBe('candidate-001');
    expect(plan.candidateLocator.jobRef).toBe('backend');
    expect(plan.payload.messageHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects candidate.markNotFit plan creation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await main([
      'node', 'recruitctl', 'plan.create',
      '--workspace', workspace,
      '--operation', 'candidate.markNotFit',
      '--candidate-key', 'candidate-001',
      '--name', '张三',
      '--job-ref', 'backend',
      '--source', 'recommended_feed',
      '--list-context-hash', 'sha256:list-state',
      '--payload-file', payloadPath,
    ]);
    expect(code).toBe(1);
  });

  it('escapes terminal control sequences in approval previews', () => {
    expect(safeTerminalPreview('normal\u001b[2Jspoof')).toBe('normal\\u001b[2Jspoof');
  });
});
