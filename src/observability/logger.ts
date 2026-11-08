import pino from 'pino';

import type { GatewayConfig } from '../config/env.js';

export type AppLogger = pino.Logger;
export type LogDestination = pino.DestinationStream;

const SECRET_KEY_PATTERN = /token|secret|authorization|cookie|credential|ticket/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Defensive serializer for anything that is about to be handed to pino.
 *
 * The redaction rules in `createLogger` protect the well-known paths, but a
 * random object passed as a log context could still carry a capability token
 * under an unexpected key. Everything this gateway logs goes through here
 * first: secret-looking keys are replaced and errors are reduced to their
 * safe name/message pair.
 */
export function toLoggable(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth >= 5) return '[REDACTED]';

  if (Array.isArray(value)) {
    return value.map((entry) => toLoggable(entry, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = toLoggable(entry, depth + 1);
    }
  }
  return result;
}

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
        '*.*.token',
        'authorization',
        '*.authorization',
        'credentials.token',
        'headers.authorization',
        'headers["x-internal-token"]',
        'internalToken',
        '*.internalToken',
        'accessToken',
        '*.accessToken',
        'capabilityToken',
        '*.capabilityToken',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination ? pino(options, destination) : pino(options);
}
