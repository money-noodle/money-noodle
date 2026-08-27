import 'server-only';
import { kalshiConfigured, kalshiEnvironment, kalshiRequest } from './kalshi-api';
import { observeKalshiOrderBook } from './kalshi-depth';
import { kalshiMakerCreateClientOrderId } from './live-order-identity';
import {
  MAKER_MANAGEMENT_CHECKS, MAKER_MANAGEMENT_POLL_MS, boundedTakerLimit,
  initialManagedMakerPrice, nextManagedMakerPrice,
  selectedManagedMakerQuote,
} from './managed-maker';
import { selectedSideDepth } from './order-book-depth';
import { beginTaskCadenceRun } from './task-cadence-runtime';

export { advanceValidKalshiPrice, backOffValidKalshiPrice, boundedTakerLimit, floorToValidKalshiPrice } from './managed-maker';
import type { BinaryOrderBook, EntryExecutionObservation, PositionSide } from './types';

/**
 * Live order placement.
 *
 * Real money moves here, so every control is deliberately restrictive and opt-in. Live trading is
 * unavailable unless it is switched on by environment variable, which cannot be done from the UI.
 */
export function liveTradingEnabled(): boolean {
  return process.env.MONEY_NOODLE_ENABLE_LIVE === 'true' && process.env.MONEY_NOODLE_KILL_SWITCH !== 'true';
}

/** Live stakes are capped far below paper stakes while the execution path is being verified. */
export function maxLiveStakeCents(): number {
  const value = Number(process.env.MONEY_NOODLE_MAX_LIVE_STAKE_CENTS ?? 25);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 500) : 25;
}

export function maxLiveOrdersPerHour(): number {
  const value = Number(process.env.MONEY_NOODLE_MAX_LIVE_ORDERS_PER_HOUR ?? 4);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 60) : 4;
}

export function liveBlockers(): string[] {
  const blockers: string[] = [];
  if (process.env.MONEY_NOODLE_KILL_SWITCH === 'true') blockers.push('Kill switch is engaged (MONEY_NOODLE_KILL_SWITCH).');
  if (process.env.MONEY_NOODLE_ENABLE_LIVE !== 'true') blockers.push('Live trading is off. Set MONEY_NOODLE_ENABLE_LIVE=true in .env.local and restart.');
  if (!kalshiConfigured()) blockers.push('Kalshi signing credentials are not configured.');
  return blockers;
}

export interface LiveFill {
  venueOrderId: string;
  exchangeIndex: number;
  filledCount: number;
  averagePriceCents: number;
  feeCents: number;
  liquidityRole: 'maker' | 'taker';
  status: string;
  executionObservations: EntryExecutionObservation[];
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
    ticker?: string;
    status?: string;
    exchange_index?: unknown;
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

interface KalshiMarketWireIdentity { ticker: string; exchangeIndex: number }
interface KalshiBookQuote extends KalshiMarketWireIdentity {
  yesBid: number;
  yesAsk: number;
  ranges?: Array<{ start: string; end: string; step: string }>;
  orderBook?: BinaryOrderBook;
}

export function validateKalshiExchangeIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Kalshi exact market returned an invalid exchange_index.');
  }
  return value;
}

export function validateKalshiMarketWireIdentity(
  requestedTicker: string,
  market: KalshiMarketResponse['market'],
): KalshiMarketWireIdentity {
  if (!market || market.ticker !== requestedTicker) {
    throw new Error(`Kalshi exact market identity did not match requested ticker ${requestedTicker}.`);
  }
  if (market.status !== 'active') throw new Error(`Kalshi exact market ${requestedTicker} is not active.`);
  return { ticker: requestedTicker, exchangeIndex: validateKalshiExchangeIndex(market.exchange_index) };
}

export function stableKalshiExchangeIndex(captured: number | undefined, observed: number): number {
  const validObserved = validateKalshiExchangeIndex(observed);
  if (captured === undefined) return validObserved;
  const validCaptured = validateKalshiExchangeIndex(captured);
  if (validCaptured !== validObserved) {
    throw new Error(`Kalshi exchange_index changed from ${validCaptured} to ${validObserved} during one order transaction.`);
  }
  return validCaptured;
}

