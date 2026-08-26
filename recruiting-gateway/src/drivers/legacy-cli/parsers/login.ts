// ── session.login output parser ──
// boss login → "登录页面已打开 ..."

import type { ParsedOutput } from './types.js';

export function parseLogin(stdout: string): ParsedOutput {
  return {
    rawOutput: stdout,
    parsed: {
      loginPageOpened: true,
      message: stdout,
    },
    fullyParsed: true,
  };
}
