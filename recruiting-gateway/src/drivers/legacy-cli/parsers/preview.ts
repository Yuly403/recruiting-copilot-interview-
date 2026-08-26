// ── candidate.preview output parser ──
// boss preview <name> [--index <N>] → candidate profile/preview text

import type { ParsedOutput } from './types.js';

export function parsePreview(stdout: string): ParsedOutput {
  return {
    rawOutput: stdout,
    parsed: {
      previewText: stdout,
      previewGenerated: stdout.length > 0,
    },
    fullyParsed: true,
  };
}
