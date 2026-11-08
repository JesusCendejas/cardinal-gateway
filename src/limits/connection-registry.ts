import type { AppLogger } from '../observability/logger.js';
import { toLoggable } from '../observability/logger.js';

/**
 * Minimal Redis surface the gateway needs. Keeping it narrow makes the fake
 * Redis in tests honest and prevents accidental coupling to ioredis.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<'OK' | null>;
  ttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  del?(...keys: string[]): Promise<number>;
  expire?(key: string, seconds: number): Promise<number>;
  pexpire?(key: string, milliseconds: number): Promise<number>;
}

/**
 * Serializable connection metadata. It intentionally has no token field:
 * tokens live only in the in-memory connection object.
 */
export interface ConnectionSnapshot {
  userId: string;
  connectionId: string;
  sandboxId: string;
  transport: string;
  connectedAt: number;
}

interface LocalReservation {
  connectionId: string;
  sandboxId: string;
  transport: string;
  connectedAt: number;
}

export interface ConnectionRegistry {
  /**
   * Atomically reserve the single connection slot for a user.
   *
   * The in-process check-and-set happens synchronously, before the first
   * `await`. Redis is consulted afterwards for cross-instance coordination;
   * a Redis failure fails open and keeps the local reservation.
   */
  reserve(
    userId: string,
    connectionId: string,
    ttlMs: number,
  ): Promise<boolean>;
  release(userId: string, connectionId: string): Promise<void>;
  isReserved(userId: string): Promise<boolean>;
  attach(
    userId: string,
    connectionId: string,
    meta: { sandboxId: string; transport: string },
  ): void;
  snapshot(): Promise<ConnectionSnapshot[]>;
}

export interface ConnectionRegistryOptions {
  logger?: AppLogger;
}

export function createConnectionRegistry(
  redis: RedisLike | null,
  options: ConnectionRegistryOptions = {},
): ConnectionRegistry {
  const local = new Map<string, LocalReservation>();
  const { logger } = options;

  function key(userId: string): string {
    return `connection:${userId}`;
  }

  function logRedisFailure(action: string, error: unknown): void {
    logger?.warn(
      toLoggable({ action, error }),
      'redis error in connection registry',
    );
  }

  return {
    async reserve(
      userId: string,
      connectionId: string,
      ttlMs: number,
    ): Promise<boolean> {
      // Atomic in this process: no await between the check and the set.
      if (local.has(userId)) return false;
      local.set(userId, {
        connectionId,
        sandboxId: '',
        transport: '',
        connectedAt: Date.now(),
      });

      if (!redis) return true;

      try {
        const result = await redis.set(
          key(userId),
          connectionId,
          'PX',
          ttlMs,
          'NX',
        );
        if (result === null) {
          // Another gateway instance owns the slot. Only remove the local
          // entry if it still belongs to this connection.
          if (local.get(userId)?.connectionId === connectionId) {
            local.delete(userId);
          }
          return false;
        }
        return true;
      } catch (error) {
        // Fail open: a Redis outage must not make the gateway unable to
        // serve connections. The local reservation remains authoritative
        // for this process.
        logRedisFailure('reserve', error);
        return true;
      }
    },

    async release(userId: string, connectionId: string): Promise<void> {
      const current = local.get(userId);
      if (!current || current.connectionId !== connectionId) {
        // Never release a reservation owned by a different connection.
        return;
      }
      local.delete(userId);

      if (!redis) return;
      try {
        if (typeof redis.del === 'function') {
          await redis.del(key(userId));
        }
      } catch (error) {
        logRedisFailure('release', error);
      }
    },

    async isReserved(userId: string): Promise<boolean> {
      if (local.has(userId)) return true;
      if (!redis) return false;
      try {
        return (await redis.get(key(userId))) !== null;
      } catch (error) {
        logRedisFailure('isReserved', error);
        return false;
      }
    },

    attach(
      userId: string,
      connectionId: string,
      meta: { sandboxId: string; transport: string },
    ): void {
      const current = local.get(userId);
      if (!current || current.connectionId !== connectionId) return;
      current.sandboxId = meta.sandboxId;
      current.transport = meta.transport;
    },

    async snapshot(): Promise<ConnectionSnapshot[]> {
      return [...local.entries()].map(([userId, entry]) => ({
        userId,
        connectionId: entry.connectionId,
        sandboxId: entry.sandboxId,
        transport: entry.transport,
        connectedAt: entry.connectedAt,
      }));
    },
  };
}
