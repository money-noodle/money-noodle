/* v8 ignore file -- @preserve -- Test-only bridge, executed by the dedicated runtime-contract Vitest config. */
/**
 * Correlated web and API telemetry from the evaluated production configuration.
 *
 * This runs inside the evaluated-runtime bridge, so the environment below is
 * what OpenTofu actually renders into the Cloud Run container — not a fixture
 * someone wrote by hand next to it. Both sides use their real production
 * composition: the web's `registerTelemetry`, the API's `createConfiguredServer`,
 * the real generated client wrapper and the real Fastify hooks.
 *
 * Two deliberate limits, stated rather than hidden:
 *
 *   * The two services register in sequence, not concurrently. A tracer
 *     provider is a process global, so two registered at once would mean one
 *     service's resource attributes silently standing in for the other's. The
 *     web renders first and its real active span produces a real `traceparent`;
 *     the API then consumes that exact header through its real hook. Parentage
 *     and trace identity are therefore proved end to end, one process at a time.
 *   * Nothing here contacts Google or a metadata server. Transports are
 *     in-memory, the endpoint is loopback, and the auth adapter refuses to
 *     attach a credential to a loopback origin.
 */
import { readFileSync } from 'node:fs';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PlatformPage from '../../../../apps/web/src/app/page';
import {
  registerTelemetry,
  resetTelemetryForTests,
} from '../../../../apps/web/src/adapters/telemetry/register-telemetry';
import { createConfiguredServer } from '../../../../services/platform-api/src/adapters/config/create-configured-server';

vi.mock('server-only', () => ({}));

interface Rendering {
  run: string;
  env: Record<string, string>;
  image: string;
  port: number;
  expected: { version: string; sourceCommit: string; digest: string; origin?: string };
}

const path = process.env.RUNTIME_CONTRACT_RENDERING;
if (!path) throw new Error('Evaluated runtime configuration is required; no fixture fallback.');
const { web, api }: { web: Rendering[]; api: Rendering[] } = JSON.parse(readFileSync(path, 'utf8'));

// An inert marker, not a credential shape: it exists to be looked for in a
// payload and must never be found there.
const FORBIDDEN_MARKER = ['FORBIDDEN-MARKER', 'CORRELATION'].join('-');

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;

