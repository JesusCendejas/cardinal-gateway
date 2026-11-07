import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  authHeader,
  createHarness,
  type Harness,
} from './helpers/harness.js';
import { openWs } from './helpers/ws-client.js';

function oneAgent(id: string) {
  return [{ id, name: id, is_primary: true }];
}

function jsonHandler(body: unknown) {
  return (
    _request: unknown,
    response: import('node:http').ServerResponse,
  ): void => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

describe('credenciales y caché', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.agentAlice.setHttpHandler(
      jsonHandler(oneAgent(harness.alice.agentId)),
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it('38. /internal/credentials recibe el sandboxId de /internal/route, no el agentId', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const route = harness.backend.lastRequest('/internal/route');
    expect(route?.body).toMatchObject({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    const credentials = harness.backend.lastRequest('/internal/credentials');
    expect(credentials?.body).toEqual({
      sandboxId: harness.alice.sandboxId,
    });
    expect(credentials?.body).not.toEqual({
      sandboxId: harness.alice.agentId,
    });

    await attempt.close();
  });

  it('39. el capability token no aparece en logs, respuesta, Redis ni snapshot', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const httpResponse = await fetch(`${harness.app.url}/v1/agents`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const httpBody = await httpResponse.text();
    expect(httpResponse.status).toBe(200);
    expect(httpBody).not.toContain(harness.alice.capabilityToken);

    const logs = harness.app.logs.text();
    expect(logs).not.toContain(harness.alice.capabilityToken);
    expect(logs).not.toContain(harness.alice.accessToken);

    expect(harness.redis.allWrites()).not.toContain(
      harness.alice.capabilityToken,
    );

    const snapshot = await harness.app.app.connectionRegistry.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(
      harness.alice.capabilityToken,
    );
    expect(JSON.stringify(snapshot)).not.toContain('token');

    await attempt.close();
  });

  it('40. /internal/credentials 500 -> close 4503 CREDENTIALS_UNAVAILABLE (no 4401)', async () => {
    harness.backend.credentialsHandler = () => ({
      status: 500,
      body: { error: 'BOOM' },
    });

    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const close = await attempt.waitForClose(2000);

    expect(close.code).toBe(4503);
    expect(close.code).not.toBe(4401);
    expect(close.reason).toContain('CREDENTIALS_UNAVAILABLE');
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('41. la caché route:<userId>:<agentId> no contiene token', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const expectedKey = `route:${harness.alice.userId}:${harness.alice.agentId}`;
    const keys = await harness.redis.keys('route:*');
    expect(keys).toContain(expectedKey);

    const raw = await harness.redis.get(expectedKey);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(harness.alice.capabilityToken);

    const cached = JSON.parse(raw as string) as Record<string, unknown>;
    expect(cached).not.toHaveProperty('token');
    expect(cached).not.toHaveProperty('credentials');
    expect(Object.keys(cached)).not.toContain('token');

    await attempt.close();
  });

  it('42. Redis caído: /internal/route se llama igual y la conexión funciona', async () => {
    harness.redis.down = true;

    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(attempt.opened).toBe(true);
    expect(harness.backend.requestsFor('/internal/route')).toHaveLength(1);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);
    expect(harness.redis.errorCount()).toBeGreaterThan(0);

    await attempt.close();
  });
});
