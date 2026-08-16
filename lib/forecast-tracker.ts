import 'server-only';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contractProvenanceRef } from './contract-provenance';
import { getContractProvenanceRegistry, recordContractProvenance } from './contract-provenance-store';
import { bestEntry, directionalLikelihood, qualifiesAsBuyEdge, venueEntryOptions, BUY_POLICY_VERSION } from './prediction-policy';
import { summarizePerformance } from './performance';
import {
  readAllShardRows, readForecastStorageIndex, readOpenSet, sealForecastStorage, summarizeFromStorage,
} from './forecast-store';
import { DATA_FRESHNESS } from './freshness';
import { calculationObservationId, signalObservationId, TRACKING_POLICY_VERSION } from './observation-window';
import type { ContractProvenanceRecord, PerformanceSummary, Prediction, TrackedForecast, TradingVenue, VenueOutcomeRecord } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'forecast-history.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'forecast-history.journal.jsonl');
const JOURNAL_COMPACTION_BYTES = 50 * 1024 * 1024;
/** Keeps well over 100 windows of one-minute, seven-asset calibration snapshots locally. */
const UNQUALIFIED_RETENTION = 20_000;
/** Cycles settled per pass. Bounds concurrent upstream requests without starving a resolution backlog. */
const RESOLUTION_CYCLES_PER_PASS = 20;
/** Backoff ceiling for a contract that never publishes an outcome. */
const RESOLUTION_MAX_RETRY_MS = 30 * 60_000;
/**
 * When a venue is treated as having abandoned a contract.
 *
 * Settlement is usually immediate — Kalshi's median is half a minute — but the tail is long, and the
 * slowest observed row still resolved after 146 minutes. Six hours sits far enough beyond that to
 * catch only genuinely abandoned contracts, never a slow one. Abandoned rows become `invalid`, which
 * excludes them from scoring: an outcome the venue never published cannot be graded, and inferring it
 * from the other venue is the cross-venue substitution the target-integrity rules forbid.
 */
const RESOLUTION_ABANDON_AFTER_MS = 6 * 60 * 60_000;
/**
 * Well inside the 15-second calculation cadence. A slower answer is worthless anyway: the pass simply
 * retries, so waiting longer only delayed work that had already missed its window.
 */
const RESOLUTION_TIMEOUT_MS = 3_000;
let resolutionInFlight = false;
let operationQueue: Promise<void> = Promise.resolve();
let forecastCache: Promise<TrackedForecast[]> | undefined;
let performanceCache: { generatedAt: number; summary: PerformanceSummary } | undefined;
// Full segment/calibration/timeline aggregation is expensive and settlement-driven; live predictions
// remain 15-second fresh while historical metrics may intentionally lag by at most one minute.
const PERFORMANCE_CACHE_MS = 60_000;

export type ForecastJournalEvent =
  | { op: 'upsert'; forecast: TrackedForecast }
  | { op: 'patch'; id: string; changes: Partial<TrackedForecast> }
  | { op: 'delete'; id: string };

export function replayForecastJournal(snapshot: TrackedForecast[], events: ForecastJournalEvent[]): TrackedForecast[] {
  const records = new Map(snapshot.map((forecast) => [forecast.id, forecast]));
  for (const event of events) {
    if (event.op === 'delete') records.delete(event.id);
    else if (event.op === 'upsert' && event.forecast?.id) records.set(event.forecast.id, event.forecast);
    else if (event.op === 'patch') {
      const existing = records.get(event.id);
      if (existing) records.set(event.id, { ...existing, ...event.changes });
    }
  }
  return [...records.values()];
}

/**
 * Reads durable history, tolerating a truncated or partially overwritten file.
 *
 * This history is append-mostly and irreplaceable, so a parse failure recovers the longest valid
 * prefix and quarantines the damaged copy rather than throwing. A corrupt record file previously took
 * down the whole performance view, which is a much worse outcome than losing the trailing entries.
 */
