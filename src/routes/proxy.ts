import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { GatewayConfig } from '../config/env.js';
import { verifyAccessToken } from '../auth/verify-access-token.js';
import type { BackendClient } from '../internal/backend-client.js';
import {
  BackendUnavailableError,
  CredentialsNotFoundError,
  CredentialsUnavailableError,
  NodeUnavailableError,
  RouteNotFoundError,
  RouteNotReadyError,
} from '../internal/errors.js';
import { resolveSandboxWithCredentials } from '../internal/resolve-sandbox.js';
import type { RouteCache } from '../internal/route-cache.js';
import type { AppLogger } from '../observability/logger.js';
import { toLoggable } from '../observability/logger.js';
import type { SandboxConfig } from '../sandbox/config.js';
import {
  InsecureTlsConfigError,
  UnsupportedTransportError,
} from '../sandbox/connection/errors.js';

export interface ProxyRouteDependencies {
  config: GatewayConfig;
  backend: BackendClient;
  routeCache: RouteCache;
  logger: AppLogger;
}

interface AuthedRequest extends FastifyRequest {
  userId?: string;
}

interface UpstreamResponse {
  status: number;
  contentType: string | undefined;
  body: Buffer;
}

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'authorization',
  'cookie',
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length',
  'accept-encoding',
]);

function extractBearer(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function toBuffer(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function extractBodyAgentId(
  body: Buffer | undefined,
  contentType: string | undefined,
): string | undefined {
  if (!body || body.length === 0) return undefined;
  if (contentType && !contentType.toLowerCase().includes('json')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).agent_id === 'string'
    ) {
      return (parsed as Record<string, string>).agent_id;
    }
  } catch {
    // Not JSON: there is no agent_id to validate.
  }
  return undefined;
}

function extractPathAgentId(pathname: string): string | undefined {
  const match = /^\/v1\/agents\/([^/]+)(?:\/.*)?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isAgentCollectionRequest(method: string, pathname: string): boolean {
  return method === 'GET' && /^\/v1\/agents\/?$/.test(pathname);
}

function filterPrimaryAgents(body: Buffer): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return [];
  }

  let list: unknown[] = [];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { agents?: unknown }).agents)
  ) {
    list = (parsed as { agents: unknown[] }).agents;
  }

  return list.filter(
    (agent) =>
      typeof agent === 'object' &&
      agent !== null &&
      (agent as { is_primary?: unknown }).is_primary === true,
  );
}

function forwardHttp(options: {
  sandbox: SandboxConfig;
  token: string;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer | undefined;
  timeoutMs: number;
}): Promise<UpstreamResponse> {
  const { sandbox, token } = options;
  const isTls = sandbox.transport === 'wss';
  const transport = isTls ? https : http;

  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(options.headers)) {
    if (value === undefined) continue;
    if (DROP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }

  headers.authorization = `Bearer ${token}`;
  headers.host = `${sandbox.endpoint}:${sandbox.port}`;
  if (options.body && options.body.length > 0) {
    headers['content-length'] = options.body.length;
  }

  return new Promise<UpstreamResponse>((resolve, reject) => {
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = transport.request(
      {
        host: sandbox.endpoint,
        port: sandbox.port,
        method: options.method,
        path: options.url,
        headers,
        timeout: options.timeoutMs,
        ...(isTls
          ? {
              rejectUnauthorized:
                sandbox.tls?.rejectUnauthorized ?? true,
              ...(sandbox.tls?.servername !== undefined
                ? { servername: sandbox.tls.servername }
                : {}),
            }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 502,
            contentType:
              typeof response.headers['content-type'] === 'string'
                ? response.headers['content-type']
                : undefined,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', finishError);
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('UPSTREAM_TIMEOUT'));
    });
    request.on('error', finishError);

    if (options.body && options.body.length > 0) {
      request.write(options.body);
    }
    request.end();
  });
}

