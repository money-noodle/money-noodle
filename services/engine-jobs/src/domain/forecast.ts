import {
  issuanceSnapshot,
  candidateEvidence,
  type CalibrationSnapshot,
  type CandidateEvaluation,
} from './forecast-evidence.js';
// Ported from the v1 basis, forecast model, observation window and resolver, sanitized.
// Probability arithmetic is independent of venue prices and observation-only candidates.
import type { LeaseGrant } from './cycle-store.js';
export type Venue = 'polymarket' | 'kalshi';
export type Side = 'UP' | 'DOWN';
export interface Contract {
  venue: Venue;
  contractId: string;
  closesAt: string;
  slug: string;
  asset?: string;
  capturedAt?: string;
  requestStartedAt?: string;
  referenceWindowSeconds?: number;
  rulesSource?: string;
  rulesFingerprint?: string;
  rulesText?: string;
  referenceSource?: string;
  referenceValue?: number;
  settlementPriceMethod?: 'unknown' | 'point-in-time' | 'simple-average' | 'time-weighted-average';
  settlementWindowSeconds?: number;
}
export interface Quote {
  contract: Contract;
  probabilityUp: number;
  askUp: number | null;
  askDown: number | null;
}
export interface PricePoint {
  time: number;
  price: number;
}
export interface ForecastInput {
  asset: string;
  calculatedAt: string;
  requestStartedAt?: string;
  closesAt: string;
  referencePrice: number;
  currentPrice: number;
  /** CoinGecko snapshot price; distinct from same-series Kraken basis current. */
  coinPrice: number;
  minuteCloses: readonly number[];
  oracleHistory: readonly PricePoint[];
  change1h: number;
  change24h: number;
  change30d: number;
  change1y: number;
  high24h: number;
  low24h: number;
  seasonalReturns: readonly number[];
  newsScores: readonly number[];
  relevantNewsCount: number;
  quotes: readonly Quote[];
  sourceObservedAt?: string;
  referenceSource?: string;
}
export interface Entry {
  venue: Venue;
  side: Side;
  price: number;
  feeRate: number;
  probability: number;
  netEdge: number;
}
export interface ForecastRow {
  id: string;
  symbol: string;
  closesAt: string;
  issuedAt: string;
  probabilityUp: number;
  confidence: number;
  qualified: boolean;
  direction: Side;
  status: 'pending' | 'resolved' | 'invalid';
  marketUrl: string;
  venueContracts: Partial<Record<Venue, Contract>>;
  entryVenue?: Venue;
  entrySide?: Side;
  entryAsk?: number;
  entryFeeRate?: number;
  candidateEvaluation: CandidateEvaluation;
  calibrationReplay: CalibrationSnapshot;
  basisProbabilityUp: number | null;
  slowTiltLogOdds: number;
  modelVersion: string;
  [key: string]: unknown;
}
export interface DueForecast {
  id: string;
  row: ForecastRow;
  restoreRunId: string | null;
}
export interface Outcome {
  venue: Venue;
  contractId: string;
  outcome?: Side;
  invalidReason?: string;
}
export interface ForecastStore {
  assertLease(grant: LeaseGrant): Promise<void>;
  readEnabledVenues(): Promise<readonly Venue[]>;
  readOracleHistory(asset: string, since: Date): Promise<readonly PricePoint[]>;
  recordObservation(grant: LeaseGrant, row: ForecastRow, input: ForecastInput): Promise<boolean>;
  readDueForecasts(now: Date, limit: number): Promise<readonly DueForecast[]>;
  patchForecast(grant: LeaseGrant, original: DueForecast, row: ForecastRow): Promise<void>;
}
export interface ForecastFeeds {
  calculate(
    now: Date,
    enabled: readonly Venue[],
    store: ForecastStore,
  ): Promise<readonly ForecastInput[]>;
  resolve(contract: Contract): Promise<Outcome | null>;
}
export const bound = (n: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, n));
export const logistic = (n: number): number => 1 / (1 + Math.exp(-n));
export const odds = (p: number): number => {
  const v = bound(p, 1e-6, 1 - 1e-6);
  return Math.log(v / (1 - v));
};
export function normalProbability(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail =
    Math.exp((-z * z) / 2) *
    0.3989422804014327 *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z < 0 ? tail : 1 - tail;
}
export function volatility(
  closes: readonly number[],
  spacing: number,
): { perSecond: number; samples: number } | null {
  const values = closes.filter((n) => Number.isFinite(n) && n > 0);
  if (values.length < 12 || spacing <= 0) return null;
  const returns = values
    .slice(1)
    .map((n, i) => Math.log(n / values[i]!))
    .filter(Number.isFinite);
  if (returns.length < 10) return null;
  const mean = returns.reduce((sum, n) => sum + n, 0) / returns.length;
  const variance = returns.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (returns.length - 1);
  const perSecond = Math.sqrt(Math.max(variance, 0)) / Math.sqrt(spacing);
  return Number.isFinite(perSecond) && perSecond > 0
    ? { perSecond, samples: returns.length }
    : null;
}
export function basisProbability(
  reference: number,
  current: number,
  seconds: number,
  sigma: number,
): number | null {
  if (!(reference > 0) || !(current > 0) || !(sigma > 0) || !Number.isFinite(seconds)) return null;
  return bound(
    normalProbability(
      Math.log(current / reference) / (sigma * Math.sqrt(Math.max(2, seconds - 30))),
    ),
    0.05,
    0.95,
  );
}
export function combinedProbability(
  basis: number | null,
  slow: number,
  weight = 0.55,
  scale = 1,
): number {
  return bound(logistic((basis === null ? 0 : odds(basis) * weight) + slow * scale), 0.03, 0.97);
}
export function entryOptions(probabilityUp: number, quotes: readonly Quote[]): Entry[] {
  const entries: Entry[] = [];
  for (const quote of quotes) {
    for (const side of ['UP', 'DOWN'] as const) {
      const price = side === 'UP' ? quote.askUp : quote.askDown;
      if (price === null || !Number.isFinite(price) || price <= 0 || price >= 1) continue;
      const probability = side === 'UP' ? probabilityUp : 1 - probabilityUp;
      const feeRate =
        quote.contract.venue === 'polymarket' ? 0.01 * price : 0.07 * price * (1 - price);
      entries.push({
        venue: quote.contract.venue,
        side,
        price,
        feeRate,
        probability,
        netEdge: probability - price - feeRate,
      });
    }
  }
  return entries.sort(
    (a, b) => b.netEdge - a.netEdge || a.price - b.price || a.side.localeCompare(b.side),
  );
}
export function bestEntry(probabilityUp: number, quotes: readonly Quote[]): Entry | undefined {
  return entryOptions(probabilityUp, quotes).find(
    (e) => e.price >= 0.1 && e.price <= 0.75 && e.probability >= 0.55 && e.netEdge < 1,
  );
}
export function observationIdentity(cycleId: string, at: number, qualified: boolean): string {
  const interval = qualified ? 15_000 : 60_000;
  return (qualified ? '' : 'calc:') + cycleId + ':' + Math.floor(at / interval) * interval;
}
export function forecast(
  input: ForecastInput,
  now: Date,
  enabled: readonly Venue[],
): ForecastRow | null {
  const calculationAt = Date.parse(input.calculatedAt);
  const at = now.getTime();
  const close = Date.parse(input.closesAt);
  if (
    !Number.isFinite(calculationAt) ||
    !Number.isFinite(at) ||
    !Number.isFinite(close) ||
    calculationAt > at ||
    at - calculationAt > 15_000 ||
    close <= at ||
    close <= now.getTime()
  )
    return null;
  if (input.sourceObservedAt !== undefined) {
    const source = Date.parse(input.sourceObservedAt);
    if (!Number.isFinite(source) || source > now.getTime() + 5000 || now.getTime() - source > 90000)
      return null;
  }
  const oracle = input.oracleHistory.filter((v) => Number.isFinite(v.price) && v.price > 0);
  const spacing =
    oracle.length > 1 ? (oracle.at(-1)!.time - oracle[0]!.time) / (oracle.length - 1) / 1000 : 0;
  const vol =
    volatility(input.minuteCloses, 60) ??
    volatility(
      oracle.map((v) => v.price),
      spacing,
    );
  const seconds = Math.max(0, (close - at) / 1000);
  const basis =
    vol === null
      ? null
      : basisProbability(input.referencePrice, input.currentPrice, seconds, vol.perSecond);
  const average = (xs: readonly number[]): number =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const seasonal =
    input.seasonalReturns.length >= 2
      ? bound(average(input.seasonalReturns) / 18, -1, 1) *
        0.12 *
        bound(input.seasonalReturns.length / 5, 0.35, 1)
      : 0;
  const news =
    bound(average(input.newsScores), -1, 1) *
    0.09 *
    (input.relevantNewsCount ? bound(input.relevantNewsCount / 4, 0.25, 1) : 0.2);
  const rawTerms = [
    bound((input.change1h * 0.7 + input.change24h * 0.3) / 2.5, -1, 1) *
      0.34 *
      bound(0.5 + Math.abs(input.change1h) / 10, 0, 0.9),
    bound(input.change30d / 20, -1, 1) * 0.06 * 0.5,
    bound(input.change1y / 80, -1, 1) * 0.03 * 0.4,
    seasonal,
    news,
  ].map((n) => n * 0.8);
  if (rawTerms.some((n) => !Number.isFinite(n))) return null;
  const rawSlow = rawTerms.reduce((a, b) => a + b, 0);
  const slow = bound(rawSlow, -0.4, 0.4);
  const probabilityUp = combinedProbability(basis, slow);
  const settlement = vol === null ? null : settlementProbability(input, at, vol.perSecond);
  // Venue availability affects input quality only, never the production probability.
  const quotes = input.quotes.filter(
    (q) =>
      Number.isFinite(Date.parse(q.contract.closesAt)) &&
      Math.abs(Date.parse(q.contract.closesAt) - close) <= 5000 &&
      Date.parse(q.contract.closesAt) > now.getTime() &&
      (q.contract.asset === undefined || q.contract.asset === input.asset) &&
      enabled.includes(q.contract.venue),
  );
  const range = input.coinPrice ? ((input.high24h - input.low24h) / input.coinPrice) * 100 : 0;
  const confidence = bound(
    0.3 +
      (basis === null ? 0 : 0.2) +
      (quotes.length ? 0.04 : 0) +
      (basis === null ? 0 : Math.min(1, (vol?.samples ?? 0) / 60) * 0.22) -
      Math.min(0.12, (seconds / 900) * 0.12) -
      (basis === null ? 0.16 : 0) -
      Math.min(0.04, range / 60),
    0.25,
    0.86,
  );
  const entry = bestEntry(probabilityUp, quotes);
  const qualified = confidence >= 0.5 && entry !== undefined && entry.netEdge >= 0.05;
  // Historical recording requires the current Polymarket target; Kalshi-only
  // restored rows are still handled by the resolution path, never new recording.
  const primary = quotes.find((q) => q.contract.venue === 'polymarket');
  if (
    primary === undefined ||
    validatedContract(primary.contract, 'polymarket', input.closesAt, primary.contract.slug) ===
      null ||
    !primary.contract.slug.includes('-updown-15m-')
  )
    return null;
  const cycleId = primary.contract.slug + ':' + input.closesAt;
  const scale = rawSlow === 0 ? 1 : slow / rawSlow;
  const row: ForecastRow = {
    id: observationIdentity(cycleId, at, qualified),
    symbol: input.asset,
    closesAt: input.closesAt,
    issuedAt: new Date(at).toISOString(),
    calculationCompletedAt: input.calculatedAt,
    requestStartedAt: input.requestStartedAt,
    probabilityUp,
    confidence,
    qualified,
    direction: probabilityUp >= 0.5 ? 'UP' : 'DOWN',
    status: 'pending',
    marketUrl:
      'https://' +
      (primary.contract.venue === 'polymarket' ? 'polymarket.com/event/' : 'kalshi.com/markets/') +
      primary.contract.slug,
    venueContracts: Object.fromEntries(quotes.map((q) => [q.contract.venue, q.contract])),
    sourceObservedAt: input.sourceObservedAt,
    referenceSource: input.referenceSource,
    basisProbabilityUp: basis,
    slowTiltLogOdds: slow,
    modelVersion: 'Blend 0.4',
    candidateEvaluation: candidateEvidence(
      issuanceSnapshot({
        basisInput:
          basis !== null && vol
            ? {
                referencePrice: input.referencePrice,
                currentPrice: input.currentPrice,
                secondsRemaining: seconds,
                volatilityPerSecond: vol.perSecond,
                volatilitySamples: vol.samples,
              }
            : undefined,
        basisProbability: basis,
        slowTiltLogOdds: slow,
        slowTerms: rawTerms.map((logOdds, index) => ({
          id: ['intraday', 'monthly', 'yearly', 'seasonal', 'news'][index]!,
          logOdds: logOdds * scale,
        })),
        probability: probabilityUp,
        confidence,
        confidenceInput: {
          basisPresent: basis !== null,
          venueProbabilityCount: quotes.length,
          volatilitySamples: basis === null ? 0 : (vol?.samples ?? 0),
          secondsRemaining: seconds,
          rangePercent: range,
        },
      }),
      quotes,
      settlement,
      confidence,
    ),
    cycleId,
    trackingPolicyVersion: 'all-qualified-15s-snapshots-v2',
    policyVersion:
      'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22',
    predictedEdge: entry?.netEdge,
    directionalLikelihood: Math.max(probabilityUp, 1 - probabilityUp),
    secondsRemaining: seconds,
    actionableVenuePrices: quotes.flatMap((q) =>
      [
        ['UP', q.askUp],
        ['DOWN', q.askDown],
      ]
        .filter((pair) => pair[1] !== null)
        .map((pair) => ({ venue: q.contract.venue, side: pair[0], price: pair[1] })),
    ),
    calibrationReplay: issuanceSnapshot({
      basisInput:
        basis !== null && vol
          ? {
              referencePrice: input.referencePrice,
              currentPrice: input.currentPrice,
              secondsRemaining: seconds,
              volatilityPerSecond: vol.perSecond,
              volatilitySamples: vol.samples,
            }
          : undefined,
      basisProbability: basis,
      slowTiltLogOdds: slow,
      slowTerms: rawTerms.map((logOdds, index) => ({
        id: ['intraday', 'monthly', 'yearly', 'seasonal', 'news'][index]!,
        logOdds: logOdds * scale,
      })),
      probability: probabilityUp,
      confidence,
      confidenceInput: {
        basisPresent: basis !== null,
        venueProbabilityCount: quotes.length,
        volatilitySamples: basis === null ? 0 : (vol?.samples ?? 0),
        secondsRemaining: seconds,
        rangePercent: range,
      },
    }),
  };
  if (entry !== undefined)
    Object.assign(row, {
      entryVenue: entry.venue,
      entrySide: entry.side,
      entryAsk: entry.price,
      entryFeeRate: entry.feeRate,
    });
  return row;
}
export function resolutionDue(row: ForecastRow, now: Date): boolean {
  if (row.status !== 'pending' || Date.parse(row.closesAt) >= now.getTime()) return false;
  const checked =
    typeof row.lastResolutionCheckAt === 'string'
      ? Date.parse(row.lastResolutionCheckAt)
      : Number.NEGATIVE_INFINITY;
  const attempts = typeof row.resolutionAttempts === 'number' ? row.resolutionAttempts : 0;
  return now.getTime() - checked >= Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}
