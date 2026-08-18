import { venueFeeFraction, type LiquidityRole } from './venue-fee-schedule';
import type { PositionSide, Prediction } from './types';

/**
 * Binary buy policy v17.
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
 * The selected side must be independently more likely than not. Policy v13 restored the 55% floor
 * after prospective v12 monitoring found that acquired 52.5–55% sides lost, and it has applied to both
 * tracks since. Venue prices do not enter the probability, and all edge, quality, price, persistence,
 * timing, portfolio, and risk gates remain unchanged.
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
export const BUY_POLICY_VERSION = 'buy-binary-edge-net5to35-quality50-owned55-price5to97-v19';
/** Minimum unique resolved 15-minute settlement timestamps, never updates or per-asset cycles. */
export const MIN_CALIBRATION_SAMPLE = 100;

/**
 * Fee as a fraction of the $1 settlement payout, from the shared schedule.
 *
 * `role` is required so every caller states which schedule it means, because the gate currently means
 * the wrong one. See `ENTRY_FEE_ROLE` below.
 */
export function venueFeeRate(venue: 'polymarket' | 'kalshi', price: number, role: LiquidityRole): number {
  return venueFeeFraction(venue, price, role);
}

/**
 * **Known wrong, deliberately unchanged, tracked in docs/entry-gate-fee-design.md.**
 *
 * The gate deducts a taker fee from every candidate's net edge, and production executes as a maker,
 * which Kalshi charges nothing for. At mid price that is 1.75pp — 35% of the 5pp `MIN_NET_EDGE`.
 *
 * It is not corrected here because correcting it changes what the desk trades. Measured over 11,479
 * admitted rows in 2,154 windows it moves 1.0% of volume: 201 rows cross the floor and are admitted,
 * 125 cross the `MAX_NET_EDGE` ceiling and are refused, and both marginal cohorts are individually
 * noise. It also shifts `edgeStrength` ranking and the `netEdge - medianNetEdge` measure that buy policy
 * v18's freshness sentinel is currently evaluating.
 *
 * **Close this when that sentinel reports.** Flipping this constant to `'maker'` is the whole change,
 * and it needs a policy version bump and a manifest entry stating it as a correctness fix with a
 * measured 1.0% volume effect, not an expected improvement in return.
 */
export const ENTRY_FEE_ROLE: LiquidityRole = 'taker';

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
    const feeRate = venueFeeRate(venue, price, ENTRY_FEE_ROLE);
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
 * DOWN/NO entry is permitted. The v14 suspension was withdrawn because its evidence did not reproduce.
 *
 * The suspension cited DOWN at -58.0% +/-14.7 over 44 settlement windows, accounting for -$17.86 of a
 * -$18.62 lifetime live result. Re-scored from the order ledger with the same convention the desk's own
 * trade record uses, live DOWN is -8.9% +/-16.8 over 56 windows — noise — and lifetime live P&L is
 * +$5.70, not negative. Excluding XRP, which is withheld separately and on evidence that does reproduce,
 * paper DOWN is -0.4% +/-10.7 over 80 windows. Four P&L conventions and eight time cutoffs were tried;
 * none recovers the original figures.
 *
 * That is not proof DOWN is profitable: the interval is wide and its point estimate is still negative.
 * It is a statement that no measurement supports removing roughly half the desk's volume, so the side
 * trades again while both tracks keep scoring it.
 *
 * Suspension remains one environment variable away if evidence arrives: MONEY_NOODLE_ALLOW_DOWN_ENTRY=false
 * stops the side on both tracks at once, because live and paper must run the same policy. A candidate
 * that stops DOWN belongs in the evaluation lane, not in a per-track flag. Exits, reduce-only sells,
 * and settlement of existing DOWN positions were never affected by either state.
 */
export function downEntryEnabled(): boolean {
  // One switch for both tracks. Paper exists to mirror live, so a per-track control here would be a
  // policy divergence between them — exactly what the mirror invariant forbids. See SPEC §12.3.
  return process.env.MONEY_NOODLE_ALLOW_DOWN_ENTRY !== 'false';
}

/**
 * The entry rules take no execution mode. Live and paper are the same policy by construction, so a
 * per-track divergence cannot be expressed here at all — the tracks differ only in execution and
 * capital. Candidate policies under evaluation never reach this path. See SPEC §12.3.
 */
const admissibleEntry = (option: VenueEntryOption) => option.price >= MIN_ENTRY_PRICE && option.price <= MAX_ENTRY_PRICE
  && option.probability >= MIN_SELECTED_SIDE_PROBABILITY
  && option.netEdge < maximumNetEdge()
  && (option.side === 'UP' || downEntryEnabled());

export function bestEntry(prediction: EntryCandidate): VenueEntryOption | undefined {
  return venueEntryOptions(prediction).find(admissibleEntry);
}

export function bestEntryForSide(prediction: EntryCandidate, side: PositionSide): VenueEntryOption | undefined {
  return venueEntryOptions(prediction).find((option) => option.side === side && admissibleEntry(option));
}

export function bestVenueEntry(prediction: EntryCandidate, venue: 'polymarket' | 'kalshi', side?: PositionSide): VenueEntryOption | undefined {
  return venueEntryOptions(prediction).find((option) => option.venue === venue && (!side || option.side === side) && admissibleEntry(option));
}

export function hasTradableEdge(prediction: EntryCandidate): boolean {
  const entry = bestEntry(prediction);
  return Boolean(entry && entry.netEdge >= MIN_NET_EDGE);
}

/** Ranking is by expected value scaled by how much we trust the estimate producing it. */
export function edgeStrength(prediction: EntryCandidate & Pick<Prediction, 'confidence'>): number {
  return Math.max(0, bestEntry(prediction)?.netEdge ?? 0) * prediction.confidence;
}

export function qualifiesVenueBuyEdge(prediction: EntryCandidate & Pick<Prediction, 'confidence'>, venue: 'polymarket' | 'kalshi', side?: PositionSide): boolean {
  const entry = bestVenueEntry(prediction, venue, side);
  // Repeats the DOWN control rather than relying on admissibleEntry: this function checks its
  // conditions inline, so omitting it here would leave an entry path the control does not cover.
  return prediction.confidence >= MIN_ESTIMATE_QUALITY && Boolean(entry
    && (entry.side === 'UP' || downEntryEnabled())
    && entry.netEdge >= MIN_NET_EDGE && entry.netEdge < maximumNetEdge() && entry.price >= MIN_ENTRY_PRICE && entry.price <= MAX_ENTRY_PRICE
    && sideProbability(prediction, entry.side) >= MIN_SELECTED_SIDE_PROBABILITY);
}

export function qualifiesAsBuyEdge(prediction: EntryCandidate & Pick<Prediction, 'confidence'>): boolean {
  return prediction.confidence >= MIN_ESTIMATE_QUALITY && hasTradableEdge(prediction);
}
