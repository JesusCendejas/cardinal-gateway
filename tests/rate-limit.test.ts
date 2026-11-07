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

describe('rate limit por userId', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness({
      config: { rateLimitPerMinute: 100 },
    });
    harness.agentAlice.setHttpHandler(
      jsonHandler(oneAgent(harness.alice.agentId)),
    );
    harness.agentBob.setHttpHandler(
      jsonHandler(oneAgent(harness.bob.agentId)),
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it('35a. petición HTTP 101 recibe 429', async () => {
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${harness.app.url}/v1/agents`, {
        headers: authHeader(harness.alice.accessToken),
      });
      expect(response.status).toBe(200);
    }

    const limited = await fetch(`${harness.app.url}/v1/agents`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(limited.status).toBe(429);
  });

  it('35b. handshake WS 101 recibe close 4429', async () => {
    for (let index = 0; index < 100; index += 1) {
      const session = await openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });
      expect(session.opened).toBe(true);
      await session.close();
    }

    const limited = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const close = await limited.waitForClose(2000);

    expect(close.code).toBe(4429);
  });

  it('36. el contador es por userId, no por IP', async () => {
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${harness.app.url}/v1/agents`, {
        headers: authHeader(harness.alice.accessToken),
      });
      expect(response.status).toBe(200);
    }

    const bobResponse = await fetch(`${harness.app.url}/v1/agents`, {
      headers: authHeader(harness.bob.accessToken),
    });
    expect(bobResponse.status).toBe(200);

    const bobBody = (await bobResponse.json()) as Array<{ id: string }>;
    expect(bobBody).toHaveLength(1);
    expect(bobBody[0]?.id).toBe(harness.bob.agentId);
  });

  it('37. Redis caído -> fail-open con log de error y contador local', async () => {
    harness.redis.down = true;

    const response = await fetch(`${harness.app.url}/v1/agents`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(response.status).toBe(200);
    expect(harness.redis.errorCount()).toBeGreaterThan(0);
    expect(harness.app.logs.text().toLowerCase()).toContain('redis');
  });
});
