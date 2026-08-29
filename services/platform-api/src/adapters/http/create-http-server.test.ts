import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GetPlatformStatus } from '../../application/get-platform-status.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import { createHttpServer } from './create-http-server.js';

const contract = createPlatformApiContract(
  readFileSync('services/platform-api/openapi/platform-api.v1.yaml', 'utf8'),
);
const service = { name: 'platform-api' as const, version: 'git-abc1234' };
const observedAt = new Date('2026-08-29T20:00:00.000Z');
const servers: ReturnType<typeof createHttpServer>[] = [];

function createServer(
  overrides: Partial<Parameters<typeof createHttpServer>[0]> = {},
): ReturnType<typeof createHttpServer> {
  const server = createHttpServer({
    contract,
    generateRequestId: () => 'request-123',
    getPlatformStatus: () => ({ asOf: observedAt, service, state: 'available' }),
    service,
    ...overrides,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('createHttpServer', () => {
  it('serves the contract-valid public platform observation with correlation', async () => {
    const response = await createServer().inject({
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'x-request-id': 'web-request-123',
      },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('web-request-123');
    expect(response.json()).toEqual({
      asOf: observedAt.toISOString(),
      requestId: 'web-request-123',
      schemaVersion: '1',
      service,
      state: 'available',
    });
  });

  it.each([
    ['/health/live', 'live'],
    ['/health/ready', 'ready'],
  ])('serves minimal %s health without topology', async (url, status) => {
    const response = await createServer().inject({ method: 'GET', url });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({ service: 'platform-api', status, version: 'git-abc1234' });
    expect(JSON.stringify(body)).not.toMatch(/host|region|project|secret|dependency/i);
  });

  it('turns an invalid application result into safe RFC 9457 details', async () => {
    const invalidQuery = (() => ({
      asOf: observedAt,
      service,
      state: 'unknown',
    })) as unknown as GetPlatformStatus;
    const response = await createServer({ getPlatformStatus: invalidQuery }).inject({
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      errorCode: 'MN-INTERNAL-ERROR',
      instance: '/v1/platform/status',
      requestId: 'request-123',
      status: 500,
      title: 'Internal Server Error',
      type: 'https://errors.noodle.money/mn-internal-error',
    });
    expect(response.body).not.toContain('unknown');
  });

  it('uses safe RFC 9457 details for unknown routes', async () => {
    const response = await createServer().inject({ method: 'GET', url: '/private/topology' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      errorCode: 'MN-ROUTE-NOT-FOUND',
      requestId: 'request-123',
      status: 404,
    });
  });

  it('replaces unsafe incoming request correlation with a bounded generated value', async () => {
    const response = await createServer().inject({
      headers: { 'x-request-id': 'unsafe request identifier' },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.headers['x-request-id']).toBe('request-123');
    expect(response.json()).toMatchObject({ requestId: 'request-123' });
  });

  it('accepts only valid non-zero W3C trace context at the adapter boundary', async () => {
    const onTraceContext = vi.fn();
    const server = createServer({ onTraceContext });

    await server.inject({
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      method: 'GET',
      url: '/v1/platform/status',
    });
    await server.inject({
      headers: { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' },
      method: 'GET',
      url: '/v1/platform/status',
    });
    await server.inject({
      headers: { traceparent: 'attacker-controlled' },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(onTraceContext).toHaveBeenCalledOnce();
    expect(onTraceContext).toHaveBeenCalledWith(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'request-123',
    );
  });
});