function install(env: Record<string, string>) {
  for (const key of Object.keys(process.env)) {
    if (/^(NODE_ENV|ARTIFACT_VERSION|PLATFORM_API_ORIGIN|MONEY_NOODLE_|OTEL_|K_)/u.test(key)) {
      vi.stubEnv(key, undefined);
    }
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

const status = {
  asOf: '2026-08-29T12:34:56.000Z',
  requestId: 'synthetic-request',
  schemaVersion: '1',
  service: { name: 'platform-api', version: 'release-1.2.3+api' },
  state: 'available',
};

afterEach(async () => {
  await resetTelemetryForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const [webRendering] = web;
const [apiRendering] = api;

describe('evaluated telemetry correlation', () => {
  it('produces one trace across the web client span and the API server span', async () => {
    expect(webRendering).toBeDefined();
    expect(apiRendering).toBeDefined();

    // --- Web: real registration, real page render, real client wrapper. ---
    install(webRendering!.env);
    const webSpans = new InMemorySpanExporter();
    const webTelemetry = await registerTelemetry(process.env, {
      allowLoopbackEndpointForTests: true,
      endpoint: 'http://127.0.0.1:4318',
      exporters: { traces: webSpans },
    });
    expect(webTelemetry.enabled).toBe(true);

    let outgoing: Request | undefined;
    const fetchStub = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      outgoing = input as Request;
      return Promise.resolve(Response.json(status));
    });
    vi.stubGlobal('fetch', fetchStub);

    const html = renderToStaticMarkup(await PlatformPage());
    expect(html).toContain('Available');
    await vi.waitFor(async () => {
      await webTelemetry.flush();
      expect(webSpans.getFinishedSpans().length).toBeGreaterThan(0);
    });

    // The header the API will receive is the injected context of a real active
    // span, not a fabricated identifier.
    const header = outgoing?.headers.get('traceparent') ?? '';
    const match = TRACEPARENT.exec(header);
    expect(match).not.toBeNull();
    const [, traceId, parentId] = match!;

    const clientSpan = webSpans
      .getFinishedSpans()
      .find((span) => span.name === 'platform-status.load');
    expect(clientSpan).toBeDefined();
    expect(clientSpan?.spanContext().traceId).toBe(traceId);
    expect(clientSpan?.spanContext().spanId).toBe(parentId);
    expect(clientSpan?.attributes['money_noodle.upstream.outcome']).toBe('available');

    // Web attribution keeps the upstream contract distinctions.
    expect(webTelemetry.resourceAttributes).toMatchObject({
      'money_noodle.source_commit': webRendering!.expected.sourceCommit,
      'service.name': 'web',
      'service.version': webRendering!.expected.version,
    });
    expect(webTelemetry.resourceAttributes['money_noodle.image_digest']).toBe(
      webRendering!.expected.digest,
    );
    // A source SHA is neither a configuration revision nor an image digest.
    expect(webTelemetry.resourceAttributes['money_noodle.source_commit']).not.toBe(
      webTelemetry.resourceAttributes['money_noodle.image_digest'],
    );

    await resetTelemetryForTests();

    // --- API: real composition, consuming that exact header. ---
    install(apiRendering!.env);
    const apiSpans = new InMemorySpanExporter();
    const { server, telemetry: apiTelemetry } = await createConfiguredServer(process.env, {
      telemetry: {
        allowLoopbackEndpointForTests: true,
        endpoint: 'http://127.0.0.1:4318',
        exporters: { traces: apiSpans },
      },
    });

    try {
      const response = await server.inject({
        headers: { traceparent: header, 'x-request-id': 'synthetic-request' },
        method: 'GET',
        url: '/v1/platform/status',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().schemaVersion).toBe('1');
      await vi.waitFor(async () => {
        await apiTelemetry.flush();
        expect(apiSpans.getFinishedSpans().length).toBeGreaterThan(0);
      });

      const [serverSpan] = apiSpans.getFinishedSpans();
      // One trace, correct parentage: the API's server span is a child of the
      // web's client span, both produced by production composition.
      expect(serverSpan?.spanContext().traceId).toBe(traceId);
      expect(serverSpan?.parentSpanContext?.spanId).toBe(parentId);
      expect(serverSpan?.name).toBe('GET /v1/platform/status');

      expect(apiTelemetry.resourceAttributes).toMatchObject({
        'money_noodle.source_commit': apiRendering!.expected.sourceCommit,
        'service.name': 'platform-api',
        'service.version': apiRendering!.expected.version,
      });
      expect(apiTelemetry.resourceAttributes['money_noodle.image_digest']).toBe(
        apiRendering!.expected.digest,
      );

      // Neither side's exported spans carry anything unallowlisted.
      const serialized = JSON.stringify([webSpans.getFinishedSpans(), apiSpans.getFinishedSpans()]);
      for (const forbidden of [FORBIDDEN_MARKER, 'OTEL_', 'MONEY_NOODLE_', '?']) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await server.close();
      await apiTelemetry.shutdown();
    }
  });

  it('leaves the rendered page unchanged when export fails', async () => {
    install(webRendering!.env);
    const failing = new InMemorySpanExporter();
    vi.spyOn(failing, 'export').mockImplementation(() => {
      throw new Error('collector-unreachable');
    });
    const telemetry = await registerTelemetry(process.env, {
      allowLoopbackEndpointForTests: true,
      endpoint: 'http://127.0.0.1:4318',
      exporters: { traces: failing },
    });

    const fetchStub = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(status));
    vi.stubGlobal('fetch', fetchStub);

    // Telemetry loss is degraded observability. It does not change what the
    // page says, and it is not by itself rollback authority.
    const html = renderToStaticMarkup(await PlatformPage());
    expect(html).toContain('Available');
    expect(html).toContain(status.asOf);
    await telemetry.flush();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
