import { MIN_EFFECTIVE_SECONDS, SETTLEMENT_WINDOW_SECONDS, normalCdf } from './basis-model';
import type { HourlyThresholdDirection } from './types';

export const HOURLY_THRESHOLD_MARKET_DATA_VERSION = 'kalshi-hourly-threshold-read-v1' as const;
export const HOURLY_THRESHOLD_MODEL_VERSION = 'strike-threshold-zero-drift-v1' as const;
export const EXACT_HOURLY_DURATION_MS = 3_600_000;

export interface KalshiThresholdMarketRow {
  ticker?: unknown;
  status?: unknown;
  market_type?: unknown;
  open_time?: unknown;
  close_time?: unknown;
  floor_strike?: unknown;
  cap_strike?: unknown;
  yes_bid_dollars?: unknown;
  yes_ask_dollars?: unknown;
  no_bid_dollars?: unknown;
  no_ask_dollars?: unknown;
  rules_primary?: unknown;
  rules_secondary?: unknown;
}

export interface NormalizedHourlyThresholdCandidate {
  direction: HourlyThresholdDirection;
  displaySide: 'UP' | 'DOWN';
  ticker: string;
  strike: number;
  relation: 'greater-than' | 'less-than';
  label: string;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  rulesText: string;
}

export interface NormalizedHourlyThresholdGroup {
  openAt?: string;
  closesAt?: string;
  candidates: NormalizedHourlyThresholdCandidate[];
  complete: boolean;
  unavailableReason?: string;
}

const finitePositive = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const bidPrice = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
};

/** Kalshi serializes an absent ask as 0.0000; it is missing liquidity, never a free contract. */
const askPrice = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : undefined;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

function directionOf(row: KalshiThresholdMarketRow): HourlyThresholdDirection | undefined {
  const floor = finitePositive(row.floor_strike);
  const cap = finitePositive(row.cap_strike);
  const rules = `${text(row.rules_primary)} ${text(row.rules_secondary)}`;
  if (floor !== undefined && cap === undefined && /\b(?:above|greater than)\b/i.test(rules)) return 'ABOVE';
  if (cap !== undefined && floor === undefined && /\b(?:below|less than)\b/i.test(rules)) return 'BELOW';
  return undefined;
}

function candidate(row: KalshiThresholdMarketRow): NormalizedHourlyThresholdCandidate | undefined {
  const direction = directionOf(row);
  const ticker = text(row.ticker);
  if (!direction || !ticker || !ticker.includes('-T')) return undefined;
  const strike = direction === 'ABOVE' ? finitePositive(row.floor_strike) : finitePositive(row.cap_strike);
  if (strike === undefined) return undefined;
  return {
    direction,
    displaySide: direction === 'ABOVE' ? 'UP' : 'DOWN',
    ticker,
    strike,
    relation: direction === 'ABOVE' ? 'greater-than' : 'less-than',
    label: direction === 'ABOVE' ? `Above ${strike}` : `Below ${strike}`,
    yesBid: bidPrice(row.yes_bid_dollars),
    yesAsk: askPrice(row.yes_ask_dollars),
    noBid: bidPrice(row.no_bid_dollars),
    noAsk: askPrice(row.no_ask_dollars),
    rulesText: [text(row.rules_primary), text(row.rules_secondary)].filter(Boolean).join('\n'),
  };
}

/**
 * Select the current exact one-hour group. Longer-duration threshold rows in the same series are never nearby
 * substitutes, and ambiguity remains unavailable rather than being resolved by row order or subtitle wording.
 */
export function selectCurrentHourlyThresholdGroup(
  rows: KalshiThresholdMarketRow[],
  nowMs = Date.now(),
): NormalizedHourlyThresholdGroup {
  const grouped = new Map<string, { openAt: string; closesAt: string; rows: KalshiThresholdMarketRow[] }>();
  for (const row of rows) {
    if (row.status !== 'active' || (row.market_type !== undefined && row.market_type !== 'binary')) continue;
    const openMs = Date.parse(text(row.open_time));
    const closeMs = Date.parse(text(row.close_time));
    if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)
      || closeMs - openMs !== EXACT_HOURLY_DURATION_MS || openMs > nowMs || closeMs <= nowMs) continue;
    const openAt = new Date(openMs).toISOString();
    const closesAt = new Date(closeMs).toISOString();
    const key = `${openAt}:${closesAt}`;
    const group = grouped.get(key) ?? { openAt, closesAt, rows: [] };
    group.rows.push(row);
    grouped.set(key, group);
  }
  const current = [...grouped.values()].sort((left, right) => Date.parse(left.closesAt) - Date.parse(right.closesAt))[0];
  if (!current) return { candidates: [], complete: false, unavailableReason: 'No active exact one-hour threshold group.' };

  const normalized = current.rows.map(candidate).filter((item): item is NormalizedHourlyThresholdCandidate => Boolean(item));
  const above = normalized.filter((item) => item.direction === 'ABOVE');
  const below = normalized.filter((item) => item.direction === 'BELOW');
  const candidates = [...(above.length === 1 ? above : []), ...(below.length === 1 ? below : [])]
    .sort((left, right) => left.direction.localeCompare(right.direction));
  const reasons = [
    above.length === 0 ? 'ABOVE contract unavailable' : above.length > 1 ? 'ABOVE contract ambiguous' : undefined,
    below.length === 0 ? 'BELOW contract unavailable' : below.length > 1 ? 'BELOW contract ambiguous' : undefined,
  ].filter((value): value is string => Boolean(value));
  return {
    openAt: current.openAt,
    closesAt: current.closesAt,
    candidates,
    complete: reasons.length === 0,
    unavailableReason: reasons.length ? `${reasons.join('; ')}.` : undefined,
  };
}

/** Zero-drift probability for one exact strike contract; BELOW complements its own low strike, never ABOVE. */
export function hourlyThresholdProbability(input: {
  direction: HourlyThresholdDirection;
  strike: number;
  currentPrice: number;
  secondsRemaining: number;
  volatilityPerSecond: number;
}): number | undefined {
  const { strike, currentPrice, secondsRemaining, volatilityPerSecond } = input;
  if (!(strike > 0) || !(currentPrice > 0) || !(volatilityPerSecond > 0) || !Number.isFinite(secondsRemaining)) return undefined;
  const effectiveSeconds = Math.max(MIN_EFFECTIVE_SECONDS, secondsRemaining - SETTLEMENT_WINDOW_SECONDS / 2);
  const standardDeviation = volatilityPerSecond * Math.sqrt(effectiveSeconds);
  if (!(standardDeviation > 0)) return undefined;
  const aboveProbability = normalCdf(Math.log(currentPrice / strike) / standardDeviation);
  return input.direction === 'ABOVE' ? aboveProbability : 1 - aboveProbability;
}
