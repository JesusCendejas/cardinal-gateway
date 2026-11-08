import type { RedisLike } from '../../src/limits/connection-registry.js';

interface RedisEntry {
  value: string;
  expiresAt: number | null;
}

interface RedisWrite {
  key: string;
  value: string;
  args: Array<string | number>;
}

/**
 * Translate a Redis KEYS glob into a RegExp.
 *
 * Redis wildcards are `*` (any sequence) and `?` (one character). Every other
 * regex metacharacter is escaped literally; a single pass is important because
 * escaping first and replacing `\*` afterwards leaves a bare `*` as a regex
 * quantifier (`route:*` would compile to `/^route:*$/`).
 */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, (character) => {
    if (character === '*') return '.*';
    if (character === '?') return '.';
    return `\\${character}`;
  });
  return new RegExp(`^${body}$`);
}

/**
 * In-memory Redis good enough for the gateway contract:
 * get / set (NX, PX, EX) / ttl / incr / keys / del / expire.
 *
 * `down = true` simulates a dead Redis: every operation throws. Tests use it
 * to prove fail-open and "Redis is never the source of truth".
 */
export class FakeRedis implements RedisLike {
  readonly store = new Map<string, RedisEntry>();
  readonly writes: RedisWrite[] = [];
  down = false;
  private readonly errors: string[] = [];

  private assertUp(): void {
    if (this.down) {
      const error = new Error('FakeRedis: connection refused');
      this.errors.push(error.message);
      throw error;
    }
  }

  private purge(key: string): RedisEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private purgeAll(): void {
    for (const key of [...this.store.keys()]) {
      this.purge(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertUp();
    return this.purge(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<'OK' | null> {
    this.assertUp();

    let nx = false;
    let px: number | undefined;
    let ex: number | undefined;

    for (let index = 0; index < args.length; index += 1) {
      const arg = String(args[index]).toUpperCase();
      if (arg === 'NX') {
        nx = true;
      } else if (arg === 'PX') {
        px = Number(args[index + 1]);
        index += 1;
      } else if (arg === 'EX') {
        ex = Number(args[index + 1]);
        index += 1;
      }
    }

    if (nx && this.purge(key) !== undefined) {
      return null;
    }

    const expiresAt =
      px !== undefined
        ? Date.now() + px
        : ex !== undefined
          ? Date.now() + ex * 1000
          : null;

    this.store.set(key, { value, expiresAt });
    this.writes.push({ key, value, args: [...args] });
    return 'OK';
  }

  async ttl(key: string): Promise<number> {
    this.assertUp();
    const entry = this.purge(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async incr(key: string): Promise<number> {
    this.assertUp();
    const entry = this.purge(key);
    const current = entry ? Number.parseInt(entry.value, 10) : 0;
    if (!Number.isFinite(current)) {
      throw new Error('FakeRedis: value is not an integer');
    }
    const next = current + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    this.writes.push({ key, value: String(next), args: ['INCR'] });
    return next;
  }

  async keys(pattern: string): Promise<string[]> {
    this.assertUp();
    this.purgeAll();
    const matcher = globToRegExp(pattern);
    return [...this.store.keys()].filter((key) => matcher.test(key)).sort();
  }

  async del(...keysToDelete: string[]): Promise<number> {
    this.assertUp();
    let deleted = 0;
    for (const key of keysToDelete) {
      if (this.store.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.assertUp();
    const entry = this.purge(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    this.assertUp();
    const entry = this.purge(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + milliseconds;
    return 1;
  }

  async flushall(): Promise<void> {
    this.store.clear();
  }

  allValues(): string[] {
    return [...this.store.values()].map((entry) => entry.value);
  }

  allWrites(): string {
    return this.writes.map((write) => `${write.key}=${write.value}`).join('\n');
  }

  errorCount(): number {
    return this.errors.length;
  }
}
