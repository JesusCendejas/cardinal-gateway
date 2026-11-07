import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = buildApp(config);

  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cardinal-gateway failed to start: ${message}`);
  process.exit(1);
});
