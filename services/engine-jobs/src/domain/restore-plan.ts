// The transform at the paper seam (ADR-0013 §1, maintainer decision 2026-10-06):
// the restored v1 tree becomes row sets for the `engine` schema. Live rows are
// dropped; paper rows keep their mirror-pair identifier as inert metadata with
// nothing to join to; live-skip and mirror-pair evidence are not loaded; the
// eight authoritative stores and the research journals are loaded as rows.

import type { DataTree } from './archive-source.js';
import { readTreeJson, readTreeText } from './archive-source.js';
import {
  readEvidenceBatch,
  readLedger,
  type EvidenceReference,
  type LedgerOrder,
  type PaperBudget,
  type StoredLedger,
} from './ledger-v9.js';
import { readForecastLayout } from './forecast-v3.js';
import { rowSetDigest } from './sha256.js';

export interface RowSet {
  table: string;
  /** The v1 store(s) the rows came from, for the evidence document. */
  source: string;
  rows: Record<string, unknown>[];
  digest: string;
}

export interface RestorePlan {
  rowSets: RowSet[];
  paperBudget: PaperBudget | undefined;
  paperOrders: LedgerOrder[];
  droppedLiveOrders: number;
  mirrorPairIdsCarried: number;
  droppedTradingControlKeys: string[];
  notLoaded: string[];
}

/** The paper-side fields of v1's trading control. Everything else is live-side. */
export const PAPER_TRADING_CONTROL_KEYS = [
  'revision',
  'state',
  'mode',
  'operatorIntent',
  'pauseOrigin',
  'pauseReason',
  'autoResumeEligible',
  'updatedAt',
] as const;

/** v1 file name → table and whether it is a JSONL journal or a JSON document. */
export const RESEARCH_JOURNALS: ReadonlyArray<{ file: string; store: string }> = [
  { file: 'hourly-threshold-observations.journal.jsonl', store: 'hourly-threshold-observations' },
  { file: 'exit-policy-sentinels-v3.journal.jsonl', store: 'exit-policy-sentinels-v3' },
  { file: 'maker-restriction-sentinels.journal.jsonl', store: 'maker-restriction-sentinels' },
  { file: 'portfolio-choice-sets.journal.jsonl', store: 'portfolio-choice-sets' },
  { file: 'contract-paths.journal.jsonl', store: 'contract-paths' },
  { file: 'calendar-evaluation.journal.jsonl', store: 'calendar-evaluation' },
  { file: 'exit-policy-sentinels-v2.journal.jsonl', store: 'exit-policy-sentinels-v2' },
  { file: 'maker-lifecycle-sentinels.journal.jsonl', store: 'maker-lifecycle-sentinels' },
  { file: 'paper-execution-timing-shadows.journal.jsonl', store: 'paper-execution-timing-shadows' },
];

export const RESEARCH_SNAPSHOTS: ReadonlyArray<{ file: string; store: string }> = [
  { file: 'edge-spike-sentinels.json', store: 'edge-spike-sentinels' },
  { file: 'exit-policy-sentinels-v3.json', store: 'exit-policy-sentinels-v3' },
  { file: 'maker-restriction-sentinels.json', store: 'maker-restriction-sentinels' },
  { file: 'portfolio-choice-sets.json', store: 'portfolio-choice-sets' },
  { file: 'contract-paths.json', store: 'contract-paths' },
  { file: 'calendar-evaluation.json', store: 'calendar-evaluation' },
  { file: 'persistence-candidate.json', store: 'persistence-candidate' },
  { file: 'model-evaluations.json', store: 'model-evaluations' },
];

/** Live-side stores that are never loaded (maintainer decision 2026-10-06). */
export const NEVER_LOADED = [
  'live-skips.json',
  'live-skips.journal.jsonl',
  'kalshi-reconciliation-checkpoint.json',
  'execution-ledger-legacy/',
  'forecast-history.json',
  'forecast-history.write.lock/',
  'archive-state.json',
  'regime-gate.json',
  'cycle-paths.json',
];

const rowSet = (table: string, source: string, rows: Record<string, unknown>[]): RowSet => ({
  table,
  source,
  rows,
  digest: rowSetDigest(rows),
});

