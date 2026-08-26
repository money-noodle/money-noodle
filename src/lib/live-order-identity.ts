import { createHash } from 'node:crypto';
import type { PaperOrder } from './types';

export const LIVE_ENTRY_CLIENT_ORDER_ID_VERSION = 'live-entry-client-order-id-v2' as const;
export const LIVE_ENTRY_CLIENT_ORDER_ID_PREFIX = 'live:v2:';
export const LIVE_ENTRY_CLIENT_ORDER_ID_BASE_LENGTH = 40;
export const LIVE_ENTRY_CLIENT_ORDER_ID_MAX_LENGTH = 42;
const HASH_HEX_LENGTH = 32;
const V2_PATTERN = /^live:v2:[0-9a-f]{32}$/;

/** Deterministic only after the human-readable episode id is final. */
export function liveEntryClientOrderId(orderId: string): string {
  if (!orderId.startsWith('live:')) throw new Error('A live entry client order ID requires a live local order ID.');
  const digest = createHash('sha256').update(orderId, 'utf8').digest('hex').slice(0, HASH_HEX_LENGTH);
  const result = `${LIVE_ENTRY_CLIENT_ORDER_ID_PREFIX}${digest}`;
  if (result.length !== LIVE_ENTRY_CLIENT_ORDER_ID_BASE_LENGTH) throw new Error('Live entry client order ID length invariant failed.');
  return result;
}

export function isV2LiveEntryClientOrderId(value: string): boolean {
  return V2_PATTERN.test(value);
}

/** Every post-only create retry keeps the complete episode identity; truncation is forbidden. */
export function kalshiMakerCreateClientOrderId(baseId: string, createAttempt: number): string {
  if (!Number.isSafeInteger(createAttempt) || createAttempt < 0 || createAttempt > 2) {
    throw new Error('Managed maker create attempt must be an integer from 0 through 2.');
  }
  if (!isV2LiveEntryClientOrderId(baseId)) {
    throw new Error('Managed maker creation requires a collision-resistant v2 live client order ID.');
  }
  const result = createAttempt === 0 ? baseId : `${baseId}-${createAttempt}`;
  if (result.length > LIVE_ENTRY_CLIENT_ORDER_ID_MAX_LENGTH) throw new Error('Managed maker client order ID exceeds its bounded length.');
  return result;
}

/** A hash collision or accidental ID reuse stops before reservation or venue submission. */
export function assertUniqueLiveEntryClientOrderId(
  orders: Array<Pick<PaperOrder, 'id' | 'executionMode' | 'clientOrderId'>>,
  candidate: Pick<PaperOrder, 'id' | 'clientOrderId'>,
): void {
  const clientOrderId = candidate.clientOrderId;
  if (!clientOrderId || !isV2LiveEntryClientOrderId(clientOrderId)) {
    throw new Error(`${candidate.id}: missing collision-resistant v2 live client order ID.`);
  }
  const collision = orders.find((order) => order.executionMode === 'live'
    && order.id !== candidate.id && order.clientOrderId === clientOrderId);
  if (collision) throw new Error(`${candidate.id}: live client order ID collides with ${collision.id}.`);
}

/** Exact candidates used only for lost-response recovery. */
export function expectedVenueClientOrderIds(clientOrderId: string): readonly string[] {
  return isV2LiveEntryClientOrderId(clientOrderId)
    ? [clientOrderId, `${clientOrderId}-1`, `${clientOrderId}-2`]
    : [clientOrderId];
}
