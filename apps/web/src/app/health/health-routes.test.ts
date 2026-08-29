import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as getLiveness } from './live/route';
import { GET as getReadiness } from './ready/route';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('web health routes', () => {
  it('reports minimal liveness with artifact attribution', async () => {
    vi.stubEnv('ARTIFACT_VERSION', 'git-abc1234');

    const response = getLiveness();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: 'web',
      status: 'live',
      version: 'git-abc1234',
    });
  });

  it('reports readiness only when production API configuration is valid', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLATFORM_API_ORIGIN', 'https://api.example.test');

    const response = getReadiness();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'web', status: 'ready' });
  });

  it('returns safe problem details when production API configuration is absent', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PLATFORM_API_ORIGIN', '');

    const response = getReadiness();
    const body: unknown = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(body).toMatchObject({
      errorCode: 'MN-WEB-NOT-READY',
      status: 503,
      title: 'Service Unavailable',
    });
    expect(JSON.stringify(body)).not.toMatch(/origin|host|secret|project/i);
  });
});
