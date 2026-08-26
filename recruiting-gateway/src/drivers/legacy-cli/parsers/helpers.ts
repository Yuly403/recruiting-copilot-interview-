// ── Shared parsing helpers ──

import type { ParsedOutput } from './types.js';

/**
 * Best-effort generic candidate list parser.
 * Scans stdout for numbered lines ("N. Name") and collects them.
 * Filters out status/header lines like "已读取" or "搜索结果".
 */
export function parseGenericCandidateList(
  stdout: string,
  key: string,
): ParsedOutput {
  const candidates: Array<Record<string, unknown>> = [];

  const lineRegex = /^(\d+)\.\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(stdout)) !== null) {
    const name = match[2].trim();
    if (
      name.includes('已读取') ||
      name.includes('搜索结果') ||
      name.includes('推荐结果')
    ) {
      continue;
    }

    candidates.push({
      index: parseInt(match[1], 10),
      name,
    });
  }

  return {
    rawOutput: stdout,
    parsed: { [key]: candidates },
    fullyParsed: candidates.length > 0,
  };
}

/**
 * Returns a fallback result when stdout is empty.
 */
export function emptyResult(stdout: string): ParsedOutput {
  return {
    rawOutput: stdout,
    parsed: { empty: true },
    fullyParsed: false,
  };
}
