// ── candidates.list / candidates.listUnread output parser ──
// boss list [--unread] → numbered candidate entries
//
// Expected format:
//   沟通列表共 N 人
//   N 人有未读消息
//   ──────────────────────────────
//   1. 姓名｜职位｜未读:N｜时间:XX｜消息:XX

import type { ParsedOutput } from './types.js';

export function parseCandidatesList(stdout: string): ParsedOutput {
  const candidates: Array<Record<string, unknown>> = [];
  let totalCount = 0;
  let unreadCount = 0;

  // Extract total: "沟通列表共 N 人"
  const totalMatch = stdout.match(/沟通列表共\s*(\d+)\s*人/);
  if (totalMatch) totalCount = parseInt(totalMatch[1], 10);

  // Extract unread: "N 人有未读消息"
  const unreadMatch = stdout.match(/(\d+)\s*人有未读消息/);
  if (unreadMatch) unreadCount = parseInt(unreadMatch[1], 10);

  // Parse candidate lines
  // Format: "N. 姓名｜职位｜未读:N｜时间:XX｜消息:XX"
  const lineRegex = /^(\d+)\.\s+(.+?)\s*[｜|](.+?)\s*[｜|]/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(stdout)) !== null) {
    const restOfLine = stdout
      .slice(match.index + match[0].length)
      .split('\n')[0];
    const name = match[2].trim();
    const title = match[3].trim();
    const lineUnreadMatch = restOfLine.match(/未读[:：](\d+)/);
    const timeMatch = restOfLine.match(/时间[:：](.+?)\s*[｜|]/);
    const msgMatch = restOfLine.match(/消息[:：](.+)/);

    candidates.push({
      index: parseInt(match[1], 10),
      name,
      title,
      unread: lineUnreadMatch ? parseInt(lineUnreadMatch[1], 10) : 0,
      time: timeMatch ? timeMatch[1] : undefined,
      message: msgMatch ? msgMatch[1].trim() : undefined,
    });
  }

  return {
    rawOutput: stdout,
    parsed: { totalCount, unreadCount, candidates },
    fullyParsed: candidates.length > 0,
  };
}
