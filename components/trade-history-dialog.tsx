'use client';

import { useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { OrderDecisionDetails } from '@/components/order-decision-details';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { PaperOrder } from '@/lib/types';
import { cn } from '@/lib/utils';

interface HistoryResponse { orders: PaperOrder[]; total: number; offset: number; limit: number; hasMore: boolean }

export function TradeHistoryDialog({ triggerLabel = 'Trade history' }: { triggerLabel?: string }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [mode, setMode] = useState('all');
  const [state, setState] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load(options: { append?: boolean; nextMode?: string; nextState?: string } = {}) {
    const selectedMode = options.nextMode ?? mode, selectedState = options.nextState ?? state;
    const offset = options.append ? data?.orders.length ?? 0 : 0;
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ limit: '50', offset: String(offset) });
      if (selectedMode !== 'all') query.set('mode', selectedMode);
      if (selectedState !== 'all') query.set('state', selectedState);
      const response = await fetch(`/api/trading/history?${query}`, { cache: 'no-store' });
      const body = await response.json() as HistoryResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to load decision history');
      setData(options.append && data ? { ...body, orders: [...data.orders, ...body.orders] } : body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load decision history'); }
    finally { setLoading(false); }
  }

  function changeMode(value: string) { setMode(value); void load({ nextMode: value }); }
  function changeState(value: string) { setState(value); void load({ nextState: value }); }

  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild><Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[9px]"><History className="size-3"/>{triggerLabel}</Button></DialogTrigger>
    <DialogContent className="max-w-5xl p-0">
      <DialogHeader className="border-b p-5 pr-12"><DialogTitle className="flex items-center gap-2"><History className="size-4 text-primary"/>Trade decision history</DialogTitle><DialogDescription>Issuance-time probability, edge, basis, factors, persistence, execution choice, and eventual trade result remain attached to the same durable order.</DialogDescription></DialogHeader>
      <div className="flex max-h-[82vh] flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <label className="text-[8px] uppercase text-muted-foreground">Track</label>
          <select value={mode} onChange={(event) => changeMode(event.target.value)} className="h-7 rounded-md border bg-background px-2 text-[9px]"><option value="all">All</option><option value="live">Live</option><option value="paper">Paper</option></select>
          <label className="ml-2 text-[8px] uppercase text-muted-foreground">Result</label>
          <select value={state} onChange={(event) => changeState(event.target.value)} className="h-7 rounded-md border bg-background px-2 text-[9px]"><option value="all">All</option><option value="open">Open</option><option value="settled">Settled</option><option value="unfilled">Unfilled/rejected</option></select>
          <span className="ml-auto font-mono text-[9px] text-muted-foreground">{data ? `${data.orders.length}/${data.total}` : '—'} orders</span>
        </div>
        <div className="overflow-y-auto p-3">
          {error && <div className="mb-3 rounded-md border border-loss/20 bg-loss/5 p-3 text-[10px] text-loss">{error}</div>}
          {loading && !data ? <div className="grid h-52 place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground"/></div> : null}
          {data && !data.orders.length ? <div className="grid h-40 place-items-center rounded-lg border border-dashed text-[10px] text-muted-foreground">No orders match this view.</div> : null}
          <div className="space-y-2">{data?.orders.map((order) => <HistoryOrder key={order.id} order={order}/>)}</div>
          {data?.hasMore && <Button variant="outline" size="sm" className="mt-3 w-full" disabled={loading} onClick={() => void load({ append: true })}>{loading ? <Loader2 className="animate-spin"/> : null}Load older decisions</Button>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

function HistoryOrder({ order }: { order: PaperOrder }) {
  const selectedProbability = order.entryDecision?.selectedSideProbability ?? (order.side === 'UP' ? order.modelProbabilityUp : 1 - order.modelProbabilityUp);
  const feeRate = order.entryDecision?.feeRate ?? ((order.actualFeeCents ?? order.feeCents) / Math.max(1, order.potentialPayoutCents));
  const edge = order.entryDecision?.netEdge ?? selectedProbability - (order.issuanceAskPrice ?? order.askPrice) - feeRate;
  const pnl = order.actualPnlCents ?? order.pnlCents;
  return <div className="rounded-lg border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><div className="flex flex-wrap items-center gap-1.5"><span className="text-[11px] font-semibold">{order.symbol} {order.side}</span><Badge variant="outline" className={order.executionMode === 'live' ? 'border-live/30 text-live' : 'border-primary/25 text-primary'}>{order.executionMode}</Badge><Badge variant="outline">{order.status.replaceAll('_', ' ')}</Badge>{order.liquidityRole && <Badge variant="outline">{order.liquidityRole}</Badge>}</div><p className="mt-1 font-mono text-[8px] text-muted-foreground">{new Date(order.createdAt).toLocaleString()} · closes {new Date(order.closesAt).toLocaleString()} · {order.contractId}</p></div>
      <div className="text-right"><p className="font-mono text-[10px]">P({order.side}) {(selectedProbability * 100).toFixed(1)}% · edge {edge >= 0 ? '+' : ''}{(edge * 100).toFixed(1)}pp</p><p className={cn('font-mono text-[10px]', (pnl ?? 0) > 0 ? 'text-gain' : (pnl ?? 0) < 0 ? 'text-loss' : 'text-muted-foreground')}>{pnl === undefined ? 'pending' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}¢ P&L`}</p></div>
    </div>
    <OrderDecisionDetails order={order}/>
  </div>;
}
