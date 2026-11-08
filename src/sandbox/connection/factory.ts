import type { SandboxConfig } from '../config.js';
import { UnsupportedTransportError } from './errors.js';
import type {
  SandboxConnection,
  SandboxConnectionOptions,
} from './sandbox-connection.js';
import { createWsConnection } from './ws-connection.js';
import { createWssConnection } from './wss-connection.js';

export type { SandboxConnection, SandboxConnectionOptions };

/**
 * Build a WebSocket connection from the normalized SandboxConfig plus the
 * short-lived capability token.
 *
 * `transport` is the only selector. There is deliberately no `provider`
 * parameter and no `provider` branch: Railway, Hetzner, Fly and bare metal
 * are indistinguishable here. An unknown transport throws before any socket
 * is opened, so the route can close with 4503.
 */
export async function createSandboxConnection(
  config: SandboxConfig,
  token: string,
  options: SandboxConnectionOptions,
): Promise<SandboxConnection> {
  switch (config.transport) {
    case 'ws':
      return createWsConnection(config, token, options);
    case 'wss':
      return createWssConnection(config, token, options);
    default:
      throw new UnsupportedTransportError(String(config.transport));
  }
}