async function exactMarket(ticker: string): Promise<NonNullable<KalshiMarketResponse['market']>> {
  const response = await kalshiRequest<KalshiMarketResponse>(`/markets/${encodeURIComponent(ticker)}`);
  validateKalshiMarketWireIdentity(ticker, response.market);
  return response.market!;
}

async function marketQuote(ticker: string): Promise<KalshiBookQuote> {
  const market = await exactMarket(ticker);
  const identity = validateKalshiMarketWireIdentity(ticker, market);
  // This starts an optional public refresh but returns cached depth synchronously, so queue telemetry
  // cannot delay the signed quote or any amend/cancel operation.
  const orderBook = observeKalshiOrderBook(ticker);
  const yesBid = Number(market.yes_bid_dollars);
  const yesAsk = Number(market.yes_ask_dollars);
  if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid <= 0 || yesAsk <= yesBid) throw new Error('Kalshi did not return a usable live bid/ask.');
  return { ...identity, yesBid, yesAsk, ranges: market.price_ranges, orderBook };
}

async function timedPreSubmit<T>(read: () => Promise<T>): Promise<T> {
  const taskRun = beginTaskCadenceRun('exact-pre-submit-quote');
  try {
    const value = await read();
    taskRun.succeed();
    return value;
  } catch (error) {
    taskRun.fail(error);
    throw error;
  }
}

const preSubmitQuote = (ticker: string) => timedPreSubmit(() => marketQuote(ticker));
const preSubmitMarketIdentity = async (ticker: string) => timedPreSubmit(async () => {
  const market = await exactMarket(ticker);
  return validateKalshiMarketWireIdentity(ticker, market);
});

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

function selectedQuote(quote: KalshiBookQuote, side: PositionSide) {
  return {
    ...selectedManagedMakerQuote({
      yesBid: quote.yesBid, yesAsk: quote.yesAsk, side, ranges: quote.ranges, orderBook: quote.orderBook,
    }),
    ticker: quote.ticker,
    exchangeIndex: quote.exchangeIndex,
  };
}

interface KalshiEntryBodyInput {
  ticker: string;
  positionSide: PositionSide;
  selectedLimit: number;
  count: number;
  clientOrderId: string;
  exchangeIndex: number;
}

export function kalshiTakerEntryOrderBody(input: KalshiEntryBodyInput) {
  return {
    ticker: input.ticker,
    side: kalshiOrderBookSide(input.positionSide, 'entry'),
    count: input.count.toFixed(2),
    price: yesPriceFromSelectedSide(input.selectedLimit, input.positionSide).toFixed(4),
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross',
    post_only: false,
    cancel_order_on_pause: true,
    reduce_only: false,
    subaccount: 0,
    exchange_index: validateKalshiExchangeIndex(input.exchangeIndex),
    client_order_id: input.clientOrderId,
  };
}

export function kalshiMakerEntryOrderBody(input: KalshiEntryBodyInput) {
  return {
    ...kalshiTakerEntryOrderBody(input),
    time_in_force: 'good_till_canceled',
    post_only: true,
  };
}

export function kalshiMakerAmendOrderBody(input: Omit<KalshiEntryBodyInput, 'clientOrderId'>) {
  return {
    ticker: input.ticker,
    side: kalshiOrderBookSide(input.positionSide, 'entry'),
    price: yesPriceFromSelectedSide(input.selectedLimit, input.positionSide).toFixed(4),
    count: input.count.toFixed(2),
    exchange_index: validateKalshiExchangeIndex(input.exchangeIndex),
  };
}

