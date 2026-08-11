import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contractProvenanceRef } from './contract-provenance';
import { recordContractProvenance } from './contract-provenance-store';
import { bestEntry, directionalLikelihood, qualifiesAsBuyEdge, venueEntryOptions, BUY_POLICY_VERSION } from './prediction-policy';
import { summarizePerformance } from './performance';
import { DATA_FRESHNESS } from './freshness';
import { calculationObservationId, signalObservationId, TRACKING_POLICY_VERSION } from './observation-window';
import type { PerformanceSummary, Prediction, TrackedForecast, TradingVenue, VenueOutcomeRecord } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'forecast-history.json');
/** Keeps well over 100 windows of one-minute, seven-asset calibration snapshots locally. */
const UNQUALIFIED_RETENTION = 20_000;
let operationQueue: Promise<void> = Promise.resolve();

/**
 * Reads durable history, tolerating a truncated or partially overwritten file.
 *
 * This history is append-mostly and irreplaceable, so a parse failure recovers the longest valid
 * prefix and quarantines the damaged copy rather than throwing. A corrupt record file previously took
 * down the whole performance view, which is a much worse outcome than losing the trailing entries.
 */
async function readForecasts(): Promise<TrackedForecast[]> {
  let raw: string;
  try {
    raw = await readFile(HISTORY_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    return JSON.parse(raw) as TrackedForecast[];
  } catch {
    for (let end = raw.length; end > 2; end -= 1) {
      if (raw[end - 1] !== ']') continue;
      try {
        const recovered = JSON.parse(raw.slice(0, end)) as TrackedForecast[];
        if (!Array.isArray(recovered)) continue;
        console.error(`Forecast history was damaged; recovered ${recovered.length} records and quarantined the original.`);
        await writeFile(`${HISTORY_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
        await writeForecasts(recovered);
        return recovered;
      } catch { /* Keep scanning backwards for a complete array. */ }
    }
    console.error('Forecast history could not be parsed or recovered; starting a new file.');
    await writeFile(`${HISTORY_FILE}.corrupt-${Date.now()}`, raw).catch(() => undefined);
    return [];
  }
}

async function writeForecasts(forecasts: TrackedForecast[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${HISTORY_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(forecasts, null, 2));
  await rename(temporary, HISTORY_FILE);
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

async function resolvePolymarketOutcome(forecast: TrackedForecast): Promise<VenueOutcomeRecord | null> {
  const reference = forecast.venueContracts?.polymarket;
  const slug = forecast.marketUrl.split('/').filter(Boolean).at(-1);
  if (!slug) return null;
  const resolutionSource = reference?.rulesSource ?? `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'SignalDesk/0.2 local-research' },
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
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
    headers: { Accept: 'application/json', 'User-Agent': 'SignalDesk/0.2 local-research' },
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
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

async function updateTracking(predictions: Prediction[], modelVersion: string): Promise<PerformanceSummary> {
  await recordContractProvenance(predictions);
  const forecasts = await readForecasts();
  const known = new Set(forecasts.map((forecast) => forecast.id));
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
      changed = true;
    }
  }

  const due = forecasts.filter((forecast) => forecast.status === 'pending'
    && new Date(forecast.closesAt).getTime() < Date.now()
    && (!forecast.lastResolutionCheckAt || Date.now() - new Date(forecast.lastResolutionCheckAt).getTime() >= DATA_FRESHNESS.resolutionRetryMs));
  const dueCycles = new Map<string, TrackedForecast[]>();
  for (const forecast of due) {
    const id = storedCycleId(forecast);
    dueCycles.set(id, [...(dueCycles.get(id) ?? []), forecast]);
  }
  await Promise.all([...dueCycles.values()].slice(0, 20).map(async (cycleForecasts) => {
    const checkedAt = new Date().toISOString();
    for (const forecast of cycleForecasts) forecast.lastResolutionCheckAt = checkedAt;
    changed = true;
    try {
      // Resolve each venue once per cycle. One venue's temporary delay never fabricates or substitutes
      // the other venue's outcome.
      const requests = new Map<string, { venue: TradingVenue; forecast: TrackedForecast }>();
      for (const forecast of cycleForecasts) {
        const polyId = forecast.venueContracts?.polymarket?.contractId
          ?? `legacy:${forecast.marketUrl.split('/').filter(Boolean).at(-1) ?? forecast.symbol}`;
        requests.set(`polymarket:${polyId}`, { venue: 'polymarket', forecast });
        const kalshiId = forecast.venueContracts?.kalshi?.contractId;
        if (kalshiId) requests.set(`kalshi:${kalshiId}`, { venue: 'kalshi', forecast });
      }
      const requested = [...requests.entries()];
      const results = await Promise.allSettled(requested.map(([, request]) => request.venue === 'polymarket'
        ? resolvePolymarketOutcome(request.forecast)
        : resolveKalshiOutcome(request.forecast)));
      const resolvedByContract = new Map<string, VenueOutcomeRecord>();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) resolvedByContract.set(requested[index][0], result.value);
      });
      for (const forecast of cycleForecasts) {
        const polyId = forecast.venueContracts?.polymarket?.contractId
          ?? `legacy:${forecast.marketUrl.split('/').filter(Boolean).at(-1) ?? forecast.symbol}`;
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
      }
    } catch {
      // Resolution is retried; a temporary upstream error never invalidates a forecast.
    }
  }));
  if (changed) await writeForecasts(pruned(forecasts));
  return summarizePerformance(forecasts);
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

export async function getPerformanceSummary(): Promise<PerformanceSummary> {
  return summarizePerformance(await readForecasts());
}

export async function getForecastHistory(): Promise<TrackedForecast[]> {
  return [...await readForecasts()].sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
}
