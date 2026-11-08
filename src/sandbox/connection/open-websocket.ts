import WebSocket, { type ClientOptions } from 'ws';

import type { SandboxConfig } from '../config.js';
import { UpstreamHandshakeError } from './errors.js';
import type {
  SandboxConnection,
  SandboxConnectionOptions,
} from './sandbox-connection.js';

export interface OpenWebSocketInput {
  url: string;
  config: SandboxConfig;
  token: string;
  options: SandboxConnectionOptions;
  tls?: {
    servername?: string;
    rejectUnauthorized?: boolean;
  };
}

type SandboxClientOptions = ClientOptions & { servername?: string };

function buildClientOptions(input: OpenWebSocketInput): SandboxClientOptions {
  const clientOptions: SandboxClientOptions = {
    headers: {
      // The upstream only ever sees the short-lived capability token. The
      // client's access token is never forwarded.
      Authorization: `Bearer ${input.token}`,
    },
    handshakeTimeout: input.options.handshakeTimeoutMs,
  };

  if (input.tls) {
    if (input.tls.servername !== undefined) {
      clientOptions.servername = input.tls.servername;
    }
    if (input.tls.rejectUnauthorized !== undefined) {
      clientOptions.rejectUnauthorized = input.tls.rejectUnauthorized;
    }
  }

  return clientOptions;
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    socket.once('close', finish);
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
      finish();
    }, 250);
    timer.unref?.();

    try {
      socket.close();
    } catch {
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
      finish();
    }
  });
}

/**
 * Open a client WebSocket to the sandbox and wait for the upgrade to complete.
 *
 * Any failure before `open` becomes `UpstreamHandshakeError` (TLS rejection,
 * non-101 response, connection refused, handshake timeout). The caller maps it
 * to close code 4402.
 */
export async function openSandboxWebSocket(
  input: OpenWebSocketInput,
): Promise<SandboxConnection> {
  const socket = new WebSocket(input.url, buildClientOptions(input));

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      socket.off('open', onOpen);
      socket.off('unexpected-response', onUnexpectedResponse);
      socket.off('close', onClose);
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
      reject(new UpstreamHandshakeError(message));
    };

    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onUnexpectedResponse = (
      _request: unknown,
      response: { statusCode?: number; resume?: () => void },
    ): void => {
      response.resume?.();
      fail(`UPSTREAM_HTTP_${response.statusCode ?? 'UNKNOWN'}`);
    };

    const onClose = (code: number, reason: Buffer): void => {
      fail(`UPSTREAM_CLOSED_BEFORE_OPEN:${code}:${reason.toString()}`);
    };

    socket.once('open', onOpen);
    socket.once('unexpected-response', onUnexpectedResponse);
    socket.once('close', onClose);
    // Keep a permanent swallow-listener so a late socket error cannot crash
    // the process after the handshake succeeded. Routing code also listens.
    socket.on('error', (error: Error) => {
      if (!settled) fail(`UPSTREAM_HANDSHAKE_ERROR:${error.message}`);
    });
  });

  return {
    socket,
    config: input.config,
    close(): Promise<void> {
      return closeSocket(socket);
    },
  };
}
