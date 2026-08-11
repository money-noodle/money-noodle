'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, BrainCircuit, CheckCircle2,
  ChevronDown, ChevronRight, CircleDot, Clock3, ExternalLink, History, Info, RefreshCw, Search, ShieldCheck, Sparkles, Target, WalletCards, Zap,
  FlaskConical, ShieldAlert,
} from 'lucide-react';
import { AccountDialog } from '@/components/account-dialog';
import { DataFreshnessDialog } from '@/components/data-freshness-dialog';
import { MarketChart } from '@/components/market-chart';
import { PerformanceDialog } from '@/components/performance-dialog';
import { ResearchDialog } from '@/components/research-dialog';
import { TradingControlDialog } from '@/components/trading-control-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AutomationStatus } from '@/components/automation-status';
import { DATA_FRESHNESS, isFreshCalculationTimestamp } from '@/lib/freshness';
import { cn } from '@/lib/utils';
import { bestEntry, edgeStrength, hasTradableEdge, MAX_ENTRY_PRICE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY, MIN_NET_EDGE, qualifiesAsBuyEdge, sideProbability, venueEntryOptions } from '@/lib/prediction-policy';
import type { DashboardData, Direction, ExecutionSignalReadiness, Factor, Prediction, TradeTrackRecord } from '@/lib/types';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function formatPrice(value: number) {
  if (value < 0.1) return `$${value.toFixed(5)}`;
  if (value < 10) return `$${value.toFixed(3)}`;
  return money.format(value);
}

function directionColor(direction: Direction) {
  return direction === 'bullish' ? 'text-primary' : direction === 'bearish' ? 'text-red-400' : 'text-muted-foreground';
}

