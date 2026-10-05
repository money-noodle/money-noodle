import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { getPlatformStatus } from '@money-noodle/platform-api-client';

import type { PlatformStatusObservation } from '../../presentation/platform-status-view-model';
import {
  createCorrelationContext,
  resolveCorrelation,
  type CorrelationContext,
} from './correlation';
import { isPlatformStatus } from './validate-platform-status';

const DEFAULT_TIMEOUT_MS = 1_500;

export { createCorrelationContext };
export type { CorrelationContext };

export interface LoadPlatformStatusOptions {
  readonly baseUrl: string;
  readonly correlation?: CorrelationContext;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function loadPlatformStatus(
  options: LoadPlatformStatusOptions,
): Promise<PlatformStatusObservation | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tracer = trace.getTracer('money-noodle.web');

  // The client span is the parent the API's server span attaches to, so the
  // pair shares one trace id. It is started around the request rather than
  // after it, because a span that starts when the response arrives measures
  // nothing useful.
  return tracer.startActiveSpan('platform-status.load', { kind: SpanKind.CLIENT }, async (span) => {
    const correlation = resolveCorrelation(options.correlation);

    try {
      const result = await getPlatformStatus({
        baseUrl: options.baseUrl,
        cache: 'no-store',
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        headers: {
          traceparent: correlation.traceparent,
          'x-request-id': correlation.requestId,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (result.error !== undefined || !isPlatformStatus(result.data)) {
        // An upstream that answered unusably is an outcome, not an error
        // message to export: the classification is allowlisted, the response
        // is not.
        span.setAttribute('money_noodle.upstream.outcome', 'unusable');
        span.setStatus({ code: SpanStatusCode.UNSET });
        return undefined;
      }

      span.setAttribute('money_noodle.upstream.outcome', 'available');
      return {
        asOf: result.data.asOf,
        serviceVersion: result.data.service.version,
        state: result.data.state,
      };
    } catch {
      // Neither the exception message nor its stack is recorded. A timeout
      // and a transport failure are both "unreachable" to a reader of the
      // trace, and the web's own status rendering is unchanged by telemetry.
      span.setAttribute('money_noodle.upstream.outcome', 'unreachable');
      span.setStatus({ code: SpanStatusCode.ERROR });
      return undefined;
    } finally {
      span.end();
    }
  });
}
