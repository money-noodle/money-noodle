import type { ExecutionMode, PositionSide, Prediction } from './types';

/**
 * Binary buy policy v13.
 *
 * The objective is profit, not forecast accuracy. A well-calibrated forecast still loses money when
 * it is bought at or above fair value, so qualification is expressed as expected value net of venue
 * fees rather than as a directional-likelihood threshold.
 *
 * The probability used here must be the venue-independent estimate. Blending the venue price into the
 * forecast and then subtracting that same price would shrink the disagreement the desk exists to trade.
 */

/** Minimum expected value per $1 of payout, after fees, before a buy qualifies. */
export const MIN_NET_EDGE = 0.05;
/**
 * Upper bound on claimed edge, above which the claim is treated as model failure rather than opportunity.
 *
 * Across 37,943 resolved forecasts, calibration is sound or conservative in every edge bucket below this
 * line — the traded band realizes 75.8% against 67.3% predicted. Above it the model inverts: edge of 35pp
 * or more predicts 64.0% and realizes 37.6%, a -26.4pp gap holding at -26.7pp clustered over 218 windows.
 * Those trades also returned -100% in the live book.
 *
 * A 35-point disagreement with a liquid venue is not an edge that large; it is the model being wrong
 * loudly, and it concentrates at cheap prices where it disagrees most. Restrictive only: this can refuse
 * a trade, never authorize one. Set MONEY_NOODLE_MAX_NET_EDGE to change or 1 to disable.
 */
export const MAX_NET_EDGE = 0.35;

export function maximumNetEdge(): number {
  const configured = Number(process.env.MONEY_NOODLE_MAX_NET_EDGE);
  return Number.isFinite(configured) && configured > 0 ? Math.min(1, configured) : MAX_NET_EDGE;
}
/** Minimum confidence in our own estimate. Deliberately independent of agreement with the market. */
export const MIN_ESTIMATE_QUALITY = 0.5;
/**
 * The selected side must be independently more likely than not. Policy v13 restores the 55% floor
 * for both paper and live after prospective v12 monitoring found that acquired 52.5–55% sides lost.
 * Venue prices do not enter the probability, and all edge, quality, price, persistence, timing,
 * portfolio, and risk gates remain unchanged.
 */
export const MIN_SELECTED_SIDE_PROBABILITY = 0.55;
/**
 * Entry price bounds.
 *
 * These are our own limits, not venue limits: Kalshi quotes from $0.001 to $0.999. The ceiling keeps
 * a payout-room backstop, though the expected-value test binds well before it: the model's probability
 * is clamped at 0.97 and edge must clear 5pp after fees, so nothing above roughly 91c can qualify.
 * The price floor remains permissive because selected-side probability now rejects model-underdog
 * longshots independently of price; price cohorts remain measurable without treating cheapness as edge.
 */
export const MIN_ENTRY_PRICE = 0.05;
export const MAX_ENTRY_PRICE = 0.97;
export const BUY_POLICY_VERSION = 'buy-binary-edge-net5to35-quality50-owned55-price5to97-uponly-v15';
/** Minimum unique resolved 15-minute settlement timestamps, never updates or per-asset cycles. */
export const MIN_CALIBRATION_SAMPLE = 100;

/**
 * Conservative fee estimates as a fraction of the $1 settlement payout. Kalshi charges a quadratic
 * per-contract trading fee; Polymarket is treated as a flat proportional cost so the gate cannot be
 * cleared by ignoring execution costs.
 */
export function venueFeeRate(venue: 'polymarket' | 'kalshi', price: number): number {
  return venue === 'kalshi' ? 0.07 * price * (1 - price) : 0.01 * price;
}

export function directionalLikelihood(prediction: Pick<Prediction, 'modelProbabilityUp'>): number {
  return Math.max(prediction.modelProbabilityUp, 1 - prediction.modelProbabilityUp);
}

export interface VenueEntryOption {
  venue: 'polymarket' | 'kalshi';
  side: PositionSide;
  price: number;
  feeRate: number;
  probability: number;
  netEdge: number;
}

type EntryCandidate = Pick<Prediction, 'modelProbabilityUp' | 'market' | 'kalshi' | 'enabledTradingVenues'>;

export function sideProbability(prediction: Pick<Prediction, 'modelProbabilityUp'>, side: PositionSide): number {
  return side === 'UP' ? prediction.modelProbabilityUp : 1 - prediction.modelProbabilityUp;
}

/**
 * Executable binary entries on enabled venues, using the ask for the side being purchased. DOWN/NO
 * is not inferred from the UP ask: its actionable ask is independent across the spread. Missing or
 * unusable side quotes fail closed.
 */
