/**
 * Every numeric bound the telemetry adapter enforces, in one place.
 *
 * These are chosen against the three anchors the platform actually fixes — the
 * web's 1,500 ms upstream timeout, Cloud Run's documented 10 s SIGTERM window,
 * and request-based CPU allocation — not against an invented production SLA.
 * Each one is justified where it is declared, because a limit whose reason is
 * not written down is a limit nobody can safely change.
 */
export const TELEMETRY_LIMITS = {
  /**
   * Spans buffered before the queue drops. 512 spans at the first slice's
   * one-span-per-request shape is roughly a minute of sustained traffic; past
   * that, dropping is the correct behaviour and is counted, not hidden.
   */
  maxQueueSize: 512,

  /** One batch stays well inside a single OTLP request under the size bound. */
  maxExportBatchSize: 128,

  /** Bytes a single export may serialize to before it is refused outright. */
  maxExportPayloadBytes: 512 * 1024,

  /**
   * How long a full batch may wait before export. Short enough that a request
   * that ends the process soon after still has its span sent, long enough to
   * coalesce a burst.
   */
  scheduledDelayMillis: 500,

  /**
   * One export attempt is bounded well under the web's 1,500 ms upstream
   * timeout, so a stuck collector can never be the reason a request is slow.
   */
  exportTimeoutMillis: 1_000,

  /** Token acquisition is bounded inside the export budget, not additive to it. */
  tokenTimeoutMillis: 750,

  /**
   * Refresh this far ahead of expiry. A token that expires mid-export is an
   * avoidable export failure.
   */
  tokenRefreshSkewMillis: 60_000,

  /** Attribute count and length caps, applied by the SDK at set time. */
  maxAttributeCount: 32,
  maxAttributeValueLength: 256,

  /** In-flight exports. Two keeps a slow export from serialising the next one. */
  maxConcurrentExports: 2,

  /**
   * One retry, then drop. Repeated retries under request-based CPU accumulate
   * background work that the platform is not paying to run.
   */
  maxExportRetries: 1,

  /**
   * Shutdown budget, comfortably inside Cloud Run's documented ten-second
   * SIGTERM window with room for the HTTP server's own close.
   */
  shutdownTimeoutMillis: 2_000,

  /**
   * Request-aware flush. Deliberately small: this runs while CPU is allocated
   * and must not become part of the user-visible latency budget.
   */
  flushTimeoutMillis: 250,

  /** Metric collection interval. */
  metricExportIntervalMillis: 15_000,
  metricExportTimeoutMillis: 1_000,

  /**
   * Distinct label combinations a single instrument may carry. Request and
   * trace identifiers are correlation fields and are never metric labels, so
   * this stays small by construction.
   */
  maxMetricAttributeSets: 64,

  /** Head sampling ratio for the first slice. Configurable; unity today. */
  defaultSamplingRatio: 1,

  /** Degradation reports per window, so a failing exporter cannot flood a log. */
  degradationWindowMillis: 60_000,
  maxDegradationReportsPerWindow: 3,
} as const;

export type TelemetryLimits = typeof TELEMETRY_LIMITS;
