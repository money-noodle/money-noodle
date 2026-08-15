'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Layers3, Loader2, Lock, Save } from 'lucide-react';
import { Badge, inlineTrigger } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface StrategyRow {
  strategyId: string; name: string; signalSource: string;
  percent: number; startingCents: number; fundedAt: string | null;
}
interface MarketRow { marketId: string; name: string; percent: number; capCents: number; strategies: StrategyRow[] }
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
  const [shares, setShares] = useState<Record<string, string>>(
    Object.fromEntries(market.strategies.map((strategy) => [strategy.strategyId, String(strategy.percent)])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const capCents = Math.floor(equityCents * (Number(marketPercent) || 0) / 100);
  const strategyTotal = Object.values(shares).reduce((sum, value) => sum + (Number(value) || 0), 0);
  // The remainder is shown rather than auto-filled: lending one strategy another's headroom is what makes
  // a split budget stop meaning anything.
  const uncommittedPercent = Math.max(0, 100 - strategyTotal);
  const overAllocated = strategyTotal > 100 || (Number(marketPercent) || 0) > 100;
  const changed = Number(marketPercent) !== market.percent
    || market.strategies.some((strategy) => Number(shares[strategy.strategyId]) !== strategy.percent);

  async function save() {
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/trading/allocations', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: provider.providerId, marketId: market.marketId,
          marketPercent: Number(marketPercent),
          strategies: market.strategies.map((strategy) => ({
            strategyId: strategy.strategyId, percent: Number(shares[strategy.strategyId]) || 0,
          })),
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

    <div className="mt-3 space-y-2 border-t pt-3">
      {market.strategies.map((strategy) => {
        const percent = Number(shares[strategy.strategyId]) || 0;
        return <div key={strategy.strategyId} className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px]">{strategy.name}</p>
            <p className="font-mono text-[8px] text-muted-foreground">
              {strategy.signalSource === 'venue-price' ? 'venue price + clock' : 'model probability'}
              {strategy.fundedAt ? ` · funded ${new Date(strategy.fundedAt).toLocaleString()}` : ' · never funded'}
            </p>
          </div>
          <PercentInput value={shares[strategy.strategyId] ?? '0'}
            onChange={(next) => setShares({ ...shares, [strategy.strategyId]: next })}
            disabled={blocked} resultCents={Math.floor(capCents * percent / 100)}/>
        </div>;
      })}
      <div className="flex items-center justify-between pt-1 text-[9px] text-muted-foreground">
        <span>Uncommitted</span>
        <span className="font-mono">{uncommittedPercent.toFixed(1)}% · {dollars(Math.floor(capCents * uncommittedPercent / 100))}</span>
      </div>
    </div>

    {overAllocated && <p className="mt-2 flex items-center gap-1 text-[10px] text-red-400">
      <AlertTriangle className="size-3"/>Shares must sum to at most 100%.
    </p>}
    {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}

    {changed && !blocked && !overAllocated && <p className="mt-2 flex items-start gap-1 text-[10px] leading-relaxed text-amber-300">
      <AlertTriangle className="mt-0.5 size-3 shrink-0"/>
      <span>Saving re-funds every strategy in this market: each one&apos;s equity restarts at the amount above,
        and any drawdown halt clears. Results from the previous funding period are kept and reported separately.</span>
    </p>}

    <Button className="mt-3 w-full" size="sm" disabled={blocked || saving || overAllocated || !changed} onClick={() => void save()}>
      {saving ? <Loader2 className="animate-spin"/> : <Save/>}Re-fund {market.name}
    </Button>
  </div>;
}

/**
 * Budget allocation across provider, market, and strategy.
 *
 * Renders from the registries rather than today's single provider and market, so a second market or a
 * third strategy appears here without a UI change.
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
    <DialogTrigger className={variant === 'badge' ? inlineTrigger : undefined} asChild={variant === 'button'}>
      {variant === 'badge'
        ? <span className="inline-flex items-center gap-1"><Layers3 className="size-3"/>Allocation</span>
        : <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] hover:bg-muted/40"><Layers3 className="size-3"/>Allocation</button>}
    </DialogTrigger>
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm"><Layers3 className="size-4"/>Budget allocation</DialogTitle>
        <DialogDescription className="text-[11px]">
          Cash sits with a provider, a percentage of it is committed to each market, and a percentage of
          that market funds each strategy. Any remainder stays uncommitted rather than being shared out.
        </DialogDescription>
      </DialogHeader>

      {loading && <p className="flex items-center gap-2 py-6 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin"/>Loading…</p>}
      {error && <p className="py-4 text-[11px] text-red-400">{error}</p>}

      {data && !loading && <div className="space-y-4">
        {/* Named blockers rather than a greyed-out button: each one needs a different action. */}
        {blocked && <div className="rounded-lg border border-amber-300/30 bg-amber-300/[.04] p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300"><Lock className="size-3"/>Allocation is read-only right now</p>
          <ul className="mt-1.5 space-y-1">
            {data.blockers.map((reason) => <li key={reason} className="text-[10px] leading-relaxed text-amber-300/90">· {reason}</li>)}
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
                <Badge variant="outline" className={cn('text-[9px]', provider.liveCapable ? 'border-primary/25 text-primary' : 'opacity-50')}>live</Badge>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {provider.markets.map((market) => <MarketPanel key={market.marketId} provider={provider} market={market}
                equityCents={data.providerEquityCents} blocked={blocked || !provider.paperCapable} onSaved={() => void load()}/>)}
            </div>
          </div>;
        })}

        <p className="text-[9px] leading-relaxed text-muted-foreground">
          Percentages compound with equity, so a share grows with its wins and contracts in its own drawdown
          without being edited. Revision {data.revision}.
        </p>
      </div>}
    </DialogContent>
  </Dialog>;
}
