import type { Browser, Page } from 'puppeteer-core';

/**
 * Compatibility hook retained for callers.
 *
 * The former implementation masked automation signals and blocked platform security,
 * telemetry and verification resources. Production automation must leave those controls
 * intact and pause when auth.ts identifies a verification/403 page.
 */
export async function installBossPageGuards(page: Page): Promise<void> {
  void page;
}

/** See installBossPageGuards. New pages intentionally receive no risk-control bypasses. */
export async function installBossBrowserPageGuards(browser: Browser): Promise<void> {
  void browser;
}
