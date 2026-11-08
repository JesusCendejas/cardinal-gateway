import { describe, expect, it } from 'vitest';

import { FakeRedis, globToRegExp } from './fake-redis.js';

describe('FakeRedis KEYS glob', () => {
  it("'route:*' matches an agent key and not an unrelated prefix", () => {
    const pattern = globToRegExp('route:*');
    expect(pattern.test('route:user-alice:agent-alice')).toBe(true);
    expect(pattern.test('xroute:user-alice:agent-alice')).toBe(false);
    // Redis glob `*` matches zero or more characters, so the degenerate key
    // `route:` is technically matched too. The old buggy regex matched it as
    // well but failed the positive assertion above.
    expect(pattern.test('route:')).toBe(true);
  });

  it("'route:user-alice:*' is scoped to that user", () => {
    const pattern = globToRegExp('route:user-alice:*');
    expect(pattern.test('route:user-alice:agent-a')).toBe(true);
    expect(pattern.test('route:user-bob:agent-a')).toBe(false);
  });

  it('a pattern without wildcards matches only itself', () => {
    const pattern = globToRegExp('route:user-alice:agent-a');
    expect(pattern.test('route:user-alice:agent-a')).toBe(true);
    expect(pattern.test('route:user-alice:agent-ab')).toBe(false);
  });

  it("'*' matches everything", () => {
    const pattern = globToRegExp('*');
    expect(pattern.test('route:user-alice:agent-alice')).toBe(true);
    expect(pattern.test('anything')).toBe(true);
    expect(pattern.test('')).toBe(true);
  });

  it("'route:?' matches exactly one character", () => {
    const pattern = globToRegExp('route:?');
    expect(pattern.test('route:a')).toBe(true);
    expect(pattern.test('route:ab')).toBe(false);
  });

  it('regex metacharacters are literal', () => {
    const pattern = globToRegExp('route:user.alice');
    expect(pattern.test('route:user.alice')).toBe(true);
    expect(pattern.test('route:userXalice')).toBe(false);
  });

  it('FakeRedis.keys() uses the glob semantics', async () => {
    const redis = new FakeRedis();
    await redis.set('route:user-alice:agent-alice', '{}', 'EX', 30);
    await redis.set('ratelimit:user-alice', '1', 'EX', 30);
    await expect(redis.keys('route:*')).resolves.toEqual([
      'route:user-alice:agent-alice',
    ]);
  });
});
