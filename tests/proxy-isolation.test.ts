import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  authHeader,
  createHarness,
  type Harness,
} from './helpers/harness.js';

interface AgentDto {
  id: string;
  name: string;
  is_primary: boolean;
}

function fiveAgents(primaryId: string): AgentDto[] {
  return [
    { id: primaryId, name: 'primary', is_primary: true },
    { id: 'agent-other-1', name: 'other-1', is_primary: false },
    { id: 'agent-other-2', name: 'other-2', is_primary: false },
    { id: 'agent-other-3', name: 'other-3', is_primary: false },
    { id: 'agent-other-4', name: 'other-4', is_primary: false },
  ];
}

function jsonHandler(body: unknown, status = 200) {
  return (
    _request: unknown,
    response: import('node:http').ServerResponse,
  ): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

describe('aislamiento multi-tenant (proxy HTTP)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('12. GET /v1/agents de alice -> Bearer del sandbox de alice y 1 agente', async () => {
    harness.agentAlice.setHttpHandler(
      jsonHandler(fiveAgents(harness.alice.agentId)),
    );

    const response = await fetch(`${harness.app.url}/v1/agents`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentDto[];
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(harness.alice.agentId);

    const upstream = harness.agentAlice.httpRequests.find((request) =>
      request.url.startsWith('/v1/agents'),
    );
    expect(upstream).toBeDefined();
    expect(upstream?.headers.authorization).toBe(
      `Bearer ${harness.alice.capabilityToken}`,
    );

    const route = harness.backend.lastRequest('/internal/route');
    expect(route?.body).toEqual({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    const credentials = harness.backend.lastRequest('/internal/credentials');
    expect(credentials?.body).toEqual({
      sandboxId: harness.alice.sandboxId,
    });
  });

  it('13. GET /v1/agents/<agent de bob> con token de alice -> 404 y cero /internal/route', async () => {
    const response = await fetch(
      `${harness.app.url}/v1/agents/${encodeURIComponent(harness.bob.agentId)}`,
      { headers: authHeader(harness.alice.accessToken) },
    );

    expect(response.status).toBe(404);
    expect(harness.backend.requestsFor('/internal/route')).toHaveLength(0);
    expect(harness.agentAlice.httpRequests).toHaveLength(0);
    expect(harness.agentBob.httpRequests).toHaveLength(0);
  });

  it('14. body con agent_id de bob en path de alice -> 403/404 sin upstream', async () => {
    const response = await fetch(
      `${harness.app.url}/v1/agents/${encodeURIComponent(harness.alice.agentId)}/messages`,
      {
        method: 'POST',
        headers: {
          ...authHeader(harness.alice.accessToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: harness.bob.agentId,
          messages: [{ role: 'user', content: 'hola' }],
        }),
      },
    );

    expect([403, 404]).toContain(response.status);
    expect(harness.agentAlice.httpRequests).toHaveLength(0);
    expect(harness.agentBob.httpRequests).toHaveLength(0);
  });

  it('15. upstream devuelve 5 agentes -> al cliente llega 1', async () => {
    harness.agentAlice.setHttpHandler(
      jsonHandler(fiveAgents(harness.alice.agentId)),
    );

    const response = await fetch(`${harness.app.url}/v1/agents`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentDto[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body.filter((agent) => agent.is_primary)).toHaveLength(1);
  });

  it('16. GET /app-server-info -> reenviado con Bearer', async () => {
    harness.agentAlice.setHttpHandler(
      jsonHandler({ backend: 'local', protocol_version: 1 }),
    );

    const response = await fetch(`${harness.app.url}/app-server-info`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      backend: 'local',
      protocol_version: 1,
    });

    const upstream = harness.agentAlice.httpRequests.find((request) =>
      request.url.startsWith('/app-server-info'),
    );
    expect(upstream).toBeDefined();
    expect(upstream?.headers.authorization).toBe(
      `Bearer ${harness.alice.capabilityToken}`,
    );
  });

  it('17. DELETE /v1/agents/x -> 405 sin tocar upstream', async () => {
    const response = await fetch(
      `${harness.app.url}/v1/agents/${encodeURIComponent(harness.alice.agentId)}`,
      {
        method: 'DELETE',
        headers: authHeader(harness.alice.accessToken),
      },
    );

    expect(response.status).toBe(405);
    expect(harness.agentAlice.httpRequests).toHaveLength(0);
    expect(harness.agentBob.httpRequests).toHaveLength(0);
  });

  it('18a. upstream 500 -> 502 UPSTREAM_ERROR', async () => {
    harness.agentAlice.setHttpHandler(
      jsonHandler({ error: 'boom' }, 500),
    );

    const response = await fetch(`${harness.app.url}/v1/agents`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'UPSTREAM_ERROR' });
  });

  it('18b. upstream supera UPSTREAM_TIMEOUT_MS -> 502 (sin colgarse)', async () => {
    const app = await harness.restartApp({ upstreamTimeoutMs: 50 });
    try {
      harness.agentAlice.setHttpHandler((_request, response) => {
        setTimeout(() => {
          try {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('[]');
          } catch {
            /* the gateway already timed out and closed the socket */
          }
        }, 300);
      });

      const startedAt = Date.now();
      const response = await fetch(`${app.url}/v1/agents`, {
        headers: authHeader(harness.alice.accessToken),
      });
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: 'UPSTREAM_ERROR',
      });
      expect(elapsedMs).toBeLessThan(2000);
    } finally {
      await app.close();
    }
  });
});
