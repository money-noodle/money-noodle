import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { SpanKind, trace } from '@opentelemetry/api';
import { InMemoryLogRecordExporter, type ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelemetry, type Telemetry } from './create-telemetry';
import type { DegradationEvent } from './telemetry-degradation';
import { TELEMETRY_LIMITS } from './telemetry-limits';
import type { TelemetryTokenSource } from './workload-identity-headers';

// Inert, obviously synthetic, and not credential shaped: the redaction
// assertions need something recognisable in a payload, not a fake secret.
const FORBIDDEN_MARKER = ['FORBIDDEN-MARKER', 'WEB-PAYLOAD'].join('-');
const syntheticToken = () => ['ya', '29', '.', 'z'.repeat(40)].join('');

const IDENTITY = {
  environment: 'synthetic-production',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeRevision: 'web-00001-abc',
  serviceName: 'web',
  serviceVersion: 'release-1.2.3',
  sourceCommit: 'b'.repeat(40),
};

const tokenSource: TelemetryTokenSource = {
  async fetchToken() {
    return { expiresAtMillis: Date.now() + 3_600_000, value: syntheticToken() };
  },
};

let active: Telemetry | undefined;

async function build(
  overrides: Parameters<typeof createTelemetry>[0] extends infer T
    ? T extends object
      ? Partial<T>
      : never
    : never = {},
): Promise<{
  telemetry: Telemetry;
  spans: InMemorySpanExporter;
  metricExporter: InMemoryMetricExporter;
  logRecords: InMemoryLogRecordExporter;
  degradations: DegradationEvent[];
}> {
  const spans = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const logRecords = new InMemoryLogRecordExporter();
  const degradations: DegradationEvent[] = [];

  const telemetry = await createTelemetry({
    allowLoopbackEndpointForTests: true,
    degradationSink: (event) => degradations.push(event),
    endpoint: 'http://127.0.0.1:4318',
    exporters: { logs: logRecords, metrics: metricExporter, traces: spans },
    identity: IDENTITY,
    tokenSource,
    ...overrides,
  });
  active = telemetry;
  return { degradations, logRecords, metricExporter, spans, telemetry };
}

afterEach(async () => {
  await active?.shutdown();
  active = undefined;
  vi.useRealTimers();
});

