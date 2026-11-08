import type { SandboxConfig } from '../config.js';
import { InsecureTlsConfigError } from './errors.js';
import { openSandboxWebSocket } from './open-websocket.js';
import type {
  SandboxConnection,
  SandboxConnectionOptions,
} from './sandbox-connection.js';

export async function createWssConnection(
  config: SandboxConfig,
  token: string,
  options: SandboxConnectionOptions,
): Promise<SandboxConnection> {
  const rejectUnauthorized = config.tls?.rejectUnauthorized ?? true;

  if (options.nodeEnv === 'production' && rejectUnauthorized === false) {
    throw new InsecureTlsConfigError(
      'TLS_VERIFICATION_DISABLED_IN_PRODUCTION',
    );
  }

  return openSandboxWebSocket({
    url: `wss://${config.endpoint}:${config.port}/ws`,
    config,
    token,
    options,
    tls: {
      rejectUnauthorized,
      ...(config.tls?.servername !== undefined
        ? { servername: config.tls.servername }
        : {}),
    },
  });
}
