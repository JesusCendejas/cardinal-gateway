import type { GatewayConfig } from '../config/env.js';
import type {
  SandboxConfig,
  SandboxCredentials,
  SandboxRouteError,
} from '../sandbox/config.js';

export type BackendRouteResponse = SandboxConfig | { error: SandboxRouteError };

export interface TicketClaims {
  userId: string;
  agentId: string;
  containerId: string;
}

/**
 * Internal backend boundary. Every method sends X-Internal-Token and is the
 * only way the gateway learns about users, agents, sandboxes and tickets.
 */
export interface BackendClient {
  route(userId: string, agentId: string): Promise<BackendRouteResponse>;
  credentials(sandboxId: string): Promise<SandboxCredentials>;
  consumeTicket(ticket: string): Promise<TicketClaims>;
}

export interface BackendClientConfig {
  backendUrl: string;
  internalToken: string;
  timeoutMs: number;
}

/**
 * Phase 0 stub: the three HTTP endpoints are not implemented yet.
 */
export function createBackendClient(
  _config: BackendClientConfig,
): BackendClient {
  return {
    async route(): Promise<BackendRouteResponse> {
      throw new Error('not implemented');
    },
    async credentials(): Promise<SandboxCredentials> {
      throw new Error('not implemented');
    },
    async consumeTicket(): Promise<TicketClaims> {
      throw new Error('not implemented');
    },
  };
}

export function backendClientConfigFrom(
  config: GatewayConfig,
): BackendClientConfig {
  return {
    backendUrl: config.backendUrl,
    internalToken: config.internalToken,
    timeoutMs: config.upstreamTimeoutMs,
  };
}
