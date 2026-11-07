import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';

/**
 * Normalized configuration consumed by buildApp() and by the rest of the
 * gateway. Environment parsing is the only place where raw env vars are read.
 */
export interface GatewayConfig {
  port: number;
  backendUrl: string;
  internalToken: string;
  accessTokenSecret: string;
  redisUrl: string;
  allowedOrigins: string[];
  upstreamTimeoutMs: number;
  upstreamHandshakeTimeoutMs: number;
  rateLimitPerMinute: number;
  logLevel: string;
  nodeEnv: NodeEnv;
  /**
   * Heartbeat tuning is not part of the public env contract. It lives here so
   * tests can make the watchdog deterministic without waiting 30 seconds.
   */
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  BACKEND_URL: z.string().url(),
  INTERNAL_TOKEN: z.string().min(32),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  REDIS_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().default(''),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  UPSTREAM_HANDSHAKE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse and normalize process.env. Throws ConfigError when a required value is
 * missing or malformed; src/main.ts turns that throw into exit code 1.
 */
export function parseEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }

  const parsed = result.data;
  return {
    port: parsed.PORT,
    backendUrl: parsed.BACKEND_URL.replace(/\/+$/, ''),
    internalToken: parsed.INTERNAL_TOKEN,
    accessTokenSecret: parsed.ACCESS_TOKEN_SECRET,
    redisUrl: parsed.REDIS_URL,
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS,
    upstreamHandshakeTimeoutMs: parsed.UPSTREAM_HANDSHAKE_TIMEOUT_MS,
    rateLimitPerMinute: parsed.RATE_LIMIT_PER_MINUTE,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
    heartbeatIntervalMs: 30_000,
    pongTimeoutMs: 90_000,
  };
}

export const loadConfig = parseEnv;
