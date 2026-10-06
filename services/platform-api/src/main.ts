import { createConfiguredServer } from './adapters/config/create-configured-server.js';

// Telemetry is initialized inside `createConfiguredServer`, before the server
// is constructed and well before it listens. Nothing is retrofitted onto a
// server that is already accepting requests.
const { accountClient, config, projection, server, telemetry } = await createConfiguredServer(
  process.env,
);

let closing = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // A second signal must not start a second shutdown.
    if (closing) return;
    closing = true;
    void server
      .close()
      // The projection connection closes after the server stops accepting
      // requests, so no in-flight read loses its connection underneath it, and
      // before telemetry so the shutdown's own spans still have somewhere to go.
      .finally(() => projection?.close())
      // The account store's connection closes with the projection's and for the
      // same reason: after the server stops accepting requests, so no in-flight
      // sign-in loses its connection underneath it.
      .finally(() => accountClient?.close())
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
