import pino from 'pino';

import type { GatewayConfig } from '../config/env.js';

export type AppLogger = pino.Logger;
export type LogDestination = pino.DestinationStream;

/**
 * Allowlist of context fields that may ever reach a log sink.
 *
 * This is deliberately a field-by-field allowlist, not a recursive denylist.
 * A future `wsSecret` (or any other unknown field) added to `SandboxConfig`
 * is dropped by default; it can only be logged after someone explicitly adds
 * its name here. The error itself is reduced to `name`/`message`/`code`.
 */
const ALLOWED_LOG_FIELDS = new Set([
  'action',
  'code',
  'reason',
  'status',
  'userId',
  'sandboxId',
  'connectionId',
  'transport',
  'error',
]);

function serializeError(error: Error): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    safe.code = code;
  }
  return safe;
}

/**
 * Build a pino-safe context object field by field (allowlist).
 *
 * Call sites pass an explicit object such as
 * `{ userId, sandboxId, error }`; this function copies only the allowed
 * primitive fields and the safe subset of an `Error`. Everything else
 * (objects, arrays, unknown or future config fields) is intentionally dropped.
 */
export function toLoggable(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of ALLOWED_LOG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const entry = source[key];

    if (key === 'error') {
      if (entry instanceof Error) {
        result.error = serializeError(entry);
      }
      continue;
    }

    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      result[key] = entry;
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
