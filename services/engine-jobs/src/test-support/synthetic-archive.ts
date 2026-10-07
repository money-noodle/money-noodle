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
import { sha256Hex } from '../domain/sha256.js';

const text = (value: string) => Buffer.from(value, 'utf8');
const json = (value: unknown) => text(`${JSON.stringify(value)}\n`);

export interface SyntheticOptions {
  /** Live orders to include beside the paper ones. */
  liveOrders?: number;
  /** Make the restored bankroll disagree with its orders by this many cents. */
  bankrollDriftCents?: number;
  prefix?: string;
}

export function syntheticDataTree(options: SyntheticOptions = {}): DataTree {
  const tree: DataTree = new Map();
  const evidence = {
    version: EVIDENCE_BATCH_VERSION,
    orders: {} as Record<string, { orderId: string; evidence: unknown }>,
  };
  const rowKey = (id: string) => sha256Hex(`row:${id}`);
  const paper: LedgerOrder[] = [
    {
      id: 'p-1',
      executionMode: 'paper',
      status: 'won',
      stakeCents: 100,
      pnlCents: 80,
      strategyId: 'edge',
      executionMirrorPair: { version: 'entry-execution-mirror-pair-v1', id: 'pair-1' },
    },
    {
      id: 'p-2',
      executionMode: 'paper',
      status: 'lost',
      stakeCents: 100,
      pnlCents: -100,
      strategyId: 'edge',
    },
    {
      id: 'p-3',
      executionMode: 'paper',
      status: 'won',
      stakeCents: 50,
      pnlCents: 30,
      strategyId: 'edge',
      paperBankrollId: 'paper-original',
    },
    { id: 'p-4', executionMode: 'paper', status: 'open', stakeCents: 40, strategyId: 'edge' },
  ];
  const live: LedgerOrder[] = Array.from({ length: options.liveOrders ?? 0 }, (_, index) => ({
    id: `l-${index + 1}`,
    executionMode: 'live' as const,
    status: 'won',
    stakeCents: 25,
    pnlCents: 10,
    strategyId: 'edge',
    budgetEpochId: 'epoch-1',
    executionMirrorPair: {
      version: 'entry-execution-mirror-pair-v1' as const,
      id: `pair-${index + 1}`,
    },
  }));
  for (const order of [...paper.slice(0, 2), ...live]) {
    evidence.orders[rowKey(order.id)] = {
      orderId: order.id,
      evidence: { decisions: [`decision for ${order.id}`] },
    };
  }
  const batchRaw = text(JSON.stringify(evidence));
  const batchSha = sha256Hex(batchRaw);
  for (const order of [...paper.slice(0, 2), ...live]) {
    order.archivedEvidence = {
      version: EVIDENCE_REF_VERSION,
      file: `batch.${batchSha}.json`,
      sha256: batchSha,
      rowKey: rowKey(order.id),
    };
  }
  tree.set(`execution-order-evidence/batch.${batchSha}.json`, batchRaw);
  // realized = 80 - 100 + 30 = 10, plus a maker-fee correction of 5 → 15.
  const ledger: StoredLedger = {
    version: 9,
    paperBudget: {
      startingCents: 10_000,
      availableCents: 9_975,
      realizedPnlCents: 15 + (options.bankrollDriftCents ?? 0),
      makerFeeCorrections: [
        {
          at: '2026-01-02T00:00:00.000Z',
          reason: 'synthetic maker fee',
          orderIds: ['p-1'],
          availableCents: 5,
          realizedPnlCents: 5,
        },
      ],
      strategyLeakCorrections: [
        {
          at: '2026-01-03T00:00:00.000Z',
          reason: 'synthetic leak',
          orderIds: ['p-2'],
          availableCents: -7,
          realizedPnlCents: -7,
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
  if (options.liveOrders) {
    tree.set('live-skips.json', json({ episodes: [{ reason: 'synthetic' }] }));
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
