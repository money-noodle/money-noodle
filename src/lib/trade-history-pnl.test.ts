import { describe, expect, it } from 'vitest';
import type { PaperOrderStatus } from './types';
import { tradeHistoryPnlDisplay } from './trade-history-pnl';

const display = (status: PaperOrderStatus, pnl: { actualPnlCents?: number; pnlCents?: number } = {}) =>
  tradeHistoryPnlDisplay({ status, ...pnl });

describe('trade history P&L labels', () => {
  it.each(['pending_reservation', 'uncertain', 'open'] as const)(
    'keeps pending for an active %s order',
    (status) => expect(display(status)).toEqual({ pnl: undefined, label: 'pending' }),
  );

  it.each(['unfilled', 'rejected'] as const)(
    'labels a terminal %s order as no fill',
    (status) => expect(display(status)).toEqual({ pnl: undefined, label: 'no fill' }),
  );

  it.each(['sold', 'won', 'lost'] as const)(
    'exposes missing P&L on a terminal %s order as unavailable',
    (status) => expect(display(status)).toEqual({ pnl: undefined, label: 'P&L unavailable' }),
  );

  it('labels an invalid order without implying it remains active', () => {
    expect(display('invalid')).toEqual({ pnl: undefined, label: 'no P&L' });
  });

  it('formats realized values for every status and prefers the exact reporting view', () => {
    for (const status of ['pending_reservation', 'uncertain', 'open', 'sold', 'won', 'lost', 'invalid', 'unfilled', 'rejected'] as const) {
      expect(display(status, { actualPnlCents: 1.25, pnlCents: 1 })).toEqual({ pnl: 1.25, label: '+1.25¢ P&L' });
      expect(display(status, { pnlCents: -2 })).toEqual({ pnl: -2, label: '-2.00¢ P&L' });
      expect(display(status, { pnlCents: 0 })).toEqual({ pnl: 0, label: '+0.00¢ P&L' });
    }
  });
});