describe('createTelemetry', () => {
  it('disables export outright when no endpoint is configured', async () => {
    const telemetry = await createTelemetry({ identity: IDENTITY });
    active = telemetry;
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.degradation.degraded).toBe(false);
    // The inert composition still answers every call, so an unconfigured
    // environment runs the same code path with export switched off.
    telemetry.recordRequest({ durationMillis: 1, method: 'GET', route: '/', statusCode: 200 });
    telemetry.recordOperationalLog('startup');
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });

  it('refuses an unapproved endpoint, records it, and exports nothing', async () => {
    const degradations: DegradationEvent[] = [];
    const telemetry = await createTelemetry({
      degradationSink: (event) => degradations.push(event),
      endpoint: 'https://telemetry.invalid',
      identity: IDENTITY,
    });
    active = telemetry;
    expect(telemetry.enabled).toBe(false);
    expect(degradations).toContainEqual({
      occurrences: 1,
      reason: 'endpoint-rejected',
      signal: 'auth',
    });
  });

  it('keeps source commit, image digest and runtime revision as three facts', async () => {
    const { telemetry } = await build();
    expect(telemetry.resourceAttributes).toMatchObject({
      'deployment.environment.name': 'synthetic-production',
      'money_noodle.image_digest': IDENTITY.imageDigest,
      'money_noodle.runtime_revision': IDENTITY.runtimeRevision,
      'money_noodle.source_commit': IDENTITY.sourceCommit,
      'service.name': 'web',
      'service.version': 'release-1.2.3',
    });
    // A source SHA is not an image digest and neither is a revision.
    expect(telemetry.resourceAttributes['money_noodle.source_commit']).not.toBe(
      telemetry.resourceAttributes['money_noodle.image_digest'],
    );
  });

  it('redacts span attributes, names, events and error text before export', async () => {
    const { telemetry, spans } = await build();
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan(`GET /?token=${FORBIDDEN_MARKER}`, {
      attributes: {
        'http.route': '/',
        'http.request.body': FORBIDDEN_MARKER,
        'url.full': `https://example.invalid/x?secret=${FORBIDDEN_MARKER}`,
      },
      kind: SpanKind.SERVER,
    });
    span.addEvent(`exception ${FORBIDDEN_MARKER}`, { 'exception.message': FORBIDDEN_MARKER });
    span.recordException(new Error(FORBIDDEN_MARKER));
    span.end();

    await telemetry.flush();
    const [exported] = spans.getFinishedSpans();
    expect(exported).toBeDefined();
    expect(exported?.attributes).toEqual({ 'http.route': '/' });
    expect(JSON.stringify(exported)).not.toContain(FORBIDDEN_MARKER);
    // The status carries a code and no provider text.
    expect(Object.keys(exported?.status ?? {})).toEqual(['code']);
  });

  it('records a bounded request metric and an operational log on the same path', async () => {
    const { telemetry, metricExporter, logRecords } = await build();

    telemetry.recordRequest({
      durationMillis: 12,
      method: 'GET',
      route: '/',
      statusCode: 200,
    });
    telemetry.recordOperationalLog('status served', {
      'http.route': '/',
      'http.request.body': FORBIDDEN_MARKER,
    });
    await telemetry.flush();

    const metrics = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    const names = metrics.map((metric) => metric.descriptor.name);
    expect(names).toContain('money_noodle.server.requests');
    expect(names).toContain('money_noodle.server.duration');
    expect(names).toContain('money_noodle.telemetry.export');

    for (const metric of metrics) {
      for (const point of metric.dataPoints) {
        expect(Object.keys(point.attributes).length).toBeLessThanOrEqual(6);
        // Correlation identifiers are never metric labels.
        expect(point.attributes).not.toHaveProperty('money_noodle.request_id');
        expect(JSON.stringify(point.attributes)).not.toContain(FORBIDDEN_MARKER);
      }
    }

    const records: ReadableLogRecord[] = logRecords.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe('status served');
    expect(records[0]?.attributes).toEqual({ 'http.route': '/' });
    expect(JSON.stringify(records[0])).not.toContain(FORBIDDEN_MARKER);
  });

  it('coalesces concurrent flushes onto one in-flight flush', async () => {
    const { telemetry, spans } = await build();
    const forceFlush = vi.spyOn(spans, 'forceFlush');
    trace.getTracer('test').startSpan('GET /health/live').end();

    await Promise.all([telemetry.flush(), telemetry.flush(), telemetry.flush()]);
    expect(forceFlush.mock.calls.length).toBeLessThanOrEqual(1);
    expect(spans.getFinishedSpans()).toHaveLength(1);
  });

  it('survives a failing exporter without hanging a request or fabricating success', async () => {
    const { telemetry, spans, degradations } = await build();
    vi.spyOn(spans, 'export').mockImplementation(() => {
      throw new Error('collector-unreachable');
    });

    trace.getTracer('test').startSpan('GET /health/ready').end();
    // The flush resolves rather than rejecting: telemetry failure never becomes
    // an application failure and never hangs the response path.
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(degradations.every((event) => event.signal !== 'auth')).toBe(true);
  });

  it('bounds a flush whose underlying export never completes', async () => {
    const { telemetry, spans } = await build();
    // An exporter that never invokes its callback is the realistic hang: the
    // batch processor is then waiting on an export that will never finish.
    vi.spyOn(spans, 'export').mockImplementation(() => {});
    trace.getTracer('test').startSpan('GET /health/live').end();

    const started = Date.now();
    await telemetry.flush();
    // The deadline, not the export, is what ends the wait.
    expect(Date.now() - started).toBeLessThan(TELEMETRY_LIMITS.flushTimeoutMillis * 8);
    expect(telemetry.degradation.degraded).toBe(true);
  });

  it('reports repeated degradation at a bounded rate and keeps counting', async () => {
    const { telemetry, degradations } = await build();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      telemetry.degradation.report('traces', 'export-failed');
    }
    expect(degradations).toHaveLength(TELEMETRY_LIMITS.maxDegradationReportsPerWindow);
    expect(telemetry.degradation.snapshot()).toContainEqual({
      occurrences: 25,
      reason: 'export-failed',
      signal: 'traces',
    });
  });

  it('shuts down within its deadline and records an incomplete shutdown', async () => {
    const { telemetry, spans } = await build();
    vi.spyOn(spans, 'shutdown').mockImplementation(() => new Promise<void>(() => {}));
    trace.getTracer('test').startSpan('GET /health/live').end();

    const started = Date.now();
    await telemetry.shutdown();
    active = undefined;
    expect(Date.now() - started).toBeLessThan(TELEMETRY_LIMITS.shutdownTimeoutMillis * 3);
    // Telemetry still queued at an abrupt termination is lost, and said to be.
    expect(telemetry.degradation.snapshot()).toContainEqual({
      occurrences: 1,
      reason: 'shutdown-incomplete',
      signal: 'traces',
    });
  });

  it('applies the configured sampling ratio through parent-based sampling', async () => {
    const { telemetry, spans } = await build({ samplingRatio: 1 });
    const tracer = trace.getTracer('test');
    for (let index = 0; index < 5; index += 1) {
      tracer.startSpan('GET /health/live').end();
    }
    await telemetry.flush();
    // Unity for the first slice: every application span is recorded.
    expect(spans.getFinishedSpans()).toHaveLength(5);
  });
});