function mapProxyFailure(error: unknown): {
  status: number;
  error: string;
} {
  if (error instanceof RouteNotFoundError) {
    return { status: 404, error: 'NOT_FOUND' };
  }
  if (error instanceof RouteNotReadyError) {
    return { status: 503, error: 'SANDBOX_NOT_READY' };
  }
  if (error instanceof NodeUnavailableError) {
    return { status: 503, error: 'NODE_UNAVAILABLE' };
  }
  if (error instanceof CredentialsNotFoundError) {
    return { status: 503, error: 'CREDENTIALS_UNAVAILABLE' };
  }
  if (error instanceof CredentialsUnavailableError) {
    return { status: 503, error: 'CREDENTIALS_UNAVAILABLE' };
  }
  if (error instanceof UnsupportedTransportError) {
    return { status: 502, error: 'UPSTREAM_ERROR' };
  }
  if (error instanceof InsecureTlsConfigError) {
    return { status: 502, error: 'UPSTREAM_ERROR' };
  }
  if (error instanceof BackendUnavailableError) {
    return { status: 503, error: 'BACKEND_UNAVAILABLE' };
  }
  return { status: 502, error: 'UPSTREAM_ERROR' };
}

export function registerProxyRoutes(
  app: FastifyInstance,
  deps: ProxyRouteDependencies,
): void {
  const { config, backend, routeCache, logger } = deps;

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = extractBearer(request.headers.authorization);
    if (!token) {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
      return;
    }

    try {
      const claims = await verifyAccessToken(token, config.accessTokenSecret);
      (request as AuthedRequest).userId = claims.userId;
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  }

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const userId = (request as AuthedRequest).userId;
    if (!userId) {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
      return;
    }

    const method = request.method.toUpperCase();
    const rawUrl = request.raw.url ?? request.url;
    let pathname: string;
    try {
      pathname = new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      await reply.code(400).send({ error: 'BAD_REQUEST' });
      return;
    }

    // DELETE of an agent is not part of the data plane. Answer without ever
    // touching the upstream.
    if (method === 'DELETE' && /^\/v1\/agents(\/|$)/.test(pathname)) {
      await reply.code(405).send({ error: 'METHOD_NOT_ALLOWED' });
      return;
    }

    const body = toBuffer(request.body);
    const contentType =
      typeof request.headers['content-type'] === 'string'
        ? request.headers['content-type']
        : undefined;
    const bodyAgentId = extractBodyAgentId(body, contentType);
    const pathAgentId = extractPathAgentId(pathname);

    if (
      pathAgentId !== undefined &&
      bodyAgentId !== undefined &&
      bodyAgentId !== pathAgentId
    ) {
      await reply.code(403).send({ error: 'AGENT_MISMATCH' });
      return;
    }

    const agentId = pathAgentId ?? bodyAgentId;

    try {
      const resolved = await resolveSandboxWithCredentials(
        { backend, routeCache, logger },
        userId,
        agentId,
      );

      const upstream = await forwardHttp({
        sandbox: resolved.sandbox,
        token: resolved.token,
        method,
        url: rawUrl,
        headers: request.headers,
        body,
        timeoutMs: config.upstreamTimeoutMs,
      });

      if (upstream.status >= 500) {
        await reply.code(502).send({ error: 'UPSTREAM_ERROR' });
        return;
      }

      if (isAgentCollectionRequest(method, pathname)) {
        const filtered = filterPrimaryAgents(upstream.body);
        reply.code(upstream.status).header('content-type', 'application/json');
        await reply.send(JSON.stringify(filtered));
        return;
      }

      reply.code(upstream.status);
      if (upstream.contentType) {
        reply.header('content-type', upstream.contentType);
      }
      await reply.send(upstream.body);
    } catch (error) {
      const failure = mapProxyFailure(error);
      logger.warn(
        { error: toLoggable(error), status: failure.status },
        'proxy request failed',
      );
      await reply.code(failure.status).send({ error: failure.error });
    }
  }

  app.all('/v1/*', { preHandler: authenticate }, handle);
  app.all('/app-server-info', { preHandler: authenticate }, handle);
}