export function venueEntryOptions(prediction: EntryCandidate): VenueEntryOption[] {
  const options: VenueEntryOption[] = [];
  const consider = (venue: 'polymarket' | 'kalshi', side: PositionSide, price: number | undefined) => {
    if (price === undefined || !(price > 0) || price >= 1) return;
    const feeRate = venueFeeRate(venue, price);
    const probability = sideProbability(prediction, side);
    options.push({ venue, side, price, feeRate, probability, netEdge: probability - price - feeRate });
  };
  if (prediction.enabledTradingVenues.includes('polymarket') && prediction.market.live) {
    consider('polymarket', 'UP', prediction.market.askUp);
    consider('polymarket', 'DOWN', prediction.market.askDown);
  }
  if (prediction.enabledTradingVenues.includes('kalshi') && prediction.kalshi?.live) {
    consider('kalshi', 'UP', prediction.kalshi.askUp);
    consider('kalshi', 'DOWN', prediction.kalshi.askDown);
  }
  return options.sort((a, b) => b.netEdge - a.netEdge || a.price - b.price || a.side.localeCompare(b.side));
}

/** The entry with the highest expected value, which may be either side of the binary contract. */
/**
 * DOWN/NO entry is suspended pending recalibration.
 *
 * Measured over 44 independent settlement windows, DOWN returned -58.0% +/-14.7 per window and accounted
 * for -$17.86 of a -$18.62 lifetime live result, while UP was indistinguishable from zero (+2.9% +/-13.1
 * over 162 windows). Regime does not explain it: 60.9% of traded asset-windows resolved DOWN, a
 * favourable base rate, yet windows where DOWN was selected resolved DOWN only 11.6% of the time — worse
 * than random in an environment tilted its way. Set MONEY_NOODLE_ALLOW_DOWN_ENTRY=true to re-enable.
 *
 * Exits, reduce-only sells, and settlement of existing DOWN positions are unaffected: this gates new
 * entries only, exactly like the regime gate.
 */
export function downEntryEnabled(mode: ExecutionMode = 'live'): boolean {
  // Per track, and defaulting to the strict track. Every caller that does not state a mode — the
  // dashboard, ranking helpers, anything added later — therefore gets live's answer, so forgetting to
  // pass a mode can only ever be more restrictive than intended, never less.
  const scoped = mode === 'paper' ? 'MONEY_NOODLE_ALLOW_DOWN_ENTRY_PAPER' : 'MONEY_NOODLE_ALLOW_DOWN_ENTRY_LIVE';
  return process.env[scoped] === 'true';
}

const admissibleEntry = (option: VenueEntryOption, mode: ExecutionMode = 'live') => option.price >= MIN_ENTRY_PRICE && option.price <= MAX_ENTRY_PRICE
  && option.probability >= MIN_SELECTED_SIDE_PROBABILITY
  && option.netEdge < maximumNetEdge()
  && (option.side === 'UP' || downEntryEnabled(mode));

export function bestEntry(prediction: EntryCandidate, mode: ExecutionMode = 'live'): VenueEntryOption | undefined {
  return venueEntryOptions(prediction).find((option) => admissibleEntry(option, mode));
}

export function bestEntryForSide(prediction: EntryCandidate, side: PositionSide, mode: ExecutionMode = 'live'): VenueEntryOption | undefined {
  return venueEntryOptions(prediction).find((option) => option.side === side && admissibleEntry(option, mode));
}

export function bestVenueEntry(prediction: EntryCandidate, venue: 'polymarket' | 'kalshi', side?: PositionSide, mode: ExecutionMode = 'live'): VenueEntryOption | undefined {
  return venueEntryOptions(prediction).find((option) => option.venue === venue && (!side || option.side === side) && admissibleEntry(option, mode));
}

export function hasTradableEdge(prediction: EntryCandidate, mode: ExecutionMode = 'live'): boolean {
  const entry = bestEntry(prediction, mode);
  return Boolean(entry && entry.netEdge >= MIN_NET_EDGE);
}

/** Ranking is by expected value scaled by how much we trust the estimate producing it. */
export function edgeStrength(prediction: EntryCandidate & Pick<Prediction, 'confidence'>): number {
  return Math.max(0, bestEntry(prediction)?.netEdge ?? 0) * prediction.confidence;
}

export function qualifiesVenueBuyEdge(prediction: EntryCandidate & Pick<Prediction, 'confidence'>, venue: 'polymarket' | 'kalshi', side?: PositionSide, mode: ExecutionMode = 'live'): boolean {
  const entry = bestVenueEntry(prediction, venue, side, mode);
  // Repeats the DOWN suspension rather than relying on admissibleEntry: this function checks its
  // conditions inline, so omitting it here would leave an entry path the suspension does not cover.
  return prediction.confidence >= MIN_ESTIMATE_QUALITY && Boolean(entry
    && (entry.side === 'UP' || downEntryEnabled(mode))
    && entry.netEdge >= MIN_NET_EDGE && entry.netEdge < maximumNetEdge() && entry.price >= MIN_ENTRY_PRICE && entry.price <= MAX_ENTRY_PRICE
    && sideProbability(prediction, entry.side) >= MIN_SELECTED_SIDE_PROBABILITY);
}

export function qualifiesAsBuyEdge(prediction: EntryCandidate & Pick<Prediction, 'confidence'>, mode: ExecutionMode = 'live'): boolean {
  return prediction.confidence >= MIN_ESTIMATE_QUALITY && hasTradableEdge(prediction, mode);
}
