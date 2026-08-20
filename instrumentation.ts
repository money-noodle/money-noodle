export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerNodeRuntime } = await import('./instrumentation.node');
  await registerNodeRuntime();
}
