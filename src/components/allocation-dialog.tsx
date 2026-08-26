'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Layers3, Loader2, Lock, Save } from 'lucide-react';
import { Badge, inlineTrigger } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface MarketRow { marketId: string; name: string; percent: number; capCents: number }
interface ProviderRow {
  providerId: string; liveCapable: boolean; paperCapable: boolean; liveLimitCents: number; markets: MarketRow[];
}
interface AllocationResponse {
  blockers: string[]; providerEquityCents: number; providers: ProviderRow[]; revision: number; error?: string;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Percentages are what you type; the resulting cash is shown beside them, because nobody reasons in
 * percentages of current equity. */
function PercentInput({ value, onChange, disabled, resultCents }: {
  value: string; onChange: (next: string) => void; disabled: boolean; resultCents: number;
}) {
  return <div className="flex items-center gap-2">
    <div className={cn('flex h-8 w-20 items-center rounded-md border bg-background px-2', disabled && 'opacity-50')}>
      <input type="number" min="0" max="100" step="0.5" value={value} disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none"/>
      <span className="text-[10px] text-muted-foreground">%</span>
    </div>
    <span className="font-mono text-[11px] text-muted-foreground">{dollars(resultCents)}</span>
  </div>;
}

function MarketPanel({ provider, market, equityCents, blocked, onSaved }: {
  provider: ProviderRow; market: MarketRow; equityCents: number; blocked: boolean;
  onSaved: () => void;
}) {
  const [marketPercent, setMarketPercent] = useState(String(market.percent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const capCents = Math.floor(equityCents * (Number(marketPercent) || 0) / 100);
  const overAllocated = (Number(marketPercent) || 0) > 100;
  const changed = Number(marketPercent) !== market.percent;

  async function save() {
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/trading/allocations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: provider.providerId, marketId: market.marketId,
          marketPercent: Number(marketPercent),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Allocation update failed');
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Allocation update failed'); }
    finally { setSaving(false); }
  }

  return <div className="rounded-lg border bg-background/40 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-[11px] font-semibold">{market.name}</p>
        <p className="font-mono text-[9px] text-muted-foreground">{market.marketId}</p>
      </div>
      <PercentInput value={marketPercent} onChange={setMarketPercent} disabled={blocked} resultCents={capCents}/>
    </div>

    {overAllocated && <p className="mt-2 flex items-center gap-1 text-[10px] text-loss">
      <AlertTriangle className="size-3"/>Market allocation must be at most 100%.
    </p>}
    {error && <p className="mt-2 text-[10px] text-loss">{error}</p>}

    <Button className="mt-3 w-full" size="sm" disabled={blocked || saving || overAllocated || !changed} onClick={() => void save()}>
      {saving ? <Loader2 className="animate-spin"/> : <Save/>}Save {market.name} allocation
    </Button>
  </div>;
}

/**
 * Budget allocation across providers and markets.
 *
 * Strategy-level splitting was retired with the long-shot strategy. Renders from the provider and market
 * registries so a new venue or market remains data rather than hardcoded UI.
 */
export function AllocationDialog({ variant = 'badge' }: { variant?: 'button' | 'badge' }) {
  const [data, setData] = useState<AllocationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/trading/allocations', { cache: 'no-store' });
      const body = await response.json() as AllocationResponse;
      if (!response.ok) throw new Error(body.error || 'Unable to load allocations');
      setData(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load allocations'); }
    finally { setLoading(false); }
  }

  const blocked = useMemo(() => (data?.blockers.length ?? 0) > 0, [data]);

  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild>
      {variant === 'badge'
        ? <button type="button" title="Budget allocation across providers and markets" className={cn(inlineTrigger, 'text-[9px]')}>
            <Layers3 className="size-2.5 shrink-0"/>Allocation<ChevronDown className="size-2.5 shrink-0"/>
          </button>
        : <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] hover:bg-muted/40"><Layers3 className="size-3"/>Allocation</button>}
    </DialogTrigger>
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm"><Layers3 className="size-4"/>Budget allocation</DialogTitle>
        <DialogDescription className="text-[11px]">
          Cash sits with a provider, and a percentage of it is committed to each market. Any provider
          remainder stays uncommitted.
        </DialogDescription>
      </DialogHeader>

      {loading && <p className="flex items-center gap-2 py-6 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin"/>Loading…</p>}
      {error && <p className="py-4 text-[11px] text-loss">{error}</p>}

      {data && !loading && <div className="space-y-4">
        {/* Named blockers rather than a greyed-out button: each one needs a different action. */}
        {blocked && <div className="rounded-lg border border-warn/30 bg-warn/[.04] p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warn"><Lock className="size-3"/>Allocation is read-only right now</p>
          <ul className="mt-1.5 space-y-1">
            {data.blockers.map((reason) => <li key={reason} className="text-[10px] leading-relaxed text-warn/90">· {reason}</li>)}
          </ul>
        </div>}

        {data.providers.map((provider) => {
          const funded = provider.markets.some((market) => market.percent > 0);
          // A provider with no capability is shown rather than hidden, so the fail-closed state is visible.
          if (!provider.liveCapable && !provider.paperCapable && !funded) {
            return <div key={provider.providerId} className="flex items-center justify-between rounded-xl border border-dashed p-3 opacity-60">
              <p className="font-mono text-[10px]">{provider.providerId}</p>
              <Badge variant="outline" className="text-[9px] text-muted-foreground">no trading capability</Badge>
            </div>;
          }
          return <div key={provider.providerId} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] font-semibold">{provider.providerId}</p>
                <p className="text-[9px] text-muted-foreground">
                  holds the cash · {dollars(data.providerEquityCents)} configured
                  {provider.liveLimitCents > 0 ? ` · ceiling ${dollars(provider.liveLimitCents)}` : ' · no provider ceiling'}
                </p>
              </div>
              <div className="flex gap-1">
                <Badge variant="outline" className={cn('text-[9px]', provider.paperCapable ? 'text-muted-foreground' : 'opacity-50')}>paper</Badge>
                <Badge variant="outline" className={cn('text-[9px]', provider.liveCapable ? 'border-live/25 text-live' : 'opacity-50')}>live</Badge>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {provider.markets.map((market) => <MarketPanel key={market.marketId} provider={provider} market={market}
                equityCents={data.providerEquityCents} blocked={blocked || !provider.paperCapable} onSaved={() => void load()}/>)}
            </div>
          </div>;
        })}

        <p className="text-[9px] leading-relaxed text-muted-foreground">
          Market percentages are hard ceilings; any unallocated provider share remains uncommitted. Revision {data.revision}.
        </p>
      </div>}
    </DialogContent>
  </Dialog>;
}
