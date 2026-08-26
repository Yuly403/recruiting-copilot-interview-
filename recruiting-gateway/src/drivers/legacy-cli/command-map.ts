import type { GatewayCommand } from '../../contracts/command.js';
import type { LegacyCliConfig } from '../../gateway/config.js';
import type { CliProcessOptions } from './cli-process.js';

// ── Operation → CLI Command Mapping (per PRD §9) ──

/**
 * Map a Gateway operation to its boss-cli subcommand and arguments.
 * Returns null for operations that the legacy_cli driver does not handle.
 */
export interface CliCommandMapping {
  subcommand: string;
  args: string[];
}

/**
 * Gateway operations that the legacy_cli driver handles.
 * These are all read/navigation/session operations (never writes).
 */
const SUPPORTED_OPERATIONS: Set<string> = new Set([
  'session.login',
  'positions.list',
  'jd.get',
  'candidates.list',
  'candidates.listUnread',
  'candidates.search',
  'candidates.deepSearch',
  'candidates.recommend',
  'candidate.preview',
  'conversation.open',
]);

export function isSupportedByLegacyCli(operation: string): boolean {
  return SUPPORTED_OPERATIONS.has(operation);
}

/**
 * Build the boss-cli command + arguments for a Gateway operation.
 *
 * Mapping table:
 *   session.login          → boss login
 *   positions.list         → boss positions
 *   jd.get                 → boss jd <name>
 *   candidates.list         → boss list
 *   candidates.listUnread   → boss list --unread
 *   candidates.search       → boss search <query> [--job <job>]
 *   candidates.deepSearch   → boss deep-search <query> --job <job> --match
 *   candidates.recommend    → boss recommend [<query>]
 *   candidate.preview       → boss preview <name>
 *   conversation.open       → boss chat <name>
 */
export function mapOperationToCli(
  command: GatewayCommand,
): CliCommandMapping | null {
  const { operation, input } = command;

  switch (operation) {
    case 'session.login':
      return { subcommand: 'login', args: [] };

    case 'positions.list':
      return { subcommand: 'positions', args: [] };

    case 'jd.get': {
      const args: string[] = [];
      if (input.job) args.push(input.job);
      return { subcommand: 'jd', args };
    }

    case 'candidates.list':
      return { subcommand: 'list', args: [] };

    case 'candidates.listUnread':
      return { subcommand: 'list', args: ['--unread'] };

    case 'candidates.search': {
      const args: string[] = [];
      if (input.query) args.push(input.query);
      if (input.job) args.push('--job', input.job);
      return { subcommand: 'search', args };
    }

    case 'candidates.deepSearch': {
      const args: string[] = [];
      // query = 岗位关键字 (positional)
      if (input.query) args.push(input.query);
      // job = 岗位下拉匹配
      if (input.job) args.push('--job', input.job);
      // Only add --match when explicitly requested (it triggers auto-greeting which requires approval)
      if (input.match === true) args.push('--match');
      return { subcommand: 'deep-search', args };
    }

    case 'candidates.recommend': {
      const args: string[] = [];
      if (input.query) args.push(input.query);
      return { subcommand: 'recommend', args };
    }

    case 'candidate.preview': {
      const args: string[] = [];
      if (input.name) args.push(input.name);
      if (input.index !== undefined && input.index > 0) {
        args.push('--index', String(input.index));
      }
      return { subcommand: 'preview', args };
    }

    case 'conversation.open': {
      const args: string[] = [];
      if (input.name) {
        args.push(input.name);
      } else if (input.index !== undefined && input.index > 0) {
        args.push('--index', String(input.index));
      }
      // Guard: need either name or index
      if (args.length === 0) {
        return null; // cannot open conversation without target
      }
      return { subcommand: 'chat', args };
    }

    default:
      return null;
  }
}

/**
 * Build a full CliProcessOptions from a Gateway command and driver config.
 */
export function buildProcessOptions(
  command: GatewayCommand,
  mapping: CliCommandMapping,
  config: LegacyCliConfig,
  cwd?: string,
): CliProcessOptions {
  return {
    executable: config.executable,
    subcommand: mapping.subcommand,
    args: mapping.args,
    timeoutMs: config.default_timeout_ms,
    maxStdoutBytes: config.max_stdout_bytes,
    maxStderrBytes: config.max_stderr_bytes,
    cwd,
  };
}
