import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

import type { SandboxConfig } from '../../src/sandbox/config.js';
import { makeTicket } from './tokens.js';

export const TEST_INTERNAL_TOKEN =
  'test-internal-token-0123456789abcdef';

export interface RecordedBackendRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  at: number;
}

export interface BackendHttpResponse {
  status: number;
  body: unknown;
}

export interface RouteRequestBody {
  userId: string;
  /**
   * Optional. Omitted means "the user's primary agent". The backend does NOT
   * use the empty string as a sentinel: `agentId: ""` is a lookup and returns
   * NOT_FOUND, exactly like the real backend.
   */
  agentId?: string;
}

export type RouteHandler = (
  body: RouteRequestBody,
  request: RecordedBackendRequest,
) => BackendHttpResponse | Promise<BackendHttpResponse>;

export type CredentialsHandler = (
  body: { sandboxId: string },
  request: RecordedBackendRequest,
) => BackendHttpResponse | Promise<BackendHttpResponse>;

export type TicketHandler = (
  body: { ticket: string },
  request: RecordedBackendRequest,
) => BackendHttpResponse | Promise<BackendHttpResponse>;

export interface FakeBackendOptions {
  /** null disables the X-Internal-Token check (still recorded). */
  internalToken?: string | null;
  route?: RouteHandler;
  credentials?: CredentialsHandler;
  ticket?: TicketHandler;
}

interface TicketRecord {
  ticket: string;
  userId: string;
  agentId: string;
  containerId: string;
  expiresAt: number;
  used: boolean;
}

interface IssueTicketOptions {
  userId: string;
  agentId: string;
  containerId?: string;
  expiresAt?: number;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

interface SandboxRecord {
  userId: string;
  sandbox: SandboxConfig;
}

/**
 * The three internal backend endpoints, authenticated with X-Internal-Token.
 * Every request (headers + parsed body) is recorded so tests can assert both
 * positive calls and the absence of calls (tenant isolation).
 */
export class FakeBackend {
  readonly requests: RecordedBackendRequest[] = [];
  readonly sandboxes = new Map<string, SandboxRecord>();
  readonly defaultSandboxes = new Map<string, SandboxConfig>();
  readonly credentialsBySandbox = new Map<string, string>();
  readonly tickets = new Map<string, TicketRecord>();

  routeHandler: RouteHandler | undefined;
  credentialsHandler: CredentialsHandler | undefined;
  ticketHandler: TicketHandler | undefined;

  /** Simulates a dead backend that accepts the TCP connection but never replies. */
  down = false;

  url = '';

