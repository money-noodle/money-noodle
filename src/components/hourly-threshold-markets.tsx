'use client';

import { useEffect, useMemo, useState } from 'react';
import { Clock3, ExternalLink, FlaskConical, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { HourlyThresholdMarketsResponse } from '@/lib/types';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 5 });
const POLL_MS = 60_000;

const cents = (value: number | undefined) => value === undefined ? '—' : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}¢`;
const probability = (value: number | undefined) => value === undefined ? '—'
  : value < 0.001 ? '<0.1%'
    : value > 0.999 ? '>99.9%'
      : `${(value * 100).toFixed(1)}%`;

export function HourlyThresholdMarkets({ query = '' }: { query?: string }) {
  const [data, setData] = useState<HourlyThresholdMarketsResponse>();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function load() {
      try {
        const response = await fetch('/api/markets/hourly');
        const body = await response.json() as HourlyThresholdMarketsResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Hourly market data unavailable.');
        if (!cancelled) { setData(body); setError(''); }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Hourly market data unavailable.');
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void load(), POLL_MS);
      }
    }
    void load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, []);

  const markets = useMemo(() => data?.markets.filter((market) =>
    `${market.symbol} ${market.name}`.toLowerCase().includes(query.toLowerCase())) ?? [], [data, query]);

  return <section className="mt-10">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">Kalshi one-hour thresholds</h2>
          <Badge variant="outline" className="border-data/25 text-data">market data only</Badge>
          <Badge variant="outline" className="text-muted-foreground">paper off · live off</Badge>
          {data && <Badge variant="secondary" className="font-mono">{markets.filter((market) => market.marketDataAvailable).length}/{markets.length}</Badge>}
        </div>
        <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-muted-foreground">ABOVE and BELOW are separate YES contracts with distinct strikes—not complementary sides. Model minus ask is a research difference, not a qualified edge or trade signal.</p>
      </div>
      <div className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
        {data ? <><Clock3 className="size-3"/>Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</> : <><RefreshCw className="size-3 animate-spin"/>Loading public contracts</>}
      </div>
    </div>

    {error && !data && <Card className="border-warn/25 bg-warn/[.04] p-5 text-sm text-muted-foreground">{error}</Card>}
    {!data && !error && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 6 }).map((_, index) => <Card key={index} className="h-56 animate-pulse bg-card/50"/>)}</div>}
    {data && markets.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {markets.map((market) => <Card key={market.symbol} className="overflow-hidden bg-card/60">
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div><div className="flex items-baseline gap-2"><h3 className="text-sm font-semibold">{market.symbol}</h3><span className="text-[10px] text-muted-foreground">{market.name}</span></div>{market.currentPrice !== undefined && <p className="mt-1 font-mono text-[10px] text-muted-foreground">Kraken {money.format(market.currentPrice)}</p>}</div>
          <Badge variant="outline" className={market.marketDataAvailable ? 'border-data/25 text-data' : 'border-warn/25 text-warn'}>{market.marketDataAvailable ? 'exact 1h' : 'unavailable'}</Badge>
        </div>
        {market.candidates.length > 0 ? <div className="divide-y">
          {market.candidates.map((candidate) => <div key={candidate.ticker} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-[9px] font-medium uppercase tracking-[.14em] text-muted-foreground">{candidate.direction} · YES</p><p className="mt-1 font-mono text-sm font-semibold">{candidate.relation === 'greater-than' ? '>' : '<'} {money.format(candidate.strike)}</p></div>
              <a href={candidate.marketUrl} target="_blank" rel="noreferrer" aria-label={`Open ${candidate.ticker} on Kalshi`} className="text-muted-foreground transition hover:text-foreground"><ExternalLink className="size-3.5"/></a>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded border bg-background/30 p-2"><p className="text-[7px] uppercase text-muted-foreground">Model YES</p><p className="mt-1 font-mono text-[11px]">{probability(candidate.modelProbabilityYes)}</p></div>
              <div className="rounded border bg-background/30 p-2"><p className="text-[7px] uppercase text-muted-foreground">YES ask</p><p className="mt-1 font-mono text-[11px]">{cents(candidate.yesAsk)}</p></div>
              <div className="rounded border border-data/15 bg-data/[.03] p-2"><p className="text-[7px] uppercase text-muted-foreground">Difference</p><p className="mt-1 font-mono text-[11px] text-data">{candidate.modelMinusAsk === undefined ? '—' : `${candidate.modelMinusAsk >= 0 ? '+' : ''}${(candidate.modelMinusAsk * 100).toFixed(1)}pp`}</p></div>
            </div>
            <p className="mt-2 truncate font-mono text-[7px] text-muted-foreground" title={candidate.ticker}>{candidate.ticker}</p>
            {candidate.modelUnavailableReason && <p className="mt-1 text-[8px] text-warn">{candidate.modelUnavailableReason}</p>}
          </div>)}
        </div> : <div className="grid min-h-40 place-items-center p-5 text-center"><div><ShieldCheck className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-[10px] text-muted-foreground">{market.unavailableReason ?? 'No active exact one-hour threshold pair.'}</p></div></div>}
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5 text-[8px] text-muted-foreground"><span>{market.closesAt ? `Closes ${new Date(market.closesAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}` : 'No active close'}</span><span className="flex items-center gap-1"><FlaskConical className="size-3"/>research only</span></div>
      </Card>)}
    </div>}
    {data && markets.length === 0 && <Card className="grid min-h-40 place-items-center p-6 text-sm text-muted-foreground">No matching hourly markets.</Card>}
  </section>;
}
