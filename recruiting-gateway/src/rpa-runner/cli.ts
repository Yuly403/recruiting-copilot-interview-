#!/usr/bin/env node
import { CdpBossBrowserFactory } from './cdp-browser.js';
import { BossFlowExecutor } from './flow-executor.js';
import { LocalRunnerServer } from './server.js';

const endpoint = process.env.BOSS_RPA_ENDPOINT?.trim() || 'recruiting-copilot-boss-rpa-v1';
const enableCommit = process.env.BOSS_RPA_ENABLE_COMMIT === 'true';
const enableNativeGreeting = process.env.BOSS_RPA_ENABLE_NATIVE_GREETING === 'true';

const executor = new BossFlowExecutor(new CdpBossBrowserFactory(), { enableCommit, enableNativeGreeting });
const server = new LocalRunnerServer(endpoint, executor);

await server.start();
console.log(`BOSS RPA Runner 已启动：${endpoint}（${enableCommit ? '受控发送已开启' : '演练模式，禁止真实发送'}）`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
}

process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
