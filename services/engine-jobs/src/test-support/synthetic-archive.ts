// A synthetic v1 archive for tests: no real data, no real identifier, no money
// figure from any real ledger. The shapes follow the sanitized inventory and
// the ported verifiers; the values are invented.

import { gunzipSync, gzipSync } from 'node:zlib';

import {
  blobObjectKey,
  parseArchiveManifest,
  type ArchiveManifest,
} from '../domain/archive-manifest.js';
import type { ArchiveSource, DataTree } from '../domain/archive-source.js';
import {
  EVIDENCE_BATCH_VERSION,
  EVIDENCE_REF_VERSION,
  type LedgerOrder,
  type StoredLedger,
} from '../domain/ledger-v9.js';
import { EDGE_STRATEGY_ID } from '../domain/paper-bankroll.js';
import { sha256Hex } from '../domain/sha256.js';

const text = (value: string) => Buffer.from(value, 'utf8');
const json = (value: unknown) => text(`${JSON.stringify(value)}\n`);

export interface SyntheticOptions {
  /** Live orders to include beside the paper ones. */
  liveOrders?: number;
  /**
   * Make the restored realized figure disagree with its orders by this many
   * cents. The available balance moves with it, so only the P&L invariant breaks.
   */
  bankrollDriftCents?: number;
  /**
   * Move the available balance alone, so the bankroll's two counters disagree
   * while the realized figure still reconciles.
   */
  availableDriftCents?: number;
  /** Add a store the transform has never heard of, so the manifest holds an UNMAPPED entry. */
  unmappedFile?: boolean;
  /** Leave `provider-budgets.json` out of the tree. */
  withoutProviderBudgets?: boolean;
  /** Add an earlier sealed generation the current index does not name. */
  staleForecastGeneration?: boolean;
  /** Add a file inside a write lease, so the manifest carries a lease entry. */
  leaseFile?: boolean;
  prefix?: string;
}

