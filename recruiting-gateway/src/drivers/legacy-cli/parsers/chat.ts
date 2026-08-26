// ── conversation.open output parser ──
// boss chat <name> [--index <N>] → chat window / conversation history
//
// Two common outputs:
// 1. "已打开与 张三 的会话" → parsed with targetName
// 2. Raw chat history lines → passthrough

import type { ParsedOutput } from './types.js';

export function parseChat(stdout: string): ParsedOutput {
  const openedMatch = stdout.match(/已打开与\s*(.+?)\s*的会话/);
  if (openedMatch) {
    return {
      rawOutput: stdout,
      parsed: {
        opened: true,
        targetName: openedMatch[1],
        conversationText: stdout,
      },
      fullyParsed: true,
    };
  }

  // Chat history output (no opening confirmation line)
  return {
    rawOutput: stdout,
    parsed: { opened: true, conversationText: stdout },
    fullyParsed: true,
  };
}
