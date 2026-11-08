import type { RedisLike } from './connection-registry.js';
import type { AppLogger } from '../observability/logger.js';
import { toLoggable } from '../observability/logger.js';

export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimitOutcome {
  allowed: boolean;
  current: number;
  limit: number;
  ttlMs: number;
}

export interface RateLimiterOptions {
  redis: RedisLike | null;
  limit: number;
  logger: AppLogger;
  windowMs?: number;
}

interface LocalCounter {
  count: number;
  resetAt: number;
}

/**
 * Per-userId fixed-window limiter.
 *
 * Redis is the shared counter, but it is never a correctness dependency:
 *  - if Redis throws, the request fails open into an in-process counter and an
 *    error is logged;
 *  - with no Redis at all the in-process counter is used directly.
 *
 * The same limiter instance backs HTTP (through @fastify/rate-limit's store)
 * and the WebSocket handshake, so both transports share `userId` counters.
 */
export class RateLimiter {
  private readonly redis: RedisLike | null;
  private readonly limit: number;
  private readonly logger: AppLogger;
  private readonly windowMs: number;
  private readonly local = new Map<string, LocalCounter>();

  constructor(options: RateLimiterOptions) {
    this.redis = options.redis;
    this.limit = options.limit;
    this.logger = options.logger;
    this.windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  }

  async consume(key: string): Promise<RateLimitOutcome> {
    if (this.redis) {
      try {
        return await this.consumeRedis(key);
      } catch (error) {
        this.logger.error(
          { error: toLoggable(error), key },
          'redis error while checking rate limit; falling back to local counter',
        );
      }
    }
    return this.consumeLocal(key);
  }

  reset(): void {
    this.local.clear();
  }

  private async consumeRedis(key: string): Promise<RateLimitOutcome> {
    const redisKey = `ratelimit:${key}`;
    const redis = this.redis as RedisLike;

    const current = await redis.incr(redisKey);
    if (current === 1) {
      if (typeof redis.pexpire === 'function') {
        await redis.pexpire(redisKey, this.windowMs);
      } else if (typeof redis.expire === 'function') {
        await redis.expire(redisKey, Math.ceil(this.windowMs / 1000));
      }
    }

    let ttlMs = this.windowMs;
    try {
      const ttlSeconds = await redis.ttl(redisKey);
      if (ttlSeconds > 0) ttlMs = ttlSeconds * 1000;
    } catch {
      // The increment succeeded; a missing TTL must not turn into a 500.
    }

    return {
      allowed: current <= this.limit,
      current,
      limit: this.limit,
      ttlMs,
    };
  }

  private consumeLocal(key: string): RateLimitOutcome {
    const now = Date.now();
    let entry = this.local.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.local.set(key, entry);
    }

    entry.count += 1;
    return {
      allowed: entry.count <= this.limit,
      current: entry.count,
      limit: this.limit,
      ttlMs: Math.max(0, entry.resetAt - now),
    };
  }
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  return new RateLimiter(options);
}

/**
 * Structural subset of @fastify/rate-limit's store contract. The plugin
 * constructs the store once and calls `incr` for every HTTP request.
 */
export interface RateLimitStoreLike {
  incr(
    key: string,
    callback: (
      error: Error | null,
      result?: { current: number; ttl: number },
    ) => void,
  ): void;
  child(routeOptions: unknown): RateLimitStoreLike;
}

export type RateLimitStoreCtor = new (options: unknown) => RateLimitStoreLike;

export function createRateLimitStore(
  limiter: RateLimiter,
): RateLimitStoreCtor {
  return class RedisBackedRateLimitStore implements RateLimitStoreLike {
    incr(
      key: string,
      callback: (
        error: Error | null,
        result?: { current: number; ttl: number },
      ) => void,
    ): void {
      void limiter.consume(key).then(
        (outcome) => {
          callback(null, { current: outcome.current, ttl: outcome.ttlMs });
        },
        (error: unknown) => {
          // RateLimiter.consume is fail-open, so this is only a last resort.
          callback(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }

    child(): RateLimitStoreLike {
      return this;
    }
  };
}
