import type { AddressInfo } from 'node:net';

import { buildApp, type GatewayApp } from '../../src/app.js';
import type { GatewayConfig } from '../../src/config/env.js';
import type { RedisLike } from '../../src/limits/connection-registry.js';
import type { LogDestination } from '../../src/observability/logger.js';
import { createLogCapture, type LogCapture } from './logs.js';

export interface TestApp {
  url: string;
  wsUrl: string;
  app: GatewayApp;
  logs: LogCapture;
  close(): Promise<void>;
}

export interface StartTestAppOptions {
  redis?: RedisLike | null;
  logCapture?: LogCapture;
  logDestination?: LogDestination;
}

/**
 * Starts buildApp() on an ephemeral port (port 0) and returns its URLs plus a
 * close() that is safe to call more than once.
 */
export async function startTestApp(
  config: GatewayConfig,
  options: StartTestAppOptions = {},
): Promise<TestApp> {
  const logs = options.logCapture ?? createLogCapture();
  const app = buildApp(config, {
    redis: options.redis ?? null,
    logDestination:
      options.logDestination ?? (logs.stream as unknown as LogDestination),
  });

  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address() as AddressInfo | string | null;
  if (!address || typeof address === 'string') {
    throw new Error('startTestApp: Fastify did not expose a TCP address');
  }

  const url = `http://127.0.0.1:${address.port}`;
  let closed = false;

  return {
    url,
    wsUrl: `ws://127.0.0.1:${address.port}`,
    app,
    logs,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
}
