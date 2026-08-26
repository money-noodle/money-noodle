'use client';

import { useState } from 'react';
import { Loader2, LockKeyhole, RefreshCw, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { AccountsData } from '@/lib/types';
import { cn } from '@/lib/utils';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function AccountDialog() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/accounts', { cache: 'no-store' });
      const body = await response.json() as AccountsData & { error?: string };
      // An error body is not an account. Assigning one left `venues` undefined and the render threw on
      // it, which is how a stateless host's 503 turned this dialog into a crash instead of a sentence.
      if (!response.ok) throw new Error(body.error || 'Unable to load accounts');
      setData(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load accounts'); }
    finally { setLoading(false); }
  }

  return <Dialog onOpenChange={(open) => { if (open && !data) void load(); }}>
    <DialogTrigger asChild><Button variant="ghost" size="sm"><WalletCards/> Portfolio <Badge variant="outline">read only</Badge></Button></DialogTrigger>
    <DialogContent className="max-w-3xl p-0">
      <DialogHeader className="border-b p-5 pr-12">
        <div className="flex items-center justify-between gap-3"><div><DialogTitle className="flex items-center gap-2"><WalletCards className="size-4 text-primary"/> Accounts</DialogTitle><DialogDescription className="mt-1">Read-only balances and positions across connected venues.</DialogDescription></div><Button variant="outline" size="icon" onClick={load} disabled={loading}>{loading ? <Loader2 className="animate-spin"/> : <RefreshCw/>}</Button></div>
      </DialogHeader>
      <div className="p-5">
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-primary/10 bg-primary/5 p-3 text-[10px] text-muted-foreground"><LockKeyhole className="size-3.5 text-primary"/>Trading is disabled. This view never sends an order and private credentials remain server-side.</div>
        {error && <div className="mb-4 rounded-lg border border-loss/20 bg-loss/5 p-3 text-xs text-loss">{error}</div>}
        {/* `venues` is optional-chained as well as the body: a 200 whose shape is not an AccountsData is
            still a parsed remote value, and a render is not the place to discover that. */}
        {loading && !data ? <div className="grid h-44 place-items-center"><Loader2 className="animate-spin text-muted-foreground"/></div> : <div className="space-y-3">{data?.venues?.map((venue) => <div key={venue.venue} className="overflow-hidden rounded-lg border">
          <div className="flex items-center justify-between border-b bg-background/50 p-3.5"><div><p className="text-sm font-semibold capitalize">{venue.venue}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{venue.configured ? venue.connected ? venue.tradeAuthenticated ? 'Authenticated account connected' : 'Public read-only account connected' : venue.error || 'Connection failed' : venue.venue === 'polymarket' ? 'Add wallet address or CLOB signer variables from .env.example' : 'Add signed Kalshi credentials from .env.example'}</p></div><div className="text-right">{venue.balance !== undefined && <p className="font-mono text-sm">{usd.format(venue.balance)}</p>}<Badge variant="outline" className={cn('mt-1', venue.connected ? 'border-data/20 text-data' : 'text-muted-foreground')}>{venue.tradeAuthenticated ? 'authenticated' : venue.connected ? 'read only' : 'not connected'}</Badge></div></div>
          {venue.positions.length ? <div className="divide-y">{venue.positions.slice(0, 25).map((position) => <div key={position.id} className="grid grid-cols-[1fr_auto] gap-3 p-3.5"><div className="min-w-0"><p className="truncate text-xs font-medium">{position.title}</p><p className="mt-1 font-mono text-[9px] text-muted-foreground">{position.side} · {position.size.toFixed(2)} contracts</p></div><div className="text-right"><p className="font-mono text-xs">{usd.format(position.currentValue)}</p><p className={cn('mt-1 font-mono text-[9px]', position.pnl >= 0 ? 'text-gain' : 'text-loss')}>{position.pnl >= 0 ? '+' : ''}{usd.format(position.pnl)} P&amp;L</p></div></div>)}</div> : <p className="p-4 text-center text-[11px] text-muted-foreground">{venue.connected ? 'No open positions.' : 'Connect this venue to monitor positions.'}</p>}
          {venue.openOrders > 0 && <div className="border-t px-3.5 py-2 text-[10px] text-muted-foreground">{venue.openOrders} resting order{venue.openOrders === 1 ? '' : 's'}</div>}
        </div>)}</div>}
      </div>
    </DialogContent>
  </Dialog>;
}
