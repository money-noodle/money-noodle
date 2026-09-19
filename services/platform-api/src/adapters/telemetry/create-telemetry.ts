/**
 * Adapter-owned OpenTelemetry composition for the API.
 *
 * This is the production composition. Tests exercise this function, not a
 * parallel handwritten SDK setup: the only thing a test substitutes is the
 * transport (an in-memory exporter or a loopback OTLP sink) and the token
 * source. Everything else — resource, sampler, limits, processors, redaction,
 * propagation, flush and shutdown — is the same code that runs in Cloud Run.
 *
 * Inner layers never see any of this. `src/domain` and `src/application` import
 * no telemetry and no provider authentication; lint enforces that separately.
 */

import { type Attributes, type Histogram, type Counter, metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';

import {
  ALLOWED_ATTRIBUTE_KEYS,
  ALLOWED_EVENT_NAMES,
  boundMetricAttributes,
  redactAttributes,
  redactSpanName,
} from './redact-attributes.js';
import {
  createTelemetryDegradation,
  type DegradationEvent,
  type TelemetryDegradation,
} from './telemetry-degradation.js';
import { TELEMETRY_LIMITS } from './telemetry-limits.js';
import {
  assertApprovedTelemetryEndpoint,
  createWorkloadIdentityHeaders,
  createWorkloadIdentityTokenSource,
  type TelemetryTokenSource,
} from './workload-identity-headers.js';

/** Span names this service may export verbatim. */
const ALLOWED_SPAN_NAMES: ReadonlySet<string> = new Set([
  'GET /v1/platform/status',
  'GET /health/live',
  'GET /health/ready',
]);

export interface TelemetryIdentity {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  /** #69's full source SHA. Distinct from the image digest, deliberately. */
  readonly sourceCommit: string | undefined;
  /** The deployed image digest, when the runtime was told it. */
  readonly imageDigest: string | undefined;
  /** The Cloud Run revision actually serving. Distinct from both of the above. */
  readonly runtimeRevision: string | undefined;
}

export interface TelemetryExporters {
  readonly traces?: SpanExporter;
  readonly metrics?: PushMetricExporter;
  readonly logs?: LogRecordExporter;
}

export interface CreateTelemetryOptions {
  readonly identity: TelemetryIdentity;
  /** OTLP endpoint. Absent disables export entirely rather than guessing one. */
  readonly endpoint?: string;
  readonly quotaProject?: string;
  readonly samplingRatio?: number;
  /** Test seam: in-memory or loopback transports. Never used in production. */
  readonly exporters?: TelemetryExporters;
  /** Test seam: a synthetic token source that never reaches a metadata server. */
  readonly tokenSource?: TelemetryTokenSource;
  readonly degradationSink?: (event: DegradationEvent) => void;
  readonly allowLoopbackEndpointForTests?: boolean;
}

export interface Telemetry {
  readonly enabled: boolean;
  readonly degradation: TelemetryDegradation;
  readonly resourceAttributes: Readonly<Record<string, string>>;
  /** Records one completed server request. Labels are bounded by construction. */
  recordRequest(attributes: {
    route: string;
    method: string;
    statusCode: number;
    durationMillis: number;
  }): void;
  /** Emits one bounded operational log record on the same export path. */
  recordOperationalLog(body: string, attributes?: Attributes): void;
  /**
   * Request-aware flush. Bounded, coalesced and safe to call on every response;
   * a background timer alone is not reliable delivery under request-based CPU.
   */
  flush(): Promise<void>;
  /** Bounded shutdown, inside Cloud Run's documented SIGTERM window. */
  shutdown(): Promise<void>;
}

/**
 * Wraps an exporter so nothing leaves without passing the allowlist.
 *
 * The SDK's span limits already bound attributes at set time; this second pass
 * exists because automatic instrumentation can attach an attribute after that,
 * and because the acceptance is stated over the serialized payload.
 */
export function createRedactingSpanExporter(delegate: SpanExporter): SpanExporter {
  return {
    export(spans, resultCallback) {
      const sanitised = spans.map((span) => sanitiseSpan(span));
      delegate.export(sanitised, resultCallback);
    },
    shutdown: () => delegate.shutdown(),
    ...(delegate.forceFlush === undefined
      ? {}
      : { forceFlush: delegate.forceFlush.bind(delegate) }),
  };
}

function sanitiseSpan(span: ReadableSpan): ReadableSpan {
  const attributes = redactAttributes(span.attributes as Record<string, unknown>, {
    allowed: ALLOWED_ATTRIBUTE_KEYS,
    maxCount: TELEMETRY_LIMITS.maxAttributeCount,
    maxLength: TELEMETRY_LIMITS.maxAttributeValueLength,
  });
  // An event whose name is not allowlisted is dropped, not renamed. Renaming
  // would keep its attributes, and an exception event's attributes are exactly
  // the message and stack that must never be exported.
  const events = span.events
    .filter((event) => ALLOWED_EVENT_NAMES.has(event.name))
    .slice(0, 8)
    .map((event) => ({
      ...event,
      attributes: redactAttributes((event.attributes ?? {}) as Record<string, unknown>, {
        allowed: ALLOWED_ATTRIBUTE_KEYS,
        maxCount: 8,
        maxLength: TELEMETRY_LIMITS.maxAttributeValueLength,
      }),
    }));

  // A shallow projection: the prototype's getters (`duration`, `ended`) are
  // preserved by delegating through the original object.
  return Object.create(span, {
    attributes: { enumerable: true, value: attributes },
    events: { enumerable: true, value: events },
    name: { enumerable: true, value: redactSpanName(span.name, ALLOWED_SPAN_NAMES) },
    // Exception messages and stacks are excluded outright: the status code is
    // the signal, the provider's text is not ours to publish.
    status: { enumerable: true, value: { code: span.status.code } },
  }) as ReadableSpan;
}

function buildResource(identity: TelemetryIdentity) {
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: identity.serviceName,
    [ATTR_SERVICE_VERSION]: identity.serviceVersion,
    'deployment.environment.name': identity.environment,
  };
  // Source commit, image digest and runtime revision are three different facts
  // and are carried as three different attributes. A source SHA is not a
  // configuration revision and is not an image digest.
  if (identity.sourceCommit !== undefined) {
    attributes['money_noodle.source_commit'] = identity.sourceCommit;
  }
  if (identity.imageDigest !== undefined) {
    attributes['money_noodle.image_digest'] = identity.imageDigest;
  }
  if (identity.runtimeRevision !== undefined) {
    attributes['money_noodle.runtime_revision'] = identity.runtimeRevision;
  }
  return { attributes, resource: resourceFromAttributes(attributes) };
}