export function resolveForecast(
  original: ForecastRow,
  result: Outcome | null,
  now: Date,
): ForecastRow {
  const row = structuredClone(original);
  const hasContracts = Object.keys(row.venueContracts).length > 0;
  const venue = hasContracts ? (row.entryVenue ?? 'polymarket') : 'polymarket';
  const reference = validatedContract(
    row.venueContracts[venue],
    venue,
    row.closesAt,
    row.marketUrl.split('/').filter(Boolean).at(-1) ?? '',
  );
  const hasProvenance = Object.keys(row.venueContracts).length > 0;
  row.lastResolutionCheckAt = now.toISOString();
  row.evaluationVenue = venue;
  row.targetIntegrity = hasProvenance
    ? reference !== null
      ? 'venue-specific'
      : 'missing-provenance'
    : 'legacy-polymarket';
  if (hasProvenance && reference === null) {
    row.status = 'invalid';
    row.invalidReason = 'missing-provenance';
  } else if (
    result !== null &&
    (result.venue !== venue || (reference !== null && result.contractId !== reference.contractId))
  ) {
    row.status = 'invalid';
    row.targetIntegrity = 'mismatched-outcome';
    row.invalidReason = 'mismatched-outcome';
  } else if (result?.invalidReason !== undefined) {
    row.status = 'invalid';
    row.invalidReason = result.invalidReason;
  } else if (result?.outcome !== undefined) {
    row.status = 'resolved';
    row.outcome = result.outcome;
    row.correct = row.direction === result.outcome;
    const p = bound(row.probabilityUp, 1e-6, 1 - 1e-6);
    const actual = result.outcome === 'UP' ? 1 : 0;
    row.brierScore = (p - actual) ** 2;
    row.venueOutcomes = {
      ...(typeof row.venueOutcomes === 'object' ? row.venueOutcomes : {}),
      [venue]: { ...result, resolvedAt: now.toISOString() },
    };
    row.logLoss = -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
    if (row.entryAsk !== undefined)
      row.realizedReturn =
        (result.outcome === (row.entrySide ?? 'UP') ? 1 : 0) -
        row.entryAsk -
        (row.entryFeeRate ?? 0);
  }
  if (row.status === 'pending' && now.getTime() - Date.parse(row.closesAt) >= 6 * 60 * 60_000) {
    row.status = 'invalid';
    row.invalidReason = 'abandoned-by-venue';
  }
  if (row.status === 'pending')
    row.resolutionAttempts =
      (typeof row.resolutionAttempts === 'number' ? row.resolutionAttempts : 0) + 1;
  else {
    row.resolvedAt = now.toISOString();
    delete row.resolutionAttempts;
  }
  return row;
}

