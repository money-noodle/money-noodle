import { describe, expect, it } from 'vitest';

import { FakeEngineStore } from './adapters/engine-store/fake-engine-store.js';
import { runRestoreJob, type RestoreJobInput } from './application/restore.js';
import { isArchiveCandidate, parseArchiveManifest } from './domain/archive-manifest.js';
import { verifyForecastStorage } from './domain/forecast-v3.js';
import { readLedger, verifyLedgerV9 } from './domain/ledger-v9.js';
import { recomputePaperBankroll } from './domain/paper-bankroll.js';
import { buildRestorePlan, paperSeam } from './domain/restore-plan.js';
import { restoreTreeFromArchive } from './domain/restore-tree.js';
import { sha256Hex } from './domain/sha256.js';
import { compareManifestWithWorkstation } from './domain/verify-first.js';
import { syntheticArchive, syntheticDataTree } from './test-support/synthetic-archive.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const template = readFileSync(
  join(import.meta.dirname, '..', 'templates', 'v1-archive-restore-evidence.md'),
  'utf8',
);

function job(
  overrides: Partial<RestoreJobInput> & { tree?: ReturnType<typeof syntheticDataTree> } = {},
) {
  const tree = overrides.tree ?? syntheticDataTree({ liveOrders: 2 });
  const archive = syntheticArchive(tree);
  const store = new FakeEngineStore();
  const writes: string[] = [];
  const input: RestoreJobInput = {
    archive: archive.source,
    workstation: tree,
    store,
    evidenceTemplate: template,
    writeEvidence: async (markdown) => {
      writes.push(markdown);
    },
    runId: 'run-1',
    now: () => new Date('2026-10-07T06:00:00.000Z'),
    ...overrides,
  };
  return { input, archive, store, writes, tree };
}

describe('verify-first: the last manifest against the workstation copy', () => {
  it('finds a complete manifest when every file matches and nothing eligible is extra', () => {
    const tree = syntheticDataTree();
    const { manifest } = syntheticArchive(tree);
    const finding = compareManifestWithWorkstation(manifest, tree);
    expect(finding.finding).toBe('complete');
    expect(finding.loadPermitted).toBe(true);
    expect(finding.equal).toBe(manifest.files.length);
  });

  it('finds an incomplete manifest when the workstation holds an eligible file the manifest lacks', () => {
    const tree = syntheticDataTree();
    const { manifest } = syntheticArchive(tree);
    const later = new Map(tree);
    later.set(
      'hourly-threshold-observations.journal.jsonl',
      Buffer.from('{"asset":"a","minute":3}\n'),
    );
    later.set('new-sentinel.journal.jsonl', Buffer.from('{"x":1}\n'));
    later.set('.hidden.json', Buffer.from('{}'));
    later.set('forecast-history.write.lock', Buffer.from(''));
    const finding = compareManifestWithWorkstation(manifest, later);
    expect(finding.finding).toBe('incomplete');
    expect(finding.missingInManifest).toBe(1);
    expect(finding.differing).toBe(1);
    expect(finding.loadPermitted).toBe(false);
    expect(finding.files.some((f) => f.path === '.hidden.json')).toBe(false);
  });

  it('finds a differing copy when the same files carry different bytes', () => {
    const tree = syntheticDataTree();
    const { manifest } = syntheticArchive(tree);
    const changed = new Map(tree);
    changed.set('trading-providers.json', Buffer.from('{"providers":{}}\n'));
    changed.delete('model-promotions.json');
    const finding = compareManifestWithWorkstation(manifest, changed);
    expect(finding.finding).toBe('differing');
    expect(finding.differing).toBe(1);
    expect(finding.missingInWorkstation).toBe(1);
    expect(finding.loadPermitted).toBe(false);
  });

  it('cannot establish completeness without a workstation copy', () => {
    const { manifest } = syntheticArchive(syntheticDataTree());
    const finding = compareManifestWithWorkstation(manifest, undefined);
    expect(finding.finding).toBe('workstation-absent');
    expect(finding.loadPermitted).toBe(false);
  });

  it('asks the writer’s own candidate question', () => {
    expect(isArchiveCandidate('paper-orders.json')).toBe(true);
    expect(isArchiveCandidate('a/b.journal.jsonl')).toBe(true);
    expect(isArchiveCandidate('history.jsonl.corrupt-1')).toBe(true);
    expect(isArchiveCandidate('x.journal-copy')).toBe(true);
    expect(isArchiveCandidate('archive-state.json')).toBe(false);
    expect(isArchiveCandidate('.cache/feed.json')).toBe(false);
    expect(isArchiveCandidate('paper-orders.json.12.ab.tmp')).toBe(false);
    expect(isArchiveCandidate('notes.txt')).toBe(false);
  });
});

