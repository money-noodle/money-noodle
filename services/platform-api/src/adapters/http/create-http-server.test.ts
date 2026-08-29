import { afterEach, describe, expect, it } from 'vitest';

import { createHttpServer } from './create-http-server.js';

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('createHttpServer', () => {
  it('starts with no product or status route in the scaffold', async () => {
    const server = createHttpServer();
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/v1/platform/status' });

    expect(response.statusCode).toBe(404);
  });
});
