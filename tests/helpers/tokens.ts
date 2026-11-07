import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';

/** At least 32 chars, matching the env contract. */
export const TEST_ACCESS_TOKEN_SECRET =
  'test-access-token-secret-0123456789abcdef';
export const WRONG_ACCESS_TOKEN_SECRET =
  'wrong-access-token-secret-0123456789abcdef';

const encoder = new TextEncoder();

export interface SignAccessTokenOptions {
  userId: string;
  agentId: string;
  agentIds?: string[];
  secret?: string;
  /** Seconds from now, or an absolute epoch second when negative/very large. */
  expiresInSeconds?: number;
  issuedAtSeconds?: number;
}

/**
 * Access token claimed shape (HS256, same secret as the backend):
 *   sub       = userId
 *   userId    = userId
 *   agentId   = primary agent
 *   agentIds  = every agent the user may touch
 */
export async function signAccessToken(
  options: SignAccessTokenOptions,
): Promise<string> {
  const {
    userId,
    agentId,
    agentIds = [agentId],
    secret = TEST_ACCESS_TOKEN_SECRET,
    expiresInSeconds = 300,
  } = options;
  const issuedAt =
    options.issuedAtSeconds ?? Math.floor(Date.now() / 1000);

  return new SignJWT({
    userId,
    agentId,
    agentIds,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresInSeconds)
    .sign(encoder.encode(secret));
}

export async function signExpiredAccessToken(
  options: Omit<SignAccessTokenOptions, 'expiresInSeconds'>,
): Promise<string> {
  const issuedAt =
    options.issuedAtSeconds ?? Math.floor(Date.now() / 1000) - 3600;
  return signAccessToken({
    ...options,
    issuedAtSeconds: issuedAt,
    expiresInSeconds: -60,
  });
}

export async function signWithWrongSecret(
  options: Omit<SignAccessTokenOptions, 'secret'>,
): Promise<string> {
  return signAccessToken({
    ...options,
    secret: WRONG_ACCESS_TOKEN_SECRET,
  });
}

/** Backend ticket wire format: <base64url>.<base64url>. */
export function makeTicket(): string {
  return `${randomBytes(18).toString('base64url')}.${randomBytes(18).toString('base64url')}`;
}
