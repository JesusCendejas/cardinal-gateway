import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './helpers/harness.js';
import { openWs } from './helpers/ws-client.js';

describe('tickets de un solo uso', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('5. ?ticket= válido -> consume, abre el WS del agentId devuelto por el backend', async () => {
    const ticket = harness.backend.issueTicket({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    const attempt = await openWs(
      `${harness.app.wsUrl}/ws?ticket=${encodeURIComponent(ticket)}`,
    );

    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const consumed = harness.backend.lastRequest(
      '/internal/tickets/consume',
    );
    expect(consumed?.body).toEqual({ ticket });

    const route = harness.backend.lastRequest('/internal/route');
    expect(route?.body).toEqual({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    await attempt.close();
  });

  it('6. ?ticket= con agentId ajeno en el query -> usa el agentId del backend (alice, no bob)', async () => {
    const ticket = harness.backend.issueTicket({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    const attempt = await openWs(
      `${harness.app.wsUrl}/ws?ticket=${encodeURIComponent(ticket)}&agentId=${encodeURIComponent(harness.bob.agentId)}`,
    );

    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const route = harness.backend.lastRequest('/internal/route');
    expect(route?.body).toEqual({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });
    expect(harness.backend.requestsFor('/internal/route')).toHaveLength(1);

    expect(harness.agentAlice.port).not.toBe(harness.agentBob.port);
    expect(harness.agentBob.upgradeRequests).toHaveLength(0);

    await attempt.close();
  });

  it('7. ticket reutilizado -> segundo intento close 4401 y no abre upstream', async () => {
    const ticket = harness.backend.issueTicket({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    const first = await openWs(
      `${harness.app.wsUrl}/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    expect(first.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const second = await openWs(
      `${harness.app.wsUrl}/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    const close = await second.waitForClose(1500);

    expect(close.code).toBe(4401);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(1);
    expect(harness.agentAlice.connections).toBe(1);

    await first.close();
  });

  it('8. ticket expirado -> close 4401, sin upstream', async () => {
    const ticket = harness.backend.issueTicket({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });
    harness.backend.expireTicket(ticket);

    const attempt = await openWs(
      `${harness.app.wsUrl}/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    const close = await attempt.waitForClose(1500);

    expect(close.code).toBe(4401);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('9. el ticket no aparece en logs ni en el url logueado', async () => {
    const ticket = harness.backend.issueTicket({
      userId: harness.alice.userId,
      agentId: harness.alice.agentId,
    });

    const attempt = await openWs(
      `${harness.app.wsUrl}/ws?ticket=${encodeURIComponent(ticket)}`,
    );
    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const logs = harness.app.logs.text();
    expect(logs).not.toContain(ticket);
    expect(logs).not.toContain('ticket=');

    await attempt.close();
  });
});