function parseJsonl(raw: string): unknown[] {
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export function paperSeam(ledger: StoredLedger): {
  paperOrders: LedgerOrder[];
  droppedLiveOrders: number;
  mirrorPairIdsCarried: number;
} {
  const paperOrders = ledger.orders.filter((order) => order.executionMode === 'paper');
  return {
    paperOrders,
    droppedLiveOrders: ledger.orders.length - paperOrders.length,
    mirrorPairIdsCarried: paperOrders.filter((order) => order.executionMirrorPair?.id).length,
  };
}

export function buildRestorePlan(tree: DataTree): RestorePlan {
  const rowSets: RowSet[] = [];
  const notLoaded = [...NEVER_LOADED];

  // 1. The execution ledger, paper rows only.
  const ledger = readLedger(tree);
  const seam = paperSeam(ledger);
  rowSets.push(
    rowSet(
      'engine.ledger_order',
      'paper-orders.json (executionMode = paper)',
      seam.paperOrders.map((order) => ({
        order_id: order.id,
        execution_mode: 'paper',
        status: order.status,
        strategy_id: order.strategyId ?? null,
        stake_cents: order.stakeCents,
        pnl_cents: order.pnlCents ?? null,
        paper_bankroll_id: order.paperBankrollId ?? null,
        // Inert metadata: the live half of the pair is not loaded, so there is
        // no join target by construction (ADR-0013 §1).
        mirror_pair_id: order.executionMirrorPair?.id ?? null,
        evidence_sha256: order.archivedEvidence?.sha256 ?? null,
        evidence_row_key: order.archivedEvidence?.rowKey ?? null,
        row: order,
      })),
    ),
  );
  rowSets.push(
    rowSet('engine.ledger_state', 'paper-orders.json (paper bankroll and persistence)', [
      { key: 'paperBudget', value: ledger.paperBudget ?? null },
      { key: 'signalPersistence', value: ledger.signalPersistence ?? {} },
      { key: 'portfolioDecisions', value: ledger.portfolioDecisions ?? {} },
      { key: 'switchPersistence', value: ledger.switchPersistence ?? {} },
    ]),
  );
  notLoaded.push('paper-orders.json: liveCorrections, lastLiveSkip, every executionMode=live row');

  // 2. Evidence batches as rows, paper rows only.
  const evidenceRows: Record<string, unknown>[] = [];
  const batches = new Map<string, EvidenceReference>();
  for (const order of seam.paperOrders) {
    if (order.archivedEvidence) batches.set(order.archivedEvidence.sha256, order.archivedEvidence);
  }
  const paperRowKeys = new Map(
    seam.paperOrders
      .filter((order) => order.archivedEvidence)
      .map((order) => [
        `${order.archivedEvidence!.sha256}/${order.archivedEvidence!.rowKey}`,
        order.id,
      ]),
  );
  for (const reference of [...batches.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1))) {
    const batch = readEvidenceBatch(tree, reference);
    for (const [rowKey, stored] of Object.entries(batch.orders).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (!paperRowKeys.has(`${reference.sha256}/${rowKey}`)) continue;
      evidenceRows.push({
        batch_sha256: reference.sha256,
        row_key: rowKey,
        order_id: stored.orderId,
        evidence: stored.evidence,
      });
    }
  }
  rowSets.push(
    rowSet(
      'engine.evidence_row',
      'execution-order-evidence/batch.<sha256>.json (paper rows)',
      evidenceRows,
    ),
  );
  notLoaded.push('execution-order-evidence: rows referenced only by live orders');

  // 3. Trading control, paper fields only.
  const control = readTreeJson<{ control?: Record<string, unknown>; audit?: unknown[] }>(
    tree,
    'trading-control.json',
  );
  const droppedTradingControlKeys: string[] = [];
  const paperControl: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(control?.control ?? {})) {
    if ((PAPER_TRADING_CONTROL_KEYS as readonly string[]).includes(key)) paperControl[key] = value;
    else droppedTradingControlKeys.push(key);
  }
  rowSets.push(
    rowSet('engine.trading_control', 'trading-control.json (paper fields only)', [
      { key: 'control', value: paperControl },
    ]),
  );
  notLoaded.push(
    'trading-control.json: live budget cents, epochs, reservations, venues, drain and audit',
  );

  // 4. Provider registry, live flag dropped.
  const providers = readTreeJson<Record<string, unknown>>(tree, 'trading-providers.json');
  const providerRows: Record<string, unknown>[] = [];
  const providerEntries =
    providers && typeof providers === 'object'
      ? Object.entries(
          (providers.providers as Record<string, Record<string, unknown>> | undefined) ?? providers,
        )
      : [];
  for (const [providerId, record] of providerEntries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const { liveEnabled: _live, ...paperSide } = record as Record<string, unknown>;
    void _live;
    providerRows.push({ provider_id: providerId, record: paperSide });
  }
  rowSets.push(
    rowSet(
      'engine.provider_registry',
      'trading-providers.json (liveEnabled dropped)',
      providerRows,
    ),
  );

  // 5 and 6. Forecast journal and sealed shards.
  const layout = readForecastLayout(tree);
  rowSets.push(
    rowSet(
      'engine.forecast_journal_event',
      'forecast-history.journal.jsonl (uncompacted suffix)',
      (layout?.journalEvents ?? []).map((event, index) => ({ sequence: index + 1, event })),
    ),
  );
  rowSets.push(
    rowSet(
      'engine.forecast_shard',
      'forecast-history-shards/index.json and sealed artifacts',
      (layout?.shards ?? []).map(({ entry, rollup }) => ({
        shard_id: entry.shardId,
        rows_sha256: entry.sha256,
        rollup_sha256: entry.rollupSha256,
        ids_sha256: entry.idsSha256 ?? null,
        row_count: entry.rowCount,
        rollup,
      })),
    ),
  );
  const forecastRows: Record<string, unknown>[] = [];
  for (const { entry, rows } of layout?.shards ?? []) {
    for (const row of rows)
      forecastRows.push({ forecast_id: row.id, shard_id: entry.shardId, status: row.status, row });
  }
  for (const row of layout?.currentOpen ?? []) {
    forecastRows.push({ forecast_id: row.id, shard_id: null, status: row.status, row });
  }
  rowSets.push(
    rowSet('engine.forecast_row', 'sealed shard rows plus the current open set', forecastRows),
  );

  // 7. Contract provenance.
  const provenance = readTreeJson<unknown>(tree, 'contract-provenance.json');
  const provenanceEntries: unknown[] = Array.isArray(provenance)
    ? provenance
    : provenance && typeof provenance === 'object'
      ? Object.values(
          ((provenance as Record<string, unknown>).records as
            Record<string, unknown> | undefined) ?? (provenance as Record<string, unknown>),
        )
      : [];
  rowSets.push(
    rowSet(
      'engine.contract_provenance',
      'contract-provenance.json',
      provenanceEntries.map((record, index) => ({
        registry_id: (record as { registryId?: string })?.registryId ?? String(index + 1),
        record,
      })),
    ),
  );

  // 8. Model promotions.
  const promotions = readTreeJson<unknown>(tree, 'model-promotions.json');
  const promotionEntries: unknown[] = Array.isArray(promotions)
    ? promotions
    : ((promotions as { promotions?: unknown[] } | undefined)?.promotions ?? []);
  rowSets.push(
    rowSet(
      'engine.model_promotion',
      'model-promotions.json',
      promotionEntries.map((record, index) => ({ sequence: index + 1, record })),
    ),
  );

  // Research journals and snapshots.
  const journalRows: Record<string, unknown>[] = [];
  for (const { file, store } of RESEARCH_JOURNALS) {
    const raw = readTreeText(tree, file);
    if (raw === undefined) continue;
    parseJsonl(raw).forEach((event, index) => {
      journalRows.push({ store, sequence: index + 1, event });
    });
  }
  rowSets.push(
    rowSet('engine.research_journal_event', 'research *.journal.jsonl files', journalRows),
  );
  const snapshotRows: Record<string, unknown>[] = [];
  for (const { file, store } of RESEARCH_SNAPSHOTS) {
    const value = readTreeJson<unknown>(tree, file);
    if (value === undefined) continue;
    snapshotRows.push({ store, snapshot: value });
  }
  rowSets.push(rowSet('engine.research_snapshot', 'research snapshot *.json files', snapshotRows));

  return {
    rowSets,
    paperBudget: ledger.paperBudget,
    paperOrders: seam.paperOrders,
    droppedLiveOrders: seam.droppedLiveOrders,
    mirrorPairIdsCarried: seam.mirrorPairIdsCarried,
    droppedTradingControlKeys,
    notLoaded,
  };
}
