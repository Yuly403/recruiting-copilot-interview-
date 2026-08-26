// ── Shared types for per-operation parsers ──

export interface ParsedOutput {
  /** Raw stdout text for transparency */
  rawOutput: string;
  /** Structured fields extracted from the output */
  parsed: Record<string, unknown>;
  /** Whether parsing was successful (best-effort, not binary) */
  fullyParsed: boolean;
}

export type ParserFn = (stdout: string) => ParsedOutput;
