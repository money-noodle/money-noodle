// Which v1 stores the restore loads, and which stay in the append-only archive
// (maintainer decision 2026-10-08, recorded on #241).
//
// The engine resumes from the authoritative stores: the paper ledger with its
// bankroll corrections, the paper side of trading control, the provider registry
// and its budgets, the forecast journal, model promotions, contract provenance,
// and the *index* of each archive-backed store. The histories those indexes point
// at — sealed forecast shard rows, evidence batch bodies, the research journals —
// are read by neither the engine nor the UI. They are not loaded, not staged and
// not fetched; they stay in the archive and are recorded in the evidence document
// with the manifest's own hash and size and the reason they were left there.
//
// This is one table, keyed by manifest path, deliberately. The loaded set has to
// be decidable from the manifest alone, because `stage-list` prints exactly what
// to upload before a single blob has been fetched, and because a classification
// the operator cannot reproduce by reading a table is not a reviewable one.
// Nothing here is a location: every name is the manifest's own relative path
// inside the v1 data directory.

export type NotLoadedReason =
  | 'live-side'
  | 'lease/lock/archive-state'
  | 'superseded'
  | 'evidence-frozen'
  | 'historical-archive-retained';

export const NOT_LOADED_REASONS: ReadonlyArray<NotLoadedReason> = [
  'live-side',
  'lease/lock/archive-state',
  'superseded',
  'evidence-frozen',
  'historical-archive-retained',
];

/**
 * What a scope admits. Each flag is a store family whose *bodies* are either
 * loaded as rows or left in the archive; the indexes that name them are
 * authoritative and are loaded under every scope.
 */
export interface LoadScopeRules {
  /** Evidence batch bodies become `engine.evidence_row` rows. */
  readonly evidenceBodies: boolean;
  /** Sealed shard rows, rollups and id artifacts become `engine.forecast_row` rows. */
  readonly sealedForecastShards: boolean;
  /** Research journals and snapshots become rows. */
  readonly researchStores: boolean;
}

/**
 * One scope for now. It is a named table rather than a boolean so that widening
 * the restore later is a reviewed entry here and a value in the evidence
 * document, not an edit spread across the transform and its verifiers.
 */
export const LOAD_SCOPES = {
  authoritative: {
    evidenceBodies: false,
    researchStores: false,
    sealedForecastShards: false,
  },
} as const satisfies Record<string, LoadScopeRules>;

export type LoadScope = keyof typeof LOAD_SCOPES;

export const LOAD_SCOPE_NAMES: ReadonlyArray<LoadScope> = Object.keys(LOAD_SCOPES) as LoadScope[];

export const DEFAULT_LOAD_SCOPE: LoadScope = 'authoritative';

export const rulesFor = (scope: LoadScope): LoadScopeRules => LOAD_SCOPES[scope];

export const isLoadScope = (value: string): value is LoadScope =>
  Object.prototype.hasOwnProperty.call(LOAD_SCOPES, value);

export const EVIDENCE_DIRECTORY = 'execution-order-evidence';
export const FORECAST_DIRECTORY = 'forecast-history-shards';
export const FORECAST_INDEX = `${FORECAST_DIRECTORY}/index.json`;
export const FORECAST_JOURNAL = 'forecast-history.journal.jsonl';

/**
 * The authoritative stores, by exact manifest path, with the `engine` tables
 * their rows reach. The forecast shard index is here and the sealed shards are
 * not: an index is a catalogue of what the archive holds, which is what the
 * decision loads, and the rows behind it are the history it does not.
 */
export const AUTHORITATIVE_STORES: ReadonlyArray<{
  readonly path: string;
  readonly tables: readonly string[];
  readonly note: string;
}> = [
  {
    path: 'paper-orders.json',
    tables: ['engine.ledger_order', 'engine.ledger_state'],
    note: 'the paper ledger, its bankroll corrections, and the evidence batch index each paper order carries',
  },
  {
    path: 'trading-control.json',
    tables: ['engine.trading_control'],
    note: 'the paper fields of trading control',
  },
  {
    path: 'trading-providers.json',
    tables: ['engine.provider_registry'],
    note: 'the provider registry, live flag dropped at the seam',
  },
  {
    path: 'provider-budgets.json',
    tables: ['engine.provider_budget'],
    note: 'provider paper ceilings',
  },
  {
    path: 'contract-provenance.json',
    tables: ['engine.contract_provenance'],
    note: 'contract provenance',
  },
  {
    path: 'model-promotions.json',
    tables: ['engine.model_promotion'],
    note: 'the manual model promotion ledger',
  },
  {
    path: FORECAST_JOURNAL,
    tables: ['engine.forecast_journal_event'],
    note: 'the forecast journal, replayed onto the open set',
  },
  {
    path: FORECAST_INDEX,
    tables: ['engine.forecast_shard'],
    note: 'the forecast shard index: shard ids, hashes and row counts, never the sealed rows themselves. It is also what says which journal bytes the last seal already incorporated, so the journal cannot be read without it',
  },
];

const AUTHORITATIVE_BY_PATH = new Map(
  AUTHORITATIVE_STORES.map((store) => [store.path, store] as const),
);

