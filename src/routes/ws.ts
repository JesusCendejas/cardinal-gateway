import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import type { GatewayConfig } from '../config/env.js';
import { verifyAccessToken, type AccessTokenClaims } from '../auth/verify-access-token.js';
import type { BackendClient } from '../internal/backend-client.js';
import {
  BackendUnavailableError,
  CredentialsNotFoundError,
  CredentialsUnavailableError,
  NodeUnavailableError,
  RouteNotFoundError,
  RouteNotReadyError,
  TicketAlreadyUsedError,
  TicketInvalidError,
} from '../internal/errors.js';
import { resolveSandboxWithCredentials } from '../internal/resolve-sandbox.js';
import type { RouteCache } from '../internal/route-cache.js';
import type { ConnectionRegistry } from '../limits/connection-registry.js';
import type { RateLimiter } from '../limits/rate-limit.js';
import type { AppLogger } from '../observability/logger.js';
import { toLoggable } from '../observability/logger.js';
import type { SandboxConfig } from '../sandbox/config.js';
import {
  InsecureTlsConfigError,
  UnsupportedTransportError,
  UpstreamHandshakeError,
} from '../sandbox/connection/errors.js';
import {
  createSandboxConnection,
  type SandboxConnection,
} from '../sandbox/connection/factory.js';

export const WS_PATH = '/ws';

export const CloseCode = {
  TICKET_INVALID: 4401,
  UPSTREAM_HANDSHAKE_FAILED: 4402,
  FORBIDDEN: 4403,
  ROUTE_NOT_FOUND: 4404,
  ALREADY_CONNECTED: 4409,
  RATE_LIMITED: 4429,
  UNAVAILABLE: 4503,
} as const;

export interface WsRouteDependencies {
  config: GatewayConfig;
  backend: BackendClient;
  routeCache: RouteCache;
  registry: ConnectionRegistry;
  rateLimiter: RateLimiter;
  logger: AppLogger;
}

export interface WsGateway {
  /** Close every client and upstream socket and release every reservation. */
  closeAll(): Promise<void>;
}

interface ActiveSession {
  userId: string;
  connectionId: string;
  client: WebSocket;
  upstream: WebSocket;
  heartbeat: NodeJS.Timeout | null;
  closed: boolean;
}

interface AuthResult {
  ticket: string | null;
  claims?: AccessTokenClaims;
}

interface MappedFailure {
  code: number;
  reason: string;
}

interface PreparedSession {
  userId: string;
  connectionId: string;
  sandbox: SandboxConfig;
  connection: SandboxConnection;
}

