import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  authHeader,
  createHarness,
  type Harness,
} from './helpers/harness.js';
import { openWs } from './helpers/ws-client.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';
const DISALLOWED_ORIGIN = 'http://evil.example';

describe('validación de Origin', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      config: { allowedOrigins: [ALLOWED_ORIGIN] },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('10. Origin fuera de ALLOWED_ORIGINS -> 403 antes del upgrade', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
      origin: DISALLOWED_ORIGIN,
    });

    expect(attempt.statusCode).toBe(403);
    expect(attempt.opened).toBe(false);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('11. Origin permitido -> upgrade y el upstream NO recibe Origin', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
      origin: ALLOWED_ORIGIN,
    });

    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const upgrade = harness.agentAlice.upgradeRequests[0];
    expect(upgrade).toBeDefined();
    expect(upgrade?.headers.origin).toBeUndefined();

    await attempt.close();
  });
});
