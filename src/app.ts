import Fastify, { type FastifyInstance } from 'fastify';

import { createConnectionRegistry } from './limits/connection-registry.js';
import type { ConnectionRegistry, RedisLike } from './limits/connection-registry.js';
import type { GatewayConfig } from './config/env.js';
import { createLogger, type LogDestination } from './observability/logger.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerWsRoutes } from './routes/ws.js';

export interface BuildAppDependencies {
  /**
   * Tests inject the in-memory fake Redis. Production will build an ioredis
   * client from config.redisUrl inside the registry.
   */
  redis?: RedisLike | null;
  /**
   * Tests inject a pino destination to capture and inspect logs.
   */
  logDestination?: LogDestination;
  connectionRegistry?: ConnectionRegistry;
}

export interface GatewayApp extends FastifyInstance {
  config: GatewayConfig;
  connectionRegistry: ConnectionRegistry;
}

/**
 * buildApp(config) -> Fastify instance.
 *
 * Phase 0: boots successfully, exposes the route shapes, and answers 501 from
 * every data-plane route. Business logic is intentionally absent.
 */
export function buildApp(
  config: GatewayConfig,
  deps: BuildAppDependencies = {},
): GatewayApp {
  const logger = createLogger(config, deps.logDestination);
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
  }) as unknown as GatewayApp;

  app.config = config;
  app.connectionRegistry =
    deps.connectionRegistry ?? createConnectionRegistry(deps.redis ?? null);

  registerHealthRoutes(app);
  registerProxyRoutes(app);
  registerWsRoutes(app);

  return app;
}
