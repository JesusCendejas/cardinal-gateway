import { jwtVerify } from 'jose';

/**
 * Claims the gateway extracts from an access token.
 *
 * The backend issues tokens with exactly `exp`, `iat`, `jti` and `sub`;
 * there are no agent or user custom claims. `sub` is the user id. Everything
 * agent/sandbox-specific is resolved by the backend via /internal/route.
 */
export interface AccessTokenClaims {
  /** User id, taken from the standard JWT `sub` claim. */
  userId: string;
  /** Standard JWT id, present in every backend access token. */
  jti: string;
}

export class AccessTokenError extends Error {
  constructor(message = 'ACCESS_TOKEN_INVALID') {
    super(message);
    this.name = 'AccessTokenError';
  }
}

const encoder = new TextEncoder();

/**
 * Verify an HS256 access token. `exp` is enforced by jose; a wrong signature,
 * a different algorithm and a missing/empty `sub` are rejected.
 *
 * Only `sub` (and the standard `jti`) are read. No custom identity claim is
 * trusted, so an agent id can never come from the token.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new AccessTokenError('ACCESS_TOKEN_MISSING');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new AccessTokenError('ACCESS_TOKEN_SECRET_MISSING');
  }

  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      algorithms: ['HS256'],
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AccessTokenError('ACCESS_TOKEN_SUBJECT_MISSING');
    }

    return {
      userId: payload.sub,
      jti: typeof payload.jti === 'string' ? payload.jti : '',
    };
  } catch (error) {
    if (error instanceof AccessTokenError) throw error;
    throw new AccessTokenError('ACCESS_TOKEN_INVALID');
  }
}
