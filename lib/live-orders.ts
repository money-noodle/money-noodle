import 'server-only';
import { kalshiConfigured, kalshiEnvironment, kalshiRequest } from './kalshi-api';
import { MANAGED_MAKER_HORIZON_SECONDS } from './maker-fill-model';
import type { PositionSide } from './types';

/**
 * Live order placement.
 *
 * Real money moves here, so every control is deliberately restrictive and opt-in. Live trading is
 * unavailable unless it is switched on by environment variable, which cannot be done from the UI.
 */
export function liveTradingEnabled(): boolean {
  return process.env.SIGNAL_DESK_ENABLE_LIVE === 'true' && process.env.SIGNAL_DESK_KILL_SWITCH !== 'true';
}

/** Live stakes are capped far below paper stakes while the execution path is being verified. */
export function maxLiveStakeCents(): number {
  const value = Number(process.env.SIGNAL_DESK_MAX_LIVE_STAKE_CENTS ?? 25);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 500) : 25;
}

export function maxLiveOrdersPerHour(): number {
  const value = Number(process.env.SIGNAL_DESK_MAX_LIVE_ORDERS_PER_HOUR ?? 4);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 60) : 4;
}

export function liveBlockers(): string[] {
  const blockers: string[] = [];
  if (process.env.SIGNAL_DESK_KILL_SWITCH === 'true') blockers.push('Kill switch is engaged (SIGNAL_DESK_KILL_SWITCH).');
  if (process.env.SIGNAL_DESK_ENABLE_LIVE !== 'true') blockers.push('Live trading is off. Set SIGNAL_DESK_ENABLE_LIVE=true in .env.local and restart.');
  if (!kalshiConfigured()) blockers.push('Kalshi signing credentials are not configured.');
  return blockers;
}

export interface LiveFill {
  venueOrderId: string;
  filledCount: number;
  averagePriceCents: number;
  feeCents: number;
  liquidityRole: 'maker' | 'taker';
  status: string;
}

interface KalshiCreateOrderV2Response {
  order_id?: string;
  fill_count?: string;
  remaining_count?: string;
  average_fill_price?: string;
  average_fee_paid?: string;
}

interface KalshiOrderResponse {
  order?: { status?: string; remaining_count_fp?: string; order_id?: string };
}

interface KalshiMarketResponse {
  market?: {
    yes_bid_dollars?: string;
    yes_ask_dollars?: string;
    price_ranges?: Array<{ start: string; end: string; step: string }>;
  };
}

interface KalshiFill {
  order_id?: string;
  count_fp?: string;
  yes_price_dollars?: string;
  fee_cost?: string;
  is_taker?: boolean;
}

interface KalshiFillsResponse { fills?: KalshiFill[] }

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAKER_MANAGEMENT_CHECKS = 6;
const MAKER_MANAGEMENT_POLL_MS = MANAGED_MAKER_HORIZON_SECONDS * 1000 / MAKER_MANAGEMENT_CHECKS;
const CANCELLATION_CONFIRMATION_DELAYS_MS = [0, 250, 750, 1_500, 2_500];

/**
 * Kalshi's order read can briefly lag a successful DELETE. Poll only for a bounded period and require
 * a terminal zero-remainder record; anything else remains ambiguous and enters full reconciliation.
 */
export async function confirmKalshiCancellation(
  venueOrderId: string,
  readOrder: () => Promise<KalshiOrderResponse>,
  wait: (milliseconds: number) => Promise<unknown> = sleep,
  delaysMs = CANCELLATION_CONFIRMATION_DELAYS_MS,
): Promise<void> {
  for (const delayMs of delaysMs) {
    if (delayMs) await wait(delayMs);
    try {
      const confirmed = await readOrder();
      const status = confirmed.order?.status?.toLowerCase();
      const remaining = Number(confirmed.order?.remaining_count_fp ?? Number.NaN);
      if (confirmed.order && status !== 'resting' && (status === 'canceled' || status === 'executed')
        && Number.isFinite(remaining) && remaining <= 1e-8) return;
    } catch {
      // A transient read failure is not cancellation evidence; use the remaining bounded reads.
    }
  }
  throw new Error(`Kalshi cancellation remains uncertain for ${venueOrderId}.`);
}

