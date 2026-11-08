import type { FastifyInstance } from 'fastify';

/**
 * Liveness and readiness endpoints.
 *
 * `healthz` is process liveness only. `readyz` reports the gateway ready once
 * Fastify is accepting requests; Redis is a cache/fail-open dependency, so a
 * Redis outage must not make the gateway unready.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/readyz', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });
}
