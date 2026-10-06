// The signed-in reads, through the generated client and nothing else.
//
// Same shape as the public reads next door: start a client span, send the
// correlation headers, bound the wait, classify the answer, return an outcome.
// The one addition is the session header, which carries the opaque identifier the
// browser gave this server and nothing else — no account, no claim, no token.
//
// The control write lives here too, and it is still a read-shaped thing from this
// site's point of view: it posts, and the answer it gets back says a row was
// recorded. Nothing on this site can make anything happen, because the API cannot
// either (ADR-0013 §3).

import 'server-only';

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  getBudgetDetail,
  getBudgetIntentHistory,
  getJobHealth,
  getSession,
  recordBudgetControl,
  type BudgetDetail,
  type ControlAccepted,
  type IntentHistory,
  type JobHealthReport,
  type SessionSummary,
} from '@money-noodle/platform-api-client';

import { readRuntimeConfig } from '../config/read-runtime-config';
import type { ReadOutcome } from '../../presentation/read-outcome';
import { resolveCorrelation, type CorrelationContext } from './correlation';
import { sessionHeader } from './session';

const CONTROL_TIMEOUT_MS = 4_000;

export interface ControlReadOptions {
  readonly correlation?: CorrelationContext;
  readonly fetch?: typeof fetch;
  readonly sessionId: string | undefined;
}

/**
 * A signed-in outcome.
 *
 * `unauthenticated` is kept apart from every other failure, because it is the one
 * a reader can do something about: the page offers sign-in rather than an
 * apology.
 */
export type ControlOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: 'unauthenticated' | 'unavailable' };

interface ApiAnswer {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: Response;
}

async function call<T>(
  spanName: string,
  options: ControlReadOptions,
  invoke: (request: {
    baseUrl: string;
    cache: 'no-store';
    fetch?: typeof fetch;
    headers: Record<string, string>;
    signal: AbortSignal;
  }) => Promise<ApiAnswer>,
): Promise<ControlOutcome<T>> {
  let baseUrl: string;
  try {
    baseUrl = readRuntimeConfig(process.env).platformApiOrigin;
  } catch {
    return { failure: 'unavailable', ok: false };
  }

  const tracer = trace.getTracer('money-noodle.web');
  return tracer.startActiveSpan(spanName, { kind: SpanKind.CLIENT }, async (span) => {
    const correlation = resolveCorrelation(options.correlation);
    try {
      const answer = await invoke({
        baseUrl,
        cache: 'no-store',
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        headers: {
          traceparent: correlation.traceparent,
          'x-request-id': correlation.requestId,
          ...sessionHeader(options.sessionId),
        },
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      });

      if (answer.error !== undefined) {
        const unauthenticated = answer.response?.status === 401;
        span.setAttribute(
          'money_noodle.upstream.outcome',
          unauthenticated ? 'unauthenticated' : 'refused',
        );
        return {
          failure: (unauthenticated ? 'unauthenticated' : 'unavailable') as
            'unauthenticated' | 'unavailable',
          ok: false as const,
        };
      }

      span.setAttribute('money_noodle.upstream.outcome', 'available');
      return { ok: true as const, value: answer.data as T };
    } catch {
      // Neither the message nor the stack is recorded or shown.
      span.setAttribute('money_noodle.upstream.outcome', 'unreachable');
      span.setStatus({ code: SpanStatusCode.ERROR });
      return { failure: 'unavailable' as const, ok: false as const };
    } finally {
      span.end();
    }
  });
}

export async function loadSession(
  options: ControlReadOptions,
): Promise<ControlOutcome<SessionSummary>> {
  if (options.sessionId === undefined) return { failure: 'unauthenticated', ok: false };
  return call<SessionSummary>('session.load', options, async (request) => getSession(request));
}

export async function loadBudgetDetail(
  kind: 'paper' | 'live',
  options: ControlReadOptions,
): Promise<ControlOutcome<BudgetDetail>> {
  if (options.sessionId === undefined) return { failure: 'unauthenticated', ok: false };
  return call<BudgetDetail>('budget-detail.load', options, async (request) =>
    getBudgetDetail({ ...request, path: { kind } }),
  );
}

export async function loadIntentHistory(
  kind: 'paper' | 'live',
  options: ControlReadOptions,
): Promise<ControlOutcome<IntentHistory>> {
  if (options.sessionId === undefined) return { failure: 'unauthenticated', ok: false };
  return call<IntentHistory>('intent-history.load', options, async (request) =>
    getBudgetIntentHistory({ ...request, path: { kind } }),
  );
}

export async function loadJobHealth(
  options: ControlReadOptions,
): Promise<ControlOutcome<JobHealthReport>> {
  if (options.sessionId === undefined) return { failure: 'unauthenticated', ok: false };
  return call<JobHealthReport>('job-health.load', options, async (request) =>
    getJobHealth(request),
  );
}

/**
 * Record a control as intent.
 *
 * The name says what happens: this submits a request to record, and a success
 * means a row exists. Calling it `pauseBudget` would be this site claiming an
 * effect it cannot cause.
 */
export async function submitControl(
  kind: 'paper' | 'live',
  action: 'configure' | 'pause' | 'resume' | 'reset' | 'provider-enable',
  options: ControlReadOptions,
): Promise<ControlOutcome<ControlAccepted>> {
  if (options.sessionId === undefined) return { failure: 'unauthenticated', ok: false };
  return call<ControlAccepted>('budget-control.record', options, async (request) =>
    recordBudgetControl({ ...request, body: { action }, path: { kind } }),
  );
}

export type { ReadOutcome };
