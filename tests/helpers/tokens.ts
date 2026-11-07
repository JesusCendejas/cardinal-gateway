import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

/** At least 32 chars, matching the env contract. */
export const TEST_ACCESS_TOKEN_SECRET =
  'test-access-token-secret-0123456789abcdef';
export const WRONG_ACCESS_TOKEN_SECRET =
  'wrong-access-token-secret-0123456789abcdef';

const encoder = new TextEncoder();

export interface SignAccessTokenOptions {
  /** Value of the JWT `sub` claim. This is the only identity claim. */
  userId: string;
  secret?: string;
  /** Seconds from now; negative values create an already-expired token. */
  expiresInSeconds?: number;
  issuedAtSeconds?: number;
  jti?: string;
}

/**
 * Sign a backend-compatible access token (HS256).
 *
 * cardinal-backend's auth tests require the payload to have exactly:
 *   ['exp', 'iat', 'jti', 'sub']
 *
 * The gateway therefore must not expect agent/user custom claims. `sub` is the
 * only identity value; everything tenant-specific is resolved by the backend
 * through /internal/route.
 */
export async function signAccessToken(
  options: SignAccessTokenOptions,
): Promise<string> {
  const {
    userId,
    secret = TEST_ACCESS_TOKEN_SECRET,
    expiresInSeconds = 300,
    jti = randomUUID(),
  } = options;
  const issuedAt =
    options.issuedAtSeconds ?? Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
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
