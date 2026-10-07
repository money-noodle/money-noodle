// The restore job, end to end, over ports: verify first, verify every blob, run
// both semantic verifiers, transform at the paper seam, load as `engine_writer`
// inside one transaction, reconcile, and write the dated evidence document at
// every exit. Nothing here names a provider, a path or a credential.

import type { ArchiveSource, DataTree } from '../domain/archive-source.js';
import type { EngineStore } from '../domain/engine-store.js';
import { RestoreRefusedError } from '../domain/engine-store.js';
import { renderEvidence, type EvidenceInput, type ReconciliationRow } from '../domain/evidence.js';
import { verifyForecastStorage, type ForecastVerification } from '../domain/forecast-v3.js';
import { verifyLedgerV9, type LedgerVerification } from '../domain/ledger-v9.js';
import { recomputePaperBankroll, type BankrollRecomputation } from '../domain/paper-bankroll.js';
import { buildRestorePlan, type RestorePlan } from '../domain/restore-plan.js';
import { restoreTreeFromArchive, type BlobVerification } from '../domain/restore-tree.js';
import { sha256Hex } from '../domain/sha256.js';
import { compareManifestWithWorkstation, type VerifyFirstFinding } from '../domain/verify-first.js';

export const ENGINE_RESTORE_SCHEMA_VERSION = '0002-engine-restore-tables';

export interface RestoreJobInput {
  archive: ArchiveSource;
  workstation: DataTree | undefined;
  store: EngineStore;
  evidenceTemplate: string;
  writeEvidence: (markdown: string) => Promise<void>;
  runId: string;
  now: () => Date;
  /** Documented override: proceed when the workstation copy is absent. Never a default. */
  allowWorkstationAbsent?: boolean;
  schemaVersion?: string;
}

export interface RestoreJobResult {
  outcome: 'loaded' | 'refused' | 'failed';
  reason: string;
  verifyFirst: VerifyFirstFinding;
  manifestKey: string;
  manifestDigest: string;
  evidence: string;
}

