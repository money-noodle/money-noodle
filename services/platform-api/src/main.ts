import { createConfiguredServer } from './adapters/config/create-configured-server.js';

const { config, server } = createConfiguredServer(process.env);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

await server.listen({ host: '0.0.0.0', port: config.port });
