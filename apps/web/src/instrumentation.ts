/**
 * Next.js instrumentation hook.
 *
 * Registers the adapter-owned telemetry composition once per Node runtime. The
 * runtime guard matters: this file must never be evaluated on the Edge runtime
 * or in a browser bundle, where the Node SDK and the workload-identity adapter
 * do not belong and must not be reachable.
 *
 * The import is dynamic so that nothing in `src/adapters/telemetry` is loaded —
 * and no network is touched — during a build or a type generation pass.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerTelemetry } = await import('./adapters/telemetry/register-telemetry');
  await registerTelemetry(process.env);
}
