import { z } from 'zod';
import { DriverTypeSchema } from '../contracts/enums.js';

// ── Gateway Config Schemas (per PRD §17) ──

export const LegacyCliConfigSchema = z.object({
  executable: z.string().default('boss'),
  default_timeout_ms: z.number().int().min(1000).default(60000),
  max_stdout_bytes: z.number().int().default(2_097_152),
  max_stderr_bytes: z.number().int().default(262_144),
});

export const RpaConfigSchema = z.object({
  adapter: z.enum(['named-pipe', 'mock']).default('named-pipe'),
  /** Mock execution is test-only and must never silently acknowledge production writes. */
  allow_mock_writes: z.boolean().default(false),
  endpoint: z.string().default('recruiting-copilot-boss-rpa-v1'),
  default_timeout_ms: z.number().int().min(1000).default(90000),
});

export const LockingConfigSchema = z.object({
  lease_seconds: z.number().int().min(10).default(180),
});

export const ApprovalsConfigSchema = z.object({
  default_ttl_minutes: z.number().int().min(1).default(30),
});

export const CircuitBreakerConfigSchema = z.object({
  identity_failures: z.number().int().min(1).default(2),
  unknown_write_results: z.number().int().min(1).default(1),
  verification_page_immediate_open: z.boolean().default(true),
});

export const BossConfigSchema = z.object({
  legacy_cli: LegacyCliConfigSchema.default({}),
  rpa: RpaConfigSchema.default({}),
  locking: LockingConfigSchema.default({}),
  approvals: ApprovalsConfigSchema.default({}),
  circuit_breaker: CircuitBreakerConfigSchema.default({}),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  redact_payloads: z.boolean().default(true),
  persist_screenshots: z.boolean().default(false),
});

export const GatewayConfigSchema = z.object({
  version: z.literal('1'),
  workspace_root: z.string().default('.'),
  runtime_dir: z.string().default('runtime/execution'),
  boss: BossConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
});

export type LegacyCliConfig = z.infer<typeof LegacyCliConfigSchema>;
export type RpaConfig = z.infer<typeof RpaConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type BossConfig = z.infer<typeof BossConfigSchema>;
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

// ── Route Config (routes.yaml, per PRD §17.2) ──

export const RouteEntrySchema = z.object({
  type: z.string(),
  primary: DriverTypeSchema,
  fallback: DriverTypeSchema,
  approval_required: z.union([z.boolean(), z.enum(['manual_login', 'policy', 'when_match'])]).optional(),
  approval_required_when: z.string().optional(),
  retry_when_result_unknown: z.boolean().optional(),
  automation_allowed: z.boolean().optional(),
});

export const RoutesConfigSchema = z.object({
  version: z.literal('1'),
  operations: z.record(z.string(), RouteEntrySchema),
});

export type RoutesConfig = z.infer<typeof RoutesConfigSchema>;
export type RouteEntry = z.infer<typeof RouteEntrySchema>;

// ── Default routes (mirrors catalog defaults) ──

export function defaultRoutesConfig(): RoutesConfig {
  return {
    version: '1',
    operations: {
      'session.login':               { type: 'session',                 primary: 'legacy_cli',  fallback: 'human', approval_required: 'manual_login' },
      'session.status':              { type: 'local_read',              primary: 'gateway_local', fallback: 'human' },
      'positions.list':              { type: 'read',                    primary: 'legacy_cli',  fallback: 'rpa' },
      'jd.get':                      { type: 'read',                    primary: 'legacy_cli',  fallback: 'rpa' },
      'candidates.list':             { type: 'read',                    primary: 'legacy_cli',  fallback: 'rpa' },
      'candidates.listUnread':       { type: 'read',                    primary: 'legacy_cli',  fallback: 'rpa' },
      'candidates.search':           { type: 'read_navigation',         primary: 'legacy_cli',  fallback: 'human' },
      'candidates.deepSearch':       { type: 'read_navigation_limited', primary: 'legacy_cli',  fallback: 'human', approval_required_when: 'input.match == true' },
      'candidates.recommend':        { type: 'read_navigation',         primary: 'legacy_cli',  fallback: 'human' },
      'candidate.preview':           { type: 'read_limited',            primary: 'legacy_cli',  fallback: 'rpa' },
      'conversation.open':           { type: 'navigation',              primary: 'legacy_cli',  fallback: 'rpa' },
      'conversation.read':           { type: 'read',                    primary: 'rpa',         fallback: 'human' },
      'message.stage':               { type: 'reversible_write',        primary: 'rpa',         fallback: 'human',  approval_required: true },
      'message.commit':              { type: 'irreversible_write',      primary: 'rpa',         fallback: 'human',  approval_required: true, retry_when_result_unknown: false },
      'greeting.commit':             { type: 'irreversible_write',      primary: 'rpa',         fallback: 'human',  approval_required: true, retry_when_result_unknown: false },
      'attachment.request':          { type: 'irreversible_write',      primary: 'rpa',         fallback: 'human',  approval_required: true, retry_when_result_unknown: false },
      'attachment.accept':           { type: 'state_write',             primary: 'rpa',         fallback: 'human',  approval_required: 'policy', retry_when_result_unknown: false },
      'remark.update':               { type: 'state_write',             primary: 'rpa',         fallback: 'human',  approval_required: true, retry_when_result_unknown: false },
      'contact.exchange':            { type: 'irreversible_write',      primary: 'rpa',         fallback: 'human',  approval_required: true, retry_when_result_unknown: false },
      'candidate.markNotFit':        { type: 'irreversible_write',      primary: 'human',       fallback: 'human',  automation_allowed: false },
      'execution.verify':            { type: 'read_verification',       primary: 'current_write_driver', fallback: 'human' },
      'execution.stop':              { type: 'control',                 primary: 'gateway_local', fallback: 'human' },
    },
  };
}
