/**
 * Fastify hooks that turn a propagated trace context into a real server span.
 *
 * The existing `onTraceContext` hook and `acceptedTraceparent` validation stay
 * exactly as they are: this adds real spans on top of that validation rather
 * than replacing or weakening it. A header that the existing validation refuses
 * — all-zero identifiers, attacker-shaped values — produces a root span here,
 * never a span parented to something invented.
 *
 * Correlation conveys no authorization. The remote context supplies parentage
 * and nothing else: no baggage, no remote attributes, no sampling override
 * beyond the parent-based sampler's documented behaviour.
 */

import {
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ALLOWED_ATTRIBUTE_KEYS, redactAttributes } from './redact-attributes.js';
import type { Telemetry } from './create-telemetry.js';
import { TELEMETRY_LIMITS } from './telemetry-limits.js';

const SPANS = new WeakMap<FastifyRequest, { span: Span; startedAt: number }>();

/** Route templates this service exports. A raw URL is never used as a name. */
function routeTemplate(request: FastifyRequest): string {
  // Fastify's matched route is already a template (`/v1/platform/status`), so
  // no identifier from the request path can reach the metric or span name.
  const route = request.routeOptions?.url;
  return typeof route === 'string' && route.length > 0 ? route : 'unmatched';
}

export function registerTelemetryHooks(server: FastifyInstance, telemetry: Telemetry): void {
  if (!telemetry.enabled) return;

  const tracer = trace.getTracer('money-noodle.platform-api');

  server.addHook('onRequest', async (request: FastifyRequest) => {
    // Extract from the validated headers. An unparseable or rejected context
    // yields the active (root) context, so the span is a root rather than a
    // child of something forged.
    const remote = propagation.extract(context.active(), request.headers);
    const span = tracer.startSpan(
      `${request.method} ${routeTemplate(request)}`,
      {
        attributes: redactAttributes(
          {
            'http.request.method': request.method,
            'http.route': routeTemplate(request),
            'money_noodle.request_id': request.id,
          },
          {
            allowed: ALLOWED_ATTRIBUTE_KEYS,
            maxCount: TELEMETRY_LIMITS.maxAttributeCount,
            maxLength: TELEMETRY_LIMITS.maxAttributeValueLength,
          },
        ),
        kind: SpanKind.SERVER,
      },
      remote,
    );
    SPANS.set(request, { span, startedAt: Date.now() });
  });

  server.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const started = SPANS.get(request);
    if (started === undefined) return;
    SPANS.delete(request);

    const durationMillis = Date.now() - started.startedAt;
    started.span.setAttribute('http.response.status_code', reply.statusCode);
    started.span.setStatus({
      code: reply.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
    });
    started.span.end();

    telemetry.recordRequest({
      durationMillis,
      method: request.method,
      route: routeTemplate(request),
      statusCode: reply.statusCode,
    });

    // Request-aware export: the flush happens while CPU is still allocated for
    // this request. A background timer alone is not reliable delivery under
    // request-based billing, and this is bounded so it cannot become latency
    // the next request pays for.
    void telemetry.flush();
  });
}

/** The span started for `request`, for tests and for explicit log correlation. */
export function activeRequestSpan(request: FastifyRequest): Span | undefined {
  return SPANS.get(request)?.span;
}
