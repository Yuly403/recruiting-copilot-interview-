import type { Driver, DriverExecuteInput, DriverHealthCheck } from '../driver.js';
import type { GatewayResult } from '../../contracts/result.js';
import { pausedResult } from '../../contracts/result.js';

// ── Human Driver (per PRD) ──
// Always pauses and requests manual takeover

export function createHumanDriver(): Driver {
  return {
    name: 'human',

    async health(): Promise<DriverHealthCheck> {
      return { healthy: true, status: 'available' };
    },

    async execute(input: DriverExecuteInput): Promise<GatewayResult> {
      return pausedResult({
        requestId: input.command.requestId,
        operation: input.command.operation,
        driver: 'human',
        reason: `操作 "${input.command.operation}" 需要人工接管`,
        code: 'INTERNAL_ERROR',
        details: {
          message: '请在 BOSS 页面手动完成此操作后，执行 recruitctl boss release-manual --confirm',
        },
      });
    },

    async stop(): Promise<void> {
      // Human driver doesn't need stopping
    },
  };
}
