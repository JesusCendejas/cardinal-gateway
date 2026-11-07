import type { GatewayConfig } from '../../src/config/env.js';
import type { SandboxConfig } from '../../src/sandbox/config.js';
import { startTestApp, type TestApp } from './app.js';
import {
  FakeAgentServer,
  type FakeAgentServerOptions,
} from './fake-agent-server.js';
import {
  FakeBackend,
  TEST_INTERNAL_TOKEN,
} from './fake-backend.js';
import { FakeRedis } from './fake-redis.js';
import {
  signAccessToken,
  TEST_ACCESS_TOKEN_SECRET,
} from './tokens.js';

export const TEST_BACKEND_URL = 'http://127.0.0.1:1';

export interface UserFixture {
  userId: string;
  agentId: string;
  sandboxId: string;
  capabilityToken: string;
  accessToken: string;
}

export interface Harness {
  config: GatewayConfig;
  redis: FakeRedis;
  backend: FakeBackend;
  agentAlice: FakeAgentServer;
  agentBob: FakeAgentServer;
  /** Alias for agentAlice, the common case. */
  agent: FakeAgentServer;
  app: TestApp;
  alice: UserFixture;
  bob: UserFixture;
  close(): Promise<void>;
  restartApp(overrides?: Partial<GatewayConfig>): Promise<TestApp>;
}

export interface CreateHarnessOptions {
  config?: Partial<GatewayConfig>;
  redis?: FakeRedis;
  agentAlice?: FakeAgentServerOptions;
  agentBob?: FakeAgentServerOptions;
}

export function baseConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    port: 0,
    backendUrl: TEST_BACKEND_URL,
    internalToken: TEST_INTERNAL_TOKEN,
    accessTokenSecret: TEST_ACCESS_TOKEN_SECRET,
    redisUrl: 'redis://127.0.0.1:6379',
    allowedOrigins: [],
    upstreamTimeoutMs: 750,
    upstreamHandshakeTimeoutMs: 500,
    rateLimitPerMinute: 10_000,
    logLevel: 'info',
    nodeEnv: 'test',
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 3000,
    ...overrides,
  };
}

export function sandboxFor(
  fixture: Pick<UserFixture, 'sandboxId'>,
  agentServer: Pick<FakeAgentServer, 'port'>,
  overrides: Partial<SandboxConfig> = {},
): SandboxConfig {
  return {
    sandboxId: fixture.sandboxId,
    endpoint: '127.0.0.1',
    port: agentServer.port,
    transport: 'ws',
    ...overrides,
  };
}

export function authHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Full stack for an integration test:
 *   fake backend + two fake Letta app servers + fake Redis + buildApp().
 *
 * Alice and Bob point at different upstream ports on purpose: tests must prove
 * the gateway opened the sandbox of the authenticated user, not the one named
 * in a query/body.
 */
export async function createHarness(
  options: CreateHarnessOptions = {},
): Promise<Harness> {
  const config = baseConfig(options.config);
  const redis = options.redis ?? new FakeRedis();

  const agentAlice = await FakeAgentServer.start(options.agentAlice);
  const agentBob = await FakeAgentServer.start(options.agentBob);

  const backend = await FakeBackend.start({
    internalToken: config.internalToken,
  });

  const aliceBase = {
    userId: 'user-alice',
    agentId: 'agent-alice',
    sandboxId: 'sandbox-alice',
    capabilityToken: 'cap-token-alice',
  };
  const bobBase = {
    userId: 'user-bob',
    agentId: 'agent-bob',
    sandboxId: 'sandbox-bob',
    capabilityToken: 'cap-token-bob',
  };

  backend.setSandbox(
    aliceBase.agentId,
    sandboxFor(aliceBase, agentAlice),
  );
  backend.setSandbox(bobBase.agentId, sandboxFor(bobBase, agentBob));
  backend.setCredential(aliceBase.sandboxId, aliceBase.capabilityToken);
  backend.setCredential(bobBase.sandboxId, bobBase.capabilityToken);

  const alice: UserFixture = {
    ...aliceBase,
    accessToken: await signAccessToken({
      userId: aliceBase.userId,
      agentId: aliceBase.agentId,
      secret: config.accessTokenSecret,
    }),
  };
  const bob: UserFixture = {
    ...bobBase,
    accessToken: await signAccessToken({
      userId: bobBase.userId,
      agentId: bobBase.agentId,
      secret: config.accessTokenSecret,
    }),
  };

  config.backendUrl = backend.url;

  const app = await startTestApp(config, { redis });
  let closed = false;

  return {
    config,
    redis,
    backend,
    agentAlice,
    agentBob,
    agent: agentAlice,
    app,
    alice,
    bob,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await app.close();
      await agentAlice.close();
      await agentBob.close();
      await backend.close();
    },
    async restartApp(
      overrides: Partial<GatewayConfig> = {},
    ): Promise<TestApp> {
      return startTestApp(
        { ...config, ...overrides, backendUrl: backend.url },
        { redis },
      );
    },
  };
}
