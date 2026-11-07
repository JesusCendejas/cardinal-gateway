import { describe, expect, it } from 'vitest';

import {
  authHeader,
  createHarness,
} from './helpers/harness.js';
import { openWs } from './helpers/ws-client.js';

describe('backend caído', () => {
  it('43. /internal/route no responde -> close 4503 BACKEND_UNAVAILABLE y reserva liberada', async () => {
    const harness = await createHarness({
      config: { upstreamTimeoutMs: 100 },
    });

    try {
      harness.backend.down = true;

      const first = await openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });
      const close = await first.waitForClose(3000);

      expect(close.code).toBe(4503);
      expect(close.reason).toContain('BACKEND_UNAVAILABLE');
      expect(harness.agentAlice.upgradeRequests).toHaveLength(0);

      harness.backend.down = false;

      const second = await openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });
      expect(second.opened).toBe(true);

      await second.close();
    } finally {
      await harness.close();
    }
  });
});
