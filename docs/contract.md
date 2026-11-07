# Gateway contract encoded by the phase-0 tests

This file records the decisions the tests enforce. It is intentionally
implementation-independent: phase 1 may structure the code differently as long
as these observable contracts hold.

## Access token

- JWT HS256 signed with `ACCESS_TOKEN_SECRET` (same secret as the backend).
- Payload is exactly `['exp', 'iat', 'jti', 'sub']`, matching cardinal-backend's
  auth tests. The gateway must not expect custom identity claims.
- `sub` is the only identity value used by the gateway (the user id).
- Everything agent/sandbox-specific is resolved by the backend through
  `/internal/route`, never from the token.
- For routes that do not carry an agent id (WS with an access token,
  `GET /v1/agents`, `GET /app-server-info`), the gateway calls
  `/internal/route` **omitting the `agentId` field** and the backend resolves
  the user's primary sandbox.

## Close codes (client WebSocket)

| Code | Meaning |
| --- | --- |
| 4401 | Ticket invalid, expired or already used |
| 4402 | Upstream TLS/handshake failure |
| 4404 | `/internal/route` returned NOT_FOUND (for example `agentId: ""`) |
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
- Stale cache handling: if `/internal/credentials` returns 404 for a cached
  `sandboxId`, the gateway deletes the route entry, calls `/internal/route`
  again, and retries credentials at most once. A re-provisioned sandbox must
  not cause an infinite loop.

## Internal backend calls

All three calls carry `X-Internal-Token`.

- `POST /internal/route` body `{ userId, agentId? }`; 200 with a sandbox config
  or `{ error: NOT_FOUND | SANDBOX_NOT_READY | NODE_UNAVAILABLE }`.
  The backend is the source of truth for agent ownership.
  > `agentId` es opcional. Ausente = agente primario del usuario. Cadena
  > vacía NO es válida y el backend la trata como no encontrada.
  - With `agentId` present: resolve that agent and validate ownership.
  - With `agentId` absent: resolve the user's primary agent.
  - With `agentId: ""`: NOT_FOUND, exactly like an unknown agent. The gateway
    must not use the empty string as a sentinel; test 45 forces this path and
    expects close 4404.
- `POST /internal/credentials` body `{ sandboxId }`; 200 `{ token }`, 404
  `SANDBOX_NOT_FOUND`. Never cached, never logged.
- `POST /internal/tickets/consume` body `{ ticket }`; 200
  `{ userId, agentId, containerId }`, 401 `TICKET_INVALID | TICKET_EXPIRED`,
  409 `TICKET_ALREADY_USED`.

## HTTP data plane

- `/v1/agents` is filtered to the caller's tenant; only the primary agent is
  returned to the client (upstream may return five, client gets one).
- Agent-specific requests take the agent id from the path (and validate any
  body `agent_id` against that path). The backend decides ownership:
  `GET /v1/agents/<bob-agent>` with alice's token produces exactly one
  `/internal/route` call with `{ userId: alice, agentId: bob-agent }`, the
  backend answers `{ error: "NOT_FOUND" }`, the client gets 404, and the
  upstream is never touched.
- `DELETE /v1/agents/:id` is 405 and does not touch the upstream.
- Upstream 5xx or timeout becomes `502 { "error": "UPSTREAM_ERROR" }`.

## Transport

- `SandboxConfig` has no token and no provider.
- `transport` is the only selector: `ws` -> `ws://`, `wss` -> `wss://`.
- `wss` uses `tls.servername` as SNI and `tls.rejectUnauthorized`.
- `rejectUnauthorized: false` is allowed in test/development and rejected in
  production.
- Any other transport closes with 4503.
