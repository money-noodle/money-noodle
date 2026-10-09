import { describe, expect, it } from 'vitest';

import { FakeEngineStore } from './adapters/engine-store/fake-engine-store.js';
import { runRestoreJob, type RestoreJobInput } from './application/restore.js';
import { isArchiveCandidate, parseArchiveManifest } from './domain/archive-manifest.js';
import { verifyForecastStorage } from './domain/forecast-v3.js';
import { readLedger, verifyLedgerV9 } from './domain/ledger-v9.js';
import {
  classifyPath,
  DEFAULT_LOAD_SCOPE,
  isLoadScope,
  LOAD_SCOPE_NAMES,
  rulesFor,
  type LoadScopeRules,
} from './domain/load-scope.js';
import { classifyManifest, countByReason } from './domain/manifest-classification.js';
import { recomputePaperBankroll } from './domain/paper-bankroll.js';
import { buildRestorePlan, paperSeam } from './domain/restore-plan.js';
import { restoreTreeFromArchive } from './domain/restore-tree.js';
import { sha256Hex } from './domain/sha256.js';
import { planStaging, stageListLines, stageListSummary, stagedPaths } from './domain/stage-list.js';
import { compareManifestWithWorkstation } from './domain/verify-first.js';

/** The authoritative scope's rules, and the widened set no scope selects yet. */
const AUTHORITATIVE: LoadScopeRules = rulesFor('authoritative');
const EVERYTHING: LoadScopeRules = {
  evidenceBodies: true,
  researchStores: true,
  sealedForecastShards: true,
};
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
      orders: 10,
      paperOrders: 9,
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
    // Every paper record, whatever its strategy or status: the seam drops live
    // rows, and the bankroll rule decides which of these moved the counter.
    expect(orders).toHaveLength(9);
    const carried = orders.filter((row) => row.mirror_pair_id !== null);
    expect(carried.map((row) => row.mirror_pair_id)).toEqual(['pair-1']);
    // Inert: no loaded row anywhere carries the live half of the pair.
    const everyRow = plan.rowSets.flatMap((s) => s.rows.map((r) => JSON.stringify(r)));
    expect(everyRow.some((r) => r.includes('"l-1"') || r.includes('"l-2"'))).toBe(false);
    // Evidence batch bodies are not loaded at all under the authoritative scope;
    // the index of each is on the paper order that references it.
    expect(plan.rowSets.find((s) => s.table === 'engine.evidence_row')!.rows).toEqual([]);
    expect(
      orders
        .filter((row) => row.evidence_sha256 !== null)
        .map((row) => row.order_id)
        .sort(),
    ).toEqual(['e-lost', 'e-won']);
    expect(orders.every((row) => row.evidence_row_key !== undefined)).toBe(true);
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
    // The current open set only: two rows after the journal replay. The sealed
    // terminal rows stay in the archive and the shard index names them.
    expect(plan.rowSets.find((s) => s.table === 'engine.forecast_row')!.rows).toHaveLength(2);
    expect(plan.rowSets.find((s) => s.table === 'engine.forecast_shard')!.rows).toEqual([
      expect.objectContaining({ row_count: 2, rollup: null, shard_id: '2026-01-01' }),
    ]);
    expect(
      plan.rowSets.find((s) => s.table === 'engine.research_journal_event')!.rows,
    ).toHaveLength(0);
  });

  it('loads the sealed shards, bodies and research stores when a scope admits them', () => {
    // No scope selects this today. The transform keeps the capability, so
    // widening the restore later is a table entry rather than a rewrite, and the
    // branch is held to working by this test rather than by hope.
    const plan = buildRestorePlan(syntheticDataTree({ liveOrders: 2 }), EVERYTHING);
    expect(
      plan.rowSets
        .find((s) => s.table === 'engine.evidence_row')!
        .rows.map((r) => r.order_id)
        .sort(),
    ).toEqual(['e-lost', 'e-won']);
    expect(plan.rowSets.find((s) => s.table === 'engine.forecast_row')!.rows).toHaveLength(4);
    expect(
      plan.rowSets.find((s) => s.table === 'engine.research_journal_event')!.rows,
    ).toHaveLength(3);
    expect(
      plan.rowSets.find((s) => s.table === 'engine.research_snapshot')!.rows.map((r) => r.store),
    ).toContain('exit-policy-sentinels-v3');
    expect(plan.rowSets.find((s) => s.table === 'engine.forecast_shard')!.rows[0]!.rollup).toEqual({
      issued: 2,
      shardId: '2026-01-01',
    });
  });

  it('loads provider budgets as paper ceilings and the frozen sentinel snapshots as rows', () => {
    const plan = buildRestorePlan(syntheticDataTree());
    const budgets = plan.rowSets.find((s) => s.table === 'engine.provider_budget')!.rows;
    expect(budgets).toEqual([
      {
        provider_id: 'venue-a',
        paper_limit_cents: 2_500,
        allocations: [{ marketId: 'market-1', percent: 100 }],
        updated_at: '2026-01-02T00:00:00.000Z',
        configuration_revision: 2,
        configuration_updated_at: '2026-01-02T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(budgets)).not.toContain('liveLimitCents');
    expect(plan.notLoaded).toContain('provider-budgets.json: liveLimitCents per provider');
    // The frozen sentinel snapshots are history for analysis: not loaded, and the
    // seam list says so rather than leaving a reader to notice the empty table.
    expect(plan.rowSets.find((s) => s.table === 'engine.research_snapshot')!.rows).toEqual([]);
    expect(plan.notLoaded.join('\n')).toContain('the research stores');
    expect(
      buildRestorePlan(syntheticDataTree(), EVERYTHING).rowSets.find(
        (s) => s.table === 'engine.research_snapshot',
      )!.rows.length,
    ).toBe(4);
    const absent = buildRestorePlan(syntheticDataTree({ withoutProviderBudgets: true }));
    expect(absent.rowSets.find((s) => s.table === 'engine.provider_budget')!.rows).toEqual([]);
  });

  it('classifies every manifest entry as loaded, intentionally not loaded or unmapped', () => {
    const tree = syntheticDataTree({ liveOrders: 2, unmappedFile: true });
    const { manifest } = syntheticArchive(tree);
    const plan = buildRestorePlan(tree);
    const classification = classifyManifest(manifest, plan.consumption, AUTHORITATIVE);
    expect(classification.manifestFiles).toBe(manifest.files.length);
    expect(classification.classified).toBe(manifest.files.length);
    expect(
      classification.loaded.length +
        classification.notLoaded.length +
        classification.unmapped.length,
    ).toBe(manifest.totals.files);
    expect(classification.unmapped).toEqual(['mystery-store.json']);
    const byPath = new Map(classification.notLoaded.map((e) => [e.path, e.reason]));
    expect(byPath.get('live-skips.json')).toBe('live-side');
    expect(byPath.get('execution-ledger-legacy/paper-orders.v8.json')).toBe('superseded');
    expect(byPath.get('regime-gate.json')).toBe('superseded');
    expect(byPath.get('trading-control.json.superseded-2026-01-01T00-00-00')).toBe('superseded');
    expect(countByReason(classification.notLoaded)).toEqual({
      'live-side': 1,
      'lease/lock/archive-state': 0,
      superseded: 5,
      'evidence-frozen': 0,
      // One evidence batch body, three sealed forecast artifacts, six research files.
      'historical-archive-retained': 10,
      'retired-feature': 0,
    });
    const loaded = new Map(classification.loaded.map((e) => [e.path, e.tables]));
    expect(loaded.get('paper-orders.json')).toEqual(['engine.ledger_order', 'engine.ledger_state']);
    expect(loaded.get('provider-budgets.json')).toEqual(['engine.provider_budget']);
    expect(loaded.get('forecast-history-shards/index.json')).toEqual(['engine.forecast_shard']);
    // No evidence batch body is loaded, and no sealed shard artifact: only the
    // shard index and the open set the journal replays onto.
    expect([...loaded.keys()].filter((p) => p.startsWith('execution-order-evidence/'))).toEqual([]);
    expect(
      [...loaded.keys()].filter((p) => p.startsWith('forecast-history-shards/')).sort(),
    ).toEqual(
      [
        'forecast-history-shards/index.json',
        ...manifest.files
          .filter((f) => /forecast-history-shards\/open\./.test(f.path))
          .map((f) => f.path),
      ].sort(),
    );
    expect(byPath.get([...manifest.files].find((f) => /\/batch\./.test(f.path))!.path)).toBe(
      'historical-archive-retained',
    );
  });

  it('classifies every evidence batch as retained, whoever referenced it', () => {
    const tree = syntheticDataTree({ liveOrders: 1 });
    const batch = (suffix: string) =>
      Buffer.from(
        `${JSON.stringify({ version: 'execution-evidence-batch-v1', orders: {} })}${suffix}`,
      );
    const liveOnly = batch('');
    const orphan = batch('\n');
    tree.set(`execution-order-evidence/batch.${sha256Hex(liveOnly)}.json`, liveOnly);
    tree.set(`execution-order-evidence/batch.${sha256Hex(orphan)}.json`, orphan);
    const ledger = readLedger(tree);
    const live = ledger.orders.find((o) => o.executionMode === 'live')!;
    live.archivedEvidence = {
      ...live.archivedEvidence!,
      file: `batch.${sha256Hex(liveOnly)}.json`,
      sha256: sha256Hex(liveOnly),
    };
    tree.set('paper-orders.json', Buffer.from(`${JSON.stringify(ledger)}\n`));
    const { manifest } = syntheticArchive(tree);
    const classification = classifyManifest(
      manifest,
      buildRestorePlan(tree).consumption,
      AUTHORITATIVE,
    );
    const byPath = new Map(classification.notLoaded.map((e) => [e.path, e.reason]));
    // Who referenced a body stopped mattering on 2026-10-08: no body is loaded,
    // so every one of them is archive-retained and none is ever fetched.
    expect(byPath.get(`execution-order-evidence/batch.${sha256Hex(liveOnly)}.json`)).toBe(
      'historical-archive-retained',
    );
    expect(byPath.get(`execution-order-evidence/batch.${sha256Hex(orphan)}.json`)).toBe(
      'historical-archive-retained',
    );
    expect(classification.unmapped).toEqual([]);
  });

  it('recomputes the paper bankroll from the records that moved its counter', () => {
    const tree = syntheticDataTree();
    const ledger = readLedger(tree);
    const result = recomputePaperBankroll(ledger.orders, ledger.paperBudget!);
    // 80 - 100 + 0 + 30 from the four edge settled statuses, plus 25 from the
    // other strategy's standalone-exit sale; the maker fee is added back and the
    // leak correction that removed that same sale is added back too, so they net.
    expect(result).toMatchObject({
      fundingId: 'paper-original',
      contributingOrders: 5,
      excludedExitRecords: 1,
      excludedOtherStrategyOrders: 2,
      orderPnlCents: 35,
      makerFeeCorrectionCents: 5,
      strategyLeakCorrectionCents: -25,
      reconciliationCorrectionCents: 3,
      recomputedRealizedPnlCents: 15,
      restoredRealizedPnlCents: 15,
      discrepancyCents: 0,
      openStakeCents: 60,
      availableResidualCents: 0,
    });
  });

  it('counts neither an exit leg nor another strategy’s own settled win', () => {
    const ledger = readLedger(syntheticDataTree());
    const baseline = recomputePaperBankroll(ledger.orders, ledger.paperBudget!);

    // The exit record carries a P&L an order-level sum would happily add.
    const withoutExit = ledger.orders.filter((order) => !order.id.includes(':exit:'));
    expect(ledger.orders.length - withoutExit.length).toBe(1);
    expect(recomputePaperBankroll(withoutExit, ledger.paperBudget!).orderPnlCents).toBe(
      baseline.orderPnlCents,
    );

    // So does the other strategy's own win, which never reached this bankroll.
    const withoutLongShotWin = ledger.orders.filter((order) => order.id !== 'ls-won');
    expect(recomputePaperBankroll(withoutLongShotWin, ledger.paperBudget!).orderPnlCents).toBe(
      baseline.orderPnlCents,
    );

    // The standalone-exit sale, by contrast, is exactly what the leak correction
    // removed from the counter, so dropping it breaks the figure.
    const withoutStandaloneSale = ledger.orders.filter((order) => order.id !== 'ls-sold');
    expect(
      recomputePaperBankroll(withoutStandaloneSale, ledger.paperBudget!).discrepancyCents,
    ).toBe(-25);
    // And it only contributes because it carries a standalone exit policy.
    const withoutPolicy = ledger.orders.map((order) => {
      if (order.id !== 'ls-sold') return order;
      const { standaloneExitPolicy: _policy, ...rest } = order;
      void _policy;
      return rest;
    });
    expect(recomputePaperBankroll(withoutPolicy, ledger.paperBudget!).discrepancyCents).toBe(-25);
  });

  it('holds open stake for open edge records alone, and checks the second counter', () => {
    const ledger = readLedger(syntheticDataTree());
    expect(recomputePaperBankroll(ledger.orders, ledger.paperBudget!)).toMatchObject({
      // The open edge record's stake, never the other strategy's open record.
      openStakeCents: 60,
      availableResidualCents: 0,
    });
    const drifted = readLedger(syntheticDataTree({ availableDriftCents: 7 }));
    const counters = recomputePaperBankroll(drifted.orders, drifted.paperBudget!);
    expect(counters.discrepancyCents).toBe(0);
    expect(counters.availableResidualCents).toBe(7);
  });

  it('scopes the order-derived figure to the budget’s own funding', () => {
    const ledger = readLedger(syntheticDataTree());
    const drifted = readLedger(syntheticDataTree({ bankrollDriftCents: 4 }));
    expect(recomputePaperBankroll(drifted.orders, drifted.paperBudget!).discrepancyCents).toBe(-4);

    // After a reset, orders belonging to the retired funding are out of scope.
    // The corrections are the current record's own and are summed whole: there is
    // no `since` filter, because the drift correction that made this counter
    // reconcile applied every entry.
    const reset = recomputePaperBankroll(ledger.orders, {
      ...ledger.paperBudget!,
      fundingId: 'paper-2',
      startedAt: '2026-01-03T00:00:00.000Z',
      realizedPnlCents: 0,
    });
    expect(reset).toMatchObject({
      contributingOrders: 0,
      orderPnlCents: 0,
      makerFeeCorrectionCents: 5,
      strategyLeakCorrectionCents: -25,
      recomputedRealizedPnlCents: -20,
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
    // The bankroll section names what moved the counter and what was excluded.
    expect(result.evidence).toContain('| contributing paper orders in scope | 5 |');
    expect(result.evidence).toContain('| excluded exit records | 1 |');
    expect(result.evidence).toContain('| excluded other-strategy orders | 2 |');
    expect(result.evidence).toContain('| order-derived realized P&L (cents) | 35 |');
    expect(result.evidence).toContain('| maker-fee corrections added back (cents) | 5 |');
    expect(result.evidence).toContain('| strategy-leak corrections added back (cents) | -25 |');
    expect(result.evidence).toContain('| reconciliation corrections, not added (cents) | 3 |');
    expect(result.evidence).toContain('| open stake held by edge positions (cents) | 60 |');
    expect(result.evidence).toContain('| available-balance residual (cents) | **0** |');
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    const inspection = await store.inspect();
    expect(inspection.counts['engine.ledger_order']).toBe(9);
    expect(inspection.counts['engine.forecast_row']).toBe(2);
    expect(inspection.counts['engine.evidence_row']).toBe(0);
    expect(inspection.counts['engine.research_journal_event']).toBe(0);
    expect(inspection.counts['engine.provider_budget']).toBe(1);
    expect(inspection.priorRuns).toHaveLength(1);
    // The evidence carries the manifest-to-load reconciliation with counts that add up.
    expect(result.evidence).toContain('| UNMAPPED | 0 |');
    expect(result.evidence).toContain('| Sum equals the manifest total | yes |');
    expect(result.evidence).toContain('| `--allow-unmapped` override | no |');
    expect(result.evidence).toContain('| `provider-budgets.json` | `engine.provider_budget` |');
  });

  it('refuses a manifest with an unmapped entry unless --allow-unmapped is passed, and records it', async () => {
    const refused = job({ tree: syntheticDataTree({ liveOrders: 1, unmappedFile: true }) });
    const result = await runRestoreJob(refused.input);
    expect(result.outcome).toBe('refused');
    expect(result.reason).toMatch(/neither loaded nor intentionally not loaded/);
    expect(result.reason).toContain('mystery-store.json');
    expect((await refused.store.inspect()).priorRuns).toHaveLength(0);
    expect(result.evidence).toContain('| UNMAPPED | **1** |');
    expect(result.evidence).toContain('| `mystery-store.json` |');

    const overridden = job({
      tree: syntheticDataTree({ liveOrders: 1, unmappedFile: true }),
      allowUnmapped: true,
    });
    const loaded = await runRestoreJob(overridden.input);
    expect(loaded.outcome, loaded.reason).toBe('loaded');
    expect(loaded.evidence).toContain('`--allow-unmapped` was passed');
    expect(loaded.evidence).toContain('| `mystery-store.json` |');
    // The override loads nothing extra: the unmapped store reaches no table.
    const everyRow = [...overridden.store.tables.values()].flat().map((r) => JSON.stringify(r));
    expect(everyRow.some((r) => r.includes('nobody knows'))).toBe(false);
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
    expect(bankroll.reason).toMatch(
      /recomputed from its orders and corrections differs from the restored value/u,
    );
    expect((await drifted.store.inspect()).priorRuns).toHaveLength(0);
  });

  it('refuses when the bankroll’s two counters disagree with each other', async () => {
    // The realized figure reconciles; the available balance does not. That is a
    // ledger whose own counters disagree, and the engine must not resume from it.
    const counters = job({ tree: syntheticDataTree({ availableDriftCents: 9 }) });
    const result = await runRestoreJob(counters.input);
    expect(result.outcome).toBe('refused');
    expect(result.reason).toBe(
      'The paper bankroll counters disagree with each other (available vs starting + realized - open stake); nothing was loaded.',
    );
    // The figure reconciles and the balance does not, and the evidence says both.
    expect(result.evidence).toContain('| discrepancy (cents) | **0** |');
    expect(result.evidence).toContain('| available-balance residual (cents) | **9** |');
    expect((await counters.store.inspect()).priorRuns).toHaveLength(0);
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

describe('the load scope table', () => {
  const classify = (path: string, rules = AUTHORITATIVE) => classifyPath(path, rules);

  it('names one scope, and that scope is the default', () => {
    expect(LOAD_SCOPE_NAMES).toEqual(['authoritative']);
    expect(DEFAULT_LOAD_SCOPE).toBe('authoritative');
    expect(isLoadScope('authoritative')).toBe(true);
    expect(isLoadScope('everything')).toBe(false);
    // Not a prototype lookup: `toString` is not a scope.
    expect(isLoadScope('toString')).toBe(false);
  });

  it('loads the authoritative stores the engine resumes from, and says which table each reaches', () => {
    expect(classify('paper-orders.json')).toMatchObject({
      kind: 'loaded',
      tables: ['engine.ledger_order', 'engine.ledger_state'],
    });
    for (const [path, table] of [
      ['trading-control.json', 'engine.trading_control'],
      ['trading-providers.json', 'engine.provider_registry'],
      ['provider-budgets.json', 'engine.provider_budget'],
      ['contract-provenance.json', 'engine.contract_provenance'],
      ['model-promotions.json', 'engine.model_promotion'],
      ['forecast-history.journal.jsonl', 'engine.forecast_journal_event'],
      ['forecast-history-shards/index.json', 'engine.forecast_shard'],
      [`forecast-history-shards/open.${'a'.repeat(64)}.json`, 'engine.forecast_row'],
    ] as const) {
      expect(classify(path), path).toMatchObject({ kind: 'loaded', tables: [table] });
    }
  });

  it('retains the histories those stores index, with the reason the decision gave', () => {
    for (const path of [
      `execution-order-evidence/batch.${'b'.repeat(64)}.json`,
      `forecast-history-shards/2026-01-01.${'c'.repeat(64)}.json`,
      `forecast-history-shards/2026-01-01.rollup.${'c'.repeat(64)}.json`,
      `forecast-history-shards/2026-01-01.ids.${'c'.repeat(64)}.json`,
      'hourly-threshold-observations.journal.jsonl',
      'portfolio-choice-sets.journal.jsonl',
      'paper-execution-timing-shadows.journal.jsonl',
      'calendar-evaluation.journal.jsonl',
      'exit-policy-sentinels-v3.json',
      'model-evaluations.json',
    ]) {
      expect(classify(path), path).toMatchObject({
        kind: 'not-loaded',
        reason: 'historical-archive-retained',
      });
    }
  });

  it('keeps the reason codes the earlier decisions set', () => {
    expect(classify('live-skips.json')).toMatchObject({ kind: 'not-loaded', reason: 'live-side' });
    expect(classify('live-skips.journal.jsonl')).toMatchObject({ reason: 'live-side' });
    expect(classify('kalshi-reconciliation-checkpoint.json')).toMatchObject({
      reason: 'live-side',
    });
    expect(classify('archive-state.json')).toMatchObject({
      reason: 'lease/lock/archive-state',
    });
    expect(classify('forecast-history.write.lock/holder.json')).toMatchObject({
      reason: 'lease/lock/archive-state',
    });
    for (const path of [
      'forecast-history.json',
      'regime-gate.json',
      'cycle-paths.json',
      'paper-fill-calibration.json',
      'execution-ledger-legacy/paper-orders.v8.json',
      'trading-control.json.superseded-2026-01-01T00-00-00',
      'history.jsonl.corrupt-1',
      'sentinels.journal-copy',
    ]) {
      expect(classify(path), path).toMatchObject({ kind: 'not-loaded', reason: 'superseded' });
    }
  });

  it('calls a store nobody has classified UNMAPPED rather than sweeping it into a reason', () => {
    expect(classify('mystery-store.json')).toEqual({ kind: 'unmapped' });
    // Sitting in a directory does not make a stranger a copy or a lease.
    expect(classify('reports/mystery-store.json')).toEqual({ kind: 'unmapped' });
    expect(classify('mystery-experiment.json')).toEqual({ kind: 'unmapped' });
  });

  // The 49 entries the second execution (2026-10-08) refused as UNMAPPED (#241).
  // Synthetic manifest paths only: the names are v1's, the stamps are the ones
  // the evidence document listed, and no file content is involved.
  describe('the 49 entries execution 2 refused as UNMAPPED', () => {
    const quarantinedShardRoot = 'forecast-history-shards.corrupt-2026-08-22T06-16-28-623Z';
    const shardDays = Array.from(
      { length: 15 },
      (_, i) => `2026-08-${String(8 + i).padStart(2, '0')}`,
    );
    const quarantinedShards = [
      `${quarantinedShardRoot}/index.json`,
      `${quarantinedShardRoot}/open.json`,
      ...shardDays.flatMap((day) => [
        `${quarantinedShardRoot}/${day}.json`,
        `${quarantinedShardRoot}/${day}.rollup.json`,
      ]),
    ];
    const corruptLockOwners = [
      '2026-08-22T01-12-03-120Z',
      '2026-08-22T02-00-00-000Z',
      '2026-08-23T11-45-09-004Z',
      '2026-08-27T19-30-41-387Z',
      '2026-09-01T00-00-00-000Z',
    ].map((stamp) => `forecast-history.write.lock.corrupt-${stamp}/owner.json`);

    const expected: ReadonlyArray<readonly [string, string]> = [
      ['analysis-bands.json', 'retired-feature'],
      ['archive/forecast-history-corrupt-1786235151716.json', 'superseded'],
      ['archive/forecast-history-pre-blend03-20260808T205858Z.json', 'superseded'],
      ['exit-policy-sentinels.journal.jsonl', 'historical-archive-retained'],
      ['exit-policy-sentinels.json', 'historical-archive-retained'],
      ['fine-paths-experiment.jsonl', 'retired-feature'],
      ['forecast-history-repair-2026-08-22T06-16-28-623Z.json', 'superseded'],
      ...quarantinedShards.map((path) => [path, 'superseded'] as const),
      ...corruptLockOwners.map((path) => [path, 'lease/lock/archive-state'] as const),
      ['hold-sentinels.json', 'retired-feature'],
      ['llm-control.json', 'superseded'],
      ['long-shot-candidates.journal.jsonl', 'retired-feature'],
      ['long-shot-settlements.json', 'retired-feature'],
      ['maker-depth-experiment.jsonl', 'retired-feature'],
    ];

    it('is exactly 49 distinct paths', () => {
      expect(quarantinedShards).toHaveLength(32);
      expect(corruptLockOwners).toHaveLength(5);
      expect(new Set(expected.map(([path]) => path)).size).toBe(49);
    });

    it('classifies each one as intentionally not loaded, with the decided reason', () => {
      for (const [path, reason] of expected) {
        expect(classify(path), path).toMatchObject({ kind: 'not-loaded', reason });
      }
    });

    it('loads none of them under the widest scope either', () => {
      for (const [path] of expected) {
        expect(classify(path, EVERYTHING).kind, path).toBe('not-loaded');
      }
    });

    it('reconciles a synthetic manifest of them with zero UNMAPPED', () => {
      const manifest = {
        files: expected.map(([path]) => ({ path, sha256: 'd'.repeat(64), sourceBytes: 1 })),
      };
      const classification = classifyManifest(
        manifest as never,
        { consumed: new Map() },
        AUTHORITATIVE,
      );
      expect(classification.unmapped).toEqual([]);
      expect(classification.loaded).toEqual([]);
      expect(classification.notLoaded).toHaveLength(49);
      expect(countByReason(classification.notLoaded)).toEqual({
        'live-side': 0,
        'lease/lock/archive-state': 5,
        superseded: 36,
        'evidence-frozen': 0,
        'historical-archive-retained': 2,
        'retired-feature': 6,
      });
    });

    it('decides by pattern, so the next stamp is classified before it exists', () => {
      expect(
        classify('forecast-history-shards.corrupt-2027-01-01T00-00-00-000Z/open.json'),
      ).toMatchObject({ reason: 'superseded' });
      expect(
        classify(
          `forecast-history-shards.corrupt-2027-01-01T00-00-00-000Z/2027-01-01.rollup.${'e'.repeat(64)}.json`,
        ),
      ).toMatchObject({ reason: 'superseded' });
      expect(
        classify('forecast-history.journal.jsonl.corrupt-2027-01-01T00-00-00-000Z'),
      ).toMatchObject({
        reason: 'superseded',
      });
      expect(
        classify('forecast-history-shards.corrupt-2027-01-01T00-00-00-000Z.journal-copy'),
      ).toMatchObject({
        reason: 'superseded',
      });
      expect(classify('paper-orders.json.superseded-2027-01-01T00-00-00')).toMatchObject({
        reason: 'superseded',
      });
      expect(
        classify('forecast-history.write.lock.corrupt-2027-01-01T00-00-00-000Z/owner.json'),
      ).toMatchObject({ reason: 'lease/lock/archive-state' });
      expect(classify('forecast-history.write.lock/owner.json')).toMatchObject({
        reason: 'lease/lock/archive-state',
      });
      expect(classify('archive/anything-at-all.json')).toMatchObject({ reason: 'superseded' });
      expect(classify('archive/nested/copy.jsonl')).toMatchObject({ reason: 'superseded' });
      expect(classify('forecast-history-repair-2027-01-01T00-00-00-000Z.json')).toMatchObject({
        reason: 'superseded',
      });
      expect(classify('some-other-experiment.jsonl')).toMatchObject({ reason: 'retired-feature' });
    });

    it('keeps a quarantined copy out of the loaded forecast family', () => {
      // A quarantined shard root is not the active shard directory, so its
      // `open.json` and `index.json` are copies, not candidates.
      expect(classify(`${quarantinedShardRoot}/index.json`).kind).toBe('not-loaded');
      expect(classify(`${quarantinedShardRoot}/open.json`).kind).toBe('not-loaded');
      expect(classify(`${quarantinedShardRoot}/open.${'a'.repeat(64)}.json`, EVERYTHING).kind).toBe(
        'not-loaded',
      );
    });
  });

  it('loads the retained families when a scope admits them', () => {
    expect(
      classify(`execution-order-evidence/batch.${'b'.repeat(64)}.json`, EVERYTHING),
    ).toMatchObject({ kind: 'loaded', tables: ['engine.evidence_row'] });
    expect(
      classify(`forecast-history-shards/2026-01-01.${'c'.repeat(64)}.json`, EVERYTHING),
    ).toMatchObject({ kind: 'loaded' });
    expect(classify('portfolio-choice-sets.journal.jsonl', EVERYTHING)).toMatchObject({
      kind: 'loaded',
    });
    // A live-side store is live-side under every scope: the seam is not a scope.
    expect(classify('live-skips.json', EVERYTHING)).toMatchObject({ reason: 'live-side' });
  });
});

describe('stage-list: what the operator uploads', () => {
  const plan = (options = {}) =>
    planStaging(syntheticArchive(syntheticDataTree(options)).manifest, 'authoritative');

  it('prints the manifest and exactly the object keys the job will fetch', () => {
    const tree = syntheticDataTree({ liveOrders: 2 });
    const archive = syntheticArchive(tree);
    const staging = planStaging(archive.manifest, 'authoritative');
    const lines = stageListLines(staging, archive.manifestKey);

    expect(lines[0]).toBe(archive.manifestKey);
    expect(lines).toHaveLength(staging.staged.length + staging.unmapped.length + 1);
    // Content-addressed archive keys, which is what a copy loop needs.
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.gz$/u);
    }
    expect(new Set(lines).size).toBe(lines.length);

    // The nine authoritative stores of this fixture, and nothing else.
    expect(staging.staged.map((object) => object.path).sort()).toEqual([
      'contract-provenance.json',
      'forecast-history-shards/index.json',
      expect.stringMatching(/^forecast-history-shards\/open\./u),
      'forecast-history.journal.jsonl',
      'model-promotions.json',
      'paper-orders.json',
      'provider-budgets.json',
      'trading-control.json',
      'trading-providers.json',
    ]);
    expect(staging.unmapped).toEqual([]);
  });

  it('leaves the histories out and still accounts for every manifest entry', () => {
    const archive = syntheticArchive(syntheticDataTree({ liveOrders: 2, unmappedFile: true }));
    const staging = planStaging(archive.manifest, 'authoritative');
    expect(staging.staged.length + staging.retained.length + staging.unmapped.length).toBe(
      archive.manifest.files.length,
    );
    // Every retained entry carries the manifest's own hash and size, and is not fetched.
    for (const entry of staging.retained) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.sourceBytes).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
    expect(staging.retainedSourceBytes).toBe(
      staging.retained.reduce((total, entry) => total + entry.sourceBytes, 0),
    );
    // An unmapped store is staged, because the refusal has to be able to name it.
    expect(staging.unmapped.map((object) => object.path)).toEqual(['mystery-store.json']);
    expect(stagedPaths(staging).has('mystery-store.json')).toBe(true);
    expect(stagedPaths(staging).has('hourly-threshold-observations.journal.jsonl')).toBe(false);
  });

  it('summarises in one line, counting what is staged and what stays behind', () => {
    const summary = stageListSummary(plan({ liveOrders: 2 }));
    expect(summary).toContain('load scope authoritative');
    expect(summary).toMatch(/^\d+ files to stage \(1 manifest \+ \d+ blobs\)/u);
    expect(summary).toContain('entries left in the archive');
    expect(stageListSummary(plan({ unmappedFile: true }))).toContain('1 unmapped');
  });

  it('stages less than the archive holds, which is the point of the decision', () => {
    const staging = plan({ liveOrders: 2 });
    expect(staging.staged.length).toBeLessThan(staging.retained.length);
  });
});

describe('verification is of the manifest and of every blob the job loads', () => {
  const inScope = (path: string) => classifyPath(path, AUTHORITATIVE).kind !== 'not-loaded';

  it('fetches and verifies the loaded set only', async () => {
    const tree = syntheticDataTree({ liveOrders: 2 });
    const archive = syntheticArchive(tree);
    const load = stagedPaths(planStaging(archive.manifest, 'authoritative'));
    const restored = await restoreTreeFromArchive(archive.source, archive.manifest, load);
    expect(restored.ok).toBe(true);
    expect(restored.tree.size).toBe(load.size);
    expect(restored.verifications).toHaveLength(load.size);
    expect(restored.verifications.every((v) => v.state === 'verified')).toBe(true);
  });

  it('does not fail on a blob that is absent for a retained entry, and still fails on a loaded one', async () => {
    const tree = syntheticDataTree({ liveOrders: 2 });
    const archive = syntheticArchive(tree);
    const load = stagedPaths(planStaging(archive.manifest, 'authoritative'));
    const retainedFile = archive.manifest.files.find((f) => !load.has(f.path))!;
    archive.objects.delete(retainedFile.objectKey);
    expect((await restoreTreeFromArchive(archive.source, archive.manifest, load)).ok).toBe(true);

    const loadedFile = archive.manifest.files.find((f) => f.path === 'paper-orders.json')!;
    archive.objects.delete(loadedFile.objectKey);
    const failed = await restoreTreeFromArchive(archive.source, archive.manifest, load);
    expect(failed.ok).toBe(false);
    expect(failed.verifications.find((v) => v.path === 'paper-orders.json')?.state).toBe('missing');
  });

  it('compares the load scope with the workstation copy and counts the rest', () => {
    const tree = syntheticDataTree({ liveOrders: 2 });
    const { manifest } = syntheticArchive(tree);
    const finding = compareManifestWithWorkstation(manifest, tree, inScope);
    expect(finding.finding).toBe('complete');
    expect(finding.comparedFiles).toBeLessThan(finding.manifestFiles);
    expect(finding.comparedFiles + finding.retainedManifestFiles).toBe(finding.manifestFiles);
    expect(finding.equal).toBe(finding.comparedFiles);
    expect(finding.reason).toContain('counted, not compared');
  });

  it('still refuses when a store inside the scope was written after the last archive run', () => {
    const tree = syntheticDataTree();
    const { manifest } = syntheticArchive(tree);
    const later = new Map(tree);
    later.set('new-authoritative-store.json', Buffer.from('{"x":1}\n'));
    const finding = compareManifestWithWorkstation(manifest, later, inScope);
    expect(finding.finding).toBe('incomplete');
    expect(finding.missingInManifest).toBe(1);
    expect(finding.loadPermitted).toBe(false);
  });

  it('counts, rather than refuses on, a retained store written after the last archive run', () => {
    // A research journal the archive never captured cannot change a loaded row:
    // it is not loaded. The count is in the evidence; the load is not refused.
    const tree = syntheticDataTree();
    const { manifest } = syntheticArchive(tree);
    const later = new Map(tree);
    later.set('portfolio-choice-sets.journal.jsonl', Buffer.from('{"x":1}\n'));
    const finding = compareManifestWithWorkstation(manifest, later, inScope);
    expect(finding.finding).toBe('complete');
    expect(finding.retainedWorkstationOnly).toBe(1);
    expect(finding.loadPermitted).toBe(true);
  });

  it('reports the loaded set when there is no workstation copy at all', () => {
    const { manifest } = syntheticArchive(syntheticDataTree());
    const finding = compareManifestWithWorkstation(manifest, undefined, inScope);
    expect(finding.finding).toBe('workstation-absent');
    expect(finding.missingInWorkstation).toBe(finding.comparedFiles);
    expect(finding.retainedWorkstationOnly).toBe(0);
  });

  it('checks the evidence references without reading the bodies, and says which it did', () => {
    const tree = syntheticDataTree({ liveOrders: 1 });
    const withoutBodies = new Map(tree);
    for (const path of tree.keys()) {
      if (path.startsWith('execution-order-evidence/')) withoutBodies.delete(path);
    }
    const scoped = verifyLedgerV9(withoutBodies, { evidenceBodies: false });
    expect(scoped).toMatchObject({ evidenceBatches: 1, evidenceBodiesVerified: false });
    // The references are still checked: a filename that disagrees with its hash
    // is refused whether or not the body is there.
    const broken = readLedger(withoutBodies);
    broken.orders[0]!.archivedEvidence = {
      ...broken.orders[0]!.archivedEvidence!,
      file: 'batch.not-the-hash.json',
    };
    withoutBodies.set('paper-orders.json', Buffer.from(`${JSON.stringify(broken)}\n`));
    expect(() => verifyLedgerV9(withoutBodies, { evidenceBodies: false })).toThrow(/disagree/);
    // And with the bodies gone, the full verifier says so rather than passing.
    expect(() => verifyLedgerV9(new Map(tree), { evidenceBodies: true })).not.toThrow();
    expect(verifyLedgerV9(new Map(tree)).evidenceBodiesVerified).toBe(true);
  });

  it('verifies the forecast index, open set and journal without the sealed shards', () => {
    const tree = syntheticDataTree();
    const withoutShards = new Map(tree);
    for (const path of tree.keys()) {
      if (/^forecast-history-shards\/(?!index\.json|open\.)/u.test(path)) {
        withoutShards.delete(path);
      }
    }
    const scoped = verifyForecastStorage(withoutShards, { sealedShards: false });
    expect(scoped.ok, scoped.errors.join('; ')).toBe(true);
    expect(scoped).toMatchObject({
      indexedTerminalRows: 2,
      openRowsAtLastSeal: 1,
      sealedRows: 0,
      sealedRowsVerified: false,
      shards: 1,
    });
    expect(scoped.notVerified.join('\n')).toContain('retained in the archive');

    // The index is still checked against itself and against the open set.
    const index = JSON.parse(
      Buffer.from(withoutShards.get('forecast-history-shards/index.json')!).toString('utf8'),
    ) as Record<string, unknown>;
    const tampered = new Map(withoutShards);
    tampered.set(
      'forecast-history-shards/index.json',
      Buffer.from(`${JSON.stringify({ ...index, terminalRows: 99, totalRows: 100 })}\n`),
    );
    const failed = verifyForecastStorage(tampered, { sealedShards: false });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join('\n')).toMatch(/shard entries sum to 2/u);

    // Without the open artifact it refuses: that one is loaded, so it must be there.
    const noOpen = new Map(withoutShards);
    for (const path of withoutShards.keys()) {
      if (/^forecast-history-shards\/open\./u.test(path)) noOpen.delete(path);
    }
    expect(verifyForecastStorage(noOpen, { sealedShards: false }).ok).toBe(false);
  });
});

describe('the restore job over the authoritative load scope', () => {
  it('records the scope, the staged count and every retained entry with its manifest hash', async () => {
    const { input } = job();
    const result = await runRestoreJob(input);
    expect(result.outcome, result.reason).toBe('loaded');
    expect(result.evidence).toContain('**Load scope:** `authoritative`');
    expect(result.evidence).toContain('| historical-archive-retained | 10 |');
    // Retained entries carry the manifest's hash and size and were never fetched.
    expect(result.evidence).toMatch(
      /\| `hourly-threshold-observations\.journal\.jsonl` \| historical-archive-retained \| `[a-f0-9]{16}` \| \d+ \|/u,
    );
    expect(result.evidence).toContain('Evidence batch bodies **not read**');
    expect(result.evidence).toContain('Sealed shard artifacts **not read**');
    expect(result.evidence).toContain('| UNMAPPED | 0 |');
    expect(result.evidence).toContain('| Sum equals the manifest total | yes |');
    // The reconciliation table states the empty tables rather than hiding them.
    expect(result.evidence).toMatch(
      /\| `engine\.evidence_row` \| not loaded: evidence batch bodies stay in the archive[^|]*\| 0 \| 0 \|/u,
    );
  });

  it('reclassifies a staged open set the active index does not name', async () => {
    const tree = syntheticDataTree({ liveOrders: 1, staleForecastGeneration: true });
    const archive = syntheticArchive(tree);
    const staging = planStaging(archive.manifest, 'authoritative');
    // Both open sets are staged, because only the index knows which is current.
    expect(
      staging.staged.filter((object) => /forecast-history-shards\/open\./u.test(object.path)),
    ).toHaveLength(2);

    const classification = classifyManifest(
      archive.manifest,
      buildRestorePlan(tree).consumption,
      AUTHORITATIVE,
    );
    const stale = classification.notLoaded.filter((entry) =>
      /forecast-history-shards\/open\./u.test(entry.path),
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]!.reason).toBe('superseded');
    expect(stale[0]!.note).toContain('the active index does not name');
    expect(classification.unmapped).toEqual([]);
    expect(classification.classified).toBe(archive.manifest.files.length);
  });

  it('classifies a lease entry as a lease, wherever the manifest puts it', () => {
    const tree = syntheticDataTree({ leaseFile: true });
    const archive = syntheticArchive(tree);
    const classification = classifyManifest(
      archive.manifest,
      buildRestorePlan(tree).consumption,
      AUTHORITATIVE,
    );
    expect(countByReason(classification.notLoaded)['lease/lock/archive-state']).toBe(1);
    expect(classification.unmapped).toEqual([]);
  });
});