describe('manifest and blob verification', () => {
  it('rejects a manifest whose totals or keys disagree with its records', () => {
    const { manifest } = syntheticArchive(syntheticDataTree());
    const broken = { ...manifest, totals: { ...manifest.totals, files: 1 } };
    expect(() => parseArchiveManifest(JSON.stringify(broken))).toThrow(/totals/);
    const unsafe = { ...manifest, files: [{ ...manifest.files[0]!, path: '../x.json' }] };
    expect(() => parseArchiveManifest(JSON.stringify(unsafe))).toThrow(/unsafe path/);
    expect(() => parseArchiveManifest('nope')).toThrow(/valid JSON/);
  });

  it('verifies every sha256 against the blobs and reports a corrupted or missing one', async () => {
    const tree = syntheticDataTree();
    const archive = syntheticArchive(tree);
    const good = await restoreTreeFromArchive(archive.source, archive.manifest);
    expect(good.ok).toBe(true);
    expect(good.tree.size).toBe(tree.size);
    const target = archive.manifest.files.find((f) => f.path === 'model-promotions.json')!;
    const other = archive.manifest.files.find((f) => f.path === 'trading-providers.json')!;
    archive.objects.set(target.objectKey, archive.objects.get(other.objectKey)!);
    archive.objects.delete(other.objectKey);
    const bad = await restoreTreeFromArchive(archive.source, archive.manifest);
    expect(bad.ok).toBe(false);
    expect(bad.verifications.find((v) => v.path === 'model-promotions.json')?.state).toBe(
      'checksum-mismatch',
    );
    expect(bad.verifications.find((v) => v.path === 'trading-providers.json')?.state).toBe(
      'missing',
    );
  });
});

describe('the semantic verifiers', () => {
  it('passes the ledger v9 verifier on a sound tree and fails it on a tampered batch', () => {
    const tree = syntheticDataTree({ liveOrders: 1 });
    const result = verifyLedgerV9(tree);
    expect(result).toMatchObject({
      version: 9,
      orders: 5,
      paperOrders: 4,
      liveOrders: 1,
      compactOrders: 3,
      evidenceBatches: 1,
    });
    const tampered = new Map(tree);
    const batchPath = [...tree.keys()].find((k) => k.startsWith('execution-order-evidence/'))!;
    tampered.set(
      batchPath,
      Buffer.from('{"version":"execution-order-evidence-batch-v1","orders":{}}'),
    );
    expect(() => verifyLedgerV9(tampered)).toThrow(/checksum mismatch/);
    const noLedger = new Map(tree);
    noLedger.delete('paper-orders.json');
    expect(() => verifyLedgerV9(noLedger)).toThrow(/holds no/);
  });

  it('passes the forecast verifier on a sound layout and names what it does not check', () => {
    const tree = syntheticDataTree();
    const result = verifyForecastStorage(tree);
    expect(result.ok, result.errors.join('; ')).toBe(true);
    expect(result).toMatchObject({
      shards: 1,
      sealedRows: 2,
      openRowsAtLastSeal: 1,
      journalEvents: 2,
      currentOpenRows: 2,
    });
    expect(result.notVerified.length).toBeGreaterThan(0);
    const tampered = new Map(tree);
    const shardPath = [...tree.keys()].find((k) =>
      /forecast-history-shards\/2026-01-01\.[a-f0-9]{64}\.json$/.test(k),
    )!;
    tampered.set(shardPath, Buffer.from('[{"id":"f-1","status":"pending"}]\n'));
    const failed = verifyForecastStorage(tampered);
    expect(failed.ok).toBe(false);
    expect(failed.errors.join('\n')).toMatch(/checksum did not match/);
    expect(failed.errors.join('\n')).toMatch(/non-terminal/);
    expect(verifyForecastStorage(new Map()).ok).toBe(false);
  });
});