function extractBearer(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  statusMessage: string,
): void {
  if (socket.destroyed) return;
  try {
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusMessage}\r\n` +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n',
    );
  } catch {
    socket.destroy();
  }
}

function closeClientQuietly(
  client: WebSocket,
  code: number,
  reason: string,
): void {
  try {
    if (client.readyState === WebSocket.OPEN) {
      client.close(code, reason);
    } else if (client.readyState === WebSocket.CONNECTING) {
      client.terminate();
    }
  } catch {
    /* socket already gone */
  }
}

function mapFailure(error: unknown): MappedFailure {
  if (error instanceof TicketInvalidError) {
    return { code: CloseCode.TICKET_INVALID, reason: 'TICKET_INVALID' };
  }
  if (error instanceof TicketAlreadyUsedError) {
    return { code: CloseCode.TICKET_INVALID, reason: 'TICKET_ALREADY_USED' };
  }
  if (error instanceof RouteNotFoundError) {
    return { code: CloseCode.ROUTE_NOT_FOUND, reason: 'ROUTE_NOT_FOUND' };
  }
  if (error instanceof RouteNotReadyError) {
    return { code: CloseCode.UNAVAILABLE, reason: 'SANDBOX_NOT_READY' };
  }
  if (error instanceof NodeUnavailableError) {
    return { code: CloseCode.UNAVAILABLE, reason: 'NODE_UNAVAILABLE' };
  }
  if (error instanceof BackendUnavailableError) {
    return { code: CloseCode.UNAVAILABLE, reason: 'BACKEND_UNAVAILABLE' };
  }
  if (error instanceof CredentialsNotFoundError) {
    return { code: CloseCode.UNAVAILABLE, reason: 'CREDENTIALS_UNAVAILABLE' };
  }
  if (error instanceof CredentialsUnavailableError) {
    return { code: CloseCode.UNAVAILABLE, reason: 'CREDENTIALS_UNAVAILABLE' };
  }
  if (error instanceof UnsupportedTransportError) {
    return { code: CloseCode.UNAVAILABLE, reason: 'UNSUPPORTED_TRANSPORT' };
  }
  if (error instanceof InsecureTlsConfigError) {
    return { code: CloseCode.UNAVAILABLE, reason: 'TLS_INSECURE_REJECTED' };
  }
  if (error instanceof UpstreamHandshakeError) {
    return {
      code: CloseCode.UPSTREAM_HANDSHAKE_FAILED,
      reason: 'UPSTREAM_HANDSHAKE_FAILED',
    };
  }
  return { code: CloseCode.UNAVAILABLE, reason: 'BACKEND_UNAVAILABLE' };
}

function forwardFrame(target: WebSocket, data: RawData, isBinary: boolean): void {
  if (target.readyState !== WebSocket.OPEN) return;
  target.send(data, { binary: isBinary }, (error) => {
    if (error) {
      try {
        target.terminate();
      } catch {
        /* already gone */
      }
    }
  });
}

export function registerWsRoutes(
  app: FastifyInstance,
  deps: WsRouteDependencies,
): WsGateway {
  const { config, backend, routeCache, registry, rateLimiter, logger } = deps;

  const sessions = new Set<ActiveSession>();
  const wss = new WebSocketServer({ noServer: true });
  const connectionTtlMs = Math.max(config.pongTimeoutMs * 3, 60_000);
  let shuttingDown = false;
  let gatewayClosed = false;

  async function finalizeSession(session: ActiveSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session);

    if (session.heartbeat) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }

    try {
      session.upstream.terminate();
    } catch {
      /* already gone */
    }

    await registry.release(session.userId, session.connectionId);
  }

  function wireSession(session: ActiveSession): void {
    const { client, upstream } = session;

    let missedPongs = 0;
    let awaitingPong = false;

    client.on('message', (data: RawData, isBinary: boolean) => {
      forwardFrame(upstream, data, isBinary);
    });
    upstream.on('message', (data: RawData, isBinary: boolean) => {
      forwardFrame(client, data, isBinary);
    });

    client.on('pong', () => {
      missedPongs = 0;
      awaitingPong = false;
    });

    client.on('close', () => {
      void finalizeSession(session);
    });
    client.on('error', () => {
      void finalizeSession(session);
    });

    upstream.on('close', () => {
      if (!session.closed) {
        closeClientQuietly(client, 1011, 'UPSTREAM_CLOSED');
      }
      void finalizeSession(session);
    });
    upstream.on('error', () => {
      if (!session.closed) {
        closeClientQuietly(client, 1011, 'UPSTREAM_ERROR');
      }
      void finalizeSession(session);
    });

    session.heartbeat = setInterval(() => {
      if (session.closed) return;
      if (client.readyState !== WebSocket.OPEN) return;

      if (awaitingPong) {
        missedPongs += 1;
        if (missedPongs >= 2) {
          // Two unanswered pings: clean close 1001, then release the slot.
          closeClientQuietly(client, 1001, 'HEARTBEAT_TIMEOUT');
          void finalizeSession(session);
          return;
        }
      } else {
        missedPongs = 1;
        awaitingPong = true;
      }

      try {
        client.ping();
      } catch {
        void finalizeSession(session);
      }
    }, config.heartbeatIntervalMs);
    session.heartbeat.unref?.();
  }

  /** Upgrade the client and immediately close it with a protocol close code. */
  function acceptAndClose(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    failure: MappedFailure,
  ): void {
    if (socket.destroyed) return;
    try {
      wss.handleUpgrade(request, socket, head, (client) => {
        closeClientQuietly(client, failure.code, failure.reason);
      });
    } catch {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  function acceptAndWire(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    prepared: PreparedSession,
  ): void {
    if (socket.destroyed) {
      void prepared.connection.close();
      void registry.release(prepared.userId, prepared.connectionId);
      return;
    }

    try {
      wss.handleUpgrade(request, socket, head, (client) => {
        if (shuttingDown || client.readyState !== WebSocket.OPEN) {
          closeClientQuietly(client, 1001, 'GATEWAY_SHUTDOWN');
          void prepared.connection.close();
          void registry.release(prepared.userId, prepared.connectionId);
          return;
        }

        registry.attach(prepared.userId, prepared.connectionId, {
          sandboxId: prepared.sandbox.sandboxId,
          transport: prepared.sandbox.transport,
        });

        const session: ActiveSession = {
          userId: prepared.userId,
          connectionId: prepared.connectionId,
          client,
          upstream: prepared.connection.socket,
          heartbeat: null,
          closed: false,
        };
        sessions.add(session);
        wireSession(session);
      });
    } catch (error) {
      void prepared.connection.close();
      void registry.release(prepared.userId, prepared.connectionId);
      logger.warn(
        { error: toLoggable(error) },
        'websocket upgrade failed after setup',
      );
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
  }

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    if (url.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    // 1. Origin, before the upgrade. A missing header is allowed when the
    // list is configured; only a present and disallowed Origin is rejected.
    const origin = request.headers.origin;
    if (
      config.allowedOrigins.length > 0 &&
      typeof origin === 'string' &&
      origin.length > 0 &&
      !config.allowedOrigins.includes(origin) &&
      !config.allowedOrigins.includes('*')
    ) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    // 2. Bearer authentication is an HTTP pre-upgrade decision (401). Ticket
    // authentication is a WebSocket close decision (4401), so it is performed
    // during setup below.
    const ticket = url.searchParams.get('ticket');
    let claims: AccessTokenClaims | undefined;
    if (ticket === null) {
      const token = extractBearer(request.headers.authorization);
      if (!token) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      try {
        claims = await verifyAccessToken(token, config.accessTokenSecret);
      } catch {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
    }

    const auth: AuthResult = { ticket, claims };
    const connectionId = randomUUID();
    let userId: string | undefined;
    let reserved = false;
    let connection: SandboxConnection | undefined;

    try {
      let agentId: string | undefined;

      if (auth.ticket !== null) {
        const ticketClaims = await backend.consumeTicket(auth.ticket);
        userId = ticketClaims.userId;
        // Never trust an agentId from the query string. The backend's answer
        // is authoritative, and `''` is preserved as a real lookup value.
        agentId = ticketClaims.agentId;
      } else {
        userId = auth.claims?.userId;
        if (!userId) {
          acceptAndClose(request, socket, head, {
            code: CloseCode.FORBIDDEN,
            reason: 'FORBIDDEN',
          });
          return;
        }
        // Bearer flow never carries an agent id: /internal/route resolves the
        // user's primary sandbox when the field is omitted.
        agentId = undefined;
      }

      const limit = await rateLimiter.consume(userId);
      if (!limit.allowed) {
        acceptAndClose(request, socket, head, {
          code: CloseCode.RATE_LIMITED,
          reason: 'RATE_LIMITED',
        });
        return;
      }

      if (shuttingDown) {
        acceptAndClose(request, socket, head, {
          code: CloseCode.UNAVAILABLE,
          reason: 'GATEWAY_SHUTTING_DOWN',
        });
        return;
      }

      reserved = await registry.reserve(userId, connectionId, connectionTtlMs);
      if (!reserved) {
        acceptAndClose(request, socket, head, {
          code: CloseCode.ALREADY_CONNECTED,
          reason: 'CONNECTION_ALREADY_OPEN',
        });
        return;
      }

      const resolved = await resolveSandboxWithCredentials(
        { backend, routeCache, logger },
        userId,
        agentId,
      );

      connection = await createSandboxConnection(
        resolved.sandbox,
        resolved.token,
        {
          handshakeTimeoutMs: config.upstreamHandshakeTimeoutMs,
          nodeEnv: config.nodeEnv,
        },
      );

      const prepared: PreparedSession = {
        userId,
        connectionId,
        sandbox: resolved.sandbox,
        connection,
      };
      // Setup is complete before the client upgrade: by the time the client
      // sees `open`, the route/credentials/upstream handshake already
      // happened. This also removes the race where a test inspects
      // /internal/route immediately after `open`.
      reserved = false; // ownership moves to the session/accept path
      acceptAndWire(request, socket, head, prepared);
    } catch (error) {
      const failure = mapFailure(error);
      logger.warn(
        {
          code: failure.code,
          reason: failure.reason,
          error: toLoggable(error),
        },
        'websocket session setup failed',
      );
      if (connection) {
        await connection.close();
      }
      if (reserved && userId) {
        await registry.release(userId, connectionId);
      }
      acceptAndClose(request, socket, head, failure);
    }
  }

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void handleUpgrade(request, socket, head).catch((error: unknown) => {
      logger.error(
        { error: toLoggable(error) },
        'unhandled websocket upgrade failure',
      );
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });
  };

  app.server.on('upgrade', onUpgrade);

  return {
    async closeAll(): Promise<void> {
      if (gatewayClosed) return;
      gatewayClosed = true;
      shuttingDown = true;

      app.server.off('upgrade', onUpgrade);

      for (const session of [...sessions]) {
        if (session.heartbeat) {
          clearInterval(session.heartbeat);
          session.heartbeat = null;
        }
        closeClientQuietly(session.client, 1001, 'GATEWAY_SHUTDOWN');
        try {
          session.upstream.terminate();
        } catch {
          /* already gone */
        }
      }

      const deadline = Date.now() + 1000;
      while (sessions.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      for (const session of [...sessions]) {
        try {
          session.client.terminate();
        } catch {
          /* already gone */
        }
        await finalizeSession(session);
      }

      try {
        wss.close();
      } catch {
        /* already closed */
      }
    },
  };
}
