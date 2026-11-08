import type { SandboxConfig } from '../sandbox/config.js';
import type { AppLogger } from '../observability/logger.js';
import { toLoggable } from '../observability/logger.js';
import type { BackendClient } from './backend-client.js';
import {
  CredentialsNotFoundError,
  CredentialsUnavailableError,
} from './errors.js';
import type { RouteCache } from './route-cache.js';

export interface ResolveSandboxDependencies {
  backend: BackendClient;
  routeCache: RouteCache;
  logger: AppLogger;
}

export interface ResolvedSandbox {
  /** Safe to cache/log: never contains the capability token. */
  sandbox: SandboxConfig;
  /**
   * Capability token. It is returned as a bare string and never placed into
   * `sandbox`, Redis, a snapshot or a log record.
   */
  token: string;
}

/**
 * Resolve the sandbox route and its short-lived capability token.
 *
 * Redis is only a cache. On a credentials 404 for a cached `sandboxId` the
 * gateway invalidates the entry, routes again exactly once and retries
 * credentials exactly once. A re-provisioned sandbox therefore cannot cause an
 * infinite loop.
 */
export async function resolveSandboxWithCredentials(
  deps: ResolveSandboxDependencies,
  userId: string,
  agentId?: string,
): Promise<ResolvedSandbox> {
  const cached = await deps.routeCache.get(userId, agentId);

  let sandbox: SandboxConfig;
  if (cached) {
    sandbox = cached;
  } else {
    sandbox = await deps.backend.route(userId, agentId);
    await deps.routeCache.set(userId, agentId, sandbox);
  }

  try {
    const token = await deps.backend.credentials(sandbox.sandboxId);
    return { sandbox, token };
  } catch (error) {
    if (!(error instanceof CredentialsNotFoundError)) {
      throw error;
    }

    if (!cached) {
      // The route was fresh and the backend still says the sandbox does not
      // exist. Do not spin: surface it as credentials unavailable.
      throw new CredentialsUnavailableError('SANDBOX_NOT_FOUND');
    }

    deps.logger.warn(
      toLoggable({
        userId,
        sandboxId: sandbox.sandboxId,
        error,
      }),
      'stale route cache entry; invalidating and re-routing once',
    );

    await deps.routeCache.invalidate(userId, agentId);
    const refreshed = await deps.backend.route(userId, agentId);
    await deps.routeCache.set(userId, agentId, refreshed);
    const token = await deps.backend.credentials(refreshed.sandboxId);
    return { sandbox: refreshed, token };
  }
}
