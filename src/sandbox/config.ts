/**
 * The only shape the sandbox connection factory ever sees.
 *
 * It deliberately has no `token` field and no `provider` field:
 *  - no token => the config is safe to cache in Redis;
 *  - no provider => the transport is the only thing that decides how to
 *    connect. Railway, Hetzner, Fly, bare metal, etc. are all identical here.
 */
export type SandboxTransport = 'ws' | 'wss';

export interface SandboxTlsConfig {
  rejectUnauthorized: boolean;
  servername?: string;
}

export interface SandboxConfig {
  sandboxId: string;
  endpoint: string; // host only, no scheme
  port: number;
  transport: SandboxTransport; // the only transport selector
  tls?: SandboxTlsConfig;
}

export interface SandboxCredentials {
  token: string;
}

export type SandboxRouteError = 'NOT_FOUND' | 'SANDBOX_NOT_READY' | 'NODE_UNAVAILABLE';

export type SandboxRouteResult = SandboxConfig | { error: SandboxRouteError };
