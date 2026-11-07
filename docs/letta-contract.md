# Letta App Server contract verification

Verified against the installed bundle before writing test 4.

- Package: `@letta-ai/letta-code@0.34.20`
- Path on this host:
  `C:\Users\52452\AppData\Roaming\npm\node_modules\@letta-ai\letta-code`
  (the task's `/usr/local/lib/node_modules/...` path does not exist on this
  Windows host; the global npm prefix is the one above)
- Main bundle: `letta.js`
- Client bundle: `dist/app-server-client.js`

## 1. The upgrade header is exactly `Authorization: Bearer <token>`

Client side, `dist/app-server-client.js`:

- `appServerSocketOptions(authToken)` returns
  `{ headers: { Authorization: \`Bearer ${token}\` } }`.
- `AppServerClient` passes those options to
  `new WebSocket(resolveAppServerUrl(options.url), socketOptions)`.

Server side, `letta.js` (bundled from `src/websocket/app-server.ts`):

- `startAppServer(options)` registers `server2.on("upgrade", ...)`.
- That handler calls `authorizeUpgrade(request2.headers, authPolicy)`.
- `authorizeUpgrade` is in the bundled `src/websocket/app-server-auth.ts`.
  It calls `bearerTokenFromHeaders(headers)`, which reads
  `headers.authorization`, accepts the scheme case-insensitively when it is
  `bearer`, and takes the token after the first space.
- Both auth modes (`capability-token` and `signed-bearer-token`) consume that
  same bearer token.

Conclusion: the upstream header is exactly
`Authorization: Bearer <capability token>`. Test 4 asserts exactly that and
explicitly asserts that the client's JWT is not forwarded.

## 2. Auth rejection is HTTP 401 before the WebSocket upgrade

In `letta.js`, bundled `src/websocket/app-server-auth.ts`:

- `unauthorized(message)` returns `{ statusCode: 401, message }`.
- `authorizeUpgrade` returns that object for a missing/invalid bearer token.
- Back in `startAppServer`'s `upgrade` handler,
  `rejectUpgrade(socket, authError.statusCode, authError.message)` is called.
- `rejectUpgrade` writes a raw HTTP response:
  `HTTP/1.1 ${statusCode} ${message}`, `Connection: close`.

Therefore a rejected upgrade arrives at the WebSocket client as an HTTP 401
(`unexpected-response`), not as a WebSocket close frame. Tests 1-3 assert that
HTTP status and that the fake upstream receives no connection.

## 3. What the gateway must forward

- The upstream must receive `Authorization: Bearer <token from
  /internal/credentials>`.
- The client access token (JWT signed with `ACCESS_TOKEN_SECRET`) must never be
  forwarded as the upstream Authorization header.
- The upstream must not receive the client `Origin` header (test 11).
