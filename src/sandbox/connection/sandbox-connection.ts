import type WebSocket from 'ws';

import type { SandboxConfig } from '../config.js';

/**
 * A live upstream WebSocket plus the config that produced it.
 *
 * The capability token is deliberately absent: it was passed as an argument to
 * the factory and lives only in the request/connection memory, never in this
 * object.
 */
export interface SandboxConnection {
  readonly socket: WebSocket;
  readonly config: SandboxConfig;
  close(): Promise<void>;
}

export interface SandboxConnectionOptions {
  handshakeTimeoutMs: number;
  nodeEnv: 'development' | 'test' | 'production';
}
