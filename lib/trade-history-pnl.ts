import type { PaperOrder } from './types';

type TradeHistoryPnlOrder = Pick<PaperOrder, 'status' | 'actualPnlCents' | 'pnlCents'>;

export interface TradeHistoryPnlDisplay {
  pnl: number | undefined;
  label: string;
}

/**
 * A missing realized value has different meanings for active and terminal orders. Keep those meanings
 * explicit so a terminal no-fill is never presented as though it were still awaiting settlement.
 */
export function tradeHistoryPnlDisplay(order: TradeHistoryPnlOrder): TradeHistoryPnlDisplay {
  const pnl = order.actualPnlCents ?? order.pnlCents;
  if (pnl !== undefined) {
    return { pnl, label: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}¢ P&L` };
  }

  switch (order.status) {
    case 'pending_reservation':
    case 'uncertain':
    case 'open':
      return { pnl, label: 'pending' };
    case 'unfilled':
    case 'rejected':
      return { pnl, label: 'no fill' };
    case 'invalid':
      return { pnl, label: 'no P&L' };
    case 'sold':
    case 'won':
    case 'lost':
      return { pnl, label: 'P&L unavailable' };
  }
}
