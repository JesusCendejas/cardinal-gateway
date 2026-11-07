import pino from 'pino';

import type { GatewayConfig } from '../config/env.js';

export type AppLogger = pino.Logger;
export type LogDestination = pino.DestinationStream;

/**
 * Pino with explicit redaction for every secret that can cross this service:
 * incoming Authorization headers, the internal token, capability tokens,
 * credentials objects and ticket query parameters.
 *
 * `req.url` is redacted wholesale. A URL such as `/ws?ticket=...` must never
 * reach a log sink, and the path alone is not useful enough to risk it.
 */
export function createLogger(
  config: Pick<GatewayConfig, 'logLevel' | 'nodeEnv'>,
  destination?: LogDestination,
): AppLogger {
  const options: pino.LoggerOptions = {
    level: config.logLevel,
    base: {
      service: 'cardinal-gateway',
      env: config.nodeEnv,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-internal-token"]',
        'req.url',
        'ticket',
        '*.ticket',
        'token',
        '*.token',
        'credentials.token',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination ? pino(options, destination) : pino(options);
}
