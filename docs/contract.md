# Gateway contract encoded by the phase-0 tests

This file records the decisions the tests enforce. It is intentionally
implementation-independent: phase 1 may structure the code differently as long
as these observable contracts hold.

## Access token

- JWT HS256 signed with `ACCESS_TOKEN_SECRET` (same secret as the backend).
- Claims used by the gateway:
  - `sub`: user id
  - `userId`: user id (same value)
  - `agentId`: primary agent id
  - `agentIds`: every agent id the user may touch
- The tenant scope is checked locally. An `agentId` outside `agentIds` is a
  404 (HTTP) or a rejection before any `/internal/route` call. This is what
  makes test 13 possible without asking the backend.

## Close codes (client WebSocket)

| Code | Meaning |
| --- | --- |
| 4401 | Ticket invalid, expired or already used |
| 4402 | Upstream TLS/handshake failure |
| 4409 | User already has a live connection |
| 4429 | Rate limit exceeded on a WS handshake |
| 4503 | Sandbox/route/transport/credentials/backend unavailable |

HTTP pre-upgrade failures use ordinary HTTP status codes (401 missing/invalid
access token, 403 disallowed Origin).

## Redis keys

- Route cache: `route:<userId>:<agentId>`, JSON of `SandboxConfig` only.
  It never contains `token`, `credentials` or any capability token.
- Connection reservation and rate-limit counters are also Redis-backed, but
  Redis is never the source of truth for routing: if Redis is down, the
  gateway calls the backend and fails open for rate limiting.

## Internal backend calls

All three calls carry `X-Internal-Token`.

- `POST /internal/route` body `{ userId, agentId }`; 200 with a sandbox config
  or `{ error: NOT_FOUND | SANDBOX_NOT_READY | NODE_UNAVAILABLE }`.
- `POST /internal/credentials` body `{ sandboxId }`; 200 `{ token }`, 404
  `SANDBOX_NOT_FOUND`. Never cached, never logged.
- `POST /internal/tickets/consume` body `{ ticket }`; 200
  `{ userId, agentId, containerId }`, 401 `TICKET_INVALID | TICKET_EXPIRED`,
  409 `TICKET_ALREADY_USED`.

## HTTP data plane

- `/v1/agents` is filtered to the caller's tenant; only the primary agent is
  returned to the client (upstream may return five, client gets one).
- `/v1/agents/<agentId>` and `/v1/agents/<agentId>/messages` validate both the
  path agent and any body `agent_id` against the token's `agentIds`.
- `DELETE /v1/agents/:id` is 405 and does not touch the upstream.
- Upstream 5xx or timeout becomes `502 { "error": "UPSTREAM_ERROR" }`.

## Transport

- `SandboxConfig` has no token and no provider.
- `transport` is the only selector: `ws` -> `ws://`, `wss` -> `wss://`.
- `wss` uses `tls.servername` as SNI and `tls.rejectUnauthorized`.
- `rejectUnauthorized: false` is allowed in test/development and rejected in
  production.
- Any other transport closes with 4503.
