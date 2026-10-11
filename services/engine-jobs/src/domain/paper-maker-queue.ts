// Stage 3 bounded domain slice. Public trade evidence only; no provider client,
// scheduler, persistence, calibration promotion or funded execution capability.
// Historical v7 queue arithmetic is retained. This module does NOT enable paper.
export interface PaperTradePrint {
  readonly id: string;
  readonly at: string;
  readonly count: number;
  readonly yesPrice: number;
  readonly noPrice: number;
  readonly takerSide: 'yes' | 'no';
}
export interface PaperMakerQueueState {
  side: 'UP' | 'DOWN';
  requestedCount: number;
  currentLimit: number;
  queueAhead?: number;
  filledCount: number;
  purchaseCents: number;
  observedTradeIds: Set<string>;
}
export interface PaperMakerTradeEvidence {
  consumingTradeCount: number;
  consumingTradeQuantity: number;
  firstConsumingTradeAt: string | undefined;
  lastConsumingTradeAt: string | undefined;
  queueAheadBefore: number | undefined;
  queueAheadAfter: number | undefined;
  fillAdded: number;
}
export const PAPER_MAKER_CHECKS = 6;
export const PAPER_MAKER_POLL_MS = 2_000;
export const PAPER_MAKER_HORIZON_MS = 12_000;
const MAX_PRINTS = 1_000;
const MAX_SEEN_PRINTS = 20_000;
function validateQueueEvidence(
  state: PaperMakerQueueState,
  trades: readonly PaperTradePrint[],
): void {
  if (
    (state.side !== 'UP' && state.side !== 'DOWN') ||
    ![state.requestedCount, state.currentLimit, state.filledCount, state.purchaseCents].every(
      Number.isFinite,
    ) ||
    state.requestedCount <= 0 ||
    state.requestedCount > 1_000_000 ||
    state.currentLimit <= 0 ||
    state.currentLimit >= 1 ||
    state.filledCount < 0 ||
    state.filledCount > state.requestedCount ||
    state.purchaseCents < 0 ||
    (state.queueAhead !== undefined &&
      (!Number.isFinite(state.queueAhead) || state.queueAhead < 0)) ||
    trades.length > MAX_PRINTS ||
    state.observedTradeIds.size + trades.length > MAX_SEEN_PRINTS ||
    trades.some(
      (trade) =>
        typeof trade.id !== 'string' ||
        trade.id.length < 1 ||
        trade.id.length > 256 ||
        typeof trade.at !== 'string' ||
        trade.at.length > 64 ||
        ![trade.count, trade.yesPrice, trade.noPrice].every(Number.isFinite) ||
        trade.count <= 0 ||
        trade.count > 1_000_000 ||
        trade.yesPrice < 0 ||
        trade.yesPrice > 1 ||
        trade.noPrice < 0 ||
        trade.noPrice > 1 ||
        (trade.takerSide !== 'yes' && trade.takerSide !== 'no'),
    )
  ) {
    throw new Error('Invalid or unbounded paper queue evidence.');
  }
}
export function paperMakerEventTimeMicros(value: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) return undefined;
  const secondMs = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(secondMs)) return undefined;
  const fractionalMicros = Number((match[2] ?? '').padEnd(6, '0'));
  const result = secondMs * 1_000 + fractionalMicros;
  return Number.isSafeInteger(result) ? result : undefined;
}

export function paperMakerEventWithinHorizon(
  eventAtMicros: number,
  acceptedAtMicros: number,
  restingUntilMicros: number,
): boolean {
  return (
    Number.isSafeInteger(eventAtMicros) &&
    Number.isSafeInteger(acceptedAtMicros) &&
    Number.isSafeInteger(restingUntilMicros) &&
    restingUntilMicros >= acceptedAtMicros &&
    eventAtMicros >= acceptedAtMicros &&
    eventAtMicros <= restingUntilMicros
  );
}

export function applyTradePrintsToPaperQueue(
  state: PaperMakerQueueState,
  trades: readonly PaperTradePrint[],
  acceptedAtMs: number,
  restingUntilMs: number,
): PaperMakerTradeEvidence {
  validateQueueEvidence(state, trades);
  if (
    !Number.isSafeInteger(acceptedAtMs) ||
    !Number.isSafeInteger(restingUntilMs) ||
    restingUntilMs < acceptedAtMs ||
    restingUntilMs - acceptedAtMs > PAPER_MAKER_HORIZON_MS
  ) {
    throw new Error('Invalid paper maker horizon.');
  }
  const consumingTakerSide = state.side === 'UP' ? 'no' : 'yes';
  const queueAheadBefore = state.queueAhead;
  const filledBefore = state.filledCount;
  let consumingTradeCount = 0,
    consumingTradeQuantity = 0;
  let firstConsumingTradeAt: string | undefined, lastConsumingTradeAt: string | undefined;
  for (const trade of [...trades].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  )) {
    if (state.observedTradeIds.has(trade.id)) continue;
    const eventAtMicros = paperMakerEventTimeMicros(trade.at);
    if (
      eventAtMicros === undefined ||
      !paperMakerEventWithinHorizon(eventAtMicros, acceptedAtMs * 1_000, restingUntilMs * 1_000)
    )
      continue;
    state.observedTradeIds.add(trade.id);
    if (trade.takerSide !== consumingTakerSide) continue;
    const selectedTradePrice = state.side === 'UP' ? trade.yesPrice : trade.noPrice;
    if (selectedTradePrice > state.currentLimit + 1e-9 || state.queueAhead === undefined) continue;
    consumingTradeCount += 1;
    consumingTradeQuantity += trade.count;
    firstConsumingTradeAt ??= trade.at;
    lastConsumingTradeAt = trade.at;
    let available = trade.count;
    const ahead = Math.min(state.queueAhead, available);
    state.queueAhead = Math.max(0, state.queueAhead - ahead);
    available -= ahead;
    if (available <= 1e-8) continue;
    const fill = Math.min(available, state.requestedCount - state.filledCount);
    if (fill <= 1e-8) continue;
    // Had our superior/equal bid really been present, an aggressive seller would execute at our limit,
    // not at the lower print produced by a book that necessarily omits the hypothetical paper order.
    state.filledCount += fill;
    state.purchaseCents += fill * state.currentLimit * 100;
    if (state.filledCount + 1e-8 >= state.requestedCount) {
      state.filledCount = state.requestedCount;
      break;
    }
  }
  return {
    consumingTradeCount,
    consumingTradeQuantity,
    firstConsumingTradeAt,
    lastConsumingTradeAt,
    queueAheadBefore,
    queueAheadAfter: state.queueAhead,
    fillAdded: state.filledCount - filledBefore,
  };
}
