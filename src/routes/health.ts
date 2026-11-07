import type { FastifyInstance } from 'fastify';

/**
 * Phase 0 stub. Health checks will answer 501 until the real readiness probe
 * (Redis + backend) exists.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async (_request, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' });
  });

  app.get('/readyz', async (_request, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' });
  });
}
