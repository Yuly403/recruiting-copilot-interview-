import { z } from 'zod';
import {
  ExecutionStatusSchema,
  ErrorCodeSchema,
  DriverTypeSchema,
} from './enums.js';

// ── Gateway Result (per PRD §GW-003) ──

export const GatewayWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type GatewayWarning = z.infer<typeof GatewayWarningSchema>;

export const GatewayErrorDetailSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type GatewayErrorDetail = z.infer<typeof GatewayErrorDetailSchema>;

export const GatewayResultSchema = z.object({
  schemaVersion: z.literal('1.0'),
  requestId: z.string(),
  operation: z.string(),
  status: ExecutionStatusSchema,
  driver: DriverTypeSchema,
  data: z.unknown().default({}),
  warnings: z.array(GatewayWarningSchema).default([]),
  error: GatewayErrorDetailSchema.nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string(),
});

export type GatewayResult = z.infer<typeof GatewayResultSchema>;

/** Build a success result */
export function successResult(params: {
  requestId: string;
  operation: string;
  driver: string;
  data?: unknown;
  warnings?: GatewayWarning[];
  startedAt: string;
  finishedAt: string;
}): GatewayResult {
  return GatewayResultSchema.parse({
    schemaVersion: '1.0',
    requestId: params.requestId,
    operation: params.operation,
    status: 'succeeded',
    driver: params.driver,
    data: params.data ?? {},
    warnings: params.warnings ?? [],
    error: null,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
  });
}

/** Build a denied result */
export function deniedResult(params: {
  requestId: string;
  operation: string;
  reason: string;
  code?: string;
}): GatewayResult {
  return GatewayResultSchema.parse({
    schemaVersion: '1.0',
    requestId: params.requestId,
    operation: params.operation,
    status: 'denied',
    driver: 'gateway_local',
    data: {},
    warnings: [],
    error: {
      code: params.code ?? 'APPROVAL_MISSING',
      message: params.reason,
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
}

/** Build a paused result */
export function pausedResult(params: {
  requestId: string;
  operation: string;
  driver: string;
  reason: string;
  code?: string;
  details?: Record<string, unknown>;
}): GatewayResult {
  return GatewayResultSchema.parse({
    schemaVersion: '1.0',
    requestId: params.requestId,
    operation: params.operation,
    status: 'paused',
    driver: params.driver,
    data: {},
    warnings: [],
    error: {
      code: params.code ?? 'INTERNAL_ERROR',
      message: params.reason,
      details: params.details,
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
}

/** Build a failed result */
export function failedResult(params: {
  requestId: string;
  operation: string;
  driver: string;
  errorCode: string;
  message: string;
  details?: Record<string, unknown>;
}): GatewayResult {
  return GatewayResultSchema.parse({
    schemaVersion: '1.0',
    requestId: params.requestId,
    operation: params.operation,
    status: 'failed',
    driver: params.driver,
    data: {},
    warnings: [],
    error: {
      code: params.errorCode,
      message: params.message,
      details: params.details,
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
}
