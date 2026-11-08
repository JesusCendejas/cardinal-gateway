/** The transport field is the only way the gateway selects a connection. */
export class UnsupportedTransportError extends Error {
  constructor(transport: string) {
    super(`UNSUPPORTED_TRANSPORT:${transport}`);
    this.name = 'UnsupportedTransportError';
  }
}

/**
 * Raised before any socket is opened when production configuration would
 * disable TLS certificate verification.
 */
export class InsecureTlsConfigError extends Error {
  constructor(message = 'INSECURE_TLS_CONFIG') {
    super(message);
    this.name = 'InsecureTlsConfigError';
  }
}

/**
 * Raised when the upstream sandbox never completes the WebSocket handshake
 * (TLS failure, 401 upgrade response, timeout, connection refused). The route
 * maps this to close code 4402.
 */
export class UpstreamHandshakeError extends Error {
  constructor(message = 'UPSTREAM_HANDSHAKE_FAILED') {
    super(message);
    this.name = 'UpstreamHandshakeError';
  }
}
