import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertUniqueLiveEntryClientOrderId, expectedVenueClientOrderIds, isV2LiveEntryClientOrderId,
  kalshiMakerCreateClientOrderId, LIVE_ENTRY_CLIENT_ORDER_ID_MAX_LENGTH, liveEntryClientOrderId,
} from './live-order-identity';

const first = 'live:HYPE:UP:2026-08-20T14:30:00Z';
const second = `${first}:episode:2`;
const third = `${first}:episode:3`;

describe('collision-resistant live entry identity', () => {
  it('is deterministic, bounded, and distinct across complete episode IDs', () => {
    const ids = [first, second, third].map(liveEntryClientOrderId);
    expect(new Set(ids).size).toBe(3);
    expect(liveEntryClientOrderId(second)).toBe(ids[1]);
    for (const id of ids) {
      expect(isV2LiveEntryClientOrderId(id)).toBe(true);
      expect(id).toMatch(/^live:v2:[0-9a-f]{32}$/);
      expect(id.length).toBe(40);
    }
  });

  it('retains the complete base across all three create attempts', () => {
    const base = liveEntryClientOrderId(third);
    expect(kalshiMakerCreateClientOrderId(base, 0)).toBe(base);
    expect(kalshiMakerCreateClientOrderId(base, 1)).toBe(`${base}-1`);
    expect(kalshiMakerCreateClientOrderId(base, 2)).toBe(`${base}-2`);
    expect(kalshiMakerCreateClientOrderId(base, 2).length).toBe(LIVE_ENTRY_CLIENT_ORDER_ID_MAX_LENGTH);
  });

  it('refuses legacy truncation and out-of-range attempts', () => {
    expect(() => kalshiMakerCreateClientOrderId(third, 1)).toThrow('requires a collision-resistant');
    expect(() => kalshiMakerCreateClientOrderId(liveEntryClientOrderId(third), 3)).toThrow('0 through 2');
  });

  it('fails closed on accidental reuse before submission', () => {
    const clientOrderId = liveEntryClientOrderId(first);
    expect(() => assertUniqueLiveEntryClientOrderId([
      { id: first, executionMode: 'live', clientOrderId },
    ], { id: second, clientOrderId })).toThrow(`collides with ${first}`);
    expect(() => assertUniqueLiveEntryClientOrderId([
      { id: first, executionMode: 'paper', clientOrderId },
    ], { id: second, clientOrderId })).not.toThrow();
  });

  it('stamps and checks the final episode identity before reservation or submission', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib', 'paper-execution.ts'), 'utf8');
    const stampAt = source.indexOf('built.order.clientOrderId = liveEntryClientOrderId(built.order.id)');
    const uniqueAt = source.indexOf('assertUniqueLiveEntryClientOrderId(ledger.orders, built.order)');
    const executeAt = source.indexOf('await executePreparedLiveBuy(built.order');
    expect(stampAt).toBeGreaterThan(0);
    expect(uniqueAt).toBeGreaterThan(stampAt);
    expect(executeAt).toBeGreaterThan(uniqueAt);
    expect(source).not.toContain('built.order.clientOrderId = built.order.id');
  });

  it('derives exact lost-response candidates only for v2 IDs', () => {
    const base = liveEntryClientOrderId(third);
    expect(expectedVenueClientOrderIds(base)).toEqual([base, `${base}-1`, `${base}-2`]);
    expect(expectedVenueClientOrderIds(third)).toEqual([third]);
  });
});
