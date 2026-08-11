export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  // Reconciliation is a hard startup barrier: the collector may run paper shadow work afterward,
  // but no live order can pass until authoritative Kalshi state has been checked.
  const [{ reconcileLiveExecution }, { startBackgroundCollector }, { completeExecutionDrain, blockExecutionDrain }] = await Promise.all([
    import('./lib/paper-execution'), import('./lib/background-collector'), import('./lib/execution-drain-state'),
  ]);
  const reconciliation = await reconcileLiveExecution({ trigger: 'startup' });
  if (reconciliation.phase === 'ready') completeExecutionDrain('Startup reconciliation passed before the collector started; no managed transaction is in flight.');
  else blockExecutionDrain(`Startup reconciliation blocked: ${reconciliation.reason}`);
  startBackgroundCollector();
}
