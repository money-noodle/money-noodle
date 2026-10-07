// Renders the dated evidence document the job writes under docs/validation/
// from the committed template. Counts and hashes only; never a row's content.

import type { ForecastVerification } from './forecast-v3.js';
import type { LedgerVerification } from './ledger-v9.js';
import type { BankrollRecomputation } from './paper-bankroll.js';
import type { BlobVerification } from './restore-tree.js';
import type { VerifyFirstFinding } from './verify-first.js';

export interface ReconciliationRow {
  table: string;
  source: string;
  planned: number;
  loaded: number | null;
  digest: string;
  ok: boolean;
}

export interface EvidenceInput {
  collectedAt: string;
  runId: string;
  manifestKey: string;
  manifestDigest: string;
  schemaVersion: string;
  outcome: 'loaded' | 'refused' | 'failed';
  outcomeReason: string;
  verifyFirst: VerifyFirstFinding;
  blobs?: BlobVerification[];
  ledger?: LedgerVerification | { error: string };
  forecast?: ForecastVerification | { error: string };
  seam?: {
    paperOrders: number;
    droppedLiveOrders: number;
    mirrorPairIdsCarried: number;
    droppedTradingControlKeys: string[];
    notLoaded: string[];
  };
  bankroll?: BankrollRecomputation;
  reconciliation?: ReconciliationRow[];
  forecastRowsPlanned?: number;
}

const yes = (ok: boolean) => (ok ? 'yes' : '**no**');

export function evidenceFileName(collectedAt: string): string {
  return `${collectedAt.slice(0, 10)}-v1-archive-restore.md`;
}

export function renderEvidence(template: string, input: EvidenceInput): string {
  const fileRows = input.verifyFirst.files
    .filter((file) => file.state !== 'equal')
    .map(
      (file) =>
        `| \`${file.path}\` | ${file.state} | ${file.manifestSha256?.slice(0, 12) ?? '—'} | ${file.workstationSha256?.slice(0, 12) ?? '—'} |`,
    );
  const blobRows = (input.blobs ?? [])
    .filter((blob) => blob.state !== 'verified')
    .map(
      (blob) =>
        `| \`${blob.path}\` | ${blob.state} | ${blob.sha256.slice(0, 12)} | ${blob.actualSha256?.slice(0, 12) ?? '—'} |`,
    );
  const reconciliationRows = (input.reconciliation ?? []).map(
    (row) =>
      `| \`${row.table}\` | ${row.source} | ${row.planned} | ${row.loaded ?? '—'} | \`${row.digest.slice(0, 16)}\` | ${yes(row.ok)} |`,
  );
  const ledger = input.ledger;
  const forecast = input.forecast;
  const bankroll = input.bankroll;
  const values: Record<string, string> = {
    COLLECTED_AT: input.collectedAt,
    RUN_ID: input.runId,
    MANIFEST_KEY: input.manifestKey,
    MANIFEST_DIGEST: input.manifestDigest,
    SCHEMA_VERSION: input.schemaVersion,
    OUTCOME: input.outcome,
    OUTCOME_REASON: input.outcomeReason,
    FINDING: input.verifyFirst.finding,
    FINDING_REASON: input.verifyFirst.reason,
    MANIFEST_CREATED_AT: input.verifyFirst.manifestCreatedAt,
    MANIFEST_FILES: String(input.verifyFirst.manifestFiles),
    WORKSTATION_FILES: String(input.verifyFirst.workstationFiles),
    EQUAL: String(input.verifyFirst.equal),
    DIFFERING: String(input.verifyFirst.differing),
    MISSING_IN_WORKSTATION: String(input.verifyFirst.missingInWorkstation),
    MISSING_IN_MANIFEST: String(input.verifyFirst.missingInManifest),
    FILE_ROWS: fileRows.length ? fileRows.join('\n') : '| _every file equal_ | | | |',
    BLOBS_VERIFIED: String((input.blobs ?? []).filter((b) => b.state === 'verified').length),
    BLOBS_TOTAL: String(input.blobs?.length ?? 0),
    BLOB_ROWS: blobRows.length ? blobRows.join('\n') : '| _every blob verified_ | | | |',
    LEDGER_RESULT: !ledger
      ? 'not run'
      : 'error' in ledger
        ? `**failed**: ${ledger.error}`
        : `passed (version ${ledger.version}; ${ledger.orders} orders, ${ledger.paperOrders} paper, ${ledger.liveOrders} live, ${ledger.compactOrders} with evidence references across ${ledger.evidenceBatches} batches)`,
    FORECAST_RESULT: !forecast
      ? 'not run'
      : 'error' in forecast
        ? `**failed**: ${forecast.error}`
        : `${forecast.ok ? 'passed' : '**failed**'} (${forecast.version}; ${forecast.shards} shards, ${forecast.sealedRows} sealed rows, ${forecast.currentOpenRows} open rows after ${forecast.journalEvents} journal events)${forecast.errors.length ? `\n\n${forecast.errors.map((e) => `- ${e}`).join('\n')}` : ''}`,
    FORECAST_NOT_VERIFIED:
      forecast && !('error' in forecast) && forecast.notVerified.length
        ? forecast.notVerified.map((item) => `- ${item}`).join('\n')
        : '- none',
    PAPER_ORDERS: String(input.seam?.paperOrders ?? 0),
    DROPPED_LIVE_ORDERS: String(input.seam?.droppedLiveOrders ?? 0),
    MIRROR_PAIR_IDS: String(input.seam?.mirrorPairIdsCarried ?? 0),
    DROPPED_CONTROL_KEYS: input.seam?.droppedTradingControlKeys.length
      ? input.seam.droppedTradingControlKeys.map((key) => `\`${key}\``).join(', ')
      : 'none',
    NOT_LOADED: (input.seam?.notLoaded ?? []).map((item) => `- ${item}`).join('\n') || '- none',
    BANKROLL_ROWS: bankroll
      ? [
          `| funding scope | \`${bankroll.fundingId}\` |`,
          `| settled paper orders in scope | ${bankroll.settledOrders} |`,
          `| order-derived realized P&L (cents) | ${bankroll.orderPnlCents} |`,
          `| maker-fee corrections added back (cents) | ${bankroll.makerFeeCorrectionCents} |`,
          `| strategy-leak corrections, not added (cents) | ${bankroll.strategyLeakCorrectionCents} |`,
          `| reconciliation corrections, not added (cents) | ${bankroll.reconciliationCorrectionCents} |`,
          `| recomputed realized P&L (cents) | ${bankroll.recomputedRealizedPnlCents} |`,
          `| restored realized P&L (cents) | ${bankroll.restoredRealizedPnlCents} |`,
          `| discrepancy (cents) | **${bankroll.discrepancyCents}** |`,
        ].join('\n')
      : '| not computed | |',
    FORECAST_ROWS_PLANNED: String(input.forecastRowsPlanned ?? 0),
    RECONCILIATION_ROWS: reconciliationRows.length
      ? reconciliationRows.join('\n')
      : '| _no load attempted_ | | | | | |',
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}
