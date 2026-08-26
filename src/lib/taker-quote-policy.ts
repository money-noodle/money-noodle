import { MAX_ENTRY_PRICE } from './prediction-policy';

/** Maximum selected-side ask movement accepted between issuance and the signed taker refresh. */
export const MAX_TAKER_QUOTE_MOVEMENT = 0.01;

export interface TakerQuoteCap {
  issuanceAsk: number;
  maximumPrice: number;
  movementLimit: number;
}

/**
 * Caps one-cent quote tolerance at the buy policy's own price ceiling. The caller sizes at
 * `maximumPrice`, then the signed path submits only at the refreshed ask actually observed.
 */
export function takerQuoteCap(issuanceAsk: number): TakerQuoteCap | null {
  if (!Number.isFinite(issuanceAsk) || !(issuanceAsk > 0) || issuanceAsk > MAX_ENTRY_PRICE + 1e-12) return null;
  const maximumPrice = Math.min(MAX_ENTRY_PRICE, issuanceAsk + MAX_TAKER_QUOTE_MOVEMENT);
  return { issuanceAsk, maximumPrice, movementLimit: maximumPrice - issuanceAsk };
}

export function refreshedAskFitsTakerCap(freshAsk: number, cap: TakerQuoteCap): boolean {
  return Number.isFinite(freshAsk) && freshAsk > 0 && !(cap.maximumPrice + 1e-9 < freshAsk);
}
