// ── candidates.recommend output parser ──
// boss recommend [<query>] → recommended candidate list

import type { ParsedOutput } from './types.js';
import { parseGenericCandidateList } from './helpers.js';

export function parseRecommend(stdout: string): ParsedOutput {
  return parseGenericCandidateList(stdout, 'recommendedCandidates');
}
