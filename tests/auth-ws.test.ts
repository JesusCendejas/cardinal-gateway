import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  authHeader,
  createHarness,
  type Harness,
} from './helpers/harness.js';
import {
  signExpiredAccessToken,
  signWithWrongSecret,
} from './helpers/tokens.js';
import { openWs } from './helpers/ws-client.js';

describe('autenticación de entrada (WS)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('1. WS sin Authorization -> HTTP 401 antes del upgrade; el upstream no recibe nada', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`);

    expect(attempt.statusCode).toBe(401);
    expect(attempt.opened).toBe(false);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
    expect(harness.agentBob.upgradeRequests).toHaveLength(0);
  });

  it('2. accessToken expirado -> 401', async () => {
    const expired = await signExpiredAccessToken({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
      secret: harness.config.accessTokenSecret,
    });

    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(expired),
    });

    expect(attempt.statusCode).toBe(401);
    expect(attempt.opened).toBe(false);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('3. accessToken firmado con otro secreto -> 401', async () => {
    const forged = await signWithWrongSecret({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(forged),
    });

    expect(attempt.statusCode).toBe(401);
    expect(attempt.opened).toBe(false);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('4. accessToken válido -> upstream recibe Bearer del sandbox, no el JWT del cliente', async () => {
    // Contract verified against @letta-ai/letta-code 0.34.20:
    // dist/app-server-client.js appServerSocketOptions() sends
    // `Authorization: Bearer <token>`; letta.js startAppServer()'s upgrade
    // handler reads it via authorizeUpgrade()/bearerTokenFromHeaders().
    // See docs/letta-contract.md.
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const upgrade = harness.agentAlice.upgradeRequests[0];
    expect(upgrade).toBeDefined();
    expect(upgrade?.headers.authorization).toBe(
      `Bearer ${harness.alice.capabilityToken}`,
    );
    expect(upgrade?.headers.authorization).not.toBe(
      `Bearer ${harness.alice.accessToken}`,
    );

    const route = harness.backend.lastRequest('/internal/route');
    expect(route?.body).toMatchObject({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });
    expect(route?.headers['x-internal-token']).toBe(
      harness.config.internalToken,
    );

    const credentials = harness.backend.lastRequest('/internal/credentials');
    expect(credentials?.body).toMatchObject({
      sandboxId: harness.alice.sandboxId,
    });
    expect(credentials?.headers['x-internal-token']).toBe(
      harness.config.internalToken,
    );

    await attempt.close();
  });
});