async function readForecastSnapshot(): Promise<TrackedForecast[]> {
  let raw: string;
  try {
    raw = await readFile(HISTORY_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as TrackedForecast[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    for (let end = raw.length; end > 2; end -= 1) {
      if (raw[end - 1] !== ']') continue;
      try {
        const recovered = JSON.parse(raw.slice(0, end)) as TrackedForecast[];
        if (!Array.isArray(recovered)) continue;
        console.error(`Forecast history was damaged; recovered ${recovered.length} records and quarantined the original.`);
        await writeFile(`${HISTORY_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
        await writeForecastSnapshot(recovered);
        return recovered;
      } catch { /* Keep scanning backwards for a complete array. */ }
    }
    console.error('Forecast history could not be parsed or recovered; starting a new file.');
    await writeFile(`${HISTORY_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
    return [];
  }
}

/**
 * Provenance is stored once in the registry and referenced from forecasts, not copied into each one.
 *
 * Rows carried a full copy of the venue contract record — 51 MB across the history, 39,290 copies of
 * 5,193 distinct records — which is the single largest thing in the file and the reason parsing it
 * blocked the event loop for around ten seconds. Every field was verified present and identical in the
 * registry beforehand, apart from `capturedAt`, which is per-observation and stays on the row. A
 * reference the registry cannot resolve keeps its full copy rather than losing anything.
 */
function slimProvenance(forecast: TrackedForecast, known: Set<string>): TrackedForecast {
  const contracts = forecast.venueContracts;
  if (!contracts) return forecast;
  const slimmed = Object.fromEntries(Object.entries(contracts).map(([venue, ref]) => [
    venue,
    ref?.registryId && known.has(ref.registryId)
      // Persisted form only; `rehydrateProvenance` restores the full record on load.
      ? { registryId: ref.registryId, capturedAt: ref.capturedAt } as unknown as typeof ref
      : ref,
  ]));
  return { ...forecast, venueContracts: slimmed as TrackedForecast['venueContracts'] };
}

function rehydrateProvenance(forecast: TrackedForecast, records: Map<string, ContractProvenanceRecord>): TrackedForecast {
  const contracts = forecast.venueContracts;
  if (!contracts) return forecast;
  let expanded = false;
  const restored = Object.fromEntries(Object.entries(contracts).map(([venue, ref]) => {
    const record = ref?.registryId ? records.get(ref.registryId) : undefined;
    // Only a slimmed reference needs expanding; a full copy is already whole.
    if (!record || ref?.contractId !== undefined) return [venue, ref];
    expanded = true;
    return [venue, { ...record, capturedAt: ref!.capturedAt ?? record.capturedAt } as unknown as typeof ref];
  }));
  return expanded ? { ...forecast, venueContracts: restored as TrackedForecast['venueContracts'] } : forecast;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function writeForecastSnapshot(forecasts: TrackedForecast[]): Promise<void> {
  // Compact JSON cuts the durable snapshot substantially; new observations use the append journal.
  const known = await knownProvenanceIds();
  await atomicWrite(HISTORY_FILE, JSON.stringify(forecasts.map((forecast) => slimProvenance(forecast, known))));
}

async function knownProvenanceIds(): Promise<Set<string>> {
  try {
    return new Set((await getContractProvenanceRegistry()).records.map((record) => record.registryId));
  } catch {
    // Without the registry nothing may be collapsed, because nothing could be restored.
    return new Set();
  }
}

async function readJournalEvents(): Promise<ForecastJournalEvent[]> {
  let raw = '';
  try {
    raw = await readFile(JOURNAL_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const validLines: string[] = [];
  const events: ForecastJournalEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let event: ForecastJournalEvent;
    try {
      event = JSON.parse(line) as ForecastJournalEvent;
    } catch {
      console.error('Forecast journal had a damaged trailing event; preserving its valid prefix and quarantining the original.');
      await writeFile(`${JOURNAL_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
      await atomicWrite(JOURNAL_FILE, validLines.length ? `${validLines.join('\n')}\n` : '');
      break;
    }
    validLines.push(line);
    events.push(event);
  }
  return events;
}

async function loadForecasts(): Promise<TrackedForecast[]> {
  const snapshot = await readForecastSnapshot();
  const replayed = replayForecastJournal(snapshot, await readJournalEvents());
  let records: Map<string, ContractProvenanceRecord>;
  try {
    records = new Map((await getContractProvenanceRegistry()).records.map((record) => [record.registryId, record]));
  } catch {
    return replayed;
  }
  return replayed.map((forecast) => rehydrateProvenance(forecast, records));
}

/**
 * Whether the sharded layout is authoritative. Absent or version-mismatched means the legacy snapshot
 * still is, which is what keeps this switch revertable: remove `index.json` and every path below falls
 * back to reading whole history exactly as before.
 */
let shardedLayout: Promise<boolean> | undefined;
function usingShardedLayout(): Promise<boolean> {
  shardedLayout ??= readForecastStorageIndex().then((index) => Boolean(index)).catch(() => false);
  return shardedLayout;
}

/**
 * The hot set: rows the cycle can still change, plus anything the journal has added since the last seal.
 *
 * This is the residency fix. The cached array was every row ever written — about 396 MB of parsed history
 * held to serve a working set near a hundred rows, growing 40 MB a day. A terminal row is immutable and
 * nothing on the fifteen-second path reads one, so only the open set stays resident.
 */
async function loadOpenForecasts(): Promise<TrackedForecast[]> {
  const open = await readOpenSet();
  const journal = await readJournalEvents();
  const replayed = replayForecastJournal(open, journal);
  let records: Map<string, ContractProvenanceRecord>;
  try {
    records = new Map((await getContractProvenanceRegistry()).records.map((record) => [record.registryId, record]));
  } catch {
    return replayed;
  }
  return replayed.map((forecast) => rehydrateProvenance(forecast, records));
}

async function readForecasts(): Promise<TrackedForecast[]> {
  forecastCache ??= usingShardedLayout().then((sharded) => (sharded ? loadOpenForecasts() : loadForecasts()));
  try {
    return await forecastCache;
  } catch (error) {
    forecastCache = undefined;
    throw error;
  }
}

/**
 * Every row, sealed and open. Transient and deliberately uncached: holding it is the cost the layout
 * exists to remove, so it is loaded for the evaluator and the on-demand reports and then released.
 */
export async function readFullForecastHistory(): Promise<TrackedForecast[]> {
  if (!(await usingShardedLayout())) return readForecasts();
  const [sealed, open] = await Promise.all([readAllShardRows(), readForecasts()]);
  const openIds = new Set(open.map((forecast) => forecast.id));
  // The open set wins on collision: a row can be sealed and then patched by the journal before the next
  // seal, and the journal is the newer statement.
  return [...sealed.filter((forecast) => !openIds.has(forecast.id)), ...open];
}

function resolutionPatch(forecast: TrackedForecast): Partial<TrackedForecast> {
  return {
    status: forecast.status, outcome: forecast.outcome, evaluationVenue: forecast.evaluationVenue,
    targetIntegrity: forecast.targetIntegrity, correct: forecast.correct, brierScore: forecast.brierScore,
    logLoss: forecast.logLoss, realizedReturn: forecast.realizedReturn, resolvedAt: forecast.resolvedAt,
    invalidReason: forecast.invalidReason, lastResolutionCheckAt: forecast.lastResolutionCheckAt,
    resolutionAttempts: forecast.resolutionAttempts,
    venueOutcomes: forecast.venueOutcomes,
  };
}

async function persistForecastChanges(
  upserts: TrackedForecast[], patches: TrackedForecast[], deletedIds: string[], retained: TrackedForecast[],
): Promise<void> {
  const known = await knownProvenanceIds();
  const events: ForecastJournalEvent[] = [
    ...upserts.map((forecast): ForecastJournalEvent => ({ op: 'upsert', forecast: slimProvenance(forecast, known) })),
    ...patches.map((forecast): ForecastJournalEvent => ({ op: 'patch', id: forecast.id, changes: resolutionPatch(forecast) })),
    ...deletedIds.map((id): ForecastJournalEvent => ({ op: 'delete', id })),
  ];
  if (!events.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(JOURNAL_FILE, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const journalSize = await stat(JOURNAL_FILE).then((value) => value.size).catch(() => 0);
  if (journalSize < JOURNAL_COMPACTION_BYTES) return;
  if (await usingShardedLayout()) {
    // Compaction under the sharded layout is a seal: terminal rows move into their day's shard, the open
    // set is rewritten, and the journal is cleared. This is the one place on the write path that touches
    // whole history, and it releases it immediately.
    //
    // `retained` is passed rather than re-read because the cache still holds the pre-commit state here,
    // and re-reading would seal a set missing the rows this very call just appended.
    const sealed = await readAllShardRows();
    const openIds = new Set(retained.map((forecast) => forecast.id));
    await sealForecastStorage(pruned([...sealed.filter((forecast) => !openIds.has(forecast.id)), ...retained]));
    return;
  }
  // Snapshot first, then clear the journal. A crash between these steps only replays idempotent events.
  await writeForecastSnapshot(retained);
  await atomicWrite(JOURNAL_FILE, '');
}

/**
 * Lifetime summary without holding lifetime rows.
 *
 * Under the sharded layout this is a sum over per-shard sufficient statistics plus the open rows, proven
 * field-by-field against the direct scan by `verifyForecastStoragePlan`. Under the legacy layout it is
 * still the direct scan, so the two agree during coexistence.
 */
async function cachedPerformanceSummary(forecasts: TrackedForecast[]): Promise<PerformanceSummary> {
  if (performanceCache && Date.now() - performanceCache.generatedAt < PERFORMANCE_CACHE_MS) return performanceCache.summary;
  const summary = await usingShardedLayout()
    ? (await summarizeFromStorage(forecasts)).summary
    : summarizePerformance(forecasts);
  performanceCache = { generatedAt: Date.now(), summary };
  return summary;
}

function predictionCycleId(prediction: Prediction): string {
  const slug = prediction.market.url.split('/').filter(Boolean).at(-1) ?? prediction.symbol;
  return `${slug}:${prediction.market.closesAt}`;
}

function storedCycleId(forecast: TrackedForecast): string {
  if (forecast.cycleId) return forecast.cycleId;
  const slug = forecast.marketUrl.split('/').filter(Boolean).at(-1) ?? forecast.symbol;
  return `${slug}:${forecast.closesAt}`;
}

function forecastId(prediction: Prediction, observedAt: number, qualified: boolean): string {
  return qualified
    ? signalObservationId(predictionCycleId(prediction), observedAt)
    : calculationObservationId(predictionCycleId(prediction), observedAt);
}

function newTrackedForecast(prediction: Prediction, modelVersion: string, observedAt: number, qualified: boolean): TrackedForecast {
  const isUp = prediction.modelProbabilityUp >= 0.5;
  const entry = bestEntry(prediction);
  return {
    qualified,
    entryVenue: entry?.venue,
    entrySide: entry?.side,
    entryAsk: entry?.price,
    entryFeeRate: entry?.feeRate,
    predictedEdge: entry?.netEdge,
    blendedProbabilityUp: prediction.blendedProbabilityUp,
    volatilityRatio: prediction.basis?.volatilityRatio,
    secondsRemaining: Math.max(0, (new Date(prediction.market.closesAt).getTime() - observedAt) / 1000),
    basisPercent: prediction.basis?.basisPercent,
    basisProbabilityUp: prediction.basis?.probabilityUp,
    calibrationReplay: prediction.calibrationReplay,
    cycleRegime: prediction.cycleRegime,
    settlementAverageEstimate: prediction.settlementAverageEstimate,
    makerFillEstimate: prediction.makerFillEstimate,
    venueProbabilityUp: prediction.venueProbabilityUp,
    targetComparison: prediction.targetComparison,
    id: forecastId(prediction, observedAt, qualified), cycleId: predictionCycleId(prediction),
    trackingPolicyVersion: TRACKING_POLICY_VERSION,
    symbol: prediction.symbol, marketUrl: prediction.market.url,
    issuedAt: new Date(observedAt).toISOString(), closesAt: prediction.market.closesAt,
    direction: isUp ? 'UP' : 'DOWN', probabilityUp: prediction.modelProbabilityUp,
    directionalLikelihood: directionalLikelihood(prediction), confidence: prediction.confidence,
    // Calibration-only records omit the drill-down payload that is never read back for them.
    confidenceBreakdown: qualified ? prediction.confidenceBreakdown : undefined,
    modelVersion, policyVersion: BUY_POLICY_VERSION,
    polymarketProbabilityUp: prediction.market.probabilityUp,
    kalshiProbabilityUp: prediction.kalshi?.probabilityUp,
    enabledTradingVenues: prediction.enabledTradingVenues,
    actionableVenuePrices: venueEntryOptions(prediction).map(({ venue, side, price }) => ({ venue, side, price })),
    venueContracts: {
      ...(prediction.market.contract ? { polymarket: contractProvenanceRef(prediction.market.contract) } : {}),
      ...(prediction.kalshi?.contract ? { kalshi: contractProvenanceRef(prediction.kalshi.contract) } : {}),
    },
    factors: qualified ? prediction.factors.map(({ id, label, score, weight, contribution, confidence, available }) => ({ id, label, score, weight, contribution, confidence, available })) : [],
    status: 'pending',
  };
}

type GammaMarket = { id?: string; conditionId?: string; closed?: boolean; outcomes?: string; outcomePrices?: string; umaResolutionStatus?: string };
type GammaEvent = { closed?: boolean; markets?: GammaMarket[] };
type ResolutionResult = { outcome: 'UP' | 'DOWN' } | { invalidReason: string };

function venueOutcome(venue: TradingVenue, contractId: string, result: ResolutionResult, resolutionSource: string): VenueOutcomeRecord {
  return {
    venue, contractId, ...result, resolutionSource,
    resolvedAt: new Date().toISOString(),
  };
}

/** Issuance contract, falling back to the slug for rows written before provenance was recorded. */
function polymarketContractId(forecast: TrackedForecast): string {
  return forecast.venueContracts?.polymarket?.contractId
    ?? `legacy:${forecast.marketUrl.split('/').filter(Boolean).at(-1) ?? forecast.symbol}`;
}

async function resolvePolymarketOutcome(forecast: TrackedForecast): Promise<VenueOutcomeRecord | null> {
  const reference = forecast.venueContracts?.polymarket;
  const slug = forecast.marketUrl.split('/').filter(Boolean).at(-1);
  if (!slug) return null;
  const resolutionSource = reference?.rulesSource ?? `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.2 local-research' },
    signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS), cache: 'no-store',
  });
  if (!response.ok) return null;
  const event = (await response.json() as GammaEvent[])[0];
  const market = event?.markets?.find((item) => item.conditionId === reference?.contractId || item.id === reference?.contractId)
    ?? event?.markets?.[0];
  if (!event?.closed && !market?.closed) return null;
  const outcomes = JSON.parse(market?.outcomes ?? '["Up","Down"]') as string[];
  const prices = (JSON.parse(market?.outcomePrices ?? '[]') as string[]).map(Number);
  const winnerIndex = prices.findIndex((price) => price >= 0.999);
  const contractId = reference?.contractId ?? market?.conditionId ?? market?.id ?? slug;
  if (winnerIndex < 0) {
    return market?.umaResolutionStatus === 'resolved'
      ? venueOutcome('polymarket', contractId, { invalidReason: 'Market resolved without a binary UP/DOWN winner' }, resolutionSource)
      : null;
  }
  const winner = outcomes[winnerIndex]?.toUpperCase();
  return winner === 'UP' || winner === 'DOWN'
    ? venueOutcome('polymarket', contractId, { outcome: winner }, resolutionSource)
    : venueOutcome('polymarket', contractId, { invalidReason: `Unsupported winning outcome: ${winner || 'unknown'}` }, resolutionSource);
}

async function resolveKalshiOutcome(forecast: TrackedForecast): Promise<VenueOutcomeRecord | null> {
  const reference = forecast.venueContracts?.kalshi;
  if (!reference) return null;
  const resolutionSource = `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(reference.contractId)}`;
  const response = await fetch(resolutionSource, {
    headers: { Accept: 'application/json', 'User-Agent': 'MoneyNoodle/0.2 local-research' },
    signal: AbortSignal.timeout(RESOLUTION_TIMEOUT_MS), cache: 'no-store',
  });
  if (!response.ok) return null;
  const body = await response.json() as { market?: { result?: string; status?: string } };
  const result = body.market?.result?.toLowerCase();
  if (result === 'yes') return venueOutcome('kalshi', reference.contractId, { outcome: 'UP' }, resolutionSource);
  if (result === 'no') return venueOutcome('kalshi', reference.contractId, { outcome: 'DOWN' }, resolutionSource);
  const status = body.market?.status?.toLowerCase();
  if ((status === 'settled' || status === 'finalized') && result) {
    return venueOutcome('kalshi', reference.contractId, { invalidReason: `Unsupported Kalshi result: ${result}` }, resolutionSource);
  }
  return null;
}

export function evaluationTargetForForecast(forecast: TrackedForecast): {
  venue: TradingVenue;
  integrity: NonNullable<TrackedForecast['targetIntegrity']>;
  resolution?: VenueOutcomeRecord;
} {
  const venue = forecast.entryVenue ?? 'polymarket';
  const hasAnyProvenance = Boolean(forecast.venueContracts && Object.keys(forecast.venueContracts).length);
  if (!hasAnyProvenance) return { venue: 'polymarket', integrity: 'legacy-polymarket', resolution: forecast.venueOutcomes?.polymarket };
  const reference = forecast.venueContracts?.[venue];
  const resolution = forecast.venueOutcomes?.[venue];
  if (reference && resolution && reference.contractId !== resolution.contractId) {
    return { venue, integrity: 'mismatched-outcome', resolution };
  }
  return {
    venue,
    integrity: reference ? 'venue-specific' : 'missing-provenance',
    resolution: reference ? resolution : undefined,
  };
}

function scoreResolution(forecast: TrackedForecast, outcome: 'UP' | 'DOWN', venue: TradingVenue, integrity: NonNullable<TrackedForecast['targetIntegrity']>): void {
  const actual = outcome === 'UP' ? 1 : 0;
  const probability = Math.min(0.999999, Math.max(0.000001, forecast.probabilityUp));
  forecast.status = 'resolved';
  forecast.outcome = outcome;
  forecast.evaluationVenue = venue;
  forecast.targetIntegrity = integrity;
  forecast.correct = forecast.direction === outcome;
  forecast.brierScore = (probability - actual) ** 2;
  forecast.logLoss = -(actual * Math.log(probability) + (1 - actual) * Math.log(1 - probability));
  // Return uses the outcome from the same venue as the stored entry price.
  if (forecast.entryAsk !== undefined) {
    const cost = forecast.entryAsk + (forecast.entryFeeRate ?? 0);
    const purchasedSide = forecast.entrySide ?? 'UP';
    forecast.realizedReturn = (outcome === purchasedSide ? 1 : 0) - cost;
  }
  forecast.resolvedAt = new Date().toISOString();
}

/**
 * Prunes, journals, and republishes the cache for a mutated forecast list. Shared by calculation
 * recording and resolution so both commit through exactly one durability path.
 */
async function commitForecastChanges(
  forecasts: TrackedForecast[], newForecastIds: Set<string>, patchedForecastIds: Set<string>,
): Promise<TrackedForecast[]> {
  const retained = pruned(forecasts);
  const retainedIds = new Set(retained.map((forecast) => forecast.id));
  const deletedIds = forecasts.filter((forecast) => !retainedIds.has(forecast.id)).map((forecast) => forecast.id);
  const upserts = retained.filter((forecast) => newForecastIds.has(forecast.id));
  const patches = retained.filter((forecast) => patchedForecastIds.has(forecast.id) && !newForecastIds.has(forecast.id));
  try {
    await persistForecastChanges(upserts, patches, deletedIds, retained);
    forecastCache = Promise.resolve(retained);
  } catch (error) {
    // Discard mutated memory so a failed append cannot make an undurable observation appear committed.
    forecastCache = undefined;
    throw error;
  }
  return retained;
}

async function updateTracking(predictions: Prediction[], modelVersion: string): Promise<PerformanceSummary> {
  await recordContractProvenance(predictions);
  const forecasts = await readForecasts();
  const known = new Set(forecasts.map((forecast) => forecast.id));
  const newForecastIds = new Set<string>();
  let changed = false;
  const observedAt = Date.now();
  for (const prediction of predictions) {
    if (!prediction.market.live || new Date(prediction.market.closesAt).getTime() <= observedAt) continue;
    // Every calculation is recorded, not only qualifying ones, so calibration is measured without
    // the selection bias of scoring the model solely where its own policy chose to act.
    const candidate = newTrackedForecast(prediction, modelVersion, observedAt, qualifiesAsBuyEdge(prediction));
    if (!known.has(candidate.id)) {
      forecasts.push(candidate);
      known.add(candidate.id);
      newForecastIds.add(candidate.id);
      changed = true;
    }
  }

  if (!changed) return await cachedPerformanceSummary(forecasts);
  return await cachedPerformanceSummary(await commitForecastChanges(forecasts, newForecastIds, new Set()));
}

function pruned(forecasts: TrackedForecast[]): TrackedForecast[] {
  const unqualified = forecasts.filter((forecast) => forecast.qualified === false);
  if (unqualified.length <= UNQUALIFIED_RETENTION) return forecasts;
  const keep = new Set(unqualified
    .sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime())
    .slice(0, UNQUALIFIED_RETENTION).map((forecast) => forecast.id));
  return forecasts.filter((forecast) => forecast.qualified !== false || keep.has(forecast.id));
}

export function trackCalculations(predictions: Prediction[], modelVersion: string): Promise<PerformanceSummary> {
  const operation = operationQueue.then(() => updateTracking(predictions, modelVersion));
  operationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/**
 * Retry delay for a forecast whose venue has not published an outcome yet. The first miss retries on
 * the ordinary interval; each further miss doubles it, up to the cap. A contract that will never
 * resolve therefore costs a couple of requests an hour instead of one every minute forever.
 */
export function resolutionRetryDelayMs(attempts: number): number {
  return Math.min(RESOLUTION_MAX_RETRY_MS, DATA_FRESHNESS.resolutionRetryMs * 2 ** Math.max(0, attempts - 1));
}

/** True once the evaluation venue has had long enough that silence means abandonment, not slowness. */
export function abandonedByVenue(forecast: TrackedForecast, now: number): boolean {
  return now - new Date(forecast.closesAt).getTime() >= RESOLUTION_ABANDON_AFTER_MS;
}

export function resolutionDue(forecast: TrackedForecast, now: number): boolean {
  if (forecast.status !== 'pending' || new Date(forecast.closesAt).getTime() >= now) return false;
  if (!forecast.lastResolutionCheckAt) return true;
  return now - new Date(forecast.lastResolutionCheckAt).getTime() >= resolutionRetryDelayMs(forecast.resolutionAttempts ?? 0);
}

/** Fetches both venues for one cycle. Each venue is requested once; neither substitutes for the other. */
async function fetchCycleOutcomes(cycleForecasts: TrackedForecast[]): Promise<Map<string, VenueOutcomeRecord>> {
  const requests = new Map<string, { venue: TradingVenue; forecast: TrackedForecast }>();
  for (const forecast of cycleForecasts) {
    requests.set(`polymarket:${polymarketContractId(forecast)}`, { venue: 'polymarket', forecast });
    const kalshiId = forecast.venueContracts?.kalshi?.contractId;
    if (kalshiId) requests.set(`kalshi:${kalshiId}`, { venue: 'kalshi', forecast });
  }
  const requested = [...requests.entries()];
  const results = await Promise.allSettled(requested.map(([, request]) => request.venue === 'polymarket'
    ? resolvePolymarketOutcome(request.forecast)
    : resolveKalshiOutcome(request.forecast)));
  const resolved = new Map<string, VenueOutcomeRecord>();
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value) resolved.set(requested[index][0], result.value);
  });
  return resolved;
}

/** Applies fetched outcomes to one cycle. Returns true when any forecast reached a terminal state. */
function applyCycleOutcomes(cycleForecasts: TrackedForecast[], resolvedByContract: Map<string, VenueOutcomeRecord>): boolean {
  let resolvedAny = false;
  for (const forecast of cycleForecasts) {
    const polyId = polymarketContractId(forecast);
    const kalshiId = forecast.venueContracts?.kalshi?.contractId;
    const ownOutcomes: Partial<Record<TradingVenue, VenueOutcomeRecord>> = {
      ...(resolvedByContract.get(`polymarket:${polyId}`) ? { polymarket: resolvedByContract.get(`polymarket:${polyId}`)! } : {}),
      ...(kalshiId && resolvedByContract.get(`kalshi:${kalshiId}`) ? { kalshi: resolvedByContract.get(`kalshi:${kalshiId}`)! } : {}),
    };
    forecast.venueOutcomes = { ...forecast.venueOutcomes, ...ownOutcomes };
    const target = evaluationTargetForForecast(forecast);
    forecast.evaluationVenue = target.venue;
    forecast.targetIntegrity = target.integrity;
    if (target.integrity === 'missing-provenance' || target.integrity === 'mismatched-outcome') {
      forecast.status = 'invalid';
      forecast.invalidReason = target.integrity === 'missing-provenance'
        ? `Missing issuance-time ${target.venue} contract provenance; cross-venue outcome substitution is forbidden.`
        : `${target.venue} outcome contract ${target.resolution?.contractId ?? 'unknown'} does not match issuance contract ${forecast.venueContracts?.[target.venue]?.contractId ?? 'unknown'}.`;
      forecast.resolvedAt = new Date().toISOString();
    } else if (target.resolution?.outcome) {
      scoreResolution(forecast, target.resolution.outcome, target.venue, target.integrity);
    } else if (target.resolution?.invalidReason) {
      forecast.status = 'invalid';
      forecast.invalidReason = `${target.venue}: ${target.resolution.invalidReason}`;
      forecast.resolvedAt = new Date().toISOString();
    }
    if (forecast.status === 'pending' && abandonedByVenue(forecast, Date.now())) {
      forecast.status = 'invalid';
      forecast.invalidReason = `${forecast.evaluationVenue ?? 'venue'} published no outcome for ${forecast.venueContracts?.[forecast.evaluationVenue ?? 'kalshi']?.contractId ?? 'the issuance contract'} within ${RESOLUTION_ABANDON_AFTER_MS / 3_600_000} hours of close.`;
      forecast.resolvedAt = new Date().toISOString();
    }
    // A pass that produced nothing counts against the backoff; any terminal state clears it.
    if (forecast.status === 'pending') forecast.resolutionAttempts = (forecast.resolutionAttempts ?? 0) + 1;
    else { forecast.resolutionAttempts = undefined; resolvedAny = true; }
  }
  return resolvedAny;
}

/**
 * Settles windows that have already closed.
 *
 * This runs on its own schedule rather than inside `trackCalculations`, because it is bookkeeping about
 * the past and the forecast cycle is about the present. Inline, one venue that had not yet published an
 * outcome held the entire 15-second calculation behind a 10-second request — so a handful of forecasts
 * stuck pending made every cycle late, indefinitely. Nothing here blocks a calculation now: the network
 * phase holds no lock, and only the short apply phase is serialized against other writers.
 */
export async function resolveDueForecasts(): Promise<{ cycles: number; resolved: number }> {
  if (resolutionInFlight) return { cycles: 0, resolved: 0 };
  resolutionInFlight = true;
  try {
    const now = Date.now();
    const due = (await readForecasts()).filter((forecast) => resolutionDue(forecast, now));
    const dueCycles = new Map<string, TrackedForecast[]>();
    for (const forecast of due) {
      const id = storedCycleId(forecast);
      dueCycles.set(id, [...(dueCycles.get(id) ?? []), forecast]);
    }
    const selected = [...dueCycles.values()].slice(0, RESOLUTION_CYCLES_PER_PASS);
    if (!selected.length) return { cycles: 0, resolved: 0 };

    // Network phase: deliberately outside the write queue so a slow venue delays nothing but itself.
    const fetched = await Promise.all(selected.map(async (cycleForecasts) => ({
      cycleForecasts,
      // A failed fetch resolves nothing and simply counts toward this cycle's backoff.
      outcomes: await fetchCycleOutcomes(cycleForecasts).catch(() => new Map<string, VenueOutcomeRecord>()),
    })));

    const apply = operationQueue.then(async () => {
      const checkedAt = new Date().toISOString();
      const patchedForecastIds = new Set<string>();
      let resolved = 0;
      for (const { cycleForecasts, outcomes } of fetched) {
        for (const forecast of cycleForecasts) {
          forecast.lastResolutionCheckAt = checkedAt;
          patchedForecastIds.add(forecast.id);
        }
        if (applyCycleOutcomes(cycleForecasts, outcomes)) resolved += 1;
      }
      await commitForecastChanges(await readForecasts(), new Set(), patchedForecastIds);
      return { cycles: selected.length, resolved };
    });
    operationQueue = apply.then(() => undefined, () => undefined);
    return await apply;
  } finally {
    resolutionInFlight = false;
  }
}

export async function getPerformanceSummary(): Promise<PerformanceSummary> {
  return cachedPerformanceSummary(await readForecasts());
}

/**
 * Whole history, newest first, for the evaluator and the on-demand reports.
 *
 * Loaded lazily and not cached: this is the shape whose residency the sharded layout exists to remove, so
 * it is read when something genuinely needs history and released afterwards. Nothing on the fifteen-second
 * path calls it.
 */
export interface ForecastStorageHealth {
  layout: 'sharded' | 'legacy';
  openRows: number;
  sealedRows: number;
  shards: number;
  /** Shards whose rollup could not be read. Every one of them is missing from every lifetime figure. */
  missingRollups: number;
  degraded: boolean;
  reason: string;
}

/**
 * Whether the lifetime summary is being computed from complete statistics.
 *
 * A missing rollup does not fail loudly — the summary is still produced, just from fewer shards — so the
 * only protection against silently under-reporting a lifetime figure is saying so. Reported rather than
 * thrown because a degraded read is better than no dashboard, but it must never look healthy.
 */
export async function getForecastStorageHealth(): Promise<ForecastStorageHealth> {
  if (!(await usingShardedLayout())) {
    return {
      layout: 'legacy', openRows: (await readForecasts()).length, sealedRows: 0, shards: 0,
      missingRollups: 0, degraded: false,
      reason: 'Reading the legacy whole-history snapshot; sharded storage is not active.',
    };
  }
  const index = await readForecastStorageIndex();
  const source = await summarizeFromStorage(await readForecasts());
  const degraded = source.missingRollups > 0;
  return {
    layout: 'sharded',
    openRows: source.openRows,
    sealedRows: index?.terminalRows ?? 0,
    shards: index?.shards.length ?? 0,
    missingRollups: source.missingRollups,
    degraded,
    reason: degraded
      ? `${source.missingRollups} shard rollup(s) could not be read; lifetime figures are missing those rows.`
      : `${source.shardRollups} shard rollup(s) cover ${index?.terminalRows ?? 0} sealed rows beside ${source.openRows} open rows.`,
  };
}

export async function getForecastHistory(): Promise<TrackedForecast[]> {
  return [...await readFullForecastHistory()].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
}
