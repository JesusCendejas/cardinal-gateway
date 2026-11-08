import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';

import { createBackendClient, type BackendClient } from './internal/backend-client.js';
import {
  createRouteCache,
  type RouteCache,
} from './internal/route-cache.js';
import { createConnectionRegistry } from './limits/connection-registry.js';
import type { ConnectionRegistry, RedisLike } from './limits/connection-registry.js';
import {
  createRateLimitStore,
  createRateLimiter,
  RATE_LIMIT_WINDOW_MS,
  type RateLimiter,
} from './limits/rate-limit.js';
import type { GatewayConfig } from './config/env.js';
import {
  createLogger,
  toLoggable,
  type AppLogger,
  type LogDestination,
} from './observability/logger.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerWsRoutes, type WsGateway } from './routes/ws.js';

export interface BuildAppDependencies {
  /**
   * Tests inject the in-memory fake Redis. `null` disables Redis entirely.
   * When omitted (production), a real ioredis client is built from
   * `config.redisUrl`.
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
  backend: BackendClient;
  routeCache: RouteCache;
  rateLimiter: RateLimiter;
}

interface RedisClientLike extends RedisLike {
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
}

function createRedisClient(url: string, logger: AppLogger): RedisClientLike {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  client.on('error', (error: unknown) => {
    logger.warn(toLoggable({ error }), 'redis client error');
  });
  return client as unknown as RedisClientLike;
}

function resolveRedis(
  config: GatewayConfig,
  injected: RedisLike | null | undefined,
  logger: AppLogger,
): { redis: RedisLike | null; ownedClient: RedisClientLike | null } {
  if (injected !== undefined) {
    return { redis: injected, ownedClient: null };
  }
  const client = createRedisClient(config.redisUrl, logger);
  return { redis: client, ownedClient: client };
}

/**
 * buildApp(config) -> Fastify instance.
 *
 * `config` is injectable so tests can tune limits, timeouts and Redis without
 * touching process.env. The route surface is registered inside one child
 * plugin so @fastify/rate-limit can attach its global store hook before the
 * routes exist, while the WebSocket upgrade handler still lives on the raw
 * HTTP server.
 */
export function buildApp(
  config: GatewayConfig,
  deps: BuildAppDependencies = {},
): GatewayApp {
  const logger = createLogger(config, deps.logDestination);
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
    forceCloseConnections: true,
  }) as unknown as GatewayApp;

  const { redis, ownedClient } = resolveRedis(config, deps.redis, logger);
  const backend = createBackendClient({
    backendUrl: config.backendUrl,
    internalToken: config.internalToken,
    timeoutMs: config.upstreamTimeoutMs,
  });
  const routeCache = createRouteCache({ redis, logger });
  const rateLimiter = createRateLimiter({
    redis,
    limit: config.rateLimitPerMinute,
    logger,
  });
  const connectionRegistry =
    deps.connectionRegistry ??
    createConnectionRegistry(redis, { logger });

  app.config = config;
  app.backend = backend;
  app.routeCache = routeCache;
  app.rateLimiter = rateLimiter;
  app.connectionRegistry = connectionRegistry;

  let wsGateway: WsGateway | undefined;

  app.register(async (instance) => {
    // Keep the raw request body so the HTTP proxy forwards exactly what the
    // client sent while still inspecting `agent_id` for tenant validation.
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    instance.addContentTypeParser(
      '*',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    await instance.register(fastifyRateLimit, {
      global: true,
      hook: 'preHandler',
      max: config.rateLimitPerMinute,
      timeWindow: RATE_LIMIT_WINDOW_MS,
      store: createRateLimitStore(rateLimiter),
      keyGenerator: (request: FastifyRequest) =>
        (request as FastifyRequest & { userId?: string }).userId ??
        request.ip,
      skipOnError: true,
    });

    registerHealthRoutes(instance);
    registerProxyRoutes(instance, { config, backend, routeCache, logger });
    wsGateway = registerWsRoutes(instance, {
      config,
      backend,
      routeCache,
      registry: connectionRegistry,
      rateLimiter,
      logger,
    });
  });

  // `preClose` runs before Fastify calls `server.close()`. Upgraded sockets
  // are not tracked by `server.closeAllConnections()`, so they must be closed
  // here or the HTTP server close would wait forever.
  app.addHook('preClose', async () => {
    await wsGateway?.closeAll();
  });

  app.addHook('onClose', async () => {
    if (ownedClient) {
      try {
        if (typeof ownedClient.quit === 'function') {
          await ownedClient.quit();
        } else {
          ownedClient.disconnect?.();
        }
      } catch {
        ownedClient.disconnect?.();
      }
    }
  });

  return app;
}
