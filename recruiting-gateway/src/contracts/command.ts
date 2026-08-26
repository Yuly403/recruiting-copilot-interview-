import { z } from 'zod';
import { OperationSchema, OperationTypeSchema } from './enums.js';

// ── Gateway Command (per PRD §GW-001, §GW-002) ──

export const GatewayCommandInputSchema = z.object({
  /** Target candidate name for operations that need one */
  name: z.string().optional(),
  /** Job/position reference */
  job: z.string().optional(),
  /** Search query string */
  query: z.string().optional(),
  /** Flag for unread-only modes */
  unread: z.boolean().optional(),
  /** Path to ActionPlan JSON file */
  plan: z.string().optional(),
  /** Path to payload file (message text, etc.) */
  payloadFile: z.string().optional(),
  /** Path to target candidate file */
  targetFile: z.string().optional(),
  /** Deep-search --match flag */
  match: z.boolean().optional(),
  /** Displayed name for preview/chat/greet */
  displayedName: z.string().optional(),
  /** Index specifier for chat */
  index: z.number().int().optional(),
  /** Remark text for remark.update */
  remark: z.string().optional(),
  /** Action ID for recovery/verify/cancel */
  action: z.string().optional(),
  /** Message text (only accepted via --payload-file or stdin, never CLI arg) */
  messageFile: z.string().optional(),
  /** Content hash for dedup / idempotency */
  messageHash: z.string().optional(),
  /** Job reference (for RPA candidate locator) */
  jobRef: z.string().optional(),
});

export type GatewayCommandInput = z.infer<typeof GatewayCommandInputSchema>;

export const GatewayCommandSchema = z.object({
  schemaVersion: z.literal('1.0'),
  requestId: z.string(),
  operation: OperationSchema,
  platform: z.literal('boss'),
  /** Structured input — validated per operation */
  input: GatewayCommandInputSchema,
  /** Optional operation type override (for routing) */
  operationType: OperationTypeSchema.optional(),
});

export type GatewayCommand = z.infer<typeof GatewayCommandSchema>;

/** Normalize a CLI-style command into a GatewayCommand */
export function toGatewayCommand(raw: {
  operation: string;
  input: Record<string, unknown>;
  requestId?: string;
}): GatewayCommand {
  const parsed = OperationSchema.safeParse(raw.operation);
  if (!parsed.success) {
    throw new Error(`Unknown operation: ${raw.operation}`);
  }

  return GatewayCommandSchema.parse({
    schemaVersion: '1.0',
    requestId: raw.requestId ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    operation: parsed.data,
    platform: 'boss',
    input: raw.input,
    operationType: getOperationType(parsed.data),
  });
}

/** Return the operation type for routing (per PRD §7.2 & §17.2) */
export function getOperationType(operation: string): string {
  const readOnlyReads = [
    'positions.list',
    'jd.get',
    'candidates.list',
    'candidates.listUnread',
  ];
  const readNavigations = [
    'candidates.search',
    'candidates.recommend',
  ];
  const readLimited = ['candidate.preview'];
  const navigations = ['conversation.open'];
  const sessionOps = ['session.login', 'session.status'];
  const reversibleWrites = ['message.stage'];
  const irreversibleWrites = [
    'message.commit',
    'greeting.commit',
    'attachment.request',
    'contact.exchange',
    'candidate.markNotFit',
  ];
  const stateWrites = ['attachment.accept', 'remark.update'];
  const readVerifications = ['execution.verify'];
  const controls = ['execution.stop'];

  if (readOnlyReads.includes(operation)) return 'read';
  if (readNavigations.includes(operation)) return 'read_navigation';
  if (readLimited.includes(operation)) return 'read_limited';
  if (navigations.includes(operation)) return 'navigation';
  if (sessionOps.includes(operation)) return operation === 'session.status' ? 'local_read' : 'session';
  if (reversibleWrites.includes(operation)) return 'reversible_write';
  if (irreversibleWrites.includes(operation)) return 'irreversible_write';
  if (stateWrites.includes(operation)) return 'state_write';
  if (readVerifications.includes(operation)) return 'read_verification';
  if (controls.includes(operation)) return 'control';
  if (operation === 'candidates.deepSearch') return 'read_navigation_limited';
  if (operation === 'conversation.read') return 'read';

  throw new Error(`No operation type mapping for: ${operation}`);
}
