import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentTelemetry, registerTelemetry, resetTelemetryForTests } from './register-telemetry';

vi.mock('server-only', () => ({}));

const PRODUCTION_ENV = {
  ARTIFACT_VERSION: 'release-1.2.3',
  MONEY_NOODLE_COMMIT: 'c'.repeat(40),
  MONEY_NOODLE_ENVIRONMENT: 'production',
  MONEY_NOODLE_SERVICE: 'web',
  NODE_ENV: 'production',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  OTEL_RESOURCE_ATTRIBUTES: [
    'service.name=web',
    'service.version=release-1.2.3',
    'deployment.environment.name=production',
    `money_noodle.image_digest=sha256:${'a'.repeat(64)}`,
    `money_noodle.source_commit=${'c'.repeat(40)}`,
  ].join(','),
  OTEL_SERVICE_NAME: 'web',
  OTEL_TRACES_SAMPLER_ARG: '1',
};

afterEach(async () => {
  await resetTelemetryForTests();
});

describe('registerTelemetry', () => {
  it('registers once and returns the same instance for repeated calls', async () => {
    const spans = new InMemorySpanExporter();
    const first = await registerTelemetry(PRODUCTION_ENV, {
      allowLoopbackEndpointForTests: true,
      exporters: { traces: spans },
      tokenSource: {
        async fetchToken() {
          return { expiresAtMillis: Date.now() + 3_600_000, value: 'unused-on-loopback' };
        },
      },
    });

    expect(first.enabled).toBe(true);
    expect(await registerTelemetry(PRODUCTION_ENV)).toBe(first);
    expect(currentTelemetry()).toBe(first);
  });

  it('coalesces concurrent registrations into one composition', async () => {
    const [a, b, c] = await Promise.all([
      registerTelemetry(PRODUCTION_ENV, { allowLoopbackEndpointForTests: true }),
      registerTelemetry(PRODUCTION_ENV, { allowLoopbackEndpointForTests: true }),
      registerTelemetry(PRODUCTION_ENV, { allowLoopbackEndpointForTests: true }),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('carries the evaluated identity into the resource', async () => {
    const telemetry = await registerTelemetry(PRODUCTION_ENV, {
      allowLoopbackEndpointForTests: true,
    });
    expect(telemetry.resourceAttributes).toMatchObject({
      'deployment.environment.name': 'production',
      'money_noodle.image_digest': `sha256:${'a'.repeat(64)}`,
      'money_noodle.source_commit': 'c'.repeat(40),
      'service.name': 'web',
      'service.version': 'release-1.2.3',
    });
  });

  it('starts with export disabled when no endpoint is configured', async () => {
    const withoutEndpoint = { ...PRODUCTION_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: undefined };
    const telemetry = await registerTelemetry(withoutEndpoint);
    // No credential is required to start, which is what makes a build and a
    // cold start free of any authentication dependency.
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.degradation.degraded).toBe(false);
  });
});

describe('the Next.js instrumentation hook', () => {
  it('registers only on the Node runtime', async () => {
    const { register } = await import('../../instrumentation');

    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    // Nothing is registered on the Edge runtime: the Node SDK and the
    // workload-identity adapter must not be reachable there.
    expect(currentTelemetry()).toBeUndefined();

    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    for (const [name, value] of Object.entries(PRODUCTION_ENV)) vi.stubEnv(name, value);
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', undefined);
    await register();
    expect(currentTelemetry()).toBeDefined();
    vi.unstubAllEnvs();
  });
});