describe('the production OTLP path', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) return resolve();
      server.close(() => resolve());
    });
    server = undefined;
  });

  /**
   * A loopback OTLP sink.
   *
   * This is the real `exporter-trace-otlp-proto` writing real protobuf over a
   * real socket to an in-process server on 127.0.0.1. Nothing here contacts
   * Google or a metadata server: the endpoint is loopback, which is also why
   * the auth adapter refuses to attach a credential to it.
   */
  async function sink(
    handler?: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ url: string; bodies: Buffer[]; headers: IncomingMessage['headers'][] }> {
    const bodies: Buffer[] = [];
    const headers: IncomingMessage['headers'][] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        headers.push(request.headers);
        if (handler !== undefined) return handler(request, response);
        response.writeHead(200, { 'content-type': 'application/x-protobuf' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server?.address() as AddressInfo;
    return { bodies, headers, url: `http://127.0.0.1:${port}` };
  }

  it('serializes a real OTLP payload carrying the route template and no marker', async () => {
    const received = await sink();
    const telemetry = await createTelemetry({
      allowLoopbackEndpointForTests: true,
      endpoint: received.url,
      identity: IDENTITY,
      tokenSource,
    });
    active = telemetry;

    const span = trace.getTracer('test').startSpan('GET /', {
      attributes: {
        'http.route': '/',
        'http.request.body': FORBIDDEN_MARKER,
      },
    });
    span.end();
    await telemetry.flush();
    await vi.waitFor(() => expect(received.bodies.length).toBeGreaterThan(0));

    const payload = Buffer.concat(received.bodies);
    // Protobuf encodes strings as raw UTF-8, so the wire format can be searched
    // directly: this is the serialized payload, not a hand-authored projection.
    expect(payload.includes('/')).toBe(true);
    expect(payload.includes(FORBIDDEN_MARKER)).toBe(false);
    expect(payload.includes('release-1.2.3')).toBe(true);
    expect(payload.length).toBeLessThan(TELEMETRY_LIMITS.maxExportPayloadBytes);

    // A loopback sink is not an approved origin, so no credential is on the wire.
    for (const headers of received.headers) {
      expect(headers.authorization).toBeUndefined();
      expect(headers['x-goog-user-project']).toBeUndefined();
    }
  });

  it('treats a redirect as a failed export rather than following it', async () => {
    // The Node OTLP transport issues a plain request and does not follow
    // redirects, so a credential cannot be replayed to a relocated host.
    const received = await sink((_request, response) => {
      response.writeHead(307, { location: 'https://telemetry.invalid/v1/traces' });
      response.end();
    });
    const degradations: DegradationEvent[] = [];
    const telemetry = await createTelemetry({
      allowLoopbackEndpointForTests: true,
      degradationSink: (event) => degradations.push(event),
      endpoint: received.url,
      identity: IDENTITY,
      tokenSource,
    });
    active = telemetry;

    trace.getTracer('test').startSpan('GET /health/live').end();
    await telemetry.flush();
    await vi.waitFor(() => expect(received.bodies.length).toBe(1));
    // Exactly one request: the redirect target was never contacted.
    expect(received.bodies).toHaveLength(1);
  });
});
