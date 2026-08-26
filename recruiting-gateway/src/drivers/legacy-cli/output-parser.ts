// ── Unified Output Parser: dispatches to per-operation parsers ──
//
// This file retains the `parseCliOutput()` function as the single entry point.
// Each operation's parsing logic lives in its own module under `parsers/`,
// making it easy to extend, test, and maintain individual parsers independently.
//
// Usage:
//   import { parseCliOutput } from './output-parser.js';
//   const result = parseCliOutput('positions.list', stdout);

import type { ParsedOutput } from './parsers/types.js';
import { emptyResult } from './parsers/helpers.js';
import { parseLogin } from './parsers/login.js';
import { parsePositions } from './parsers/positions.js';
import { parseJd } from './parsers/jd.js';
import { parseCandidatesList } from './parsers/candidates-list.js';
import { parseSearch } from './parsers/search.js';
import { parseDeepSearch } from './parsers/deep-search.js';
import { parseRecommend } from './parsers/recommend.js';
import { parsePreview } from './parsers/preview.js';
import { parseChat } from './parsers/chat.js';

// Re-export the central type for consumers
export type { ParsedOutput } from './parsers/types.js';

/**
 * Parse boss-cli stdout based on the operation type.
 *
 * Dispatches to the appropriate per-operation parser. If no specialized
 * parser exists for the operation, returns raw output with a note.
 */
export function parseCliOutput(
  operation: string,
  stdout: string,
): ParsedOutput {
  if (!stdout.trim()) {
    return emptyResult(stdout);
  }

  switch (operation) {
    case 'session.login':
      return parseLogin(stdout);
    case 'positions.list':
      return parsePositions(stdout);
    case 'jd.get':
      return parseJd(stdout);
    case 'candidates.list':
    case 'candidates.listUnread':
      return parseCandidatesList(stdout);
    case 'candidates.search':
      return parseSearch(stdout);
    case 'candidates.deepSearch':
      return parseDeepSearch(stdout);
    case 'candidates.recommend':
      return parseRecommend(stdout);
    case 'candidate.preview':
      return parsePreview(stdout);
    case 'conversation.open':
      return parseChat(stdout);
    default:
      return {
        rawOutput: stdout,
        parsed: { note: 'no specialized parser for this operation' },
        fullyParsed: false,
      };
  }
}