  private readonly options: FakeBackendOptions;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  private constructor(options: FakeBackendOptions) {
    this.options = options;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!response.writableEnded) {
          response.end(
            JSON.stringify({
              error: 'FAKE_BACKEND_ERROR',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(options: FakeBackendOptions = {}): Promise<FakeBackend> {
    const backend = new FakeBackend(options);
    await new Promise<void>((resolve, reject) => {
      backend.server.once('error', reject);
      backend.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = backend.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('FakeBackend: no TCP address');
    }
    backend.url = `http://127.0.0.1:${address.port}`;
    return backend;
  }

  /**
   * Register an agent-specific sandbox owned by `userId`. The backend is the
   * source of truth: asking for another user's agentId returns NOT_FOUND.
   */
  setSandbox(userId: string, agentId: string, sandbox: SandboxConfig): void {
    this.sandboxes.set(agentId, { userId, sandbox });
  }

  /**
   * Convenience for tests that change the transport of a user's only sandbox:
   * keep both the agent-specific route and the default route in sync.
   */
  setUserSandbox(userId: string, agentId: string, sandbox: SandboxConfig): void {
    this.setSandbox(userId, agentId, sandbox);
    this.setDefaultSandbox(userId, sandbox);
  }

  /**
   * Sandbox used for collection/default routes, where the gateway sends
   * `agentId: ""` because the access token carries no agent information.
   */
  setDefaultSandbox(userId: string, sandbox: SandboxConfig): void {
    this.defaultSandboxes.set(userId, sandbox);
  }

  setCredential(sandboxId: string, token: string): void {
    this.credentialsBySandbox.set(sandboxId, token);
  }

  issueTicket(options: IssueTicketOptions): string {
    const ticket = makeTicket();
    this.tickets.set(ticket, {
      ticket,
      userId: options.userId,
      agentId: options.agentId,
      containerId: options.containerId ?? randomUUID(),
      expiresAt: options.expiresAt ?? Date.now() + 60_000,
      used: false,
    });
    return ticket;
  }

  expireTicket(ticket: string): void {
    const record = this.tickets.get(ticket);
    if (!record) throw new Error(`FakeBackend: unknown ticket ${ticket}`);
    record.expiresAt = Date.now() - 1;
  }

  requestsFor(path: string): RecordedBackendRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  lastRequest(path: string): RecordedBackendRequest | undefined {
    return this.requestsFor(path).at(-1);
  }

  reset(): void {
    this.requests.length = 0;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.sockets.clear();
  }

  private defaultRoute(body: RouteRequestBody): BackendHttpResponse {
    // Absent means "primary agent for this user".
    if (body.agentId === undefined) {
      const defaultSandbox = this.defaultSandboxes.get(body.userId);
      if (!defaultSandbox) {
        return { status: 200, body: { error: 'NOT_FOUND' } };
      }
      return { status: 200, body: defaultSandbox };
    }

    // Empty is a real lookup value, not a synonym for absent.
    if (body.agentId === '') {
      return { status: 200, body: { error: 'NOT_FOUND' } };
    }

    const record = this.sandboxes.get(body.agentId);
    if (!record || record.userId !== body.userId) {
      return { status: 200, body: { error: 'NOT_FOUND' } };
    }
    return { status: 200, body: record.sandbox };
  }

  private defaultCredentials(body: {
    sandboxId: string;
  }): BackendHttpResponse {
    const token = this.credentialsBySandbox.get(body.sandboxId);
    if (!token) {
      return { status: 404, body: { error: 'SANDBOX_NOT_FOUND' } };
    }
    return { status: 200, body: { token } };
  }

  private defaultTicket(body: { ticket: string }): BackendHttpResponse {
    const record = this.tickets.get(body.ticket);
    if (!record) {
      return { status: 401, body: { error: 'TICKET_INVALID' } };
    }
    if (record.expiresAt <= Date.now()) {
      return { status: 401, body: { error: 'TICKET_EXPIRED' } };
    }
    if (record.used) {
      return { status: 409, body: { error: 'TICKET_ALREADY_USED' } };
    }
    record.used = true;
    return {
      status: 200,
      body: {
        userId: record.userId,
        agentId: record.agentId,
        containerId: record.containerId,
      },
    };
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.down) {
      // Keep the socket open and never answer: the gateway must time out.
      return;
    }

    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const rawBody = await readBody(request);

    let body: unknown = null;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        sendJson(response, 400, { error: 'INVALID_JSON' });
        return;
      }
    }

    this.requests.push({
      method: request.method ?? 'GET',
      path,
      headers: request.headers,
      body,
      at: Date.now(),
    });

    const expectedToken =
      this.options.internalToken === undefined
        ? TEST_INTERNAL_TOKEN
        : this.options.internalToken;

    if (
      expectedToken !== null &&
      request.headers['x-internal-token'] !== expectedToken
    ) {
      sendJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }

    try {
      if (request.method === 'POST' && path === '/internal/route') {
        const routeBody = body as { userId?: unknown; agentId?: unknown };
        if (
          typeof routeBody?.userId !== 'string' ||
          (routeBody.agentId !== undefined &&
            typeof routeBody.agentId !== 'string')
        ) {
          sendJson(response, 400, { error: 'INVALID_BODY' });
          return;
        }

        const routeInput: RouteRequestBody = { userId: routeBody.userId };
        if (routeBody.agentId !== undefined) {
          routeInput.agentId = routeBody.agentId;
        }

        const result = this.routeHandler
          ? await this.routeHandler(
              routeInput,
              this.requests.at(-1) as RecordedBackendRequest,
            )
          : this.defaultRoute(routeInput);
        sendJson(response, result.status, result.body);
        return;
      }

      if (request.method === 'POST' && path === '/internal/credentials') {
        const credentialsBody = body as { sandboxId?: unknown };
        if (typeof credentialsBody?.sandboxId !== 'string') {
          sendJson(response, 400, { error: 'INVALID_BODY' });
          return;
        }
        const result = this.credentialsHandler
          ? await this.credentialsHandler(
              { sandboxId: credentialsBody.sandboxId },
              this.requests.at(-1) as RecordedBackendRequest,
            )
          : this.defaultCredentials({ sandboxId: credentialsBody.sandboxId });
        sendJson(response, result.status, result.body);
        return;
      }

      if (
        request.method === 'POST' &&
        path === '/internal/tickets/consume'
      ) {
        const ticketBody = body as { ticket?: unknown };
        if (typeof ticketBody?.ticket !== 'string') {
          sendJson(response, 400, { error: 'INVALID_BODY' });
          return;
        }
        const result = this.ticketHandler
          ? await this.ticketHandler(
              { ticket: ticketBody.ticket },
              this.requests.at(-1) as RecordedBackendRequest,
            )
          : this.defaultTicket({ ticket: ticketBody.ticket });
        sendJson(response, result.status, result.body);
        return;
      }

      sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: 'FAKE_BACKEND_ERROR', message });
    }
  }
}

export async function createFakeBackend(
  options: FakeBackendOptions = {},
): Promise<FakeBackend> {
  return FakeBackend.start(options);
}