function Countdown({ closesAt }: { closesAt: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (now === null) return <span className="font-mono tabular-nums text-muted-foreground">--:--</span>;
  const remaining = Math.max(0, new Date(closesAt).getTime() - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return <span className="font-mono tabular-nums">{remaining ? `${minutes}:${seconds.toString().padStart(2, '0')}` : 'closing'}</span>;
}

function SignalBadge({ prediction }: { prediction: Prediction }) {
  const isTrade = prediction.signal === 'UP' || prediction.signal === 'DOWN';
  return <Badge className={cn(
    'gap-1 border px-2.5 py-1 font-mono text-[10px]',
    prediction.signal === 'UP' && 'border-primary/25 bg-primary/10 text-primary',
    prediction.signal === 'DOWN' && 'border-red-400/25 bg-red-400/10 text-red-400',
    !isTrade && 'border-border bg-secondary text-muted-foreground',
  )}>
    {prediction.signal === 'UP' ? <ArrowUpRight/> : prediction.signal === 'DOWN' ? <ArrowDownRight/> : <CircleDot/>}
    {prediction.signal}
  </Badge>;
}

function FactorRow({ factor }: { factor: Factor }) {
  return <div className="group rounded-lg border bg-background/40 p-3.5 transition-colors hover:border-input">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{factor.label}</span>
          {!factor.available && <Badge variant="outline" className="border-amber-400/20 text-amber-300/80">collecting</Badge>}
        </div>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{factor.eyebrow}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn('font-mono text-sm font-semibold', directionColor(factor.direction))}>
          {factor.contribution >= 0 ? '+' : ''}{factor.contribution.toFixed(1)}pp
        </p>
        <p className="text-[10px] text-muted-foreground">{Math.round(factor.weight * 100)}% weight</p>
      </div>
    </div>
    <div className="mt-3 flex items-center gap-3">
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div className="absolute left-1/2 top-0 h-full w-px bg-muted-foreground/30"/>
        <div className={cn('absolute top-0 h-full rounded-full', factor.score >= 0 ? 'left-1/2 bg-primary' : 'right-1/2 bg-red-400')} style={{ width: `${Math.abs(factor.score) * 50}%` }}/>
      </div>
      <span className="w-16 text-right text-[10px] capitalize text-muted-foreground">{factor.direction}</span>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-foreground/90">{factor.summary}</p>
    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{factor.detail}</p>
    <p className="mt-2 text-[10px] text-muted-foreground/70">Source: {factor.source} · confidence {Math.round(factor.confidence * 100)}%</p>
  </div>;
}

function PredictionDetail({ prediction, news }: { prediction: Prediction; news: DashboardData['news'] }) {
  const positive = prediction.modelProbabilityUp >= 0.5;
  return <DialogContent className="p-0 sm:max-w-4xl">
    <DialogHeader className="border-b p-5 pr-12">
      <div className="flex items-center gap-3">
        {prediction.iconUrl ? <img src={prediction.iconUrl} alt="" className="size-9 rounded-full"/> : <div className="size-9 rounded-full bg-secondary"/>}
        <div>
          <DialogTitle className="flex items-center gap-2 text-base">{prediction.name} <span className="font-mono text-xs text-muted-foreground">{prediction.symbol}</span></DialogTitle>
          <DialogDescription>15-minute forecast · <Countdown closesAt={prediction.market.closesAt}/>&nbsp; remaining</DialogDescription>
        </div>
      </div>
    </DialogHeader>
    <div className="grid grid-cols-2 border-b lg:grid-cols-4">
      <div className="p-5 border-r">
        <p className="text-[10px] uppercase tracking-[.16em] text-muted-foreground">Signal Desk</p>
        <p className={cn('mt-1 font-mono text-3xl font-semibold', positive ? 'text-primary' : 'text-red-400')}>{Math.round(prediction.modelProbabilityUp * 100)}% <span className="text-sm">UP</span></p>
      </div>
      <div className="p-5 lg:border-r">
        <p className="text-[10px] uppercase tracking-[.16em] text-muted-foreground">Polymarket</p>
        <p className="mt-1 font-mono text-3xl font-semibold">{Math.round(prediction.market.probabilityUp * 100)}% <span className="text-sm text-muted-foreground">UP</span></p>
      </div>
      <div className="border-r border-t p-5 lg:border-t-0">
        <p className="text-[10px] uppercase tracking-[.16em] text-muted-foreground">Kalshi ≈</p>
        <p className="mt-1 font-mono text-3xl font-semibold">{prediction.kalshi ? Math.round(prediction.kalshi.probabilityUp * 100) : '—'}{prediction.kalshi && '%'} <span className="text-sm text-muted-foreground">UP</span></p>
      </div>
      <div className="border-t p-5 lg:border-t-0">
        <p className="text-[10px] uppercase tracking-[.16em] text-muted-foreground">Edge vs Poly</p>
        <p className={cn('mt-1 font-mono text-3xl font-semibold', prediction.edge >= 0 ? 'text-primary' : 'text-red-400')}>{prediction.edge >= 0 ? '+' : ''}{(prediction.edge * 100).toFixed(1)}<span className="text-sm">pp</span></p>
      </div>
    </div>
    <Tabs defaultValue="factors" className="px-5 pb-5">
      <div className="flex items-center justify-between pt-4">
        <TabsList><TabsTrigger value="factors">Factor stack</TabsTrigger><TabsTrigger value="chart">Price history</TabsTrigger><TabsTrigger value="news">News</TabsTrigger></TabsList>
        <Button asChild variant="ghost" size="sm"><a href={prediction.market.url} target="_blank" rel="noreferrer">Market <ExternalLink/></a></Button>
      </div>
      <TabsContent value="factors"><div className="grid gap-2.5 sm:grid-cols-2">{prediction.factors.map((factor) => <FactorRow key={factor.id} factor={factor}/>)}</div></TabsContent>
      <TabsContent value="chart"><div className="h-80 rounded-lg border bg-background/40 p-3"><MarketChart data={prediction.chart} positive={prediction.priceChange24h >= 0}/></div><p className="mt-2 text-[10px] text-muted-foreground">Seven-day spot reference · CoinGecko · not the contract resolution feed</p></TabsContent>
      <TabsContent value="news"><div className="divide-y rounded-lg border">{news.slice(0, 8).map((item) => <a key={item.link || item.title} href={item.link} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-4 p-3.5 transition hover:bg-secondary/40"><div><p className="text-xs font-medium leading-relaxed">{item.title}</p><p className="mt-1 text-[10px] text-muted-foreground">{item.publishedAt ? new Date(item.publishedAt).toLocaleString() : 'Recent'}</p></div><span className={cn('mt-0.5 size-2 shrink-0 rounded-full', item.sentiment === 'bullish' ? 'bg-primary' : item.sentiment === 'bearish' ? 'bg-red-400' : 'bg-muted-foreground')}/></a>)}</div></TabsContent>
    </Tabs>
  </DialogContent>;
}

function PredictionCard({ prediction, news }: { prediction: Prediction; news: DashboardData['news'] }) {
  const up = prediction.modelProbabilityUp >= 0.5;
  return <Dialog>
    <Card className="group overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[0_18px_50px_rgba(0,0,0,.25)]">
      <CardHeader className="flex-row items-start justify-between space-y-0 border-b p-4">
        <div className="flex items-center gap-2.5">
          {prediction.iconUrl ? <img src={prediction.iconUrl} alt="" className="size-8 rounded-full ring-1 ring-border"/> : <div className="size-8 rounded-full bg-secondary"/>}
          <div><div className="flex items-baseline gap-1.5"><h2 className="text-sm font-semibold">{prediction.symbol}</h2><span className="max-w-24 truncate text-[10px] text-muted-foreground">{prediction.name}</span></div><div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px]"><span>{formatPrice(prediction.price)}</span><span className={prediction.priceChange24h >= 0 ? 'text-primary' : 'text-red-400'}>{prediction.priceChange24h >= 0 ? '+' : ''}{prediction.priceChange24h.toFixed(2)}%</span></div></div>
        </div>
        <SignalBadge prediction={prediction}/>
      </CardHeader>
      <CardContent className="p-4">
        <div className="flex items-end justify-between">
          <div><p className="text-[10px] uppercase tracking-[.16em] text-muted-foreground">Model says</p><p className={cn('mt-1 font-mono text-3xl font-semibold tracking-tight', up ? 'text-primary' : 'text-red-400')}>{Math.round(up ? prediction.modelProbabilityUp * 100 : (1 - prediction.modelProbabilityUp) * 100)}% <span className="text-xs">{up ? 'UP' : 'DOWN'}</span></p></div>
          <div className="text-right"><p className="text-[10px] text-muted-foreground">closes in</p><p className="mt-1 text-xs"><Countdown closesAt={prediction.market.closesAt}/></p></div>
        </div>
        <div className="mt-4 h-16"><MarketChart data={prediction.chart} positive={prediction.priceChange24h >= 0} compact/></div>
        <div className="mt-4 space-y-2.5">
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Polymarket UP</span><span className="font-mono">{Math.round(prediction.market.probabilityUp * 100)}%</span></div>
          <Progress value={prediction.market.probabilityUp * 100} indicatorClassName="bg-foreground/50"/>
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Kalshi UP ≈</span><span className="font-mono">{prediction.kalshi ? `${Math.round(prediction.kalshi.probabilityUp * 100)}%` : '—'}</span></div>
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Edge vs Poly</span><span className={cn('font-mono font-medium', prediction.edge >= 0 ? 'text-primary' : 'text-red-400')}>{prediction.edge >= 0 ? '+' : ''}{(prediction.edge * 100).toFixed(1)}pp</span></div>
        </div>
        <div className="mt-4 grid grid-cols-6 gap-1" title="Factor direction overview">{prediction.factors.map((factor) => <div key={factor.id} className={cn('h-1 rounded-full', factor.direction === 'bullish' ? 'bg-primary' : factor.direction === 'bearish' ? 'bg-red-400' : 'bg-muted-foreground/35')}/>)}</div>
        <div className="mt-2 flex justify-between font-mono text-[8px] uppercase tracking-wide text-muted-foreground/70"><span>Mkt</span><span>Day</span><span>Mo</span><span>Yr</span><span>Season</span><span>News</span></div>
      </CardContent>
      <div className="border-t px-4 py-3">
        <DialogTrigger asChild><Button variant="ghost" size="sm" className="h-7 w-full justify-between px-1 text-xs text-muted-foreground group-hover:text-foreground">Open thesis <ChevronRight/></Button></DialogTrigger>
      </div>
    </Card>
    <PredictionDetail prediction={prediction} news={news}/>
  </Dialog>;
}

function ProbabilityCell({ label, probabilityUp, model = false, approximate = false, enabled = true, askUp, askDown }: { label: string; probabilityUp?: number; model?: boolean; approximate?: boolean; enabled?: boolean; askUp?: number; askDown?: number }) {
  if (probabilityUp === undefined) return <div className={cn('min-w-0 rounded-md border bg-background/30 p-2', !enabled && 'opacity-45')}><p className="truncate text-[8px] uppercase tracking-wider text-muted-foreground">{label}{approximate ? ' ≈' : ''}{!enabled ? ' · off' : ''}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">Unavailable</p></div>;
  const isUp = probabilityUp >= 0.5;
  const likelihood = Math.max(probabilityUp, 1 - probabilityUp);
  return <div className={cn('min-w-0 rounded-md border bg-background/30 p-2', model && 'border-primary/15 bg-primary/[.03]', !enabled && 'opacity-45')}>
    <p className="truncate text-[8px] uppercase tracking-wider text-muted-foreground">{label}{approximate ? ' ≈' : ''}{!enabled ? ' · off' : ''}</p>
    <p className={cn('mt-1 font-mono text-[11px] font-semibold', isUp ? 'text-primary' : 'text-red-400')}>{isUp ? 'UP' : 'DOWN'} {(likelihood * 100).toFixed(0)}%</p>
    <p className="mt-0.5 truncate font-mono text-[7px] text-muted-foreground">U {(probabilityUp * 100).toFixed(0)} · D {((1 - probabilityUp) * 100).toFixed(0)}</p>
    {!model && <p className="mt-1 truncate border-t pt-1 font-mono text-[7px] text-muted-foreground">asks U {askUp === undefined ? '—' : `${(askUp * 100).toFixed(0)}¢`} · D {askDown === undefined ? '—' : `${(askDown * 100).toFixed(0)}¢`}</p>}
  </div>;
}

function liveSignalDisplay(readiness: ExecutionSignalReadiness | undefined): { label: string; detail: string; className: string } {
  const attempt = readiness?.liveAttempt;
  if (attempt) {
    if (attempt.status === 'open') return { label: 'filled · open', detail: `Live maker fill ${attempt.filledCount?.toFixed(2) ?? attempt.quantity.toFixed(2)} of ${attempt.quantity.toFixed(2)} contracts.`, className: 'border-red-400/35 bg-red-400/10 text-red-300' };
    if (attempt.status === 'pending_reservation') return { label: 'live order working', detail: 'A live maker entry is currently being managed.', className: 'border-red-400/35 bg-red-400/10 text-red-300' };
    if (attempt.status === 'uncertain') return { label: 'execution uncertain', detail: attempt.reason ?? 'Reservation retained until authoritative Kalshi reconciliation completes.', className: 'border-red-400/40 bg-red-400/10 text-red-300' };
    if (attempt.status === 'unfilled') {
      const count = `${attempt.attemptNumber ?? 1}/${attempt.maximumAttempts ?? 2}`;
      const outcome = attempt.noFillReason === 'post_only_race' ? 'post-only race' : attempt.noFillReason === 'rested_no_fill' ? 'rested · no fill' : 'no fill';
      return attempt.retryEligible
        ? { label: `${count} ${outcome} · retry ready`, detail: `${attempt.reason ?? 'The maker remainder was canceled without a fill; no money was spent.'} A fresh bounded retry may proceed only while every current gate still passes.`, className: 'border-amber-300/30 text-amber-200' }
        : { label: `${count} · ${outcome}`, detail: attempt.reason ?? 'The maker remainder was canceled without a fill; no money was spent.', className: 'border-muted-foreground/30 text-muted-foreground' };
    }
    if (attempt.status === 'rejected') return { label: 'attempted · rejected', detail: attempt.reason ?? 'The live order was rejected before a fill.', className: 'border-amber-300/30 text-amber-200' };
    if (attempt.status === 'sold') return { label: 'closed · switched', detail: attempt.reason ?? 'The live position was closed.', className: 'border-muted-foreground/30 text-muted-foreground' };
    if (attempt.status === 'won') return { label: 'settled · won', detail: 'The live position settled UP.', className: 'border-primary/30 text-primary' };
    if (attempt.status === 'lost') return { label: 'settled · lost', detail: 'The live position settled DOWN.', className: 'border-red-400/30 text-red-300' };
    return { label: 'settled · invalid', detail: attempt.reason ?? 'The venue invalidated the contract.', className: 'border-muted-foreground/30 text-muted-foreground' };
  }
  if (readiness?.eligible) return { label: 'ready · not attempted', detail: readiness.reason, className: 'border-primary/25 text-primary' };
  if (readiness?.reason.includes('final')) return { label: 'entry window closed', detail: readiness.reason, className: 'border-amber-300/25 text-amber-200' };
  if (readiness) return { label: `${readiness.qualifyingSnapshots}/3 collecting`, detail: readiness.reason, className: 'border-amber-300/25 text-amber-200' };
  return { label: 'checking execution', detail: 'Waiting for the execution ledger to refresh.', className: 'border-muted-foreground/30 text-muted-foreground' };
}

function PositiveEdgeBuys({ predictions, updatedAt }: { predictions: Prediction[]; updatedAt: string }) {
  const [now, setNow] = useState(() => Date.parse(updatedAt));
  const [executionSignals, setExecutionSignals] = useState<ExecutionSignalReadiness[]>([]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/trading/control', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (!cancelled && body?.executionSignals) setExecutionSignals(body.executionSignals); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [updatedAt]);
  const calculatedAt = Date.parse(updatedAt);
  const freshnessNow = Number.isFinite(calculatedAt) ? Math.max(now, calculatedAt) : now;
  const calculationAgeMs = Number.isFinite(calculatedAt) ? freshnessNow - calculatedAt : Number.POSITIVE_INFINITY;
  const stale = !isFreshCalculationTimestamp(updatedAt, freshnessNow);
  const ranked = stale ? [] : [...predictions]
    .filter(qualifiesAsBuyEdge)
    .sort((a, b) => edgeStrength(b) - edgeStrength(a));
  return <section className="mb-8 overflow-hidden rounded-xl border bg-card/80 shadow-[0_20px_70px_rgba(0,0,0,.18)]">
    <div className="flex flex-col justify-between gap-2 border-b px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex items-center gap-2"><div className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary"><Zap className="size-4"/></div><div><h2 className="text-xs font-semibold">Positive-edge buys</h2><p className="text-[9px] text-muted-foreground">Signal qualification: ≥{Math.round(MIN_NET_EDGE * 100)}pp net edge and ≥{Math.round(MIN_ESTIMATE_QUALITY * 100)}% quality. Execution additionally waits 60s, requires 3 persistent snapshots over 30s, and stops entries in the final 120s.</p></div></div>
      <div className={cn('flex items-center gap-2 font-mono text-[9px]', stale ? 'text-amber-300' : 'text-muted-foreground')} title={Number.isFinite(calculatedAt) ? new Date(calculatedAt).toLocaleString() : 'Invalid calculation timestamp'}><span className="relative flex size-2">{!stale && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-50"/>}<span className={cn('relative inline-flex size-2 rounded-full', stale ? 'bg-amber-300' : 'bg-primary')}/></span>{stale ? 'Expired' : `Calculated ${new Date(calculatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${Math.floor(calculationAgeMs / 1_000)}s ago`}</div>
    </div>
    {ranked.length ? <div className="grid [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
      {ranked.map((prediction, index) => {
        const bestVenue = bestEntry(prediction);
        const side = bestVenue?.side ?? (prediction.modelProbabilityUp >= 0.5 ? 'UP' : 'DOWN');
        const isUp = side === 'UP';
        const readiness = executionSignals.find((item) => item.symbol === prediction.symbol && item.side === side && item.closesAt === prediction.market.closesAt);
        const execution = liveSignalDisplay(readiness);
        const portfolio = readiness?.portfolio;
        const portfolioLabel = portfolio?.state === 'portfolio-selected' ? `portfolio${portfolio.rank ? ` #${portfolio.rank}` : ''}`
          : portfolio?.state === 'switch-candidate' ? 'switch candidate'
          : portfolio?.state === 'qualified' ? 'qualified only'
          : portfolio?.state === 'blocked' ? 'portfolio blocked'
          : 'portfolio checking';
        return <div key={prediction.symbol} className="border-b border-r p-4">
          <div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-muted-foreground">#{index + 1} strongest buy</span><div className="flex flex-wrap justify-end gap-1"><Badge variant="outline" className={cn('font-mono text-[8px]', portfolio?.state === 'portfolio-selected' ? 'border-primary/25 text-primary' : portfolio?.state === 'switch-candidate' ? 'border-violet-400/30 text-violet-300' : portfolio?.state === 'blocked' ? 'border-red-400/25 text-red-300' : 'border-amber-300/25 text-amber-200')} title={portfolio?.reason}>{portfolioLabel}</Badge><Badge variant="outline" className={cn('font-mono text-[8px]', execution.className)} title={execution.detail}>{execution.label}</Badge><Badge className={cn('border font-mono text-[9px]', isUp ? 'border-primary/20 bg-primary/10 text-primary' : 'border-red-400/20 bg-red-400/10 text-red-400')}>{isUp ? 'UP' : 'DOWN'}</Badge></div></div>
          <div className="mt-3 flex items-center gap-2">{prediction.iconUrl && <img src={prediction.iconUrl} alt="" className="size-5 rounded-full"/>}<span className="text-sm font-semibold">{prediction.symbol}</span></div>
          <div className="mt-3 grid grid-cols-3 gap-1.5"><ProbabilityCell label="Signal Desk" probabilityUp={prediction.modelProbabilityUp} model/><ProbabilityCell label="Polymarket" probabilityUp={prediction.market.live ? prediction.market.probabilityUp : undefined} askUp={prediction.market.askUp} askDown={prediction.market.askDown} enabled={prediction.enabledTradingVenues.includes('polymarket')}/><ProbabilityCell label="Kalshi" probabilityUp={prediction.kalshi?.live ? prediction.kalshi.probabilityUp : undefined} askUp={prediction.kalshi?.askUp} askDown={prediction.kalshi?.askDown} enabled={prediction.enabledTradingVenues.includes('kalshi')} approximate/></div>
          {bestVenue && <p className="mt-2 font-mono text-[8px] text-primary">{bestVenue.venue === 'kalshi' ? 'Kalshi' : 'Polymarket'} {bestVenue.side} {(bestVenue.price * 100).toFixed(1)}¢ + {(bestVenue.feeRate * 100).toFixed(1)}¢ fee · expected value {bestVenue.netEdge >= 0 ? '+' : ''}{(bestVenue.netEdge * 100).toFixed(1)}pp</p>}
          <p className="mt-1 text-[8px] leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Portfolio:</span> {portfolio?.reason ?? 'Waiting for constrained portfolio evaluation.'}</p>
          <p className="mt-1 text-[8px] leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Live execution:</span> {execution.detail}</p>
          <div className="mt-3 flex items-center justify-between text-[9px]"><span className="text-muted-foreground">Model confidence</span><span className="font-mono font-semibold text-foreground">{Math.round(prediction.confidence * 100)}%</span></div>
          <Progress value={prediction.confidence * 100} className="mt-1.5 h-1"/>
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2 text-[9px] text-muted-foreground"><span className="flex items-center gap-1"><Clock3 className="size-2.5"/>closes in <Countdown closesAt={prediction.market.closesAt}/></span><span className="font-mono">calc {new Date(calculatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
        </div>;
      })}
    </div> : <div className="flex min-h-28 items-center justify-center p-6 text-center"><div><ShieldCheck className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs font-medium">{stale ? 'Calculation window expired' : 'No positive-edge buy right now'}</p><p className="mt-1 text-[10px] text-muted-foreground">{stale ? `The prior calculation exceeded ${DATA_FRESHNESS.observationBucketMs / 1_000} seconds and was cleared while fresh actionable data is requested.` : 'Every current market is priced at or above our estimate once fees are included, so there is no edge to buy.'}</p>{stale && Number.isFinite(calculatedAt) && <p className="mt-1 font-mono text-[9px] text-amber-300">Last calculated {new Date(calculatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {Math.floor(calculationAgeMs / 1_000)}s ago</p>}</div></div>}
    {!stale && <details className="group border-t bg-background/20">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[10px] text-muted-foreground transition hover:bg-secondary/30 hover:text-foreground [&::-webkit-details-marker]:hidden"><span className="flex items-center gap-2"><Info className="size-3.5"/>Debug edge calculations for all {predictions.length} markets</span><ChevronDown className="size-3.5 transition-transform group-open:rotate-180"/></summary>
      <div className="border-t p-3">
        <div className="mb-2 hidden grid-cols-[110px_1fr_1fr_1fr_80px] gap-3 px-3 font-mono text-[8px] uppercase tracking-wider text-muted-foreground sm:grid"><span>Market / status</span><span>Independent P(UP)</span><span>Estimate quality</span><span>Best entry · net edge</span><span>Edge score</span></div>
        <div className="space-y-2">{[...predictions].sort((a, b) => edgeStrength(b) - edgeStrength(a)).map((prediction) => {
          const entry = bestEntry(prediction);
          const selected = entry?.side ?? (prediction.modelProbabilityUp >= 0.5 ? 'UP' : 'DOWN');
          const isUp = selected === 'UP';
          const likelihood = sideProbability(prediction, selected);
          const qualifies = qualifiesAsBuyEdge(prediction);
          const priceRoom = hasTradableEdge(prediction);
          const edgeGap = (entry?.netEdge ?? -1) - MIN_NET_EDGE;
          const confidenceGap = prediction.confidence - MIN_ESTIMATE_QUALITY;
          const breakdown = prediction.confidenceBreakdown;
          const rawConfidence = breakdown.base + breakdown.dataQuality + breakdown.sampleQuality - breakdown.uncertaintyPenalty;
          return <div key={prediction.symbol} className="grid gap-3 rounded-lg border bg-card/50 p-3 sm:grid-cols-[110px_1fr_1fr_1fr_80px] sm:items-center">
            <div><div className="flex items-center gap-2"><span className="text-xs font-semibold">{prediction.symbol}</span><span className={cn('font-mono text-[9px]', isUp ? 'text-primary' : 'text-red-400')}>{isUp ? 'UP' : 'DOWN'}</span></div><Badge variant="outline" className={cn('mt-1.5', qualifies ? 'border-primary/20 text-primary' : 'text-muted-foreground')}>{qualifies ? 'passes gates' : 'below gates'}</Badge></div>
            <div><div className="flex items-center justify-between text-[9px]"><span className="text-muted-foreground">venue-independent</span><span className="font-mono font-semibold">{(likelihood * 100).toFixed(1)}%</span></div>{prediction.basis ? <><p className="mt-1 font-mono text-[9px] text-muted-foreground">basis {prediction.basis.basisPercent >= 0 ? '+' : ''}{prediction.basis.basisPercent.toFixed(3)}% · σ {prediction.basis.standardDeviationPercent.toFixed(3)}% · z {prediction.basis.zScore >= 0 ? '+' : ''}{prediction.basis.zScore.toFixed(2)} → {(prediction.basis.probabilityUp * 100).toFixed(1)}%</p><p className={cn('mt-1 font-mono text-[9px]', prediction.basis.volatilityRatio === undefined ? 'text-muted-foreground' : Math.abs(Math.log(prediction.basis.volatilityRatio)) > 0.4 ? 'text-amber-300/80' : 'text-muted-foreground')}>{prediction.basis.volatilityRatio === undefined ? 'σ vs market: not comparable' : `σ vs market: ${prediction.basis.volatilityRatio.toFixed(2)}× — edge comes only from this`}</p></> : <p className="mt-1 text-[9px] text-amber-300/80">No oracle reference · basis term withheld</p>}<p className="mt-1 font-mono text-[9px] text-muted-foreground">with venue blend {prediction.blendedProbabilityUp === undefined ? '—' : `${(prediction.blendedProbabilityUp * 100).toFixed(1)}%`}{prediction.venueDisagreement !== undefined ? ` · venues differ ${(prediction.venueDisagreement * 100).toFixed(0)}pp` : ''}</p></div>
            <div><div className="flex items-center justify-between text-[9px]"><span className="text-muted-foreground">base + data + sample − uncertainty</span><span className={cn('font-mono font-semibold', confidenceGap >= 0 ? 'text-primary' : 'text-red-400')}>{(prediction.confidence * 100).toFixed(1)}%</span></div><p className="mt-1 font-mono text-[9px] text-muted-foreground">clamp({(breakdown.base * 100).toFixed(1)} + {(breakdown.dataQuality * 100).toFixed(1)} + {(breakdown.sampleQuality * 100).toFixed(1)} − {(breakdown.uncertaintyPenalty * 100).toFixed(1)} = {(rawConfidence * 100).toFixed(1)}, 25, 86) = {(prediction.confidence * 100).toFixed(1)}%</p><p className={cn('mt-1 text-[9px]', confidenceGap >= 0 ? 'text-primary/80' : 'text-red-400/80')}>{Math.round(MIN_ESTIMATE_QUALITY * 100)}% threshold · {confidenceGap >= 0 ? '+' : ''}{(confidenceGap * 100).toFixed(1)}pp</p></div>
            <div><div className="grid grid-cols-2 gap-1.5"><ProbabilityCell label="Polymarket" probabilityUp={prediction.market.live ? prediction.market.probabilityUp : undefined} askUp={prediction.market.askUp} askDown={prediction.market.askDown} enabled={prediction.enabledTradingVenues.includes('polymarket')}/><ProbabilityCell label="Kalshi" probabilityUp={prediction.kalshi?.live ? prediction.kalshi.probabilityUp : undefined} askUp={prediction.kalshi?.askUp} askDown={prediction.kalshi?.askDown} enabled={prediction.enabledTradingVenues.includes('kalshi')} approximate/></div><p className={cn('mt-1.5 font-mono text-[8px]', priceRoom ? 'text-primary/80' : 'text-red-400/80')}>{entry ? `${entry.venue === 'kalshi' ? 'Kalshi' : 'Poly'} ${entry.side} ${(entry.price * 100).toFixed(1)}¢ + fee ${(entry.feeRate * 100).toFixed(1)}¢ → edge ${entry.netEdge >= 0 ? '+' : ''}${(entry.netEdge * 100).toFixed(1)}pp · ${priceRoom ? 'passes' : 'blocked'}` : 'No enabled actionable binary ask · blocked'}</p></div>
            <div className="sm:text-right"><p className="font-mono text-sm">{(edgeStrength(prediction) * 100).toFixed(2)}</p><p className="mt-0.5 text-[8px] text-muted-foreground">net edge × quality</p><div className="mt-2 flex gap-1 sm:justify-end"><span className={cn('size-1.5 rounded-full', edgeGap >= 0 ? 'bg-primary' : 'bg-red-400')}/><span className={cn('size-1.5 rounded-full', confidenceGap >= 0 ? 'bg-primary' : 'bg-red-400')}/><span className={cn('size-1.5 rounded-full', priceRoom ? 'bg-primary' : 'bg-red-400')}/></div></div>
          </div>;
        })}</div>
        <p className="mt-3 px-1 text-[9px] leading-relaxed text-muted-foreground">Confidence is clamped to 25–86%. “Live” is a source-availability bonus, not the 15% prediction-market factor weight. Venue probabilities are shown for research, while the binary buy gate uses the actionable ask for the selected UP/YES or DOWN/NO side on venues enabled in Budget. Disabled venues are dimmed and cannot qualify the calculation. The tradeable P(UP), and therefore P(DOWN)=1−P(UP), is computed without venue input because prices are execution costs rather than forecast features. Qualification is expected value after venue fees, not directional confidence. Entries remain restricted to the {Math.round(MIN_ENTRY_PRICE * 100)}–{Math.round(MAX_ENTRY_PRICE * 100)}¢ range. Selling remains reduce-only and is never treated as an implicit opposite-side entry.</p>
      </div>
    </details>}
  </section>;
}

/**
 * One row per execution track. Signal quality above measures the forecast; these measure the money,
 * and the two modes are reported separately because they trade different bankrolls at different sizes.
 */
function TradeRecordRow({ record, label }: { record: TradeTrackRecord | undefined; label: string }) {
  const isLive = label === 'Live';
  const cash = (cents: number) => `${cents >= 0 ? '+' : '−'}$${Math.abs(cents / 100).toFixed(2)}`;
  const settled = record?.settled ?? 0;
  return <div className={cn('grid grid-cols-2 items-center gap-2 rounded-lg border px-3 py-2 sm:grid-cols-6',
    isLive ? 'border-red-400/25 bg-red-400/[.03]' : 'border-primary/20 bg-primary/[.02]')}>
    <div className="flex items-center gap-1.5">
      {isLive ? <ShieldAlert className="size-3.5 text-red-300"/> : <FlaskConical className="size-3.5 text-primary"/>}
      <span className={cn('text-[11px] font-semibold', isLive && 'text-red-200')}>{label}</span>
    </div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Settled</p><p className="font-mono text-xs">{settled}<span className="ml-1 text-[9px] text-muted-foreground">{record?.windows ?? 0}w</span></p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Win rate</p><p className="font-mono text-xs">{record?.winRate === null || record?.winRate === undefined ? '—' : `${(record.winRate * 100).toFixed(0)}%`}<span className="ml-1 text-[9px] text-muted-foreground">{record?.wins ?? 0}W {record?.losses ?? 0}L</span></p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Return on stake</p><p className={cn('font-mono text-xs', (record?.roi ?? 0) > 0 ? 'text-primary' : (record?.roi ?? 0) < 0 ? 'text-red-400' : '')}>{record?.roi === null || record?.roi === undefined ? '—' : `${record.roi >= 0 ? '+' : ''}${(record.roi * 100).toFixed(1)}%`}</p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Realized P&amp;L</p><p className={cn('font-mono text-xs', (record?.realizedPnlCents ?? 0) > 0 ? 'text-primary' : (record?.realizedPnlCents ?? 0) < 0 ? 'text-red-400' : '')}>{cash(record?.realizedPnlCents ?? 0)}</p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Predicted → realized</p><p className="font-mono text-[10px]">{record?.meanPredictedEdge == null ? '—' : `${(record.meanPredictedEdge * 100).toFixed(1)}pp`} <span className="text-muted-foreground">→</span> <span className={cn(settled === 0 ? 'text-muted-foreground' : (record?.meanRealizedReturn ?? 0) > 0 ? 'text-primary' : 'text-red-400')}>{record?.meanRealizedReturn == null ? '—' : `${record.meanRealizedReturn >= 0 ? '+' : ''}${(record.meanRealizedReturn * 100).toFixed(1)}¢`}</span></p></div>
  </div>;
}

function PerformancePanel({ performance }: { performance: DashboardData['performance'] }) {
  const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  const [records, setRecords] = useState<{ paperRecord?: TradeTrackRecord; liveRecord?: TradeTrackRecord }>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/performance', { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as { paperRecord?: TradeTrackRecord; liveRecord?: TradeTrackRecord };
        if (!cancelled) setRecords({ paperRecord: body.paperRecord, liveRecord: body.liveRecord });
      } catch { /* Keep the previous figures rather than blanking the panel. */ }
    }
    void load();
    const timer = window.setInterval(() => void load(), DATA_FRESHNESS.dashboardPollMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  return <section className="mb-8 rounded-xl border bg-card/60 p-4">
    <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
      <div className="flex min-w-52 items-center gap-3"><div className="grid size-9 place-items-center rounded-lg bg-secondary text-muted-foreground"><Target className="size-4"/></div><div><h2 className="text-xs font-semibold">Positive-edge track record</h2><p className="mt-0.5 text-[9px] text-muted-foreground">Signal quality below; executed money split by mode</p></div></div>
      <div className="flex-1">
      <p className="mb-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">Signal quality · every qualifying calculation, whether or not it was traded</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Updates tracked</p><p className="mt-1 font-mono text-lg">{performance.issued}<span className="ml-1 text-[9px] text-muted-foreground">· {performance.cycles} cycles</span></p></div>
        <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Update accuracy</p><p className="mt-1 font-mono text-lg">{percent(performance.accuracy)}<span className="ml-1 text-[9px] text-muted-foreground">n={performance.resolved}</span></p></div>
        <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Cycle-balanced</p><p className="mt-1 font-mono text-lg">{percent(performance.cycleBalancedAccuracy)}<span className="ml-1 text-[9px] text-muted-foreground">n={performance.resolvedCycles}</span></p></div>
        <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Brier score</p><p className="mt-1 font-mono text-lg">{performance.brierScore === null ? '—' : performance.brierScore.toFixed(3)}<span className="ml-1 text-[9px] text-muted-foreground">lower is better</span></p></div>
        <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Cycle streak</p><p className={cn('mt-1 font-mono text-lg', performance.currentCycleStreak > 0 ? 'text-primary' : performance.currentCycleStreak < 0 ? 'text-red-400' : '')}>{performance.currentCycleStreak > 0 ? `W${performance.currentCycleStreak}` : performance.currentCycleStreak < 0 ? `L${Math.abs(performance.currentCycleStreak)}` : '—'}<span className="ml-1 text-[9px] text-muted-foreground">forecast direction</span></p></div>
      </div>
      </div>
    </div>
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Executed trades · real fills and fees, separate bankrolls</p>
      <TradeRecordRow record={records.liveRecord} label="Live"/>
      <TradeRecordRow record={records.paperRecord} label="Paper"/>
    </div>
    <div className="mt-4 grid gap-4 border-t pt-4 lg:grid-cols-[1fr_auto] lg:items-center">
      <div><div className="mb-1.5 flex items-center justify-between text-[9px] text-muted-foreground"><span>Calibration evidence</span><span className="font-mono">{performance.calibrationWindows}/{performance.calibrationMinimum} independent windows</span></div><Progress value={performance.calibrationProgress * 100} className="h-1"/><p className="mt-1.5 text-[9px] text-muted-foreground">{performance.calibrationReady ? 'Enough independent settlement windows to evaluate a held-out calibration candidate.' : `Live model adjustment is locked; ${performance.resolvedCycles} resolved asset-cycles do not substitute for independent windows.`}</p></div>
      <div className="flex flex-wrap items-center justify-end gap-2">{performance.recent.length > 0 && <div className="scrollbar-none flex max-w-full gap-1.5 overflow-x-auto lg:max-w-sm"><span className="flex items-center gap-1 pr-1 text-[9px] text-muted-foreground"><History className="size-3"/>Recent</span>{performance.recent.slice(0, 4).map((forecast) => <Badge key={forecast.id} variant="outline" className={cn('shrink-0 gap-1 font-mono', forecast.status === 'pending' ? 'text-muted-foreground' : forecast.correct ? 'border-primary/20 text-primary' : 'border-red-400/20 text-red-400')}>{forecast.symbol} {forecast.direction} · {forecast.status === 'pending' ? 'pending' : forecast.correct ? '✓' : '×'}</Badge>)}</div>}<PerformanceDialog/></div>
    </div>
  </section>;
}

function LoadingState() {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 7 }).map((_, index) => <Card key={index}><CardHeader><Skeleton className="h-8 w-28"/></CardHeader><CardContent><Skeleton className="h-10 w-32"/><Skeleton className="mt-6 h-16 w-full"/><Skeleton className="mt-5 h-10 w-full"/></CardContent></Card>)}</div>;
}

export function Dashboard({ initialData }: { initialData: DashboardData | null }) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (data) return;
    fetch('/api/dashboard').then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load dashboard');
      setData(body);
    }).catch((reason) => setError(reason.message));
  }, [data]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch('/api/dashboard');
        if (!response.ok) return;
        const body = await response.json() as DashboardData;
        setData((current) => !current || Date.parse(body.generatedAt) >= Date.parse(current.generatedAt) ? body : current);
      } catch { /* Keep the previous verified snapshot on a transient polling failure. */ }
    }, DATA_FRESHNESS.dashboardPollMs);
    return () => window.clearInterval(timer);
  }, []);

  const predictions = useMemo(() => data?.predictions.filter((item) => `${item.symbol} ${item.name}`.toLowerCase().includes(query.toLowerCase())) ?? [], [data, query]);

  function refresh() {
    setError('');
    startTransition(async () => {
      try {
        const response = await fetch('/api/dashboard?refresh=1');
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Refresh failed');
        setData((current) => !current || Date.parse(body.generatedAt) >= Date.parse(current.generatedAt) ? body : current);
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Refresh failed'); }
    });
  }

  return <main className="relative min-h-screen overflow-hidden">
    <div className="grid-fade pointer-events-none absolute inset-x-0 top-0 h-[520px]"/>
    <header className="relative border-b bg-background/75 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1500px] items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <a href="#" className="flex items-center gap-2"><div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground"><Activity className="size-4"/></div><span className="text-sm font-semibold tracking-tight">Signal Desk</span></a>
          <nav className="hidden items-center gap-1 md:flex"><Button variant="secondary" size="sm"><BarChart3/> Predictions</Button><ResearchDialog/><AccountDialog/><TradingControlDialog/></nav>
        </div>
        <div className="flex items-center gap-2"><div className="md:hidden"><ResearchDialog/></div><div className="md:hidden"><TradingControlDialog/></div>{data && <DataFreshnessDialog data={data}/>}<Button variant="outline" size="sm" onClick={refresh} disabled={isPending}><RefreshCw className={cn(isPending && 'animate-spin')}/><span className="hidden sm:inline">Refresh</span></Button></div>
      </div>
    </header>

    <div className="relative mx-auto max-w-[1500px] px-4 py-8 sm:px-6 sm:py-12">
      <section className="mb-8 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="max-w-2xl">
          <div className="mb-3 flex items-center gap-2"><Badge variant="outline" className="gap-1.5 border-primary/20 bg-primary/5 text-primary"><Sparkles/> {data?.modelVersion ?? 'Blend 0.2'}</Badge><span className="text-[10px] text-muted-foreground">15-minute crypto markets</span></div>
          <h1 className="text-3xl font-semibold tracking-[-.04em] sm:text-4xl">See the signal.<br/><span className="text-muted-foreground">Inspect the evidence.</span></h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">A transparent model layered over prediction-market prices, trend regimes, seasonal history, and breaking crypto news.</p>
        </div>
        <div className="w-full max-w-md">
          <p className="mb-2 text-[10px] uppercase tracking-[.16em] text-muted-foreground">Find a market</p>
          <div className="flex h-10 items-center gap-2 rounded-lg border bg-card px-3 focus-within:ring-1 focus-within:ring-ring"><Search className="size-4 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search BTC, Ethereum, Solana…" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"/><kbd className="rounded border bg-secondary px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">/</kbd></div>
        </div>
      </section>

      <AutomationStatus/>
      {data && <PositiveEdgeBuys predictions={data.predictions} updatedAt={data.generatedAt}/>} 
      {data && <PerformancePanel performance={data.performance}/>} 

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2"><h2 className="text-sm font-medium">Live opportunities</h2><Badge variant="secondary" className="font-mono">{predictions.length}</Badge></div>
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground"><span className="flex items-center gap-1"><Clock3 className="size-3"/>{data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Loading'}</span><span className="hidden items-center gap-1 sm:flex"><ShieldCheck className="size-3"/>Sorted by buy strength</span></div>
        </div>
        {error && <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300"><Info className="size-4"/>{error}</div>}
        {!data && !error ? <LoadingState/> : predictions.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{predictions.map((prediction) => <PredictionCard key={prediction.symbol} prediction={prediction} news={data?.news ?? []}/>)}</div> : <Card className="grid min-h-52 place-items-center text-sm text-muted-foreground">No matching markets.</Card>}
      </section>

      <section className="mt-8 grid gap-3 md:grid-cols-3">
        <Card className="bg-card/60 p-4"><div className="flex items-start gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><BrainCircuit className="size-4"/></div><div><p className="text-xs font-medium">Transparent by default</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Every probability-point contribution is available in the thesis view.</p></div></div></Card>
        <Card className="bg-card/60 p-4"><div className="flex items-start gap-3"><div className="rounded-lg bg-secondary p-2 text-muted-foreground"><CheckCircle2 className="size-4"/></div><div><p className="text-xs font-medium">No invented history</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Unavailable seasonal evidence stays neutral while the local baseline grows.</p></div></div></Card>
        <Card className="bg-card/60 p-4"><div className="flex items-start gap-3"><div className="rounded-lg bg-secondary p-2 text-muted-foreground"><WalletCards className="size-4"/></div><div><p className="text-xs font-medium">Trading is isolated</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Future venue actions require preview, risk checks, and explicit confirmation.</p></div></div></Card>
      </section>

      <footer className="mt-10 flex flex-col justify-between gap-3 border-t py-6 text-[10px] leading-relaxed text-muted-foreground sm:flex-row"><p className="max-w-3xl">{data?.disclaimer ?? 'Research only—not financial advice.'}</p><p className="shrink-0">Polymarket · Kalshi · CoinGecko · Kraken · CoinDesk</p></footer>
    </div>
  </main>;
}
