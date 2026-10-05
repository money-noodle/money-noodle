// The dashboard reads, through the generated client and nothing else.
//
// One shape for all five: start a client span, send the correlation headers, bound the
// wait, classify the answer, and return an outcome. No retry, no cache, and no memory
// between renders — a reload re-reads what the API has, which is the only refresh this
// site offers because the API offers no bypass either.
//
// The deadlines differ per read because the reads differ. A market read may wait on the
// API's own upstream round trip; the full simulation record is a large document from a
// provider that suspends when idle; the status card is a tiny in-memory answer. Each one
// is bounded, and a read that passes its bound is reported as unreachable rather than
// left to hold a page open.
//
// Nothing here interprets a figure. The guards decide whether the answer is this
// contract, and the presentation layer decides how to show it.

import 'server-only';

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  getHourlyThresholdMarkets,
  getMarketOverview,
  getPaperBudget,
  getPaperPerformance,
  getPaperPerformanceSummary,
  type HourlyThresholdMarkets,
  type MarketOverview,
  type PaperBudget,
  type PaperPerformance,
  type PaperPerformanceSummary,
} from '@money-noodle/platform-api-client';

import { readRuntimeConfig } from '../config/read-runtime-config';
import {
  readModelFailure,
  type ReadFailureKind,
  type ReadOutcome,
} from '../../presentation/read-outcome';
import { resolveCorrelation, type CorrelationContext } from './correlation';
import {
  isHourlyThresholdMarkets,
  isMarketOverview,
  isPaperBudget,
  isPaperPerformance,
  isPaperPerformanceSummary,
} from './validate-dashboard-responses';

/**
 * How long each read may take before it is reported as unreachable.
 *
 * Set from where the read appears rather than from how slow it could be. The home page
 * issues three of these at once and a reader is waiting on the page, so those are bounded
 * tightly; a view of its own may wait a little longer, and the full record — a large
 * document from a provider that suspends when idle — longest of all.
 *
 * The cost of a tight bound is a slow-but-working API rendering as unreachable. That is the
 * right way round: a labelled "not available" is honest, and a page that hangs is not.
 */
const HOME_TIMEOUT_MS = 2_500;
const VIEW_TIMEOUT_MS = 4_000;
const RECORD_TIMEOUT_MS = 6_000;

export interface DashboardReadOptions {
  readonly baseUrl: string;
  readonly correlation?: CorrelationContext;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface GeneratedRequest {
  readonly baseUrl: string;
  readonly cache: 'no-store';
  readonly fetch?: typeof fetch;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

interface ApiAnswer {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: Response;
}

/** The problem code the API published, when it published one. */
function problemCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as Record<string, unknown>).errorCode;
  return typeof code === 'string' ? code : undefined;
}

/**
 * What a failed read was.
 *
 * The generated client hands back a transport failure and a published refusal through the
 * same member, so they are told apart here: a refusal arrives with a problem document and
 * a response behind it, while a connection that never completed arrives as a thrown error
 * with no response at all. Calling the second one a refusal would blame the API for this
 * site's own reachability.
 */
function classifyFailure(error: unknown, response: Response | undefined): ReadFailureKind {
  const code = problemCode(error);
  if (code !== undefined) return readModelFailure(code);
  if (response === undefined || error instanceof Error) return 'transport';
  return 'api-problem';
}

async function read<T>(
  read: {
    readonly guard: (value: unknown) => value is T;
    readonly spanName: string;
    readonly timeoutMs: number;
  },
  options: DashboardReadOptions,
  call: (request: GeneratedRequest) => Promise<ApiAnswer>,
): Promise<ReadOutcome<T>> {
  const tracer = trace.getTracer('money-noodle.web');

  return tracer.startActiveSpan(read.spanName, { kind: SpanKind.CLIENT }, async (span) => {
    const correlation = resolveCorrelation(options.correlation);

    try {
      const answer = await call({
        baseUrl: options.baseUrl,
        cache: 'no-store',
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        headers: {
          traceparent: correlation.traceparent,
          'x-request-id': correlation.requestId,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? read.timeoutMs),
      });

      if (answer.error !== undefined) {
        // A refusal the API chose to publish, or a request that never arrived. The code is
        // this API's own vocabulary and is classified; nothing else from the answer travels.
        const failure = classifyFailure(answer.error, answer.response);
        span.setAttribute(
          'money_noodle.upstream.outcome',
          failure === 'transport' ? 'unreachable' : 'refused',
        );
        span.setStatus({
          code: failure === 'transport' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
        });
        return { failure, ok: false as const };
      }

      if (!read.guard(answer.data)) {
        span.setAttribute('money_noodle.upstream.outcome', 'unusable');
        span.setStatus({ code: SpanStatusCode.UNSET });
        return { failure: 'api-unusable' as const, ok: false as const };
      }

      span.setAttribute('money_noodle.upstream.outcome', 'available');
      return { ok: true as const, value: answer.data };
    } catch {
      // Neither the message nor the stack is recorded or shown. A timeout and a refused
      // connection are both "this site could not reach the API" to a reader.
      span.setAttribute('money_noodle.upstream.outcome', 'unreachable');
      span.setStatus({ code: SpanStatusCode.ERROR });
      return { failure: 'transport' as const, ok: false as const };
    } finally {
      span.end();
    }
  });
}

