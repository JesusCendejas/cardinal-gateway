import { EventEmitter } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface RecordedUpgrade {
  url: string;
  headers: IncomingHttpHeaders;
  at: number;
}

export interface RecordedAgentHttpRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  at: number;
}

export type FakeAgentHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) => void | Promise<void>;

export interface FakeAgentServerOptions {
  httpHandler?: FakeAgentHttpHandler;
  authorizeUpgrade?: (request: IncomingMessage) => boolean;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Fake Letta App Server:
 *  - accepts WS upgrades and records their headers (this is how tests prove
 *    the upstream saw `Authorization: Bearer <capability token>` and not a JWT);
 *  - echoes text, echoes binary, and emits five ordered stream_delta frames;
 *  - also serves ordinary HTTP requests so the /v1 proxy tests have an upstream.
 */
export class FakeAgentServer {
  readonly httpRequests: RecordedAgentHttpRequest[] = [];
  readonly upgradeRequests: RecordedUpgrade[] = [];
  readonly serverNames: string[] = [];
  connections = 0;
  activeConnections = 0;

  httpHandler: FakeAgentHttpHandler | undefined;
  authorizeUpgrade: ((request: IncomingMessage) => boolean) | undefined;

  httpUrl = '';
  wsUrl = '';
  port = 0;

  private readonly emitter = new EventEmitter();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Set<WebSocket>();

  private constructor(options: FakeAgentServerOptions) {
    this.httpHandler = options.httpHandler;
    this.authorizeUpgrade = options.authorizeUpgrade;

    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!response.writableEnded) {
          response.end(
            JSON.stringify({
              error: 'FAKE_AGENT_SERVER_ERROR',
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

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket, request) => {
      void request;
      this.clients.add(socket);
      this.connections += 1;
      this.activeConnections += 1;
      this.emitter.emit('connection');
      socket.on('close', () => {
        this.clients.delete(socket);
        this.activeConnections -= 1;
      });
      socket.on('error', () => {
        /* tests assert close codes; socket errors are expected on teardown */
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          socket.send(data, { binary: true });
          return;
        }
        const text = data.toString();
        if (text === 'stream' || text === '{"type":"stream"}') {
          for (let index = 1; index <= 5; index += 1) {
            socket.send(
              JSON.stringify({
                type: 'stream_delta',
                delta: `delta-${index}`,
                index,
              }),
            );
          }
          return;
        }
        socket.send(text);
      });
    });

    this.server.on('upgrade', (request, socket, head) => {
      const record: RecordedUpgrade = {
        url: request.url ?? '/',
        headers: request.headers,
        at: Date.now(),
      };
      this.upgradeRequests.push(record);
      this.emitter.emit('upgrade', record);

      if (this.authorizeUpgrade && !this.authorizeUpgrade(request)) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n' +
            '\r\n',
        );
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (websocket) => {
        this.wss.emit('connection', websocket, request);
      });
    });
  }

  static async start(
    options: FakeAgentServerOptions = {},
  ): Promise<FakeAgentServer> {
    const server = new FakeAgentServer(options);
    await new Promise<void>((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('FakeAgentServer: no TCP address');
    }
    server.port = address.port;
    server.httpUrl = `http://127.0.0.1:${address.port}`;
    server.wsUrl = `ws://127.0.0.1:${address.port}`;
    return server;
  }

  setHttpHandler(handler: FakeAgentHttpHandler | undefined): void {
    this.httpHandler = handler;
  }

  setUpgradeAuthorizer(
    authorizer: ((request: IncomingMessage) => boolean) | undefined,
  ): void {
    this.authorizeUpgrade = authorizer;
  }

  waitForUpgrade(timeoutMs = 750): Promise<boolean> {
    if (this.upgradeRequests.length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const onUpgrade = (): void => {
        if (timer) clearTimeout(timer);
        this.emitter.off('upgrade', onUpgrade);
        resolve(true);
      };
      this.emitter.once('upgrade', onUpgrade);
      timer = setTimeout(() => {
        this.emitter.off('upgrade', onUpgrade);
        this.timers.delete(timer as NodeJS.Timeout);
        resolve(false);
      }, timeoutMs);
      this.timers.add(timer);
    });
  }

  waitForConnection(timeoutMs = 750): Promise<boolean> {
    if (this.connections > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const onConnection = (): void => {
        if (timer) clearTimeout(timer);
        this.emitter.off('connection', onConnection);
        resolve(true);
      };
      this.emitter.once('connection', onConnection);
      timer = setTimeout(() => {
        this.emitter.off('connection', onConnection);
        this.timers.delete(timer as NodeJS.Timeout);
        resolve(false);
      }, timeoutMs);
      this.timers.add(timer);
    });
  }

  async waitForHttpRequest(
    predicate: (request: RecordedAgentHttpRequest) => boolean,
    timeoutMs = 750,
  ): Promise<boolean> {
    if (this.httpRequests.some(predicate)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const onRequest = (): void => {
        if (this.httpRequests.some(predicate)) {
          if (timer) clearTimeout(timer);
          this.emitter.off('http-request', onRequest);
          resolve(true);
        }
      };
      this.emitter.on('http-request', onRequest);
      timer = setTimeout(() => {
        this.emitter.off('http-request', onRequest);
        this.timers.delete(timer as NodeJS.Timeout);
        resolve(false);
      }, timeoutMs);
      this.timers.add(timer);
    });
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    this.wss.close();
    if (this.server.listening) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    this.sockets.clear();
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBody(request);
    const record: RecordedAgentHttpRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      body,
      at: Date.now(),
    };
    this.httpRequests.push(record);
    this.emitter.emit('http-request', record);

    if (this.httpHandler) {
      try {
        await this.httpHandler(request, response, body);
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        response.end(
          JSON.stringify({
            error: 'FAKE_AGENT_HANDLER_ERROR',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }
}

export async function createFakeAgentServer(
  options: FakeAgentServerOptions = {},
): Promise<FakeAgentServer> {
  return FakeAgentServer.start(options);
}
