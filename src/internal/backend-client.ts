import type { GatewayConfig } from '../config/env.js';
import type { SandboxConfig, SandboxTransport } from '../sandbox/config.js';
import {
  BackendUnavailableError,
  CredentialsNotFoundError,
  CredentialsUnavailableError,
  NodeUnavailableError,
  RouteNotFoundError,
  RouteNotReadyError,
  TicketAlreadyUsedError,
  TicketInvalidError,
} from './errors.js';

export interface TicketClaims {
  userId: string;
  agentId: string;
  containerId: string;
}

/**
 * Internal backend boundary. Every method sends X-Internal-Token and is the
 * only way the gateway learns about users, agents, sandboxes and tickets.
 *
 * `route` deliberately takes `agentId?: string`: `undefined` omits the field
 * (meaning "the user's primary agent") while `''` is forwarded as a real
 * lookup value. The gateway never uses `''` as a sentinel.
 */
export interface BackendClient {
  route(userId: string, agentId?: string): Promise<SandboxConfig>;
  /**
   * Resolves the capability token for a sandbox. It returns a bare string on
   * purpose: the token must not travel inside an object that could be logged
   * or serialized.
   */
  credentials(sandboxId: string): Promise<string>;
  consumeTicket(ticket: string): Promise<TicketClaims>;
}

export interface BackendClientConfig {
  backendUrl: string;
  internalToken: string;
  timeoutMs: number;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a SandboxConfig from the backend payload, dropping anything the
 * gateway does not understand (notably `provider`). The result therefore has
 * exactly the fields that are safe to cache in Redis.
 */
function normalizeSandboxConfig(raw: unknown): SandboxConfig {
  if (!isRecord(raw)) {
    throw new BackendUnavailableError('ROUTE_INVALID_RESPONSE');
  }

  const { sandboxId, endpoint, port, transport, tls } = raw;
  if (
    typeof sandboxId !== 'string' ||
    typeof endpoint !== 'string' ||
    typeof port !== 'number' ||
    typeof transport !== 'string'
  ) {
    throw new BackendUnavailableError('ROUTE_INVALID_RESPONSE');
  }

  const config: SandboxConfig = {
    sandboxId,
    endpoint,
    port,
    // Deliberately not narrowed to the union here: an unknown transport must
    // reach the connection factory so it can close with 4503. The cast keeps
    // the runtime value intact.
    transport: transport as SandboxTransport,
  };

  if (isRecord(tls)) {
    config.tls = {
      rejectUnauthorized:
        typeof tls.rejectUnauthorized === 'boolean'
          ? tls.rejectUnauthorized
          : true,
      ...(typeof tls.servername === 'string'
        ? { servername: tls.servername }
        : {}),
    };
  }

  return config;
}

function routeError(raw: unknown): Error | undefined {
  if (!isRecord(raw)) return undefined;

  switch (raw.error) {
    case 'NOT_FOUND':
      return new RouteNotFoundError();
    case 'SANDBOX_NOT_READY':
      return new RouteNotReadyError();
    case 'NODE_UNAVAILABLE':
      return new NodeUnavailableError();
    default:
      return undefined;
  }
}

export function createBackendClient(
  config: BackendClientConfig,
): BackendClient {
  const baseUrl = config.backendUrl.replace(/\/+$/, '');

  async function post(path: string, body: unknown): Promise<JsonResponse> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': config.internalToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch {
      // Network error, DNS failure, connection refused or timeout. Never
      // propagate as a generic 500.
      throw new BackendUnavailableError();
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    return { status: response.status, body: parsed };
  }

  return {
    async route(userId: string, agentId?: string): Promise<SandboxConfig> {
      const body: { userId: string; agentId?: string } = { userId };
      if (agentId !== undefined) body.agentId = agentId;

      const response = await post('/internal/route', body);
      if (response.status !== 200) {
        throw new BackendUnavailableError(`ROUTE_HTTP_${response.status}`);
      }

      const failure = routeError(response.body);
      if (failure) throw failure;

      return normalizeSandboxConfig(response.body);
    },

    async credentials(sandboxId: string): Promise<string> {
      const response = await post('/internal/credentials', { sandboxId });

      if (response.status === 404) {
        throw new CredentialsNotFoundError();
      }
      if (response.status !== 200) {
        throw new CredentialsUnavailableError(
          `CREDENTIALS_HTTP_${response.status}`,
        );
      }

      const token = isRecord(response.body)
        ? response.body.token
        : undefined;
      if (typeof token !== 'string' || token.length === 0) {
        throw new CredentialsUnavailableError('CREDENTIALS_INVALID_RESPONSE');
      }
      return token;
    },

    async consumeTicket(ticket: string): Promise<TicketClaims> {
      const response = await post('/internal/tickets/consume', { ticket });

      if (response.status === 401) {
        throw new TicketInvalidError();
      }
      if (response.status === 409) {
        throw new TicketAlreadyUsedError();
      }
      if (response.status !== 200 || !isRecord(response.body)) {
        throw new BackendUnavailableError(
          `TICKET_HTTP_${response.status}`,
        );
      }

      const { userId, agentId, containerId } = response.body;
      if (
        typeof userId !== 'string' ||
        typeof agentId !== 'string' ||
        typeof containerId !== 'string'
      ) {
        throw new BackendUnavailableError('TICKET_INVALID_RESPONSE');
      }

      // `agentId: ''` is preserved exactly as returned. It is a real lookup
      // value for /internal/route, not a synonym for "primary".
      return { userId, agentId, containerId };
    },
  };
}

export function backendClientConfigFrom(
  config: GatewayConfig,
): BackendClientConfig {
  return {
    backendUrl: config.backendUrl,
    internalToken: config.internalToken,
    timeoutMs: config.upstreamTimeoutMs,
  };
}