export function syntheticDataTree(options: SyntheticOptions = {}): DataTree {
  const tree: DataTree = new Map();
  const evidence = {
    version: EVIDENCE_BATCH_VERSION,
    orders: {} as Record<string, { orderId: string; evidence: unknown }>,
  };
  const rowKey = (id: string) => sha256Hex(`row:${id}`);
  const LONG_SHOT_STRATEGY_ID = 'long-shot-binary-buy';
  // One record of every class the bankroll rule distinguishes. The ids name the
  // class so a failing assertion says which rule moved.
  const paper: LedgerOrder[] = [
    // The four edge settled statuses: these, and only these, contribute.
    {
      id: 'e-won',
      executionMode: 'paper',
      status: 'won',
      stakeCents: 100,
      pnlCents: 80,
      strategyId: EDGE_STRATEGY_ID,
      executionMirrorPair: { version: 'entry-execution-mirror-pair-v1', id: 'pair-1' },
    },
    {
      id: 'e-lost',
      executionMode: 'paper',
      status: 'lost',
      stakeCents: 100,
      pnlCents: -100,
      strategyId: EDGE_STRATEGY_ID,
    },
    {
      id: 'e-invalid',
      executionMode: 'paper',
      status: 'invalid',
      stakeCents: 50,
      pnlCents: 0,
      strategyId: EDGE_STRATEGY_ID,
    },
    {
      id: 'e-sold',
      executionMode: 'paper',
      status: 'sold',
      stakeCents: 50,
      pnlCents: 30,
      strategyId: EDGE_STRATEGY_ID,
      paperBankrollId: 'paper-original',
    },
    // The exit leg of the sale above. Its P&L is not a second contribution.
    {
      id: 'e-sold:exit:1',
      executionMode: 'paper',
      status: 'sold',
      stakeCents: 0,
      pnlCents: 999,
      strategyId: EDGE_STRATEGY_ID,
    },
    // Another strategy's own settled win. It never moved this bankroll.
    {
      id: 'ls-won',
      executionMode: 'paper',
      status: 'won',
      stakeCents: 40,
      pnlCents: 70,
      strategyId: LONG_SHOT_STRATEGY_ID,
    },
    // Another strategy's standalone-exit-policy sale: the one non-edge payout
    // that did reach this bankroll, and what the leak correction removed again.
    {
      id: 'ls-sold',
      executionMode: 'paper',
      status: 'sold',
      stakeCents: 40,
      pnlCents: 25,
      strategyId: LONG_SHOT_STRATEGY_ID,
      standaloneExitPolicy: 'exit-policy-v3',
    },
    // Open stake: the edge record's is reserved against the available balance,
    // the other strategy's is not.
    {
      id: 'e-open',
      executionMode: 'paper',
      status: 'open',
      stakeCents: 60,
      strategyId: EDGE_STRATEGY_ID,
    },
    {
      id: 'ls-open',
      executionMode: 'paper',
      status: 'open',
      stakeCents: 45,
      strategyId: LONG_SHOT_STRATEGY_ID,
    },
  ];
  const live: LedgerOrder[] = Array.from({ length: options.liveOrders ?? 0 }, (_, index) => ({
    id: `l-${index + 1}`,
    executionMode: 'live' as const,
    status: 'won',
    stakeCents: 25,
    pnlCents: 10,
    strategyId: EDGE_STRATEGY_ID,
    budgetEpochId: 'epoch-1',
    executionMirrorPair: {
      version: 'entry-execution-mirror-pair-v1' as const,
      id: `pair-${index + 1}`,
    },
  }));
  const withEvidence = [paper[0]!, paper[1]!, ...live];
  for (const order of withEvidence) {
    evidence.orders[rowKey(order.id)] = {
      orderId: order.id,
      evidence: { decisions: [`decision for ${order.id}`] },
    };
  }
  const batchRaw = text(JSON.stringify(evidence));
  const batchSha = sha256Hex(batchRaw);
  for (const order of withEvidence) {
    order.archivedEvidence = {
      version: EVIDENCE_REF_VERSION,
      file: `batch.${batchSha}.json`,
      sha256: batchSha,
      rowKey: rowKey(order.id),
    };
  }
  tree.set(`execution-order-evidence/batch.${batchSha}.json`, batchRaw);
  // Order-derived: 80 - 100 + 0 + 30 (edge settled) + 25 (the standalone-exit
  // sale) = 35. Corrections applied to the counter: +5 maker fee, -25 strategy
  // leak (which removed that same sale) = -20. Expected realized = 15. The
  // reconciliation correction is reported and not added: it is the adjustment
  // this check verifies. Available = starting + realized - open edge stake.
  const realizedPnlCents = 15 + (options.bankrollDriftCents ?? 0);
  const openEdgeStakeCents = 60;
  const ledger: StoredLedger = {
    version: 9,
    paperBudget: {
      startingCents: 10_000,
      availableCents:
        10_000 + realizedPnlCents - openEdgeStakeCents + (options.availableDriftCents ?? 0),
      realizedPnlCents,
      makerFeeCorrections: [
        {
          at: '2026-01-02T00:00:00.000Z',
          reason: 'synthetic maker fee',
          orderIds: ['e-won'],
          availableCents: 5,
          realizedPnlCents: 5,
        },
      ],
      strategyLeakCorrections: [
        {
          at: '2026-01-03T00:00:00.000Z',
          reason: 'synthetic leak of another strategy’s standalone exit',
          orderIds: ['ls-sold'],
          availableCents: -25,
          realizedPnlCents: -25,
        },
      ],
      reconciliationCorrections: [
        {
          at: '2026-01-04T00:00:00.000Z',
          reason: 'synthetic reconciliation',
          orderIds: [],
          availableCents: 3,
          realizedPnlCents: 3,
        },
      ],
    },
    orders: [...paper, ...live],
    signalPersistence: { 'asset-a': { streak: 2 } },
    portfolioDecisions: {},
    switchPersistence: {},
    liveCorrections: live.length
      ? [{ at: '2026-01-05T00:00:00.000Z', reason: 'synthetic live correction' }]
      : [],
    lastLiveSkip: live.length ? { reason: 'synthetic', at: '2026-01-05T00:00:00.000Z' } : undefined,
  };
  tree.set('paper-orders.json', json(ledger));
  tree.set(
    'trading-control.json',
    json({
      control: {
        revision: 3,
        state: 'active',
        mode: 'paper',
        operatorIntent: 'active',
        availableBudgetCents: 0,
        reservedBudgetCents: 0,
        epochId: 'epoch-1',
        enabledVenues: ['venue-a'],
      },
      audit: [],
    }),
  );
  tree.set(
    'trading-providers.json',
    json({
      providers: { 'venue-a': { researchEnabled: true, paperEnabled: true, liveEnabled: false } },
    }),
  );
  tree.set(
    'contract-provenance.json',
    json({
      records: {
        'reg-1': {
          version: 'contract-provenance-v1',
          registryId: 'reg-1',
          venue: 'venue-a',
          contractId: 'c-1',
        },
      },
    }),
  );
  tree.set(
    'model-promotions.json',
    json([{ at: '2026-01-01T00:00:00.000Z', modelVersion: 'm-1' }]),
  );
  // Forecast storage v4: one sealed shard, an open set and a journal with a suffix.
  const sealedRows = [
    { id: 'f-1', status: 'resolved', qualified: true, issuedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'f-2', status: 'invalid', qualified: false, issuedAt: '2026-01-01T00:15:00.000Z' },
  ];
  const rowsRaw = `${JSON.stringify(sealedRows)}\n`;
  const rollupRaw = `${JSON.stringify({ shardId: '2026-01-01', issued: 2 })}\n`;
  const idsRaw = `${JSON.stringify(sealedRows.map((r) => r.id).sort())}\n`;
  const openRows = [{ id: 'f-3', status: 'pending', qualified: true }];
  const openRaw = `${JSON.stringify(openRows)}\n`;
  const compacted = `${JSON.stringify({ op: 'upsert', forecast: openRows[0] })}\n`;
  const suffix = `${JSON.stringify({ op: 'patch', id: 'f-3', changes: { note: 'after seal' } })}\n${JSON.stringify({ op: 'upsert', forecast: { id: 'f-4', status: 'pending' } })}\n`;
  const sha = (raw: string) => sha256Hex(raw);
  tree.set(
    'forecast-history-shards/index.json',
    json({
      version: 'forecast-storage-v4',
      generation: 'gen-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      totalRows: 3,
      openRows: 1,
      openFile: `open.${sha(openRaw)}.json`,
      openSha256: sha(openRaw),
      compactedJournalSha256: sha(compacted),
      compactedJournalBytes: Buffer.byteLength(compacted),
      terminalRows: 2,
      shards: [
        {
          shardId: '2026-01-01',
          file: `2026-01-01.${sha(rowsRaw)}.json`,
          rollupFile: `2026-01-01.rollup.${sha(rollupRaw)}.json`,
          rowCount: 2,
          sha256: sha(rowsRaw),
          rollupSha256: sha(rollupRaw),
          idsFile: `2026-01-01.ids.${sha(idsRaw)}.json`,
          idsSha256: sha(idsRaw),
          qualifiedRows: 1,
          unqualifiedRows: 1,
        },
      ],
    }),
  );
  tree.set(`forecast-history-shards/2026-01-01.${sha(rowsRaw)}.json`, text(rowsRaw));
  tree.set(`forecast-history-shards/2026-01-01.rollup.${sha(rollupRaw)}.json`, text(rollupRaw));
  tree.set(`forecast-history-shards/2026-01-01.ids.${sha(idsRaw)}.json`, text(idsRaw));
  tree.set(`forecast-history-shards/open.${sha(openRaw)}.json`, text(openRaw));
  tree.set('forecast-history.journal.jsonl', text(compacted + suffix));
  tree.set(
    'hourly-threshold-observations.journal.jsonl',
    text(
      `${JSON.stringify({ asset: 'a', minute: 1 })}\n${JSON.stringify({ asset: 'a', minute: 2 })}\n`,
    ),
  );
  tree.set('exit-policy-sentinels-v3.json', json({ sentinels: [] }));
  // Store 6: provider budget configuration, paper and live ceilings side by side.
  if (!options.withoutProviderBudgets) {
    tree.set(
      'provider-budgets.json',
      json({
        version: 'provider-budget-v1',
        revision: 2,
        updatedAt: '2026-01-02T00:00:00.000Z',
        providers: [
          {
            providerId: 'venue-a',
            liveLimitCents: 5_000,
            paperLimitCents: 2_500,
            allocations: [{ marketId: 'market-1', percent: 100 }],
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    );
  }
  // The `.json` halves of the frozen or concluded sentinel stores (15, 17, 20).
  tree.set('exit-policy-sentinels-v2.json', json({ sentinels: [], retired: true }));
  tree.set('maker-lifecycle-sentinels.json', json({ sentinels: [], concluded: true }));
  tree.set('paper-execution-timing-shadows.json', json({ shadows: [] }));
  tree.set(
    'maker-lifecycle-sentinels.journal.jsonl',
    text(`${JSON.stringify({ sentinel: 's-1', at: '2026-01-01T00:00:00.000Z' })}\n`),
  );
  if (options.staleForecastGeneration) {
    // An earlier generation: a sealed shard and an open set the current index
    // does not name. The open set is staged as a candidate and then found stale.
    const staleRows = `${JSON.stringify([{ id: 'f-0', status: 'resolved' }])}\n`;
    const staleOpen = `${JSON.stringify([{ id: 'f-9', status: 'pending' }])}\n`;
    tree.set(`forecast-history-shards/2025-12-31.${sha(staleRows)}.json`, text(staleRows));
    tree.set(`forecast-history-shards/open.${sha(staleOpen)}.json`, text(staleOpen));
  }
  if (options.leaseFile) {
    tree.set('forecast-history.write.lock/holder.json', json({ holder: 'synthetic' }));
  }
  // Derived, rebuildable and quarantine entries the v1 archive also captured.
  tree.set('regime-gate.json', json({ candidates: [] }));
  tree.set('cycle-paths.json', json({ paths: [] }));
  tree.set('paper-fill-calibration.json', json({ version: 'neutral' }));
  tree.set('trading-control.json.superseded-2026-01-01T00-00-00', json({ control: {} }));
  tree.set('execution-ledger-legacy/paper-orders.v8.json', json({ version: 8, orders: [] }));
  if (options.liveOrders) {
    tree.set('live-skips.json', json({ episodes: [{ reason: 'synthetic' }] }));
  }
  if (options.unmappedFile) {
    tree.set('mystery-store.json', json({ what: 'nobody knows' }));
  }
  return tree;
}

export interface SyntheticArchive {
  source: ArchiveSource;
  manifest: ArchiveManifest;
  manifestKey: string;
  /** Mutable: tests corrupt or remove blobs through it. */
  objects: Map<string, Uint8Array>;
}

export function syntheticArchive(
  tree: DataTree,
  options: { prefix?: string; createdAt?: string } = {},
): SyntheticArchive {
  const prefix = options.prefix ?? 'synthetic/v1';
  const objects = new Map<string, Uint8Array>();
  const files = [...tree.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, bytes]) => {
      const sha256 = sha256Hex(bytes);
      const compressed = gzipSync(bytes);
      const objectKey = blobObjectKey(prefix, sha256);
      objects.set(objectKey, compressed);
      return {
        path,
        sourceBytes: bytes.byteLength,
        compressedBytes: compressed.byteLength,
        sha256,
        objectKey,
        modifiedAt: '2026-01-02T00:00:00.000Z',
      };
    });
  const manifest: ArchiveManifest = {
    version: 'money-noodle-local-archive-v1',
    createdAt: options.createdAt ?? '2026-01-02T00:05:00.000Z',
    hostname: 'synthetic-host',
    sourceRoot: 'data',
    files,
    totals: {
      files: files.length,
      sourceBytes: files.reduce((s, f) => s + f.sourceBytes, 0),
      compressedBytes: files.reduce((s, f) => s + f.compressedBytes, 0),
      newBlobs: files.length,
      reusedBlobs: 0,
    },
  };
  const manifestKey = `${prefix}/manifests/2026/01/02/2026-01-02T00-05-00-000Z.json`;
  const manifestRaw = text(`${JSON.stringify(manifest)}\n`);
  objects.set(manifestKey, manifestRaw);
  const source: ArchiveSource = {
    async listManifestKeys() {
      return [...objects.keys()].filter((key) => key.includes('/manifests/')).sort();
    },
    async readManifest(key) {
      const raw = objects.get(key);
      if (!raw) throw new Error(`no manifest ${key}`);
      return { manifest: parseArchiveManifest(Buffer.from(raw).toString('utf8')), raw };
    },
    async readBlob(objectKey) {
      const compressed = objects.get(objectKey);
      return compressed === undefined ? undefined : gunzipSync(compressed);
    },
  };
  return { source, manifest, manifestKey, objects };
}
