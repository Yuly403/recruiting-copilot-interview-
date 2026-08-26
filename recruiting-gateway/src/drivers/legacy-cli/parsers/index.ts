// ── Parser barrel: re-exports all per-operation parsers ──
//
// Each parser is a standalone module for a specific boss-cli operation.
// They share types and helpers via `types.ts` and `helpers.ts`.
//
// Use `parseCliOutput(operation, stdout)` from `output-parser.ts` for the
// unified entry point that dispatches to the correct parser automatically.

export { type ParsedOutput, type ParserFn } from './types.js';
export { emptyResult, parseGenericCandidateList } from './helpers.js';
export { parseLogin } from './login.js';
export { parsePositions } from './positions.js';
export { parseJd } from './jd.js';
export { parseCandidatesList } from './candidates-list.js';
export { parseSearch } from './search.js';
export { parseDeepSearch } from './deep-search.js';
export { parseRecommend } from './recommend.js';
export { parsePreview } from './preview.js';
export { parseChat } from './chat.js';
