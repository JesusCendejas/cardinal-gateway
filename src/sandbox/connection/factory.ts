import type WebSocket from 'ws';

import type { SandboxConfig, SandboxCredentials } from '../config.js';

export interface SandboxConnection {
  readonly socket: WebSocket;
  readonly config: SandboxConfig;
  close(): Promise<void>;
}

export interface SandboxConnectionOptions {
  handshakeTimeoutMs: number;
  nodeEnv: 'development' | 'test' | 'production';
}

/**
 * Builds a WebSocket connection from the normalized SandboxConfig plus the
 * short-lived capability token. The token is passed as an argument and never
 * becomes part of `config`.
 */
export async function createSandboxConnection(
  _config: SandboxConfig,
  _credentials: SandboxCredentials,
  _options: SandboxConnectionOptions,
): Promise<SandboxConnection> {
  throw new Error('not implemented');
}
