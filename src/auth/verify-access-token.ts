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

export async function verifyAccessToken(
  _token: string,
  _secret: string,
): Promise<AccessTokenClaims> {
  throw new Error('not implemented');
}
