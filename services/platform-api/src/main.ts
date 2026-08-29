import { readPort } from './adapters/config/read-port.js';
import { createHttpServer } from './adapters/http/create-http-server.js';

const server = createHttpServer();
const port = readPort(process.env.PORT);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

await server.listen({ host: '0.0.0.0', port });