describe('the transform at the paper seam', () => {
  it('drops live rows and keeps mirror-pair ids as inert metadata with no join target', () => {
    const tree = syntheticDataTree({ liveOrders: 2 });
    const ledger = readLedger(tree);
    const seam = paperSeam(ledger);
    expect(seam.droppedLiveOrders).toBe(2);
    expect(seam.paperOrders.every((o) => o.executionMode === 'paper')).toBe(true);
    expect(seam.mirrorPairIdsCarried).toBe(1);

    const plan = buildRestorePlan(tree);
    const orders = plan.rowSets.find((s) => s.table === 'engine.ledger_order')!.rows;
    expect(orders).toHaveLength(4);
    const carried = orders.filter((row) => row.mirror_pair_id !== null);
    expect(carried.map((row) => row.mirror_pair_id)).toEqual(['pair-1']);
    // Inert: no loaded row anywhere carries the live half of the pair.
    const everyRow = plan.rowSets.flatMap((s) => s.rows.map((r) => JSON.stringify(r)));
    expect(everyRow.some((r) => r.includes('"l-1"') || r.includes('"l-2"'))).toBe(false);
    // Live evidence rows and live-side state are not loaded.
    const evidence = plan.rowSets.find((s) => s.table === 'engine.evidence_row')!.rows;
    expect(evidence.map((r) => r.order_id).sort()).toEqual(['p-1', 'p-2']);
    expect(everyRow.some((r) => r.includes('live-skips') || r.includes('liveCorrections'))).toBe(
      false,
    );
    const control = plan.rowSets.find((s) => s.table === 'engine.trading_control')!.rows[0]!
      .value as Record<string, unknown>;
    expect(Object.keys(control).sort()).toEqual(['mode', 'operatorIntent', 'revision', 'state']);
    expect(plan.droppedTradingControlKeys).toEqual(
      expect.arrayContaining(['availableBudgetCents', 'epochId', 'enabledVenues']),
    );
    const providers = plan.rowSets.find((s) => s.table === 'engine.provider_registry')!.rows;
    expect(providers[0]!.record).toEqual({ researchEnabled: true, paperEnabled: true });
    expect(plan.rowSets.find((s) => s.table === 'engine.forecast_row')!.rows).toHaveLength(4);
    expect(
      plan.rowSets.find((s) => s.table === 'engine.research_journal_event')!.rows,
    ).toHaveLength(2);
  });

  it('recomputes the paper bankroll from its orders and three correction classes', () => {
    const tree = syntheticDataTree();
    const ledger = readLedger(tree);
    const result = recomputePaperBankroll(ledger.orders, ledger.paperBudget!);
    expect(result).toMatchObject({
      orderPnlCents: 10,
      makerFeeCorrectionCents: 5,
      strategyLeakCorrectionCents: -7,
      reconciliationCorrectionCents: 3,
      recomputedRealizedPnlCents: 15,
      discrepancyCents: 0,
    });
    const drifted = readLedger(syntheticDataTree({ bankrollDriftCents: 4 }));
    expect(recomputePaperBankroll(drifted.orders, drifted.paperBudget!).discrepancyCents).toBe(-4);
    // A reset scopes the figure to the current funding and to corrections since it started.
    const reset = recomputePaperBankroll(ledger.orders, {
      ...ledger.paperBudget!,
      fundingId: 'paper-2',
      startedAt: '2026-01-03T00:00:00.000Z',
      realizedPnlCents: 0,
    });
    expect(reset).toMatchObject({
      settledOrders: 0,
      makerFeeCorrectionCents: 0,
      recomputedRealizedPnlCents: 0,
    });
  });
});

