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

export interface ConnectionRegistry {
  /**
   * Atomically reserve the single connection slot for a user.
   * Returns true only for the caller that won the race.
   */
  reserve(userId: string, connectionId: string, ttlMs: number): Promise<boolean>;
  release(userId: string, connectionId: string): Promise<void>;
  isReserved(userId: string): Promise<boolean>;
  snapshot(): Promise<ConnectionSnapshot[]>;
}

/**
 * Phase 0 stub: creation is allowed so buildApp() can start, but every
 * operation throws until the registry is implemented.
 */
export function createConnectionRegistry(
  _redis: RedisLike | null,
): ConnectionRegistry {
  return {
    async reserve(): Promise<boolean> {
      throw new Error('not implemented');
    },
    async release(): Promise<void> {
      throw new Error('not implemented');
    },
    async isReserved(): Promise<boolean> {
      throw new Error('not implemented');
    },
    async snapshot(): Promise<ConnectionSnapshot[]> {
      throw new Error('not implemented');
    },
  };
}
