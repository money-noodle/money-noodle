export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  // Vercel/serverless deployments are a stateless research dashboard only. Do not reconcile,
  // start a timer, mutate ledgers, or create an execution path outside the persistent worker.
  if (process.env.VERCEL === '1' || process.env.MONEY_NOODLE_STATELESS === 'true') return;
  // Reconciliation is a hard startup barrier: the collector may run paper shadow work afterward,
  // but no live order can pass until authoritative Kalshi state has been checked.
  const [{ reconcileLiveExecution, syncCurrentPublicPaperBudgetProjection }, { startBackgroundCollector }, { completeExecutionDrain, blockExecutionDrain }, { startLocalArchiveScheduler }] = await Promise.all([
    import('./lib/paper-execution'), import('./lib/background-collector'), import('./lib/execution-drain-state'), import('./lib/local-archive-scheduler'),
  ]);
  const reconciliation = await reconcileLiveExecution({ trigger: 'startup' });
  if (reconciliation.phase === 'ready') completeExecutionDrain('Startup reconciliation passed before the collector started; no managed transaction is in flight.');
  else blockExecutionDrain(`Startup reconciliation blocked: ${reconciliation.reason}`);
  // Projection replication is best effort and never delays the hard reconciliation barrier.
  void syncCurrentPublicPaperBudgetProjection().catch((error) => console.error('Initial Postgres paper projection sync failed:', error));
  startBackgroundCollector();
  // Archiving runs in a separate low-frequency process and is local-only. It never shares the
  // calculation, reconciliation, or execution queue and never removes source files.
  startLocalArchiveScheduler();
}