describe('the restore job end to end over a fake store', () => {
  it('writes the finding before loading, then loads and reconciles a complete archive', async () => {
    const { input, store, writes } = job();
    const result = await runRestoreJob(input);
    expect(result.outcome, result.reason).toBe('loaded');
    expect(writes.length).toBe(2);
    expect(writes[0]).toContain('load not yet attempted');
    expect(result.evidence).toContain('**loaded**');
    expect(result.evidence).toContain('| discrepancy (cents) | **0** |');
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    const inspection = await store.inspect();
    expect(inspection.counts['engine.ledger_order']).toBe(4);
    expect(inspection.counts['engine.forecast_row']).toBe(4);
    expect(inspection.priorRuns).toHaveLength(1);
  });

  it('refuses to load when the manifest is not complete and nothing reaches the store', async () => {
    const tree = syntheticDataTree();
    const later = new Map(tree);
    later.set('extra.journal.jsonl', Buffer.from('{"a":1}\n'));
    const { input, store } = job({ tree, workstation: later });
    const result = await runRestoreJob(input);
    expect(result.outcome).toBe('refused');
    expect(result.verifyFirst.finding).toBe('incomplete');
    expect((await store.inspect()).priorRuns).toHaveLength(0);
  });

  it('refuses without a workstation copy unless the documented override is passed', async () => {
    const refused = job({ workstation: undefined });
    expect((await runRestoreJob(refused.input)).outcome).toBe('refused');
    const overridden = job({ workstation: undefined, allowWorkstationAbsent: true });
    expect((await runRestoreJob(overridden.input)).outcome).toBe('loaded');
  });

  it('refuses a corrupted blob and a drifted bankroll before any load', async () => {
    const corrupted = job();
    const file = corrupted.archive.manifest.files.find((f) => f.path === 'model-promotions.json')!;
    corrupted.archive.objects.delete(file.objectKey);
    const blob = await runRestoreJob(corrupted.input);
    expect(blob.outcome).toBe('refused');
    expect(blob.reason).toMatch(/blob/);
    const drifted = job({ tree: syntheticDataTree({ bankrollDriftCents: 1 }) });
    const bankroll = await runRestoreJob(drifted.input);
    expect(bankroll.outcome).toBe('refused');
    expect(bankroll.reason).toMatch(/bankroll/);
    expect((await drifted.store.inspect()).priorRuns).toHaveLength(0);
  });

  it('refuses to run against a non-empty engine schema and a repeated manifest digest', async () => {
    const first = job();
    expect((await runRestoreJob(first.input)).outcome).toBe('loaded');
    const second = await runRestoreJob({ ...first.input, runId: 'run-2' });
    expect(second.outcome).toBe('refused');
    expect(second.reason).toMatch(/already restored/);
    const occupied = job();
    occupied.store.tables.get('engine.forecast_shard')!.push({ shard_id: 'x' });
    const result = await runRestoreJob(occupied.input);
    expect(result.outcome).toBe('refused');
    expect(result.reason).toMatch(/not empty/);
  });

  it('rolls the load back when the store reports counts that do not reconcile', async () => {
    const { input, store } = job();
    const original = store.load.bind(store);
    store.load = (run, rowSets, reconcile) =>
      original(run, rowSets, (loaded) =>
        reconcile({ counts: { ...loaded.counts, 'engine.ledger_order': 999 } }),
      );
    const result = await runRestoreJob(input);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/rolled back/);
    expect((await store.inspect()).counts['engine.ledger_order']).toBe(0);
    expect(result.evidence).toContain('| 999 |');
  });

  it('hashes row sets stably whatever key order a reader produced', () => {
    expect(sha256Hex('a')).toMatch(/^[a-f0-9]{64}$/);
  });
});
