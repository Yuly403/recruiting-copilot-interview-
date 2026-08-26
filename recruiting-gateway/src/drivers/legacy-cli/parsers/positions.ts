// ── positions.list output parser ──
// boss positions → numbered position list with status counts
//
// Expected format (Chinese text):
//   已读取 N 个职位
//   开放中 N｜待开放 N｜已关闭 N
//   ──────────────────────────
//   1. 职位名｜状态:X｜标签:X｜经验X｜学历X｜看过我:X｜沟通过:X｜感兴趣:X

import type { ParsedOutput } from './types.js';

export function parsePositions(stdout: string): ParsedOutput {
  const positions: Array<Record<string, string>> = [];
  let totalCount = 0;
  let openCount = 0;
  let pendingCount = 0;
  let closedCount = 0;

  // Extract total count: "已读取 N 个职位"
  const totalMatch = stdout.match(/已读取\s*(\d+)\s*个职位/);
  if (totalMatch) totalCount = parseInt(totalMatch[1], 10);

  // Extract status counts: "开放中 N｜待开放 N｜已关闭 N"
  const statusMatch = stdout.match(
    /开放中\s*(\d+)[｜|]\s*待开放\s*(\d+)[｜|]\s*已关闭\s*(\d+)/,
  );
  if (statusMatch) {
    openCount = parseInt(statusMatch[1], 10);
    pendingCount = parseInt(statusMatch[2], 10);
    closedCount = parseInt(statusMatch[3], 10);
  }

  // Parse individual position lines
  // Format: "N. 职位名｜状态:X｜标签:X｜经验X｜学历X｜..."
  const posRegex = /^(\d+)\.\s+(.+?)\s*[｜|]/gm;
  let posMatch: RegExpExecArray | null;
  while ((posMatch = posRegex.exec(stdout)) !== null) {
    const nextNewline = stdout.indexOf('\n', posMatch.index);
    const line =
      nextNewline === -1
        ? stdout.slice(posMatch.index)
        : stdout.slice(posMatch.index, nextNewline);
    const name = posMatch[2].trim();
    const statusLine = line.match(/状态[:：](.+?)\s*[｜|]/);
    positions.push({
      index: posMatch[1],
      name,
      status: statusLine ? statusLine[1] : 'unknown',
    });
  }

  return {
    rawOutput: stdout,
    parsed: {
      totalCount,
      openCount,
      pendingCount,
      closedCount,
      positions,
    },
    fullyParsed: positions.length > 0,
  };
}
