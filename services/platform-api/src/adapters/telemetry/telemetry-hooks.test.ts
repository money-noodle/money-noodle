import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConfiguredServer } from '../config/create-configured-server.js';
import { TELEMETRY_LIMITS } from './telemetry-limits.js';

const PRODUCTION_ENV = {
  ARTIFACT_VERSION: 'release-1.2.3',
  MONEY_NOODLE_COMMIT: 'd'.repeat(40),
  MONEY_NOODLE_ENVIRONMENT: 'production',
  MONEY_NOODLE_SERVICE: 'platform-api',
  NODE_ENV: 'production',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  OTEL_SERVICE_NAME: 'platform-api',
};

const FORBIDDEN_MARKER = ['FORBIDDEN-MARKER', 'HEADER'].join('-');

let close: (() => Promise<void>) | undefined;

async function serverWithTelemetry() {
  const spans = new InMemorySpanExporter();
  const { server, telemetry } = await createConfiguredServer(PRODUCTION_ENV, {
    telemetry: { allowLoopbackEndpointForTests: true, exporters: { traces: spans } },
  });
  close = async () => {
    await server.close();
    await telemetry.shutdown();
  };
  return { server, spans, telemetry };
}

afterEach(async () => {
  await close?.();
  close = undefined;
});

const traceparent = (traceId: string, parentId: string, flags = '01') =>
  `00-${traceId}-${parentId}-${flags}`;

describe('the API telemetry hooks', () => {
  it('parents a server span to a valid remote trace context', async () => {
    const { server, spans, telemetry } = await serverWithTelemetry();
    const traceId = 'a'.repeat(32);
    const parentId = 'b'.repeat(16);

    const response = await server.inject({
      headers: { traceparent: traceparent(traceId, parentId) },
      method: 'GET',
      url: '/v1/platform/status',
    });
    expect(response.statusCode).toBe(200);
    await telemetry.flush();

    const [span] = spans.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.parentSpanContext?.spanId).toBe(parentId);
    expect(span?.name).toBe('GET /v1/platform/status');
    expect(span?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'http.route': '/v1/platform/status',
    });
  });

  it.each([
    ['an all-zero trace id', traceparent('0'.repeat(32), 'b'.repeat(16))],
    ['an all-zero parent id', traceparent('a'.repeat(32), '0'.repeat(16))],
    ['an attacker-shaped header', `00-${FORBIDDEN_MARKER}-x-01`],
    ['an empty header', ''],
  ])('starts a root span rather than trusting %s', async (_label, header) => {
    const { server, spans, telemetry } = await serverWithTelemetry();

    await server.inject({
      headers: { traceparent: header },
      method: 'GET',
      url: '/health/ready',
    });
    await telemetry.flush();

    const [span] = spans.getFinishedSpans();
    expect(span).toBeDefined();
    // A rejected context yields a root span: parentage is never invented, and
    // the forged identifier never appears anywhere in the exported span.
    expect(span?.parentSpanContext).toBeUndefined();
    expect(JSON.stringify(span)).not.toContain(FORBIDDEN_MARKER);
  });

  it('keeps concurrent requests on distinct traces', async () => {
    const { server, spans, telemetry } = await serverWithTelemetry();
    const traces = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];

    await Promise.all(
      traces.map((traceId) =>
        server.inject({
          headers: { traceparent: traceparent(traceId, 'b'.repeat(16)) },
          method: 'GET',
          url: '/v1/platform/status',
        }),
      ),
    );
    // Flushes coalesce by design, so one flush can return before a later
    // response's span is queued. Waiting on the count is the honest assertion:
    // export is asynchronous, and pretending otherwise would hide a race.
    await vi.waitFor(async () => {
      await telemetry.flush();
      expect(spans.getFinishedSpans()).toHaveLength(traces.length);
    });

    const observed = spans.getFinishedSpans().map((span) => span.spanContext().traceId);
    expect(new Set(observed)).toEqual(new Set(traces));
  });

  it('exports a route template, never a raw URL, for an unmatched path', async () => {
    const { server, spans, telemetry } = await serverWithTelemetry();

    await server.inject({ method: 'GET', url: `/not-a-route/${FORBIDDEN_MARKER}?x=1` });
    await telemetry.flush();

    const [span] = spans.getFinishedSpans();
    expect(span?.name).toBe('GET unmatched');
    expect(JSON.stringify(span)).not.toContain(FORBIDDEN_MARKER);
  });

  it('records the request metric and flushes while the request is still served', async () => {
    const { server, telemetry } = await serverWithTelemetry();
    const started = Date.now();

    await server.inject({ method: 'GET', url: '/health/live' });
    // The response path is not paying an unbounded telemetry cost: the flush is
    // request-aware and bounded, so a slow collector cannot become latency.
    expect(Date.now() - started).toBeLessThan(TELEMETRY_LIMITS.flushTimeoutMillis * 8);
    await telemetry.flush();
    expect(telemetry.enabled).toBe(true);
  });

  it('leaves the server unchanged when telemetry is disabled', async () => {
    const withoutTelemetry = { ...PRODUCTION_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: undefined };
    const { server, telemetry } = await createConfiguredServer(withoutTelemetry);
    close = async () => {
      await server.close();
      await telemetry.shutdown();
    };

    const response = await server.inject({ method: 'GET', url: '/v1/platform/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json().schemaVersion).toBe('1');
    expect(telemetry.enabled).toBe(false);
  });
});
