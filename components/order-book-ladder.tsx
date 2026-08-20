'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Layers3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DATA_FRESHNESS } from '@/lib/freshness';
import { cn } from '@/lib/utils';
import type { OrderBookLadderLevel, SelectedOrderBookLadder } from '@/lib/order-book-depth';
import type { PositionSide } from '@/lib/types';

interface OrderBookResponse extends SelectedOrderBookLadder { ticker: string }

const shownLevels = 6;

function contracts(value: number): string {
  return value >= 10_000 ? `${(value / 1_000).toFixed(1)}k` : value >= 1_000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toFixed(2);
}

function LadderRow({ level, kind }: { level: OrderBookLadderLevel; kind: 'ask' | 'bid' }) {
  return <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 px-2 py-1 font-mono text-[8px] odd:bg-background/30">
    <span className={kind === 'bid' ? 'text-gain' : 'text-loss'}>{(level.price * 100).toFixed(1)}¢</span>
    <span className="text-right text-foreground">{contracts(level.quantity)}</span>
    <span className="text-right text-muted-foreground">{contracts(level.cumulativeQuantity)}</span>
  </div>;
}

function LadderHalf({ levels, kind }: { levels: OrderBookLadderLevel[]; kind: 'ask' | 'bid' }) {
  const displayed = levels.slice(0, shownLevels);
  const ordered = kind === 'ask' ? [...displayed].reverse() : displayed;
  return <div className="min-h-[120px]">
    <p className={cn('border-b px-2 py-1 font-mono text-[7px] uppercase tracking-wider', kind === 'bid' ? 'text-gain' : 'text-loss')}>{kind}s</p>
    {ordered.length
      ? ordered.map((level) => <LadderRow key={`${kind}:${level.price}`} level={level} kind={kind}/>)
      : <div className="grid min-h-[96px] place-items-center px-2 text-[8px] text-muted-foreground">No displayed {kind}s</div>}
  </div>;
}

export function OrderBookLadder({
  ticker, side, expanded, active = true, onToggle,
}: {
  ticker: string;
  side: PositionSide;
  expanded: boolean;
  active?: boolean;
  onToggle: () => void;
}) {
  const [book, setBook] = useState<OrderBookResponse>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded || !active) return;
    let stopped = false;
    let running = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    setBook(undefined);
    setError('');
    setLoading(true);

    const schedule = () => {
      if (!stopped) timer = window.setTimeout(() => void load(), DATA_FRESHNESS.orderBookMonitorPollMs);
    };
    async function load() {
      if (stopped || running) return;
      if (document.visibilityState === 'hidden') { schedule(); return; }
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/order-book?ticker=${encodeURIComponent(ticker)}&side=${side}`, {
          cache: 'no-store', signal: controller.signal,
        });
        const body = await response.json() as OrderBookResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || 'Order book unavailable.');
        if (!stopped) { setBook(body); setError(''); }
      } catch (reason) {
        if (!stopped && !(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : 'Order book unavailable.');
        }
      } finally {
        running = false;
        if (!stopped) { setLoading(false); schedule(); }
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || stopped || running) return;
      if (timer !== undefined) window.clearTimeout(timer);
      void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void load();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, expanded, side, ticker]);

  const observedMs = book ? Date.parse(book.observedAt) : Number.NaN;
  const ageSeconds = Number.isFinite(observedMs) ? Math.max(0, Math.floor((Date.now() - observedMs) / 1_000)) : null;
  const stale = ageSeconds === null || ageSeconds > DATA_FRESHNESS.orderBookMonitorPollMs * 3 / 1_000;
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;

  return <div className="mt-3 border-t pt-2">
    <Button type="button" variant="ghost" size="sm" className="h-7 w-full justify-between px-1 text-[9px] text-muted-foreground" onClick={onToggle} aria-expanded={expanded}>
      <span className="flex items-center gap-1.5"><Layers3 className="size-3"/>Kalshi {side} order book</span>
      <ChevronDown className={cn('size-3 transition-transform duration-300', expanded && 'rotate-180')}/>
    </Button>
    {expanded && <div className="mt-2 min-h-[310px] overflow-hidden rounded-md border bg-background/20">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b px-2 py-1.5">
        <div><p className="font-mono text-[8px]">{bestBid === undefined ? '—' : `${(bestBid * 100).toFixed(1)}¢`} bid · {bestAsk === undefined ? '—' : `${(bestAsk * 100).toFixed(1)}¢`} ask</p><p className="font-mono text-[7px] text-muted-foreground">spread {spread === undefined ? '—' : `${(spread * 100).toFixed(1)}¢`} · raw displayed depth</p></div>
        <Badge variant="outline" className={cn('font-mono text-[7px]', stale || error ? 'border-warn/25 text-warn' : 'border-data/25 text-data')}>{loading && !book ? 'loading' : error ? 'read error' : stale ? 'stale' : `${ageSeconds}s old`}</Badge>
      </div>
      <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 border-b px-2 py-1 font-mono text-[7px] uppercase tracking-wider text-muted-foreground"><span>price</span><span className="text-right">level</span><span className="text-right">cumulative</span></div>
      {book ? <><LadderHalf levels={book.asks} kind="ask"/><div className="border-y px-2 py-1 text-center font-mono text-[7px] text-muted-foreground">spread</div><LadderHalf levels={book.bids} kind="bid"/></> : <div className="grid min-h-[254px] place-items-center px-4 text-center text-[8px] text-muted-foreground">{error || 'Loading displayed Kalshi depth…'}</div>}
      {error && book && <p className="border-t px-2 py-1 text-[7px] text-warn">Latest refresh failed; retaining the last timestamped book.</p>}
    </div>}
  </div>;
}