/**
 * Highest valid market price at or below a target across Kalshi's tapered ranges.
 *
 * Crypto books use 0.1c ticks below 10c, 1c ticks in the middle, then 0.1c above 90c. Reusing the
 * bid's tick after a reprice crosses 10c/90c creates an invalid price even though each side looked
 * valid independently.
 */
export function floorToValidKalshiPrice(priceDollars: number, ranges?: Array<{ start: string; end: string; step: string }>): number {
  let best = 0;
  for (const item of ranges ?? [{ start: '0', end: '1', step: '0.01' }]) {
    const start = Number(item.start), end = Number(item.end), step = Number(item.step);
    if (![start, end, step].every(Number.isFinite) || step <= 0 || priceDollars + 1e-10 < start) continue;
    const ceiling = Math.min(priceDollars, end);
    const candidate = start + Math.floor((ceiling - start + 1e-10) / step) * step;
    if (candidate <= priceDollars + 1e-9 && candidate <= end + 1e-9) best = Math.max(best, candidate);
  }
  return Number(best.toFixed(6));
}

/** Moves down by exact venue ticks, including across tapered 10c/90c boundaries. */
export function backOffValidKalshiPrice(priceDollars: number, ticks: number, ranges?: Array<{ start: string; end: string; step: string }>): number {
  let result = floorToValidKalshiPrice(priceDollars, ranges);
  for (let index = 0; index < ticks && result > 0; index += 1) result = floorToValidKalshiPrice(result - 1e-8, ranges);
  return result;
}

interface KalshiBookQuote { yesBid: number; yesAsk: number; ranges?: Array<{ start: string; end: string; step: string }> }

async function marketQuote(ticker: string): Promise<KalshiBookQuote> {
  const response = await kalshiRequest<KalshiMarketResponse>(`/markets/${encodeURIComponent(ticker)}`);
  const market = response.market;
  const yesBid = Number(market?.yes_bid_dollars);
  const yesAsk = Number(market?.yes_ask_dollars);
  if (!market || !Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid <= 0 || yesAsk <= yesBid) throw new Error('Kalshi did not return a usable live bid/ask.');
  return { yesBid, yesAsk, ranges: market.price_ranges };
}

/** Converts Kalshi's YES-denominated fill/limit price to the side the ledger owns. */
export function selectedSidePriceFromYes(yesPrice: number, side: PositionSide): number {
  return side === 'UP' ? yesPrice : 1 - yesPrice;
}

/** Converts a selected-side limit back to Kalshi's YES book representation. */
export function yesPriceFromSelectedSide(price: number, side: PositionSide): number {
  return side === 'UP' ? price : 1 - price;
}

export function kalshiOrderBookSide(positionSide: PositionSide, operation: 'entry' | 'exit'): 'bid' | 'ask' {
  if (operation === 'entry') return positionSide === 'UP' ? 'bid' : 'ask';
  return positionSide === 'UP' ? 'ask' : 'bid';
}

function selectedRanges(side: PositionSide, ranges?: Array<{ start: string; end: string; step: string }>): Array<{ start: string; end: string; step: string }> | undefined {
  if (side === 'UP' || !ranges) return ranges;
  return ranges.map((range) => ({
    start: String(1 - Number(range.end)), end: String(1 - Number(range.start)), step: range.step,
  })).sort((a, b) => Number(a.start) - Number(b.start));
}

function selectedQuote(quote: KalshiBookQuote, side: PositionSide): { bid: number; ask: number; ranges?: Array<{ start: string; end: string; step: string }> } {
  return side === 'UP'
    ? { bid: quote.yesBid, ask: quote.yesAsk, ranges: selectedRanges(side, quote.ranges) }
    : { bid: 1 - quote.yesAsk, ask: 1 - quote.yesBid, ranges: selectedRanges(side, quote.ranges) };
}

