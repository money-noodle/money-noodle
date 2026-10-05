// The correlation this site sends with every read, in one place.
//
// Two headers: a request identifier the API echoes into its response, and a
// `traceparent` taken from the active span so the API's server span is a genuine child
// of this render rather than of an identifier nothing recorded. The fallback matters
// for a runtime with no registered tracer — a unit test, a build-time render — where a
// well-formed synthetic context is still better than an absent one.

import { randomBytes, randomUUID } from 'node:crypto';

import { context, propagation } from '@opentelemetry/api';

export interface CorrelationContext {
  readonly requestId: string;
  readonly traceparent: string;
}

/** A well-formed context with no active span behind it. */
export function createCorrelationContext(): CorrelationContext {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return {
    requestId: randomUUID(),
    traceparent: `00-${traceId}-${parentId}-01`,
  };
}

/** W3C headers for the current active span, or undefined when there is none. */
export function injectedCorrelation(requestId: string): CorrelationContext | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier.traceparent;
  return typeof traceparent === 'string' && traceparent.length > 0
    ? { requestId, traceparent }
    : undefined;
}

/** The context to send: the caller's, the active span's, or a synthetic one. */
export function resolveCorrelation(provided?: CorrelationContext): CorrelationContext {
  const requestId = provided?.requestId ?? randomUUID();
  return provided ?? injectedCorrelation(requestId) ?? createCorrelationContext();
}
