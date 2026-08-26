// ── candidates.search output parser ──
// boss search <query> [--job <job>] → candidate search results

import type { ParsedOutput } from './types.js';
import { parseGenericCandidateList } from './helpers.js';

export function parseSearch(stdout: string): ParsedOutput {
  return parseGenericCandidateList(stdout, 'searchResults');
}