export function kalshiExitOrderBody(input: KalshiEntryBodyInput) {
  return {
    ticker: input.ticker,
    side: kalshiOrderBookSide(input.positionSide, 'exit'),
    count: input.count.toFixed(2),
    price: yesPriceFromSelectedSide(input.selectedLimit, input.positionSide).toFixed(4),
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross',
    post_only: false,
    reduce_only: true,
    subaccount: 0,
    exchange_index: validateKalshiExchangeIndex(input.exchangeIndex),
    client_order_id: input.clientOrderId,
  };
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
export async function placeKalshiBuy(input: {
  ticker: string; positionSide?: PositionSide; priceCents: number; startPriceCents?: number;
  count: number; clientOrderId: string; onAccepted?: (venueOrderId: string, exchangeIndex: number) => Promise<void>;
  onObservation?: (observation: EntryExecutionObservation) => Promise<void>;
}): Promise<LiveFill> {
  if (!liveTradingEnabled()) throw new Error('Live trading is disabled.');
  const positionSide = input.positionSide ?? 'UP';
  if (!Number.isFinite(input.priceCents) || input.priceCents < 0.1 || input.priceCents >= 100) throw new Error('Live order price must be between 0.1 and 99.9 cents.');
  const countUnits = Math.round(input.count * 100);
  if (!Number.isSafeInteger(countUnits) || countUnits < 1 || Math.abs(input.count * 100 - countUnits) > 1e-8) throw new Error('Live order count must be at least 0.01 contract in 0.01 increments.');

  const maximumDollars = input.priceCents / 100;
  const requestedStart = Number.isFinite(input.startPriceCents) ? Number(input.startPriceCents) / 100 : 0;
  const executionObservations: EntryExecutionObservation[] = [];
  const emit = async (observation: EntryExecutionObservation) => {
    executionObservations.push(observation);
    try { await input.onObservation?.(observation); }
    catch (error) { console.error('Entry execution observation could not be persisted immediately:', error); }
  };
  const quoteObservation = (event: EntryExecutionObservation['event'], quote: ReturnType<typeof selectedQuote>, limitPrice: number, patch: Partial<EntryExecutionObservation> = {}): EntryExecutionObservation => ({
    at: new Date().toISOString(), event, selectedBid: quote.bid, selectedAsk: quote.ask,
    spread: quote.ask - quote.bid, limitPrice, exchangeIndex: quote.exchangeIndex,
    touched: quote.ask <= limitPrice + 1e-9,
    ...selectedSideDepth(quote.orderBook, positionSide, quote.bid, quote.ask, limitPrice),
    ...patch,
  });
  let orderPrice = 0;
  let exchangeIndex: number | undefined;
  let created: KalshiCreateOrderV2Response | undefined;
  for (let createAttempt = 0; createAttempt < 3 && !created; createAttempt += 1) {
    const quote = selectedQuote(await preSubmitQuote(input.ticker), positionSide);
    exchangeIndex = stableKalshiExchangeIndex(exchangeIndex, quote.exchangeIndex);
    // After each acknowledgement race, concede one more valid tick rather than repeatedly chasing
    // the moving ask at the highest passive level. Paper calls this same pure decision.
    orderPrice = initialManagedMakerPrice({
      quote, maximumPrice: maximumDollars, requestedStart, createAttempt,
    });
    if (!(orderPrice > 0)) throw new Error('No backed-off passive Kalshi bid fits below the ask.');
    await emit(quoteObservation('create_quote', quote, orderPrice));
    try {
      created = await kalshiRequest<KalshiCreateOrderV2Response>('/portfolio/events/orders', {
        method: 'POST',
        // Kalshi's event book is YES-denominated. An ask opens NO exposure; the ledger and risk
        // cap remain in selected-side cents and are converted only at the signed API boundary.
        body: kalshiMakerEntryOrderBody({
          ticker: input.ticker, positionSide, selectedLimit: orderPrice, count: input.count,
          exchangeIndex,
          // A definitively rejected post-only request can safely use a new exact attempt id. The complete
          // episode identity is retained; truncation would let later episodes alias earlier ones.
          clientOrderId: kalshiMakerCreateClientOrderId(input.clientOrderId, createAttempt),
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const definitelyCrossed = message.includes('post') && (message.includes('cross') || message.includes('taker'));
      await emit(quoteObservation('create_rejected', quote, orderPrice, { reason: error instanceof Error ? error.message : 'Create rejected' }));
      if (!definitelyCrossed || createAttempt === 2) throw error;
      // The ask moved between quote and submit. Refresh and move the post-only bid back below it.
    }
  }
  const venueOrderId = created?.order_id;
  if (!venueOrderId) throw new Error('Kalshi v2 returned no order id.');
  const acceptedExchangeIndex = validateKalshiExchangeIndex(exchangeIndex);
  await input.onAccepted?.(venueOrderId, acceptedExchangeIndex);
  const acceptedAtMs = Date.now();
  await emit({
    at: new Date(acceptedAtMs).toISOString(), event: 'accepted', limitPrice: orderPrice,
    exchangeIndex: acceptedExchangeIndex, filledCount: 0, remainingCount: input.count,
  });

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
      stableKalshiExchangeIndex(acceptedExchangeIndex, quote.exchangeIndex);
      // Progressively traverse the passive spread using the same pure state transition as paper.
      const nextPrice = nextManagedMakerPrice({
        quote, maximumPrice: maximumDollars, currentPrice: orderPrice, managementAttempt: attempt,
      });
      await emit(quoteObservation('management_quote', quote, orderPrice, { filledCount: filled, remainingCount: Math.max(0, input.count - filled) }));
      if (nextPrice <= orderPrice + 1e-10) continue;
      try {
        await kalshiRequest(`/portfolio/events/orders/${encodeURIComponent(venueOrderId)}/amend`, {
          method: 'POST',
          body: kalshiMakerAmendOrderBody({
            ticker: input.ticker, positionSide, selectedLimit: nextPrice,
            count: input.count, exchangeIndex: acceptedExchangeIndex,
          }),
        });
        orderPrice = nextPrice;
        await emit(quoteObservation('amend_accepted', quote, nextPrice, { filledCount: filled, remainingCount: Math.max(0, input.count - filled) }));
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        // A rejected post-only amend leaves the already-accepted resting order unchanged. Continue
        // managing it rather than converting a safe amendment race into ambiguous order state.
        await emit(quoteObservation('amend_rejected', quote, nextPrice, {
          filledCount: filled, remainingCount: Math.max(0, input.count - filled),
          reason: error instanceof Error ? error.message : 'Amend rejected',
        }));
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
      const cancellationStartedAt = Date.now();
      await emit({
        at: new Date(cancellationStartedAt).toISOString(), event: 'cancel_requested', limitPrice: orderPrice,
        filledCount: filledBeforeCancel, remainingCount: Math.max(0, input.count - filledBeforeCancel),
      });
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
      await emit({
        at: new Date().toISOString(), event: 'cancel_confirmed', limitPrice: orderPrice,
        filledCount: filledBeforeCancel, remainingCount: 0,
        cancellationLatencyMs: Date.now() - cancellationStartedAt,
      });
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
  await emit({
    at: new Date().toISOString(), event: 'terminal_fill', limitPrice: orderPrice,
    filledCount, remainingCount: Math.max(0, input.count - filledCount),
    restingDurationMs: Date.now() - acceptedAtMs,
  });
  return {
    venueOrderId, exchangeIndex: acceptedExchangeIndex, filledCount, averagePriceCents, feeCents,
    liquidityRole: fills.some((fill) => fill.is_taker) ? 'taker' : 'maker',
    status: filledCount >= input.count ? 'filled' : filledCount > 0 ? 'partial' : 'unfilled',
    executionObservations,
  };
}

/**
 * Opens selected-side exposure with a marketable IOC limit capped at the caller's all-in reserved maximum.
 * This is never an uncapped market order: a quote beyond that maximum fails before submission, and IOC leaves
 * no resting remainder. The caller must durably persist the client and venue IDs exactly as for maker.
 */
export async function placeKalshiTakerBuy(input: {
  ticker: string; positionSide?: PositionSide; maximumPriceCents: number; count: number;
  clientOrderId: string; onAccepted?: (venueOrderId: string, exchangeIndex: number) => Promise<void>;
  onObservation?: (observation: EntryExecutionObservation) => Promise<void>;
  cushionTicks?: number;
  authorizeQuote?: (quote: { bid: number; ask: number; spread: number; limit: number; tickSize: number }) => string | undefined;
}): Promise<LiveFill> {
  if (!liveTradingEnabled()) throw new Error('Live trading is disabled.');
  const positionSide = input.positionSide ?? 'UP';
  const countUnits = Math.round(input.count * 100);
  if (!Number.isSafeInteger(countUnits) || countUnits < 1 || Math.abs(input.count * 100 - countUnits) > 1e-8) throw new Error('Live order count must be at least 0.01 contract in 0.01 increments.');
  if (!Number.isFinite(input.maximumPriceCents) || input.maximumPriceCents < 0.1 || input.maximumPriceCents >= 100) throw new Error('Live order price must be between 0.1 and 99.9 cents.');

  const executionObservations: EntryExecutionObservation[] = [];
  const emit = async (observation: EntryExecutionObservation) => {
    executionObservations.push(observation);
    try { await input.onObservation?.(observation); }
    catch (error) { console.error('Entry execution observation could not be persisted immediately:', error); }
  };
  const quote = selectedQuote(await preSubmitQuote(input.ticker), positionSide);
  const maximumDollars = input.maximumPriceCents / 100;
  const cushionTicks = input.cushionTicks ?? 0;
  if (!Number.isSafeInteger(cushionTicks) || cushionTicks < 0 || cushionTicks > 2) throw new Error('Taker cushion must be zero, one, or two venue ticks.');
  const terms = boundedTakerLimit({ ask: quote.ask, maximumPrice: maximumDollars, cushionTicks, ranges: quote.ranges });
  if (!terms) throw new Error('Taker not submitted: exact quote could not produce a valid venue-ladder limit.');
  const { limit, tickSize } = terms;
  if (limit + 1e-9 < quote.ask) throw new Error(`Taker not submitted: current ${positionSide} ask ${(quote.ask * 100).toFixed(1)}c exceeds approved ${(maximumDollars * 100).toFixed(1)}c cap.`);
  const refusal = input.authorizeQuote?.({ bid: quote.bid, ask: quote.ask, spread: quote.ask - quote.bid, limit, tickSize });
  if (refusal) throw new Error(`Taker not submitted: refreshed quote no longer clears execution policy. ${refusal}`);
  await emit({
    at: new Date().toISOString(), event: 'create_quote', selectedBid: quote.bid, selectedAsk: quote.ask,
    spread: quote.ask - quote.bid, limitPrice: limit, exchangeIndex: quote.exchangeIndex,
    ...selectedSideDepth(quote.orderBook, positionSide, quote.bid, quote.ask, limit),
  });
  const created = await kalshiRequest<KalshiCreateOrderV2Response>('/portfolio/events/orders', {
    method: 'POST',
    body: kalshiTakerEntryOrderBody({
      ticker: input.ticker, positionSide, selectedLimit: limit, exchangeIndex: quote.exchangeIndex,
      count: input.count, clientOrderId: input.clientOrderId,
    }),
  });
  const venueOrderId = created.order_id;
  if (!venueOrderId) throw new Error('Kalshi accepted the taker order but returned no order id.');
  await input.onAccepted?.(venueOrderId, quote.exchangeIndex);
  const acceptedAtMs = Date.now();
  await emit({
    at: new Date(acceptedAtMs).toISOString(), event: 'accepted', limitPrice: limit,
    exchangeIndex: quote.exchangeIndex, filledCount: 0, remainingCount: input.count,
  });
  const cancellationStartedAt = Date.now();
  await confirmKalshiCancellation(
    venueOrderId,
    () => kalshiRequest<KalshiOrderResponse>(`/portfolio/orders/${encodeURIComponent(venueOrderId)}`),
  );
  await emit({ at: new Date().toISOString(), event: 'cancel_confirmed', limitPrice: limit, remainingCount: 0, cancellationLatencyMs: Date.now() - cancellationStartedAt });

  let fills: KalshiFill[] = [];
  for (const delayMs of [0, 250, 750, 1_500]) {
    if (delayMs) await sleep(delayMs);
    fills = await fillsFor(venueOrderId, input.ticker);
    if (fills.length || Number(created.fill_count ?? 0) <= 0) break;
  }
  if (Number(created.fill_count ?? 0) > 0 && !fills.length) throw new Error(`Kalshi taker fill records remain unavailable for ${venueOrderId}.`);
  const filledCount = fills.reduce((sum, fill) => sum + Number(fill.count_fp ?? 0), 0);
  const weightedPriceDollars = fills.reduce((sum, fill) => sum + Number(fill.count_fp ?? 0) * selectedSidePriceFromYes(Number(fill.yes_price_dollars ?? 0), positionSide), 0);
  const feeDollars = fills.reduce((sum, fill) => sum + Number(fill.fee_cost ?? 0), 0);
  const averagePriceCents = filledCount ? weightedPriceDollars / filledCount * 100 : 0;
  const feeCents = feeDollars * 100;
  if (![filledCount, averagePriceCents, feeCents].every(Number.isFinite) || filledCount > input.count + 1e-8) throw new Error('Kalshi returned malformed taker fill terms.');
  await emit({ at: new Date().toISOString(), event: 'terminal_fill', limitPrice: limit, filledCount, remainingCount: Math.max(0, input.count - filledCount), restingDurationMs: Date.now() - acceptedAtMs });
  return {
    venueOrderId, exchangeIndex: quote.exchangeIndex, filledCount, averagePriceCents, feeCents, liquidityRole: 'taker',
    status: filledCount >= input.count ? 'filled' : filledCount > 0 ? 'partial' : 'unfilled', executionObservations,
  };
}

/**
 * Closes an existing YES or NO position with a reduce-only IOC limit.
 *
 * Kalshi rejects reduce-only FOK orders, so IOC is the safest supported primitive: it cannot flip the
 * account into a short position and leaves no resting remainder. Callers must reconcile a partial
 * fill and must not buy the replacement unless the incumbent closed completely.
 */
export async function placeKalshiSell(input: { ticker: string; positionSide?: PositionSide; minimumPriceCents: number; count: number; clientOrderId: string; onAccepted?: (venueOrderId: string, exchangeIndex: number) => Promise<void> }): Promise<LiveFill> {
  if (!liveTradingEnabled()) throw new Error('Live trading is disabled.');
  const positionSide = input.positionSide ?? 'UP';
  const countUnits = Math.round(input.count * 100);
  if (!Number.isSafeInteger(countUnits) || countUnits < 1 || Math.abs(input.count * 100 - countUnits) > 1e-8) throw new Error('Live sell count must be at least 0.01 contract in 0.01 increments.');
  if (!Number.isFinite(input.minimumPriceCents) || input.minimumPriceCents < 0.1 || input.minimumPriceCents >= 100) throw new Error('Live sell limit must be between 0.1 and 99.9 cents.');
  const { exchangeIndex } = await preSubmitMarketIdentity(input.ticker);
  const response = await kalshiRequest<KalshiCreateOrderV2Response>('/portfolio/events/orders', {
    method: 'POST',
    body: kalshiExitOrderBody({
      ticker: input.ticker, positionSide, selectedLimit: input.minimumPriceCents / 100,
      count: input.count, clientOrderId: input.clientOrderId, exchangeIndex,
    }),
  });
  const venueOrderId = response.order_id;
  if (!venueOrderId) throw new Error('Kalshi v2 returned no reduce-only exit order id.');
  await input.onAccepted?.(venueOrderId, exchangeIndex);
  const filledCount = Number(response.fill_count ?? 0);
  const averagePriceCents = selectedSidePriceFromYes(Number(response.average_fill_price ?? 0), positionSide) * 100;
  const feeCents = Number(response.average_fee_paid ?? 0) * filledCount * 100;
  if (![filledCount, averagePriceCents, feeCents].every(Number.isFinite)) throw new Error('Kalshi returned malformed exit fill terms.');
  return {
    venueOrderId, exchangeIndex, filledCount, averagePriceCents, feeCents, liquidityRole: 'taker',
    status: filledCount + 1e-8 >= input.count ? 'filled' : filledCount > 0 ? 'partial' : 'unfilled',
    executionObservations: [],
  };
}

export function liveEnvironmentLabel(): 'demo' | 'production' {
  return kalshiEnvironment();
}