export async function loadMarketOverview(
  options: DashboardReadOptions,
): Promise<ReadOutcome<MarketOverview>> {
  return read(
    { guard: isMarketOverview, spanName: 'market-overview.load', timeoutMs: HOME_TIMEOUT_MS },
    options,
    async (request) => getMarketOverview(request),
  );
}

export async function loadHourlyThresholds(
  options: DashboardReadOptions,
): Promise<ReadOutcome<HourlyThresholdMarkets>> {
  return read(
    {
      guard: isHourlyThresholdMarkets,
      spanName: 'hourly-thresholds.load',
      timeoutMs: VIEW_TIMEOUT_MS,
    },
    options,
    async (request) => getHourlyThresholdMarkets(request),
  );
}

export async function loadPaperBudget(
  options: DashboardReadOptions,
): Promise<ReadOutcome<PaperBudget>> {
  return read(
    { guard: isPaperBudget, spanName: 'paper-budget.load', timeoutMs: HOME_TIMEOUT_MS },
    options,
    async (request) => getPaperBudget(request),
  );
}

export async function loadPaperPerformanceSummary(
  options: DashboardReadOptions,
): Promise<ReadOutcome<PaperPerformanceSummary>> {
  return read(
    {
      guard: isPaperPerformanceSummary,
      spanName: 'paper-performance-summary.load',
      timeoutMs: HOME_TIMEOUT_MS,
    },
    options,
    async (request) => getPaperPerformanceSummary(request),
  );
}

export async function loadPaperPerformance(
  options: DashboardReadOptions,
): Promise<ReadOutcome<PaperPerformance>> {
  return read(
    {
      guard: isPaperPerformance,
      spanName: 'paper-performance.load',
      timeoutMs: RECORD_TIMEOUT_MS,
    },
    options,
    async (request) => getPaperPerformance(request),
  );
}

/**
 * The configured API origin, or nothing when this revision cannot state one.
 *
 * A revision with invalid configuration never reports ready, so it should not be serving
 * at all; if it is, every read answers as unreachable rather than throwing a page away.
 */
export function platformApiOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  try {
    return readRuntimeConfig(env).platformApiOrigin;
  } catch {
    return undefined;
  }
}

const unreachable = <T>(): ReadOutcome<T> => ({ failure: 'transport', ok: false });

export interface PageReadOptions {
  readonly correlation?: CorrelationContext;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

function requestOptions(baseUrl: string, options: PageReadOptions): DashboardReadOptions {
  return {
    baseUrl,
    ...(options.correlation === undefined ? {} : { correlation: options.correlation }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
}

export interface HomeReads {
  readonly budget: ReadOutcome<PaperBudget>;
  readonly market: ReadOutcome<MarketOverview>;
  readonly summary: ReadOutcome<PaperPerformanceSummary>;
}

/**
 * The home page's three reads, concurrently.
 *
 * Concurrently because they are independent and a reader waits for the slowest rather than
 * the sum. One read failing leaves the others alone: the page shows what it has.
 */
export async function loadHomeReads(options: PageReadOptions = {}): Promise<HomeReads> {
  const baseUrl = platformApiOrigin(options.env);
  if (baseUrl === undefined) {
    return { budget: unreachable(), market: unreachable(), summary: unreachable() };
  }
  const request = requestOptions(baseUrl, options);
  const [market, budget, summary] = await Promise.all([
    loadMarketOverview(request),
    loadPaperBudget(request),
    loadPaperPerformanceSummary(request),
  ]);
  return { budget, market, summary };
}

export async function loadBudgetPageRead(
  options: PageReadOptions = {},
): Promise<ReadOutcome<PaperBudget>> {
  const baseUrl = platformApiOrigin(options.env);
  return baseUrl === undefined ? unreachable() : loadPaperBudget(requestOptions(baseUrl, options));
}

export interface PerformanceReads {
  readonly record: ReadOutcome<PaperPerformance>;
  readonly summary: ReadOutcome<PaperPerformanceSummary>;
}

export async function loadPerformancePageReads(
  options: PageReadOptions = {},
): Promise<PerformanceReads> {
  const baseUrl = platformApiOrigin(options.env);
  if (baseUrl === undefined) return { record: unreachable(), summary: unreachable() };
  const request = requestOptions(baseUrl, options);
  const [summary, record] = await Promise.all([
    loadPaperPerformanceSummary(request),
    loadPaperPerformance(request),
  ]);
  return { record, summary };
}

export async function loadHourlyPageRead(
  options: PageReadOptions = {},
): Promise<ReadOutcome<HourlyThresholdMarkets>> {
  const baseUrl = platformApiOrigin(options.env);
  return baseUrl === undefined
    ? unreachable()
    : loadHourlyThresholds(requestOptions(baseUrl, options));
}