/** The historical candidate distribution; cannot feed production probability or entry policy. */
export function settlementProbability(
  input: ForecastInput,
  at: number,
  sigma: number,
): number | null {
  if (
    !(input.referencePrice > 0) ||
    !(input.currentPrice > 0) ||
    !(sigma > 0) ||
    ![at, Date.parse(input.closesAt)].every(Number.isFinite)
  )
    return null;
  const remaining = Math.max(0, (Date.parse(input.closesAt) - at) / 1000),
    window =
      input.quotes.find((q) => q.contract.venue === 'polymarket')?.contract
        .settlementWindowSeconds ??
      input.quotes[0]?.contract.settlementWindowSeconds ??
      60;
  let mean = Math.log(input.currentPrice),
    variance = remaining - (2 * window) / 3;
  if (remaining < window) {
    const start = Date.parse(input.closesAt) - window * 1000;
    const valid = input.oracleHistory
      .filter((p) => Number.isFinite(p.time) && p.price > 0)
      .toSorted((a, b) => a.time - b.time);
    const first =
      valid.findLast((p) => p.time <= start) ?? valid.find((p) => p.time > start && p.time < at);
    if (first === undefined) return null;
    const points = [
      { time: start, price: first.price },
      ...valid.filter((p) => p.time > start && p.time < at),
      { time: at, price: input.currentPrice },
    ];
    let integral = 0;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!,
        next = points[i]!;
      integral +=
        (((next.time - prev.time) / 1000) * (Math.log(prev.price) + Math.log(next.price))) / 2;
    }
    mean = (integral + remaining * Math.log(input.currentPrice)) / window;
    variance = remaining ** 3 / (3 * window ** 2);
  }
  const deviation = sigma * Math.sqrt(Math.max(0, variance)),
    basis = mean - Math.log(input.referencePrice);
  return deviation > 1e-12
    ? bound(normalProbability(basis / deviation), 0.001, 0.999)
    : basis >= 0
      ? 0.999
      : 0.001;
}

