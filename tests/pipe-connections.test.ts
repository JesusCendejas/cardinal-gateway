import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  authHeader,
  createHarness,
  type Harness,
} from './helpers/harness.js';
import { waitForCondition } from './helpers/wait.js';
import { openWs } from './helpers/ws-client.js';

describe('pipe bidireccional, reservas y cierre', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('25. texto cliente -> upstream -> eco', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForConnection()).toBe(true);

    attempt.send('hola-letta');
    const message = await attempt.waitForMessage(
      (candidate) => candidate.data === 'hola-letta',
      1000,
    );
    expect(message.data).toBe('hola-letta');

    await attempt.close();
  });

  it('26. buffer de 64 KB íntegro', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForConnection()).toBe(true);

    const payload = Buffer.alloc(64 * 1024, 0x5a);
    attempt.send(payload);

    const message = await attempt.waitForMessage(
      (candidate) => candidate.isBinary,
      1500,
    );
    expect(message.isBinary).toBe(true);
    const received = message.data as Buffer;
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(received.length).toBe(payload.length);
    expect(received.equals(payload)).toBe(true);

    await attempt.close();
  });

  it('27. 5 stream_delta en orden', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForConnection()).toBe(true);

    attempt.send('stream');
    const messages = await attempt.waitForMessages(5, 1500);
    expect(messages).toHaveLength(5);

    const parsed = messages.map(
      (message) =>
        JSON.parse(message.data.toString()) as {
          type: string;
          delta: string;
          index: number;
        },
    );
    expect(parsed.map((message) => message.type)).toEqual([
      'stream_delta',
      'stream_delta',
      'stream_delta',
      'stream_delta',
      'stream_delta',
    ]);
    expect(parsed.map((message) => message.delta)).toEqual([
      'delta-1',
      'delta-2',
      'delta-3',
      'delta-4',
      'delta-5',
    ]);
    expect(parsed.map((message) => message.index)).toEqual([1, 2, 3, 4, 5]);

    await attempt.close();
  });

  it('28a. SANDBOX_NOT_READY -> close 4503', async () => {
    harness.backend.routeHandler = () => ({
      status: 200,
      body: { error: 'SANDBOX_NOT_READY' },
    });

    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const close = await attempt.waitForClose(1500);

    expect(close.code).toBe(4503);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('28b. NODE_UNAVAILABLE -> close 4503', async () => {
    harness.backend.routeHandler = () => ({
      status: 200,
      body: { error: 'NODE_UNAVAILABLE' },
    });

    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const close = await attempt.waitForClose(1500);

    expect(close.code).toBe(4503);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('29. segunda conexión del mismo usuario -> 4409 y la primera sigue viva', async () => {
    const first = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(first.opened).toBe(true);
    expect(await harness.agentAlice.waitForConnection()).toBe(true);

    const second = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const close = await second.waitForClose(1500);

    expect(close.code).toBe(4409);
    expect(first.socket?.readyState).toBe(WebSocket.OPEN);

    first.send('sigo-viva');
    const echo = await first.waitForMessage(
      (message) => message.data === 'sigo-viva',
      1000,
    );
    expect(echo.data).toBe('sigo-viva');

    await first.close();
  });

  it('30. reserva atómica: dos conexiones simultáneas -> exactamente una gana', async () => {
    const [first, second] = await Promise.all([
      openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      }),
      openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      }),
    ]);

    const sessions = [first, second];
    const closeResults = await Promise.all(
      sessions.map((session) => session.waitForClose(1500)),
    );

    const rejected = closeResults.filter((close) => close.code === 4409);
    const alive = sessions.filter(
      (session) => session.socket?.readyState === WebSocket.OPEN,
    );

    expect(rejected).toHaveLength(1);
    expect(alive).toHaveLength(1);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(1);

    await alive[0]?.close();
  });

  it('31. reserva huérfana tras SANDBOX_NOT_READY: luego se permite conectar', async () => {
    harness.backend.routeHandler = () => ({
      status: 200,
      body: { error: 'SANDBOX_NOT_READY' },
    });

    const first = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const firstClose = await first.waitForClose(1500);
    expect(firstClose.code).toBe(4503);

    harness.backend.routeHandler = undefined;

    const second = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(second.opened).toBe(true);

    await second.close();
  });

  it('32. reserva huérfana tras handshake 401: se libera y la siguiente conecta', async () => {
    harness.agentAlice.setUpgradeAuthorizer(() => false);

    const first = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const firstClose = await first.waitForClose(2000);
    expect(firstClose.code).not.toBe(4409);
    expect(firstClose.code).toBeGreaterThan(0);

    harness.agentAlice.setUpgradeAuthorizer(() => true);

    const second = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(second.opened).toBe(true);

    await second.close();
  });

  it('33. heartbeat: cliente que no responde pong -> cierre limpio y reserva liberada', async () => {
    const app = await harness.restartApp({
      heartbeatIntervalMs: 40,
      pongTimeoutMs: 120,
    });

    try {
      const silent = await openWs(`${app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
        autoPong: false,
      });
      expect(silent.opened).toBe(true);

      const close = await silent.waitForClose(3000);
      expect(close.timedOut).not.toBe(true);
      expect(close.code).not.toBe(1006);

      const again = await openWs(`${app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });
      expect(again.opened).toBe(true);
      await again.close();
    } finally {
      await app.close();
    }
  });

  it('34. cerrar el gateway cierra sockets y libera reservas', async () => {
    const first = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    expect(first.opened).toBe(true);
    expect(await waitForCondition(() => harness.agentAlice.activeConnections === 1)).toBe(
      true,
    );

    await harness.app.close();

    const close = await first.waitForClose(2000);
    expect(close.timedOut).not.toBe(true);
    expect(
      await waitForCondition(
        () => harness.agentAlice.activeConnections === 0,
        1000,
      ),
    ).toBe(true);

    const secondApp = await harness.restartApp();
    try {
      const second = await openWs(`${secondApp.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });
      expect(second.opened).toBe(true);
      await second.close();
    } finally {
      await secondApp.close();
    }
  });
});
