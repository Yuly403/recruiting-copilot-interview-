// ── jd.get output parser ──
// boss jd <name> → JD text (pass-through)

import type { ParsedOutput } from './types.js';

export function parseJd(stdout: string): ParsedOutput {
  return {
    rawOutput: stdout,
    parsed: {
      jdText: stdout,
    },
    fullyParsed: true,
  };
}