const noop: Telemetry = {
  degradation: createTelemetryDegradation(),
  enabled: false,
  async flush() {},
  recordOperationalLog() {},
  recordRequest() {},
  resourceAttributes: {},
  async shutdown() {},
};

/**
 * Builds the telemetry composition.
 *
 * Returns a disabled, inert `Telemetry` when no endpoint is configured, so an
 * unconfigured environment runs the same code path with export switched off
 * rather than a different one.
 */
export async function createTelemetry(options: CreateTelemetryOptions): Promise<Telemetry> {
  const degradation = createTelemetryDegradation(
    options.degradationSink === undefined ? {} : { sink: options.degradationSink },
  );

  if (options.endpoint === undefined || options.endpoint.length === 0) {
    return { ...noop, degradation };
  }

  let endpoint: URL;
  try {
    endpoint = assertApprovedTelemetryEndpoint(
      options.endpoint,
      options.allowLoopbackEndpointForTests === undefined
        ? {}
        : { allowLoopbackForTests: options.allowLoopbackEndpointForTests },
    );
  } catch {
    // A rejected endpoint disables export. It never falls back to a different
    // one and never becomes an application failure.
    degradation.report('auth', 'endpoint-rejected');
    return { ...noop, degradation };
  }

  const { attributes, resource } = buildResource(options.identity);
  const headersFactory = createWorkloadIdentityHeaders({
    degradation,
    endpoint,
    ...(options.quotaProject === undefined ? {} : { quotaProject: options.quotaProject }),
    tokenSource: options.tokenSource ?? createWorkloadIdentityTokenSource({}),
  });

  const [traceExporter, metricExporter, logExporter] = await Promise.all([
    options.exporters?.traces ?? createOtlpTraceExporter(endpoint, headersFactory.headers),
    options.exporters?.metrics ?? createOtlpMetricExporter(endpoint, headersFactory.headers),
    options.exporters?.logs ?? createOtlpLogExporter(endpoint, headersFactory.headers),
  ]);

  const spanProcessor = new BatchSpanProcessor(createRedactingSpanExporter(traceExporter), {
    exportTimeoutMillis: TELEMETRY_LIMITS.exportTimeoutMillis,
    maxExportBatchSize: TELEMETRY_LIMITS.maxExportBatchSize,
    maxQueueSize: TELEMETRY_LIMITS.maxQueueSize,
    scheduledDelayMillis: TELEMETRY_LIMITS.scheduledDelayMillis,
  });

  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(
        options.samplingRatio ?? TELEMETRY_LIMITS.defaultSamplingRatio,
      ),
    }),
    spanLimits: {
      attributeCountLimit: TELEMETRY_LIMITS.maxAttributeCount,
      attributeValueLengthLimit: TELEMETRY_LIMITS.maxAttributeValueLength,
    },
    spanProcessors: [spanProcessor],
  });
  // Correlation only. Baggage is deliberately not registered: a remote caller
  // must not be able to attach arbitrary attributes, and correlation conveys no
  // authorization.
  tracerProvider.register({ propagator: new W3CTraceContextPropagator() });

  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: TELEMETRY_LIMITS.metricExportIntervalMillis,
        exportTimeoutMillis: TELEMETRY_LIMITS.metricExportTimeoutMillis,
      }),
    ],
    resource,
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    processors: [
      new BatchLogRecordProcessor({
        exporter: logExporter,
        exportTimeoutMillis: TELEMETRY_LIMITS.exportTimeoutMillis,
        maxExportBatchSize: TELEMETRY_LIMITS.maxExportBatchSize,
        maxQueueSize: TELEMETRY_LIMITS.maxQueueSize,
        scheduledDelayMillis: TELEMETRY_LIMITS.scheduledDelayMillis,
      }),
    ],
    resource,
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const meter = meterProvider.getMeter(options.identity.serviceName);
  const requests: Counter = meter.createCounter('money_noodle.server.requests', {
    description: 'Completed server requests, labelled by route template and status class.',
  });
  const latency: Histogram = meter.createHistogram('money_noodle.server.duration', {
    description: 'Server request duration.',
    unit: 'ms',
  });
  const exportHealth: Counter = meter.createCounter('money_noodle.telemetry.export', {
    description: 'Telemetry export outcomes, so a silent exporter is visible as a metric.',
  });
  const logger = loggerProvider.getLogger(options.identity.serviceName);

  let flushing: Promise<void> | undefined;

  async function boundedFlush(timeoutMillis: number): Promise<void> {
    // Concurrent flushes coalesce onto one in-flight flush rather than
    // multiplying the work a request pays for.
    if (flushing !== undefined) return flushing;
    flushing = (async () => {
      try {
        await withDeadline(
          Promise.all([
            tracerProvider.forceFlush(),
            meterProvider.forceFlush(),
            loggerProvider.forceFlush(),
          ]).then(() => undefined),
          timeoutMillis,
        );
      } catch {
        degradation.report('traces', 'export-timeout');
      } finally {
        flushing = undefined;
      }
    })();
    return flushing;
  }

  return {
    degradation,
    enabled: true,
    async flush() {
      await boundedFlush(TELEMETRY_LIMITS.flushTimeoutMillis);
    },
    recordOperationalLog(body, logAttributes = {}) {
      const span = trace.getActiveSpan()?.spanContext();
      logger.emit({
        attributes: redactAttributes(logAttributes as Record<string, unknown>, {
          allowed: ALLOWED_ATTRIBUTE_KEYS,
          maxCount: TELEMETRY_LIMITS.maxAttributeCount,
          maxLength: TELEMETRY_LIMITS.maxAttributeValueLength,
        }),
        // The body is an allowlisted operational string, never request content.
        body: redactSpanName(body, new Set()),
        severityText: 'INFO',
        ...(span === undefined ? {} : { spanId: span.spanId, traceId: span.traceId }),
      });
    },
    recordRequest({ route, method, statusCode, durationMillis }) {
      const bounded = boundMetricAttributes({
        [ATTR_HTTP_ROUTE]: route,
        'http.request.method': method,
        'http.response.status_code': statusCode,
      });
      requests.add(1, bounded);
      latency.record(durationMillis, bounded);
      exportHealth.add(0, boundMetricAttributes({ 'money_noodle.export.outcome': 'observed' }));
    },
    resourceAttributes: attributes,
    async shutdown() {
      headersFactory.reset();
      try {
        await withDeadline(
          Promise.all([
            tracerProvider.shutdown(),
            meterProvider.shutdown(),
            loggerProvider.shutdown(),
          ]).then(() => undefined),
          TELEMETRY_LIMITS.shutdownTimeoutMillis,
        );
      } catch {
        // Telemetry in the queue at an abrupt termination is lost. Saying so is
        // the honest outcome; pretending shutdown succeeded is not.
        degradation.report('traces', 'shutdown-incomplete');
      }
      trace.disable();
      metrics.disable();
    },
  };
}

