import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SandboxConfig } from '../src/sandbox/config.js';
import {
  authHeader,
  createHarness,
  sandboxFor,
  type Harness,
} from './helpers/harness.js';
import { createFakeTlsServer } from './helpers/fake-tls-server.js';
import { openWs } from './helpers/ws-client.js';

describe('el transporte decide la conexión', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('19. transport ws -> conexión ws:// al endpoint/port indicados', async () => {
    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });

    expect(attempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);

    const upgrade = harness.agentAlice.upgradeRequests[0];
    expect(upgrade).toBeDefined();
    expect(upgrade?.url.startsWith('/ws')).toBe(true);

    await attempt.close();
  });

  it('20. transport wss -> conexión wss:// con SNI = tls.servername', async () => {
    const tls = await createFakeTlsServer();
    try {
      harness.backend.setSandbox(harness.alice.agentId, {
        ...sandboxFor(harness.alice, harness.agentAlice),
        endpoint: '127.0.0.1',
        port: tls.port,
        transport: 'wss',
        tls: { rejectUnauthorized: false, servername: 'localhost' },
      });

      const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });

      expect(attempt.opened).toBe(true);
      expect(await tls.waitForUpgrade()).toBe(true);
      expect(tls.servernames).toContain('localhost');

      await attempt.close();
    } finally {
      await tls.close();
    }
  });

  it('21. transport http -> close 4503 UNSUPPORTED_TRANSPORT sin conexión', async () => {
    const invalid = {
      ...sandboxFor(harness.alice, harness.agentAlice),
      transport: 'http',
    } as unknown as SandboxConfig;
    harness.backend.setSandbox(harness.alice.agentId, invalid);

    const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const close = await attempt.waitForClose(1500);

    expect(close.code).toBe(4503);
    expect(harness.agentAlice.upgradeRequests).toHaveLength(0);
  });

  it('22. wss con rejectUnauthorized:true y cert autofirmado -> 4402, no 4401', async () => {
    const tls = await createFakeTlsServer();
    try {
      harness.backend.setSandbox(harness.alice.agentId, {
        ...sandboxFor(harness.alice, harness.agentAlice),
        port: tls.port,
        transport: 'wss',
        tls: { rejectUnauthorized: true, servername: 'localhost' },
      });

      const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });
      const close = await attempt.waitForClose(2000);

      expect(close.code).toBe(4402);
      expect(close.code).not.toBe(4401);
      expect(tls.upgradeRequests).toHaveLength(0);
    } finally {
      await tls.close();
    }
  });

  it('23a. wss con rejectUnauthorized:false -> conecta (válido solo en test)', async () => {
    const tls = await createFakeTlsServer();
    try {
      harness.backend.setSandbox(harness.alice.agentId, {
        ...sandboxFor(harness.alice, harness.agentAlice),
        port: tls.port,
        transport: 'wss',
        tls: { rejectUnauthorized: false, servername: 'localhost' },
      });

      const attempt = await openWs(`${harness.app.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });

      expect(attempt.opened).toBe(true);
      expect(await tls.waitForUpgrade()).toBe(true);

      await attempt.close();
    } finally {
      await tls.close();
    }
  });

  it('23b. NODE_ENV=production rechaza rejectUnauthorized:false en la config del sandbox', async () => {
    const tls = await createFakeTlsServer();
    const prodApp = await harness.restartApp({ nodeEnv: 'production' });
    try {
      harness.backend.setSandbox(harness.alice.agentId, {
        ...sandboxFor(harness.alice, harness.agentAlice),
        port: tls.port,
        transport: 'wss',
        tls: { rejectUnauthorized: false, servername: 'localhost' },
      });

      const attempt = await openWs(`${prodApp.wsUrl}/ws`, {
        headers: authHeader(harness.alice.accessToken),
      });
      const close = await attempt.waitForClose(2000);

      expect([4402, 4503]).toContain(close.code);
      expect(tls.upgradeRequests).toHaveLength(0);
    } finally {
      await prodApp.close();
      await tls.close();
    }
  });

  it('24. provider railway/hetzner no participa: mismo transport, mismo resultado', async () => {
    harness.backend.setSandbox(harness.alice.agentId, {
      ...sandboxFor(harness.alice, harness.agentAlice),
      provider: 'railway',
    } as unknown as SandboxConfig);
    harness.backend.setSandbox(harness.bob.agentId, {
      ...sandboxFor(harness.bob, harness.agentBob),
      provider: 'hetzner',
    } as unknown as SandboxConfig);

    const aliceAttempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.alice.accessToken),
    });
    const bobAttempt = await openWs(`${harness.app.wsUrl}/ws`, {
      headers: authHeader(harness.bob.accessToken),
    });

    expect(aliceAttempt.opened).toBe(true);
    expect(bobAttempt.opened).toBe(true);
    expect(await harness.agentAlice.waitForUpgrade()).toBe(true);
    expect(await harness.agentBob.waitForUpgrade()).toBe(true);

    expect(harness.agentAlice.upgradeRequests[0]?.headers.authorization).toBe(
      `Bearer ${harness.alice.capabilityToken}`,
    );
    expect(harness.agentBob.upgradeRequests[0]?.headers.authorization).toBe(
      `Bearer ${harness.bob.capabilityToken}`,
    );

    await aliceAttempt.close();
    await bobAttempt.close();
  });
});
