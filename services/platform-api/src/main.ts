import { createConfiguredServer } from './adapters/config/create-configured-server.js';

// Telemetry is initialized inside `createConfiguredServer`, before the server
// is constructed and well before it listens. Nothing is retrofitted onto a
// server that is already accepting requests.
const { config, server, telemetry } = await createConfiguredServer(process.env);

let closing = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // A second signal must not start a second shutdown.
    if (closing) return;
    closing = true;
    void server
      .close()
      // Telemetry shuts down after the server stops accepting requests, so the
      // last responses' spans are in the queue before the bounded flush. The
      // deadline lives inside Cloud Run's documented ten-second SIGTERM window;
      // anything still queued past it is lost, which is recorded rather than
      // hidden.
      .finally(() => telemetry.shutdown())
      .finally(() => process.exit(0));
  });
}

await server.listen({ host: '0.0.0.0', port: config.port });
