import { venueFeeFraction, type LiquidityRole } from './venue-fee-schedule';
import type { PositionSide, Prediction } from './types';

/**
 * Binary buy policy v22.
 *
 * The objective is profit, not forecast accuracy. A well-calibrated forecast still loses money when
 * it is bought at or above fair value, so qualification is expressed as expected value net of venue
 * fees rather than as a directional-likelihood threshold.
 *
 * The probability used here must be the venue-independent estimate. Blending the venue price into the
 * forecast and then subtracting that same price would shrink the disagreement the desk exists to trade.
 */

/**
 * Minimum expected value per $1 of payout, after fees, before a buy qualifies.
 *
 * **Restored to +5pp at v22**, reversing the v20 reduction to −5pp. A positive floor means the desk only
 * buys when its own probability exceeds the all-in cost of the contract, so every admitted row is a claim
 * of mispricing rather than agreement with a correctly priced favourite.
 *
 * **This reverses a decision whose evidence still reproduces, and that is an operator choice rather than
 * a measured promotion.** v20 lowered the floor because the 5pp gate was refusing 402 decisions that
 * returned +17.5% ±6.5 held to settlement. Replayed at 2026-08-20 over every recorded resolved snapshot,
 * that cohort is still positive: the exact-provider replay found 487 edge-floor decisions inside the
 * new price band returning +21.3% ±3.8 over 204 settlement timestamps. Across every v21 position, v22
 * was −3.7pp ±1.3 ask-priced versus v21; see `reports/entry-admission-v22-review-2026-08-20.md`.
 *
 * Those are ask-priced replays with no fill model. The desk fills roughly 48% of maker attempts and its
 * own measurements show adverse selection concentrating fills on the moves running against it, so an
 * ask-priced return is an upper bound this book has never realized. Concentrating capital on fewer,
 * higher-conviction tickets is the stated reason for accepting that trade. It is not what the replay
 * shows, and the replay is recorded here so the cost stays visible rather than being rediscovered later.
 */
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
/**
 * **Disarmed at v20** by raising the default to 1, which admits every edge the model can express.
 *
 * The calibration inversion this describes is real and is not withdrawn: above 35pp the model predicted
 * 64.0% and realized 37.6% over 218 windows. What changed is the statistic that decides. Win rate is the
 * wrong one for comparing across price levels — a high edge means a low price, and a lower win rate at a
 * much lower price still pays. Measured on return per dollar, the refused cohort returned +144% ±141 over
 * 18 decisions and contributed 8% of the v20 increment's profit on negligible stake.
 *
 * That is a wide interval on a small cohort. It is included because it is nearly free, not because it is
 * established. Restrictive only: re-arm with MONEY_NOODLE_MAX_NET_EDGE=0.35.
 */
export const MAX_NET_EDGE = 1;

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
 * These are our own limits, not venue limits: Kalshi quotes from $0.001 to $0.999.
 *
 * **Narrowed from 5–97¢ to 10–75¢ at v22.** Both ends now bind rather than acting as backstops, which
 * the previous band did not: with the 97¢ ceiling the expected-value test refused everything above
 * roughly 91¢ on its own, so the ceiling admitted no row the edge floor was not already deciding.
 * At 75¢ the ceiling is a live constraint — a 75¢ ask needs P(side) of at least 81.3% to clear the
 * +5pp floor after its 1.3¢ fee, and the probability cap of 0.97 leaves room for that. Under §5.7 this
 * is now a gate that changes admitted rows, and may be described as one.
 *
 * The 10¢ floor is deliberately above the old 5¢ one. Cheapness is not edge, and the floor bounds how
 * far into the model's documented calibration inversion the desk can reach: above 35pp of claimed edge
 * the model predicted 64.0% and realized 37.6% over 218 windows, and claimed edge rises as price falls.
 * `maximumNetEdge()` remains disarmed, so price is the only gate bounding that cohort. Replayed at
 * 2026-08-20 the band admits no row v21 did not already admit — it is purely restrictive, and it
 * withheld nine exact-provider decisions below 10¢ at the corrected review read; two won, with return
 * uncertainty wider than the estimate itself.
 */
export const MIN_ENTRY_PRICE = 0.10;
export const MAX_ENTRY_PRICE = 0.75;
export const BUY_POLICY_VERSION = 'buy-binary-edge-net5-nocap-quality50-owned55-price10to75-late30-persist2of15-v22';
/** Minimum unique resolved 15-minute settlement timestamps, never updates or per-asset cycles. */
export const MIN_CALIBRATION_SAMPLE = 100;

/**
 * Fee as a fraction of the $1 settlement payout, from the shared schedule.
 *
 * `role` is required so every caller states which schedule it means. The shared gate deliberately uses
 * immediate taker economics; adaptive execution computes its own maker/taker values later.
 */
export function venueFeeRate(venue: 'polymarket' | 'kalshi', price: number, role: LiquidityRole): number {
  return venueFeeFraction(venue, price, role);
}

/**
 * Shared admission uses the cost of immediate executable entry, before adaptive execution chooses how to
 * place the order. It is conservative when the later path rests as maker and correct when it takes.
 *
 * This is deliberately not an execution-role switch: making it depend on paper/live style would create a
 * circular rule and violate the mirror invariant. See docs/entry-gate-fee-design.md §10.
 */
export const ENTRY_ADMISSION_FEE_ROLE: LiquidityRole = 'taker';

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
    const feeRate = venueFeeRate(venue, price, ENTRY_ADMISSION_FEE_ROLE);
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
