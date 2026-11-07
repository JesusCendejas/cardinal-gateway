import { EventEmitter } from 'node:events';
import WebSocket, { type ClientOptions } from 'ws';

export interface WsMessage {
  data: string | Buffer;
  isBinary: boolean;
  timedOut?: boolean;
}

export interface WsCloseInfo {
  code: number;
  reason: string;
  timedOut?: boolean;
}

export interface WsSession {
  opened: boolean;
  statusCode?: number;
  statusMessage?: string;
  closeCode?: number;
  closeReason?: string;
  error?: Error;
  socket?: WebSocket;
  messages: WsMessage[];
  waitForClose(timeoutMs?: number): Promise<WsCloseInfo>;
  waitForMessage(
    predicate: (message: WsMessage) => boolean,
    timeoutMs?: number,
  ): Promise<WsMessage>;
  waitForMessages(count: number, timeoutMs?: number): Promise<WsMessage[]>;
  send(data: string | Buffer): void;
  close(): Promise<void>;
}

/**
 * Opens a WS connection and resolves with either:
 *  - opened=true (the upgrade succeeded), or
 *  - opened=false plus statusCode / closeCode / error (the gateway rejected it).
 *
 * It never rejects: tests assert the concrete rejection instead of relying on
 * a test timeout. The returned session keeps listening for messages and close.
 */
export function openWs(
  url: string,
  options: ClientOptions = {},
  timeoutMs = 1500,
): Promise<WsSession> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, options);
    const messages: WsMessage[] = [];
    const emitter = new EventEmitter();

    let closeInfo: WsCloseInfo | undefined;
    let opened = false;
    let settled = false;
    let statusCode: number | undefined;
    let statusMessage: string | undefined;
    let error: Error | undefined;

    const session: WsSession = {
      opened: false,
      messages,
      waitForClose(waitMs = 1500) {
        if (closeInfo) return Promise.resolve(closeInfo);
        return new Promise((resolveClose) => {
          let timer: NodeJS.Timeout | undefined;
          const onClose = (): void => {
            if (timer) clearTimeout(timer);
            resolveClose(closeInfo ?? { code: -1, reason: 'unknown' });
          };
          socket.once('close', onClose);
          timer = setTimeout(() => {
            socket.off('close', onClose);
            resolveClose({ code: -1, reason: 'timeout', timedOut: true });
          }, waitMs);
        });
      },
      waitForMessage(predicate, waitMs = 1500) {
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolveMessage) => {
          let timer: NodeJS.Timeout | undefined;
          const onMessage = (): void => {
            const found = messages.find(predicate);
            if (!found) return;
            if (timer) clearTimeout(timer);
            emitter.off('message', onMessage);
            resolveMessage(found);
          };
          emitter.on('message', onMessage);
          timer = setTimeout(() => {
            emitter.off('message', onMessage);
            resolveMessage({ data: '', isBinary: false, timedOut: true });
          }, waitMs);
        });
      },
      waitForMessages(count, waitMs = 1500) {
        if (messages.length >= count) {
          return Promise.resolve(messages.slice(0, count));
        }
        return new Promise((resolveMessages) => {
          let timer: NodeJS.Timeout | undefined;
          const onMessage = (): void => {
            if (messages.length < count) return;
            if (timer) clearTimeout(timer);
            emitter.off('message', onMessage);
            resolveMessages(messages.slice(0, count));
          };
          emitter.on('message', onMessage);
          timer = setTimeout(() => {
            emitter.off('message', onMessage);
            resolveMessages(messages.slice());
          }, waitMs);
        });
      },
      send(data) {
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error('ws session is not open');
        }
        socket.send(data);
      },
      close() {
        return new Promise((resolveClose) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolveClose();
            return;
          }
          const timer = setTimeout(() => {
            socket.terminate();
            resolveClose();
          }, 500);
          socket.once('close', () => {
            clearTimeout(timer);
            resolveClose();
          });
          socket.close();
        });
      },
    };

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      session.opened = opened;
      session.statusCode = statusCode;
      session.statusMessage = statusMessage;
      session.closeCode = closeInfo?.code;
      session.closeReason = closeInfo?.reason;
      session.error = error;
      session.socket = socket;
      resolve(session);
    }

    const openTimer = setTimeout(() => {
      error = new Error('ws open timed out');
      socket.terminate();
      finish();
    }, timeoutMs);

    socket.on('open', () => {
      opened = true;
      finish();
    });

    socket.on('unexpected-response', (_request, response) => {
      statusCode = response.statusCode;
      statusMessage = response.statusMessage;
      response.resume();
      socket.terminate();
      finish();
    });

    socket.on('error', (socketError) => {
      error = socketError;
      if (!opened) finish();
    });

    socket.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() };
      session.closeCode = code;
      session.closeReason = closeInfo.reason;
      emitter.emit('close');
      if (!opened) finish();
    });

    socket.on('message', (data, isBinary) => {
      const message: WsMessage = {
        data: isBinary ? Buffer.from(data as Buffer) : data.toString(),
        isBinary,
      };
      messages.push(message);
      emitter.emit('message', message);
    });
  });
}