/** Untrusted restored JSON references must be valid before issuing any network request. */
export function validatedContract(
  value: unknown,
  venue: Venue,
  close: string,
  fallbackSlug: string,
): Contract | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>,
    at = Date.parse(close);
  if (
    raw.venue !== venue ||
    typeof raw.contractId !== 'string' ||
    raw.contractId.length === 0 ||
    raw.contractId.length > 256 ||
    typeof raw.closesAt !== 'string' ||
    !Number.isFinite(at) ||
    !Number.isFinite(Date.parse(raw.closesAt)) ||
    Math.abs(Date.parse(raw.closesAt) - at) > 5000
  )
    return null;
  const slug = typeof raw.slug === 'string' && raw.slug.length ? raw.slug : fallbackSlug;
  if (!slug || slug.length > 256) return null;
  return { ...raw, venue, contractId: raw.contractId, closesAt: raw.closesAt, slug };
}

/** Oldest unchecked eligible cycles first; interleave rows so one cycle cannot
 * consume the entire bounded pass. Attempts move checked cycles behind untouched ones. */
export function selectDueForecasts(
  rows: readonly DueForecast[],
  now: Date,
  limit: number,
): readonly DueForecast[] {
  const groups = new Map<string, DueForecast[]>();
  const checked = (r: DueForecast) =>
    typeof r.row.lastResolutionCheckAt === 'string'
      ? Date.parse(r.row.lastResolutionCheckAt)
      : Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (!resolutionDue(row.row, now)) continue;
    const key = row.row.symbol + ':' + row.row.closesAt;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const ordered = [...groups.values()]
    .map((g) => g.sort((a, b) => checked(a) - checked(b) || a.id.localeCompare(b.id)))
    .sort(
      (a, b) =>
        checked(a[0]!) - checked(b[0]!) ||
        Date.parse(a[0]!.row.closesAt) - Date.parse(b[0]!.row.closesAt) ||
        a[0]!.row.symbol.localeCompare(b[0]!.row.symbol),
    )
    .slice(0, 20);
  const out: DueForecast[] = [];
  const cap = Math.max(1, Math.min(Math.trunc(limit), 2000));
  for (let index = 0; out.length < cap; index++) {
    let added = false;
    for (const group of ordered) {
      const row = group[index];
      if (row && out.length < cap) {
        out.push(row);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
