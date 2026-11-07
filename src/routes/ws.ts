import type { FastifyInstance } from 'fastify';

/**
 * Phase 0 stub for the WebSocket entrypoint.
 *
 * A plain GET /ws answers 501. Upgrade requests bypass Fastify routing, so the
 * HTTP server's upgrade event is terminated explicitly with a 501 response.
 * This keeps tests in the red for the right reason (status 501) instead of
 * hanging until the client timeout.
 */
export function registerWsRoutes(app: FastifyInstance): void {
  app.get('/ws', async (_request, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' });
  });

  app.server.on('upgrade', (request, socket) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    socket.end(
      'HTTP/1.1 501 Not Implemented\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n',
    );
  });
}
