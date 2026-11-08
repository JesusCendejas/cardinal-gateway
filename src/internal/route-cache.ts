import type { SandboxConfig, SandboxTlsConfig, SandboxTransport } from '../sandbox/config.js';
import type { RedisLike } from '../limits/connection-registry.js';
import type { AppLogger } from '../observability/logger.js';
import { toLoggable } from '../observability/logger.js';

export const ROUTE_CACHE_TTL_SECONDS = 30;
export const PRIMARY_ROUTE_KEY = '__primary';

export interface RouteCache {
  key(userId: string, agentId?: string): string;
  get(userId: string, agentId?: string): Promise<SandboxConfig | null>;
  set(userId: string, agentId: string | undefined, config: SandboxConfig): Promise<void>;
  invalidate(userId: string, agentId?: string): Promise<void>;
}

export interface RouteCacheOptions {
  redis: RedisLike | null;
  logger: AppLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuild the cacheable shape from an untrusted JSON payload. Only
 * `sandboxId`, `endpoint`, `port`, `transport` and `tls` survive: no token,
 * no credentials and no provider ever leaves Redis.
 */
function parseCachedSandbox(raw: string): SandboxConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const { sandboxId, endpoint, port, transport, tls } = parsed;
  if (
    typeof sandboxId !== 'string' ||
    typeof endpoint !== 'string' ||
    typeof port !== 'number' ||
    typeof transport !== 'string'
  ) {
    return null;
  }

  const config: SandboxConfig = {
    sandboxId,
    endpoint,
    port,
    transport: transport as SandboxTransport,
  };

  if (isRecord(tls)) {
    const tlsConfig: SandboxTlsConfig = {
      rejectUnauthorized:
        typeof tls.rejectUnauthorized === 'boolean'
          ? tls.rejectUnauthorized
          : true,
    };
    if (typeof tls.servername === 'string') {
      tlsConfig.servername = tls.servername;
    }
    config.tls = tlsConfig;
  }

  return config;
}

function serializeSandbox(config: SandboxConfig): string {
  const cacheable: Record<string, unknown> = {
    sandboxId: config.sandboxId,
    endpoint: config.endpoint,
    port: config.port,
    transport: config.transport,
  };
  if (config.tls) {
    cacheable.tls = {
      rejectUnauthorized: config.tls.rejectUnauthorized,
      ...(config.tls.servername !== undefined
        ? { servername: config.tls.servername }
        : {}),
    };
  }
  return JSON.stringify(cacheable);
}

export function createRouteCache(options: RouteCacheOptions): RouteCache {
  const { redis, logger } = options;

  function key(userId: string, agentId?: string): string {
    return `route:${userId}:${agentId ?? PRIMARY_ROUTE_KEY}`;
  }

  function logRedisFailure(action: string, error: unknown): void {
    logger.error(
      toLoggable({ action, error }),
      'redis route cache unavailable',
    );
  }

  return {
    key,

    async get(userId: string, agentId?: string): Promise<SandboxConfig | null> {
      if (!redis) return null;
      try {
        const raw = await redis.get(key(userId, agentId));
        if (raw === null) return null;
        return parseCachedSandbox(raw);
      } catch (error) {
        logRedisFailure('get', error);
        return null;
      }
    },

    async set(
      userId: string,
      agentId: string | undefined,
      config: SandboxConfig,
    ): Promise<void> {
      if (!redis) return;
      try {
        await redis.set(
          key(userId, agentId),
          serializeSandbox(config),
          'EX',
          ROUTE_CACHE_TTL_SECONDS,
        );
      } catch (error) {
        logRedisFailure('set', error);
      }
    },

    async invalidate(userId: string, agentId?: string): Promise<void> {
      if (!redis) return;
      try {
        if (typeof redis.del === 'function') {
          await redis.del(key(userId, agentId));
        }
      } catch (error) {
        logRedisFailure('del', error);
      }
    },
  };
}
