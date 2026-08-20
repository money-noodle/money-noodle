import path from 'node:path';
import { cleanupStaleTmpFiles } from './lib/local-data-archive';

/** Persistent Node-worker startup only; `instrumentation.ts` never imports this module in the Edge runtime. */
export async function registerNodeRuntime() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  // Hosted/stateless deployments are a research dashboard only; clean up nothing that requires write authority.
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
  // Best-effort durable housekeeping: reclaim orphaned atomic-write `.tmp` files left by a crashed writer.
  // Only the persistent worker writes durable state, so this runs only here. It is fire-and-forget and
  // never touches a live rename target.
  void Promise.all([
    cleanupStaleTmpFiles(path.resolve(process.cwd(), 'data')),
    cleanupStaleTmpFiles(path.resolve(process.cwd(), '.cache')),
  ]).catch((error) => console.error('Stale temp cleanup failed:', error));
  // Archiving runs in a separate low-frequency process and is local-only. It never shares the
  // calculation, reconciliation, or execution queue and never removes source files.
  startLocalArchiveScheduler();
}
