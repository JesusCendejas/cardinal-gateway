/**
 * Claims the gateway expects in an access token.
 *
 * The access token is issued by the backend with ACCESS_TOKEN_SECRET (HS256).
 * `agentIds` is the tenant scope of the token: the gateway rejects an agentId
 * that is not in this list *before* asking the backend for a route. That is
 * what makes case 13 ("bob's agent with alice's token => 404 and zero
 * /internal/route calls") possible without trusting the path or query.
 */
export interface AccessTokenClaims {
  userId: string;
  /** Primary agent for requests that do not carry an agentId in the path. */
  agentId: string;
  /** Every agent the user is allowed to touch. */
  agentIds: string[];
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
