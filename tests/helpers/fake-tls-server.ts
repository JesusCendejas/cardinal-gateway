import { EventEmitter } from 'node:events';
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https';
import { createSecureContext, type SecureContext } from 'node:tls';
import type { Duplex } from 'node:stream';
import selfsigned from 'selfsigned';
import { WebSocketServer, type WebSocket } from 'ws';

export interface RecordedTlsUpgrade {
  url: string;
  headers: IncomingHttpHeaders;
  at: number;
}

/**
 * WSS upstream with a certificate generated inside the test (no network, no
 * checked-in key material). SNI is recorded so the transport tests can prove
 * that tls.servername was actually used.
 */
export class FakeTlsServer {
  readonly upgradeRequests: RecordedTlsUpgrade[] = [];
  readonly servernames: string[] = [];
  connections = 0;

  url = '';
  port = 0;

  private readonly emitter = new EventEmitter();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly server: HttpsServer;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<Duplex>();
  private readonly clients = new Set<WebSocket>();

  private constructor() {
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      {
        days: 1,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' },
            ],
          },
        ],
      },
    );

    const context: SecureContext = createSecureContext({
      key: pems.private,
      cert: pems.cert,
    });

    this.server = createHttpsServer(
      {
        key: pems.private,
        cert: pems.cert,
        SNICallback: (servername, callback) => {
          this.servernames.push(servername);
          callback(null, context);
        },
      },
      (request, response) => {
        void this.handleHttp(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json' });
          }
          if (!response.writableEnded) {
            response.end(
              JSON.stringify({
                error: 'FAKE_TLS_SERVER_ERROR',
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        });
      },
    );

    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      this.connections += 1;
      this.emitter.emit('connection');
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => {
        /* expected during teardown or a failed TLS test */
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          socket.send(data, { binary: true });
          return;
        }
        socket.send(data.toString());
      });
    });

    this.server.on('upgrade', (request, socket, head) => {
      const record: RecordedTlsUpgrade = {
        url: request.url ?? '/',
        headers: request.headers,
        at: Date.now(),
      };
      this.upgradeRequests.push(record);
      this.emitter.emit('upgrade', record);
      this.wss.handleUpgrade(request, socket, head, (websocket) => {
        this.wss.emit('connection', websocket, request);
      });
    });
  }

  static async start(): Promise<FakeTlsServer> {
    const server = new FakeTlsServer();
    await new Promise<void>((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('FakeTlsServer: no TCP address');
    }
    server.port = address.port;
    server.url = `wss://127.0.0.1:${address.port}`;
    return server;
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
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        path: request.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      }),
    );
  }
}

export async function createFakeTlsServer(): Promise<FakeTlsServer> {
  return FakeTlsServer.start();
}
