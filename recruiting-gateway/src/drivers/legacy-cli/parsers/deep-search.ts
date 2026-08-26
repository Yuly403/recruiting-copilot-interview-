// ── candidates.deepSearch output parser ──
// boss deep-search <query> --job <job> --match → detailed candidate results
//
// Expected format (blocks, not just one-liner):
//   N. 姓名
//       概要：X年经验 · X学历
//       经历：XX
//       教育：XX
//       推荐：XX

import type { ParsedOutput } from './types.js';

export function parseDeepSearch(stdout: string): ParsedOutput {
  const result: Record<string, unknown> = {};
  const candidates: Array<Record<string, unknown>> = [];

  // Extract match remaining count
  const remainingMatch = stdout.match(/今日匹配剩余[:：](\d+)/);
  if (remainingMatch) result.matchRemaining = parseInt(remainingMatch[1], 10);

  // Extract new results count
  const newCountMatch = stdout.match(
    /本次新增推荐简历.*?共\s*(\d+)\s*人/,
  );
  if (newCountMatch) result.newCount = parseInt(newCountMatch[1], 10);

  // Parse candidate entries
  const entryRegex = /^(\d+)\.\s+(.+)$/gm;
  const lines = stdout.split('\n');
  let entryMatch: RegExpExecArray | null;

  while ((entryMatch = entryRegex.exec(stdout)) !== null) {
    const lineIdx = lines.findIndex((l) =>
      l.includes(`${entryMatch![1]}. ${entryMatch![2]}`),
    );
    if (lineIdx === -1) continue;

    const entry: Record<string, unknown> = {
      index: parseInt(entryMatch[1], 10),
      name: entryMatch[2].trim(),
    };

    // Look ahead for detail lines (indented with spaces/tabs)
    for (
      let i = lineIdx + 1;
      i < Math.min(lineIdx + 6, lines.length);
      i++
    ) {
      const line = lines[i].trim();
      if (!line || /^\d+\.\s+/.test(line)) break;

      if (line.startsWith('概要'))
        entry.summary = line.replace(/^概要[:：]\s*/, '');
      else if (line.startsWith('经历'))
        entry.experience = line.replace(/^经历[:：]\s*/, '');
      else if (line.startsWith('教育'))
        entry.education = line.replace(/^教育[:：]\s*/, '');
      else if (line.startsWith('推荐'))
        entry.recommendReason = line.replace(/^推荐[:：]\s*/, '');
    }

    candidates.push(entry);
  }

  result.candidates = candidates;

  return {
    rawOutput: stdout,
    parsed: result,
    fullyParsed: candidates.length > 0,
  };
}