async function fillsFor(orderId: string, ticker: string): Promise<KalshiFill[]> {
  const response = await kalshiRequest<KalshiFillsResponse>(`/portfolio/fills?limit=200&ticker=${encodeURIComponent(ticker)}`);
  return (response.fills ?? []).filter((fill) => fill.order_id === orderId);
}

/**
 * Places a managed post-only limit buy.
 *
 * A marketable IOC is technically a limit order, but it removes liquidity and pays taker fees. This
 * implementation instead joins or improves the bid, waits, then amends toward the ask without ever
 * crossing it. Any remainder is cancelled before returning, and venue fill records supply the actual
 * price and fee. Repricing gives the order several chances to fill without turning it into a taker.
 */
export async function placeKalshiBuy(input: { ticker: string; positionSide?: PositionSide; priceCents: number; startPriceCents?: number; count: number; clientOrderId: string; onAccepted?: (venueOrderId: string) => Promise<void> }): Promise<LiveFill> {
  if (!liveTradingEnabled()) throw new Error('Live trading is disabled.');
  const positionSide = input.positionSide ?? 'UP';
  if (!Number.isFinite(input.priceCents) || input.priceCents < 0.1 || input.priceCents >= 100) throw new Error('Live order price must be between 0.1 and 99.9 cents.');
  const countUnits = Math.round(input.count * 100);
  if (!Number.isSafeInteger(countUnits) || countUnits < 1 || Math.abs(input.count * 100 - countUnits) > 1e-8) throw new Error('Live order count must be at least 0.01 contract in 0.01 increments.');

  const maximumDollars = input.priceCents / 100;
  const requestedStart = Number.isFinite(input.startPriceCents) ? Number(input.startPriceCents) / 100 : 0;
  let orderPrice = 0;
  let created: KalshiCreateOrderV2Response | undefined;
  for (let createAttempt = 0; createAttempt < 3 && !created; createAttempt += 1) {
    const quote = selectedQuote(await marketQuote(input.ticker), positionSide);
    const passiveCeiling = floorToValidKalshiPrice(Math.min(maximumDollars, quote.ask - 1e-8), quote.ranges);
    if (!(passiveCeiling > 0)) throw new Error(`No passive Kalshi ${positionSide} bid fits below the ${positionSide} ask.`);
    const highestRequestedPassive = floorToValidKalshiPrice(Math.min(passiveCeiling, Math.max(quote.bid, requestedStart)), quote.ranges);
    // After each acknowledgement race, concede one more valid tick rather than repeatedly chasing
    // the moving ask at the highest passive level.
    orderPrice = backOffValidKalshiPrice(highestRequestedPassive, createAttempt, quote.ranges);
    if (!(orderPrice > 0)) throw new Error('No backed-off passive Kalshi bid fits below the ask.');
    try {
      created = await kalshiRequest<KalshiCreateOrderV2Response>('/portfolio/events/orders', {
        method: 'POST',
        body: {
          ticker: input.ticker,
          side: kalshiOrderBookSide(positionSide, 'entry'),
          count: input.count.toFixed(2),
          // Kalshi's event book is YES-denominated. An ask opens NO exposure; the ledger and risk
          // cap remain in selected-side cents and are converted only at the signed API boundary.
          price: yesPriceFromSelectedSide(orderPrice, positionSide).toFixed(4),
          time_in_force: 'good_till_canceled',
          self_trade_prevention_type: 'taker_at_cross',
          post_only: true,
          cancel_order_on_pause: true,
          reduce_only: false,
          subaccount: 0,
          exchange_index: 0,
          // A definitively rejected post-only request can safely use a new id on the next attempt.
          client_order_id: createAttempt ? `${input.clientOrderId.slice(0, 30)}-${createAttempt}` : input.clientOrderId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const definitelyCrossed = message.includes('post') && (message.includes('cross') || message.includes('taker'));
      if (!definitelyCrossed || createAttempt === 2) throw error;
      // The ask moved between quote and submit. Refresh and move the post-only bid back below it.
    }
  }
  const venueOrderId = created?.order_id;
  if (!venueOrderId) throw new Error('Kalshi v2 returned no order id.');
  await input.onAccepted?.(venueOrderId);

  let managementError: unknown;
  try {
    // Manage for twelve seconds, moving gradually toward the highest passive level. Every amend
    // remains below the refreshed ask and below the original edge-approved maximum.
    for (let attempt = 0; attempt < MAKER_MANAGEMENT_CHECKS; attempt += 1) {
      await sleep(MAKER_MANAGEMENT_POLL_MS);
      const currentFills = await fillsFor(venueOrderId, input.ticker);
      const filled = currentFills.reduce((sum, fill) => sum + Number(fill.count_fp ?? 0), 0);
      if (filled >= input.count) break;
      if (attempt === MAKER_MANAGEMENT_CHECKS - 1) break;

      const quote = selectedQuote(await marketQuote(input.ticker), positionSide);
      const passiveCeiling = floorToValidKalshiPrice(Math.min(maximumDollars, quote.ask - 1e-8), quote.ranges);
      // Progressively traverse the passive spread; later checks follow the highest valid passive
      // level. Quantize each target in its own tapered range, not the prior bid's range.
      const progress = (attempt + 1) / (MAKER_MANAGEMENT_CHECKS - 1);
      const target = Math.min(passiveCeiling, quote.bid + (passiveCeiling - quote.bid) * progress);
      const nextPrice = floorToValidKalshiPrice(target, quote.ranges);
      if (nextPrice <= orderPrice + 1e-10) continue;
      try {
        await kalshiRequest(`/portfolio/events/orders/${encodeURIComponent(venueOrderId)}/amend`, {
          method: 'POST',
          body: { ticker: input.ticker, side: kalshiOrderBookSide(positionSide, 'entry'), price: yesPriceFromSelectedSide(nextPrice, positionSide).toFixed(4), count: input.count.toFixed(2), exchange_index: 0 },
        });
        orderPrice = nextPrice;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        // A rejected post-only amend leaves the already-accepted resting order unchanged. Continue
        // managing it rather than converting a safe amendment race into ambiguous order state.
        if (!(message.includes('post') && (message.includes('cross') || message.includes('taker')))) throw error;
      }
    }
  } catch (error) {
    managementError = error;
  } finally {
    // A fully filled order is terminal. Every remainder must have a confirmed non-resting state;
    // a lost DELETE response is followed by an authoritative order read rather than assumed safe.
    const beforeCancel = await fillsFor(venueOrderId, input.ticker).catch(() => []);
    const filledBeforeCancel = beforeCancel.reduce((sum, fill) => sum + Number(fill.count_fp ?? 0), 0);
    if (filledBeforeCancel + 1e-8 < input.count) {
      let cancelError: unknown;
      try {
        await kalshiRequest(`/portfolio/events/orders/${encodeURIComponent(venueOrderId)}?market_ticker=${encodeURIComponent(input.ticker)}`, { method: 'DELETE' });
      } catch (error) { cancelError = error; }
      try {
        await confirmKalshiCancellation(
          venueOrderId,
          () => kalshiRequest<KalshiOrderResponse>(`/portfolio/orders/${encodeURIComponent(venueOrderId)}`),
        );
      } catch (confirmationError) {
        if (cancelError) {
          const cancellationMessage = cancelError instanceof Error ? cancelError.message : 'DELETE request failed';
          const confirmationMessage = confirmationError instanceof Error ? confirmationError.message : 'confirmation failed';
          throw new Error(`${confirmationMessage} Cancellation request also reported: ${cancellationMessage}`);
        }
        throw confirmationError;
      }
    }
  }
  if (managementError) throw managementError;

  // Confirmed terminal order plus fills describe the complete acquired position.
  const fills = await fillsFor(venueOrderId, input.ticker);
  const filledCount = fills.reduce((sum, fill) => sum + Number(fill.count_fp ?? 0), 0);
  const weightedPriceDollars = fills.reduce((sum, fill) => sum + Number(fill.count_fp ?? 0) * selectedSidePriceFromYes(Number(fill.yes_price_dollars ?? 0), positionSide), 0);
  const feeDollars = fills.reduce((sum, fill) => sum + Number(fill.fee_cost ?? 0), 0);
  const averagePriceCents = filledCount ? weightedPriceDollars / filledCount * 100 : 0;
  const feeCents = feeDollars * 100;
  if (![filledCount, averagePriceCents, feeCents].every(Number.isFinite)) throw new Error('Kalshi returned malformed maker fill terms.');
  return {
    venueOrderId, filledCount, averagePriceCents, feeCents,
    liquidityRole: fills.some((fill) => fill.is_taker) ? 'taker' : 'maker',
    status: filledCount >= input.count ? 'filled' : filledCount > 0 ? 'partial' : 'unfilled',
  };
}

/**
 * Closes an existing YES or NO position with a reduce-only IOC limit.
 *
 * Kalshi rejects reduce-only FOK orders, so IOC is the safest supported primitive: it cannot flip the
 * account into a short position and leaves no resting remainder. Callers must reconcile a partial
 * fill and must not buy the replacement unless the incumbent closed completely.
 */
export async function placeKalshiSell(input: { ticker: string; positionSide?: PositionSide; minimumPriceCents: number; count: number; clientOrderId: string; onAccepted?: (venueOrderId: string) => Promise<void> }): Promise<LiveFill> {
  if (!liveTradingEnabled()) throw new Error('Live trading is disabled.');
  const positionSide = input.positionSide ?? 'UP';
  const countUnits = Math.round(input.count * 100);
  if (!Number.isSafeInteger(countUnits) || countUnits < 1 || Math.abs(input.count * 100 - countUnits) > 1e-8) throw new Error('Live sell count must be at least 0.01 contract in 0.01 increments.');
  if (!Number.isFinite(input.minimumPriceCents) || input.minimumPriceCents < 0.1 || input.minimumPriceCents >= 100) throw new Error('Live sell limit must be between 0.1 and 99.9 cents.');
  const response = await kalshiRequest<KalshiCreateOrderV2Response>('/portfolio/events/orders', {
    method: 'POST',
    body: {
      ticker: input.ticker,
      side: kalshiOrderBookSide(positionSide, 'exit'),
      count: input.count.toFixed(2),
      price: yesPriceFromSelectedSide(input.minimumPriceCents / 100, positionSide).toFixed(4),
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      post_only: false,
      reduce_only: true,
      subaccount: 0,
      exchange_index: 0,
      client_order_id: input.clientOrderId,
    },
  });
  const venueOrderId = response.order_id;
  if (!venueOrderId) throw new Error('Kalshi v2 returned no reduce-only exit order id.');
  await input.onAccepted?.(venueOrderId);
  const filledCount = Number(response.fill_count ?? 0);
  const averagePriceCents = selectedSidePriceFromYes(Number(response.average_fill_price ?? 0), positionSide) * 100;
  const feeCents = Number(response.average_fee_paid ?? 0) * filledCount * 100;
  if (![filledCount, averagePriceCents, feeCents].every(Number.isFinite)) throw new Error('Kalshi returned malformed exit fill terms.');
  return {
    venueOrderId, filledCount, averagePriceCents, feeCents, liquidityRole: 'taker',
    status: filledCount + 1e-8 >= input.count ? 'filled' : filledCount > 0 ? 'partial' : 'unfilled',
  };
}

export function liveEnvironmentLabel(): 'demo' | 'production' {
  return kalshiEnvironment();
}
