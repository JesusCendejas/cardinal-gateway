import type { SandboxConfig } from '../config.js';
import { openSandboxWebSocket } from './open-websocket.js';
import type {
  SandboxConnection,
  SandboxConnectionOptions,
} from './sandbox-connection.js';

export async function createWsConnection(
  config: SandboxConfig,
  token: string,
  options: SandboxConnectionOptions,
): Promise<SandboxConnection> {
  return openSandboxWebSocket({
    url: `ws://${config.endpoint}:${config.port}/ws`,
    config,
    token,
    options,
  });
}