/**
 * Bounds a promise *and* the work behind it, as far as the SDK allows.
 *
 * The providers' own `exportTimeoutMillis` stops the underlying HTTP request;
 * this deadline stops the caller waiting on a provider that ignored it. Both
 * are needed: a promise race alone leaves the work running.
 */
async function withDeadline(work: Promise<void>, timeoutMillis: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('telemetry-deadline')), timeoutMillis);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function createOtlpTraceExporter(
  endpoint: URL,
  headers: () => Promise<Record<string, string>>,
): Promise<SpanExporter> {
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
  return new OTLPTraceExporter({
    concurrencyLimit: TELEMETRY_LIMITS.maxConcurrentExports,
    headers,
    timeoutMillis: TELEMETRY_LIMITS.exportTimeoutMillis,
    url: new URL('v1/traces', ensureTrailingSlash(endpoint)).toString(),
  });
}

async function createOtlpMetricExporter(
  endpoint: URL,
  headers: () => Promise<Record<string, string>>,
): Promise<PushMetricExporter> {
  const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-proto');
  return new OTLPMetricExporter({
    concurrencyLimit: TELEMETRY_LIMITS.maxConcurrentExports,
    headers,
    timeoutMillis: TELEMETRY_LIMITS.metricExportTimeoutMillis,
    url: new URL('v1/metrics', ensureTrailingSlash(endpoint)).toString(),
  });
}

async function createOtlpLogExporter(
  endpoint: URL,
  headers: () => Promise<Record<string, string>>,
): Promise<LogRecordExporter> {
  const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-proto');
  return new OTLPLogExporter({
    concurrencyLimit: TELEMETRY_LIMITS.maxConcurrentExports,
    headers,
    timeoutMillis: TELEMETRY_LIMITS.exportTimeoutMillis,
    url: new URL('v1/logs', ensureTrailingSlash(endpoint)).toString(),
  });
}

function ensureTrailingSlash(endpoint: URL): URL {
  const copy = new URL(endpoint.toString());
  if (!copy.pathname.endsWith('/')) copy.pathname = `${copy.pathname}/`;
  return copy;
}