export async function runRestoreJob(input: RestoreJobInput): Promise<RestoreJobResult> {
  const collectedAt = input.now().toISOString();
  const schemaVersion = input.schemaVersion ?? ENGINE_RESTORE_SCHEMA_VERSION;
  const keys = await input.archive.listManifestKeys();
  const manifestKey = keys.at(-1);
  if (!manifestKey) throw new RestoreRefusedError('The archive source holds no manifest.');
  const { manifest, raw } = await input.archive.readManifest(manifestKey);
  const manifestDigest = sha256Hex(raw);

  // Step 1: verify first. The finding is written before anything else happens.
  const verifyFirst = compareManifestWithWorkstation(manifest, input.workstation);
  const evidence: EvidenceInput = {
    collectedAt,
    runId: input.runId,
    manifestKey,
    manifestDigest,
    schemaVersion,
    outcome: 'refused',
    outcomeReason: '',
    verifyFirst,
  };
  const finish = async (
    outcome: EvidenceInput['outcome'],
    reason: string,
  ): Promise<RestoreJobResult> => {
    evidence.outcome = outcome;
    evidence.outcomeReason = reason;
    const markdown = renderEvidence(input.evidenceTemplate, evidence);
    await input.writeEvidence(markdown);
    return { outcome, reason, verifyFirst, manifestKey, manifestDigest, evidence: markdown };
  };
  await input.writeEvidence(
    renderEvidence(input.evidenceTemplate, {
      ...evidence,
      outcomeReason: 'verify-first finding recorded; load not yet attempted',
    }),
  );

  const workstationOverride =
    verifyFirst.finding === 'workstation-absent' && input.allowWorkstationAbsent === true;
  if (!verifyFirst.loadPermitted && !workstationOverride) {
    return finish('refused', `Load refused after the verify-first step: ${verifyFirst.reason}`);
  }

  // Step 2: every sha256 in the manifest against the blobs, then both verifiers.
  const restored = await restoreTreeFromArchive(input.archive, manifest);
  evidence.blobs = restored.verifications satisfies BlobVerification[];
  if (!restored.ok) {
    const failed = restored.verifications.filter((v) => v.state !== 'verified').length;
    return finish(
      'refused',
      `${failed} blob(s) failed verification against the manifest; nothing was loaded.`,
    );
  }
  let ledger: LedgerVerification;
  try {
    ledger = verifyLedgerV9(restored.tree);
    evidence.ledger = ledger;
  } catch (error) {
    evidence.ledger = { error: (error as Error).message };
    return finish('refused', `The ledger v9 verifier failed: ${(error as Error).message}`);
  }
  const forecast: ForecastVerification = verifyForecastStorage(restored.tree);
  evidence.forecast = forecast;
  if (!forecast.ok) {
    return finish(
      'refused',
      `The forecast storage verifier failed with ${forecast.errors.length} error(s).`,
    );
  }

  // Step 3: the transform at the paper seam.
  const plan: RestorePlan = buildRestorePlan(restored.tree);
  evidence.seam = {
    paperOrders: plan.paperOrders.length,
    droppedLiveOrders: plan.droppedLiveOrders,
    mirrorPairIdsCarried: plan.mirrorPairIdsCarried,
    droppedTradingControlKeys: plan.droppedTradingControlKeys,
    notLoaded: plan.notLoaded,
  };
  evidence.forecastRowsPlanned =
    plan.rowSets.find((s) => s.table === 'engine.forecast_row')?.rows.length ?? 0;
  if (!plan.paperBudget) {
    return finish('refused', 'The restored ledger carries no paper bankroll; nothing was loaded.');
  }
  const bankroll: BankrollRecomputation = recomputePaperBankroll(
    plan.paperOrders,
    plan.paperBudget,
  );
  evidence.bankroll = bankroll;
  if (bankroll.discrepancyCents !== 0) {
    return finish(
      'refused',
      `The paper bankroll recomputed from its orders and corrections differs from the restored value; nothing was loaded.`,
    );
  }
  if (ledger.paperOrders !== plan.paperOrders.length) {
    return finish(
      'refused',
      'The paper order count after the seam differs from the verifier count; nothing was loaded.',
    );
  }

  // Idempotency rule (ADR-0013 §1): refuse a non-empty engine schema.
  const inspection = await input.store.inspect();
  const occupied = Object.entries(inspection.counts).filter(([, count]) => count > 0);
  if (occupied.length > 0 || inspection.priorRuns.length > 0) {
    const prior = inspection.priorRuns.find(
      (run) => run.manifestDigest === manifestDigest && run.schemaVersion === schemaVersion,
    );
    return finish(
      'refused',
      prior
        ? `This manifest digest was already restored into schema version ${schemaVersion} by run ${prior.runId}; a second invocation loads nothing.`
        : `The engine schema is not empty (${occupied.map(([table, count]) => `${table}: ${count}`).join(', ')}); the restore refuses to load into it. Rollback is to discard the schema contents and re-run.`,
    );
  }

  // Step 4: load inside one transaction and reconcile before it commits.
  const reconciliation: ReconciliationRow[] = plan.rowSets.map((set) => ({
    table: set.table,
    source: set.source,
    planned: set.rows.length,
    loaded: null,
    digest: set.digest,
    ok: false,
  }));
  evidence.reconciliation = reconciliation;
  try {
    await input.store.load(
      { manifestDigest, manifestKey, schemaVersion, runId: input.runId },
      plan.rowSets,
      (loaded) => {
        for (const row of reconciliation) {
          row.loaded = loaded.counts[row.table] ?? null;
          row.ok = row.loaded === row.planned;
        }
        const mismatched = reconciliation.filter((row) => !row.ok);
        if (mismatched.length > 0) {
          throw new RestoreRefusedError(
            `Row counts after load differ from the plan for ${mismatched.map((row) => row.table).join(', ')}; the transaction is rolled back.`,
          );
        }
      },
    );
  } catch (error) {
    return finish('failed', `The load did not commit: ${(error as Error).message}`);
  }
  return finish(
    'loaded',
    `Loaded ${plan.rowSets.reduce((sum, set) => sum + set.rows.length, 0)} rows across ${plan.rowSets.length} tables; every per-table count and the paper bankroll reconcile.`,
  );
}