/**
 * The open forecast set at the last seal. Its name carries its own content hash,
 * so which one the active generation names is only knowable from the index, and
 * the index cannot be read while deciding what to stage. Every candidate is
 * therefore in the loaded set; the one the index does not name is reclassified as
 * superseded once the transform has read the index.
 */
const FORECAST_OPEN_SET = /^open\..+\.json$/;

/** v1 research journals: sentinels, choice sets, timing shadows, calendar evaluation. */
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
  { file: 'exit-policy-sentinels-v2.json', store: 'exit-policy-sentinels-v2' },
  { file: 'maker-lifecycle-sentinels.json', store: 'maker-lifecycle-sentinels' },
  { file: 'paper-execution-timing-shadows.json', store: 'paper-execution-timing-shadows' },
];

const RESEARCH_FILES = new Set<string>([
  ...RESEARCH_JOURNALS.map((entry) => entry.file),
  ...RESEARCH_SNAPSHOTS.map((entry) => entry.file),
]);

/** Live-side stores, never loaded under any scope (maintainer decision 2026-10-06). */
const LIVE_SIDE_FILES = new Set([
  'live-skips.json',
  'live-skips.journal.jsonl',
  'kalshi-reconciliation-checkpoint.json',
]);

/** Derived, rebuildable or retired stores (sanitized v1 engine inventory B.1: 3, 10, 22, 25, 27). */
const SUPERSEDED_FILES = new Map<string, string>([
  ['forecast-history.json', 'legacy v2 snapshot superseded by storage v4 shards'],
  ['regime-gate.json', 'derived control, regenerated by the new engine'],
  ['cycle-paths.json', 'derived report input, regenerated by the new engine'],
  ['paper-fill-calibration.json', 'configuration re-entered by hand in the new system'],
]);

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Quarantine and migration copies the v1 writer kept beside a store. */
export function isQuarantineCopy(path: string): boolean {
  const name = base(path);
  return /\.corrupt-/.test(name) || /\.superseded-/.test(name) || name.endsWith('.journal-copy');
}

export function isLeaseOrState(path: string): boolean {
  if (base(path) === 'archive-state.json') return true;
  return path.split('/').some((part) => part.endsWith('.lock') || part.endsWith('.lock/'));
}

export type LoadClass =
  | { readonly kind: 'loaded'; readonly tables: readonly string[]; readonly note: string }
  | { readonly kind: 'not-loaded'; readonly reason: NotLoadedReason; readonly note: string }
  | { readonly kind: 'unmapped' };

const loaded = (tables: readonly string[], note: string): LoadClass => ({
  kind: 'loaded',
  note,
  tables,
});
const retained = (reason: NotLoadedReason, note: string): LoadClass => ({
  kind: 'not-loaded',
  note,
  reason,
});

const ARCHIVE_RETAINED = 'historical-archive-retained' as const;

/**
 * The classification table. First matching rule wins, and the order is the
 * meaning: a live-side or lease entry is live-side or a lease whatever directory
 * it sits in, and a store the table has never heard of is UNMAPPED rather than
 * quietly swept into a reason.
 *
 * Decidable from the path and the scope alone, so `stage-list`, the staged
 * download, the blob verification and the evidence document all answer the same
 * question the same way.
 */
export function classifyPath(path: string, rules: LoadScopeRules): LoadClass {
  const authoritative = AUTHORITATIVE_BY_PATH.get(path);
  if (authoritative) return loaded(authoritative.tables, authoritative.note);

  if (isLeaseOrState(path)) {
    return retained('lease/lock/archive-state', 'leases, locks and archive state never migrate');
  }
  if (LIVE_SIDE_FILES.has(path)) {
    return retained('live-side', 'live-side store dropped at the paper seam');
  }
  if (path.startsWith(`${EVIDENCE_DIRECTORY}/`)) {
    return rules.evidenceBodies
      ? loaded(['engine.evidence_row'], 'evidence batch bodies')
      : retained(
          ARCHIVE_RETAINED,
          'evidence batch body: history for analysis, read by neither the engine nor the UI. The index of it is loaded on each paper ledger order',
        );
  }
  if (path.startsWith('execution-ledger-legacy/')) {
    return retained('superseded', 'pre-v9 ledger copy; the v9 ledger is loaded instead');
  }
  if (path.startsWith(`${FORECAST_DIRECTORY}/`)) {
    if (FORECAST_OPEN_SET.test(base(path))) {
      return loaded(['engine.forecast_row'], 'the open forecast set the journal replays onto');
    }
    return rules.sealedForecastShards
      ? loaded(['engine.forecast_row', 'engine.forecast_shard'], 'sealed shard artifacts')
      : retained(
          ARCHIVE_RETAINED,
          'sealed forecast artifact: terminal history for analysis. The shard index that names it is loaded',
        );
  }
  if (RESEARCH_FILES.has(path)) {
    return rules.researchStores
      ? loaded(['engine.research_journal_event', 'engine.research_snapshot'], 'research store')
      : retained(
          ARCHIVE_RETAINED,
          'research journal or snapshot: history for analysis, read by neither the engine nor the UI',
        );
  }
  if (isQuarantineCopy(path)) {
    return retained('superseded', 'quarantine or migration copy kept beside its store');
  }
  const supersededNote = SUPERSEDED_FILES.get(path);
  if (supersededNote) return retained('superseded', supersededNote);

  return { kind: 'unmapped' };
}
