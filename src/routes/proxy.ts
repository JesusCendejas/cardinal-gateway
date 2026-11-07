import type { FastifyInstance } from 'fastify';

/**
 * Phase 0 stub for the HTTP data plane:
 *   /v1/*             -> tenant-scoped proxy to the sandbox app server
 *   /app-server-info  -> forwarded app server info
 *
 * Everything answers 501. Methods that are not part of the contract (for
 * example DELETE /v1/agents/:id) must eventually answer 405 without touching
 * the upstream; that behavior is asserted by tests/proxy-isolation.test.ts.
 */
export function registerProxyRoutes(app: FastifyInstance): void {
  app.all('/v1/*', async (_request, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' });
  });

  app.all('/app-server-info', async (_request, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' });
  });
}
