'use client';

import { Fragment, useEffect, useMemo, useState, useTransition } from 'react';
import {
  ArrowDownRight, ArrowUpRight, BrainCircuit, CheckCircle2,
  ChevronDown, ChevronRight, CircleDot, Clock3, ExternalLink, History, Info, Menu, RefreshCw, Search, ShieldCheck, Sparkles, Target, WalletCards, X, Zap,
  FlaskConical, ShieldAlert,
} from 'lucide-react';
import { AccountDialog } from '@/components/account-dialog';
import { DataFreshnessDialog } from '@/components/data-freshness-dialog';
import { MarketChart } from '@/components/market-chart';
import { HourlyThresholdMarkets } from '@/components/hourly-threshold-markets';
import { OrderBookLadder } from '@/components/order-book-ladder';
import { PerformanceDialog } from '@/components/performance-dialog';
import { PaperBudgetDialog } from '@/components/paper-budget-panel';
import { PolicyDialog } from '@/components/policy-dialog';
import { AllocationDialog } from '@/components/allocation-dialog';
import { SentinelsDialog } from '@/components/sentinels-dialog';
import { ResearchDialog } from '@/components/research-dialog';
import { TradingControlDialog } from '@/components/trading-control-dialog';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AutomationStatus, PublicAutomationStatus } from '@/components/automation-status';
import { usePublicPaperPerformanceSummary } from '@/components/use-public-paper';
import { DATA_FRESHNESS, isFreshCalculationTimestamp } from '@/lib/freshness';
import { cn } from '@/lib/utils';
import { bestEntry, edgeStrength, hasTradableEdge, MAX_ENTRY_PRICE, MAX_NET_EDGE, MIN_ENTRY_PRICE, MIN_ESTIMATE_QUALITY, MIN_NET_EDGE, MIN_SELECTED_SIDE_PROBABILITY, qualifiesAsBuyEdge, sideProbability, venueEntryOptions } from '@/lib/prediction-policy';
import { EXECUTION_LATE_CUTOFF_MS, EXECUTION_WARMUP_MS, REQUIRED_OBSERVATION_SPAN_MS, REQUIRED_QUALIFYING_SNAPSHOTS } from '@/lib/signal-persistence';
import { executionSignalDisplay } from '@/lib/execution-signal-display';
import {
  reconcileRetainedSignals, signalDisplayKey, signalDisplayPhase, signalRemovalAtMs,
  type RetainedSignal,
} from '@/lib/signal-display-lifecycle';
import type {
  DashboardData, DashboardViewData, Direction, ExecutionMode, ExecutionSignalReadiness, Factor, PerformanceSummary,
  Prediction, PublicPaperPerformanceSummary, TradeTrackRecord, TradeTrackSummary, TradingControlData,
  TradingProviderId,
} from '@/lib/types';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function formatPrice(value: number) {
  if (value < 0.1) return `$${value.toFixed(5)}`;
  if (value < 10) return `$${value.toFixed(3)}`;
  return money.format(value);
}

function directionColor(direction: Direction) {
  return direction === 'bullish' ? 'text-gain' : direction === 'bearish' ? 'text-loss' : 'text-muted-foreground';
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
    prediction.signal === 'UP' && 'border-gain/25 bg-gain/10 text-gain',
    prediction.signal === 'DOWN' && 'border-loss/25 bg-loss/10 text-loss',
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
          {!factor.available && <Badge variant="outline" className="border-warn/20 text-warn/80">collecting</Badge>}
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
        <div className={cn('absolute top-0 h-full rounded-full', factor.score >= 0 ? 'left-1/2 bg-gain' : 'right-1/2 bg-loss')} style={{ width: `${Math.abs(factor.score) * 50}%` }}/>
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
        <p className="text-[10px] uppercase tracking-[.16em] text-muted-foreground">Money Noodle</p>
        <p className={cn('mt-1 font-mono text-3xl font-semibold', positive ? 'text-gain' : 'text-loss')}>{Math.round(prediction.modelProbabilityUp * 100)}% <span className="text-sm">UP</span></p>
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
        <p className={cn('mt-1 font-mono text-3xl font-semibold', prediction.edge >= 0 ? 'text-gain' : 'text-loss')}>{prediction.edge >= 0 ? '+' : ''}{(prediction.edge * 100).toFixed(1)}<span className="text-sm">pp</span></p>
      </div>
    </div>
    <Tabs defaultValue="factors" className="px-5 pb-5">
      <div className="flex items-center justify-between pt-4">
        <TabsList><TabsTrigger value="factors">Factor stack</TabsTrigger><TabsTrigger value="chart">Price history</TabsTrigger><TabsTrigger value="news">News</TabsTrigger></TabsList>
        <Button asChild variant="ghost" size="sm"><a href={prediction.market.url} target="_blank" rel="noreferrer">Market <ExternalLink/></a></Button>
      </div>
      <TabsContent value="factors"><div className="grid gap-2.5 sm:grid-cols-2">{prediction.factors.map((factor) => <FactorRow key={factor.id} factor={factor}/>)}</div></TabsContent>
      <TabsContent value="chart"><div className="h-80 rounded-lg border bg-background/40 p-3"><MarketChart data={prediction.chart} positive={prediction.priceChange24h >= 0}/></div><p className="mt-2 text-[10px] text-muted-foreground">Seven-day spot reference · CoinGecko · not the contract resolution feed</p></TabsContent>
      <TabsContent value="news"><div className="divide-y rounded-lg border">{news.slice(0, 8).map((item) => <a key={item.link || item.title} href={item.link} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-4 p-3.5 transition hover:bg-secondary/40"><div><p className="text-xs font-medium leading-relaxed">{item.title}</p><p className="mt-1 text-[10px] text-muted-foreground">{item.publishedAt ? new Date(item.publishedAt).toLocaleString() : 'Recent'}</p></div><span className={cn('mt-0.5 size-2 shrink-0 rounded-full', item.sentiment === 'bullish' ? 'bg-gain' : item.sentiment === 'bearish' ? 'bg-loss' : 'bg-muted-foreground')}/></a>)}</div></TabsContent>
    </Tabs>
  </DialogContent>;
}

function PredictionCard({ prediction, news }: { prediction: Prediction; news: DashboardData['news'] }) {
  const up = prediction.modelProbabilityUp >= 0.5;
  return <Dialog>
    <Card className="group flex h-full min-h-[430px] flex-col overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-[0_18px_50px_rgba(0,0,0,.25)]">
      <CardHeader className="flex-row items-start justify-between space-y-0 border-b p-4">
        <div className="flex items-center gap-2.5">
          {prediction.iconUrl ? <img src={prediction.iconUrl} alt="" className="size-8 rounded-full ring-1 ring-border"/> : <div className="size-8 rounded-full bg-secondary"/>}
          <div><div className="flex items-baseline gap-1.5"><h2 className="text-sm font-semibold">{prediction.symbol}</h2><span className="max-w-24 truncate text-[10px] text-muted-foreground">{prediction.name}</span></div><div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px]"><span>{formatPrice(prediction.price)}</span><span className={prediction.priceChange24h >= 0 ? 'text-gain' : 'text-loss'}>{prediction.priceChange24h >= 0 ? '+' : ''}{prediction.priceChange24h.toFixed(2)}%</span></div></div>
        </div>
        <SignalBadge prediction={prediction}/>
      </CardHeader>
      <CardContent className="flex-1 p-4">
        <div className="flex items-end justify-between">
          <div><p className="text-[10px] uppercase tracking-[.16em] text-muted-foreground">Model says</p><p className={cn('mt-1 font-mono text-3xl font-semibold tracking-tight', up ? 'text-gain' : 'text-loss')}>{Math.round(up ? prediction.modelProbabilityUp * 100 : (1 - prediction.modelProbabilityUp) * 100)}% <span className="text-xs">{up ? 'UP' : 'DOWN'}</span></p></div>
          <div className="text-right"><p className="text-[10px] text-muted-foreground">closes in</p><p className="mt-1 text-xs"><Countdown closesAt={prediction.market.closesAt}/></p></div>
        </div>
        <div className="mt-4 h-16"><MarketChart data={prediction.chart} positive={prediction.priceChange24h >= 0} compact/></div>
        <div className="mt-4 space-y-2.5">
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Polymarket UP</span><span className="font-mono">{Math.round(prediction.market.probabilityUp * 100)}%</span></div>
          <Progress value={prediction.market.probabilityUp * 100} indicatorClassName="bg-foreground/50"/>
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Kalshi UP ≈</span><span className="font-mono">{prediction.kalshi ? `${Math.round(prediction.kalshi.probabilityUp * 100)}%` : '—'}</span></div>
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Edge vs Poly</span><span className={cn('font-mono font-medium', prediction.edge >= 0 ? 'text-gain' : 'text-loss')}>{prediction.edge >= 0 ? '+' : ''}{(prediction.edge * 100).toFixed(1)}pp</span></div>
        </div>
        <div className="mt-4 grid grid-cols-6 gap-1" title="Factor direction overview">{prediction.factors.map((factor) => <div key={factor.id} className={cn('h-1 rounded-full', factor.direction === 'bullish' ? 'bg-gain' : factor.direction === 'bearish' ? 'bg-loss' : 'bg-muted-foreground/35')}/>)}</div>
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
  return <div className={cn('min-w-0 rounded-md border bg-background/30 p-2', model && 'border-data/15 bg-data/[.03]', !enabled && 'opacity-45')}>
    <p className="truncate text-[8px] uppercase tracking-wider text-muted-foreground">{label}{approximate ? ' ≈' : ''}{!enabled ? ' · off' : ''}</p>
    <p className={cn('mt-1 font-mono text-[11px] font-semibold', isUp ? 'text-gain' : 'text-loss')}>{isUp ? 'UP' : 'DOWN'} {(likelihood * 100).toFixed(0)}%</p>
    <p className="mt-0.5 truncate font-mono text-[7px] text-muted-foreground">U {(probabilityUp * 100).toFixed(0)} · D {((1 - probabilityUp) * 100).toFixed(0)}</p>
    {!model && <p className="mt-1 truncate border-t pt-1 font-mono text-[7px] text-muted-foreground">asks U {askUp === undefined ? '—' : `${(askUp * 100).toFixed(0)}¢`} · D {askDown === undefined ? '—' : `${(askDown * 100).toFixed(0)}¢`}</p>}
  </div>;
}

/**
 * The edge calculation itself is public research: it is derived on the client from public predictions and
 * fixed policy thresholds. Live execution and portfolio readiness are not, and their endpoint requires a
 * signed session, so `publicView` skips that fetch and omits the per-candidate execution badges rather
 * than leaving every card stuck on an indefinite "checking execution".
 */
function PositiveEdgeBuys({ predictions, updatedAt, publicView = false, executionSignals = [], executionSignalsLoaded = false, onRefresh, refreshing = false }: { predictions: Prediction[]; updatedAt: string; publicView?: boolean; executionSignals?: ExecutionSignalReadiness[]; executionSignalsLoaded?: boolean; onRefresh?: () => void; refreshing?: boolean }) {
  const [now, setNow] = useState(() => Date.parse(updatedAt));
  const [showConfirmingSignals, setShowConfirmingSignals] = useState(true);
  const [expandedBookKey, setExpandedBookKey] = useState<string>();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const calculatedAt = Date.parse(updatedAt);
  const freshnessNow = Number.isFinite(calculatedAt) ? Math.max(now, calculatedAt) : now;
  const calculationAgeMs = Number.isFinite(calculatedAt) ? freshnessNow - calculatedAt : Number.POSITIVE_INFINITY;
  const stale = !isFreshCalculationTimestamp(updatedAt, freshnessNow);
  const ranked = stale ? [] : [...predictions]
    .filter((prediction) => qualifiesAsBuyEdge(prediction))
    .sort((a, b) => edgeStrength(b) - edgeStrength(a));
  const rankedSignature = ranked.map(signalDisplayKey).join('|');
  const [displayedSignals, setDisplayedSignals] = useState<RetainedSignal<Prediction>[]>(() =>
    reconcileRetainedSignals([], ranked, Number.isFinite(calculatedAt) ? calculatedAt : 0));
  useEffect(() => {
    setDisplayedSignals((previous) => reconcileRetainedSignals(
      previous, ranked, Date.now(), Number.isFinite(calculatedAt) ? calculatedAt : Date.now(),
    ));
  }, [calculatedAt, predictions, rankedSignature]);
  useEffect(() => {
    const nextRemovalAt = displayedSignals.map((item) => signalRemovalAtMs(item.prediction)).sort((a, b) => a - b)[0];
    if (nextRemovalAt === undefined) return;
    const timer = window.setTimeout(() => {
      const currentTime = Date.now();
      setDisplayedSignals((items) => items.filter((item) => signalRemovalAtMs(item.prediction) > currentTime));
    }, Math.max(0, nextRemovalAt - Date.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [displayedSignals]);
  const rankedKeys = new Set(ranked.map(signalDisplayKey));
  const readinessFor = (prediction: Prediction) => {
    const side = bestEntry(prediction)?.side ?? (prediction.modelProbabilityUp >= 0.5 ? 'UP' : 'DOWN');
    return executionSignals.find((item) => item.symbol === prediction.symbol && item.side === side
      && item.closesAt === prediction.market.closesAt);
  };
  const confirmedOrAttempted = publicView || !executionSignalsLoaded ? ranked : ranked.filter((prediction) => {
    const readiness = readinessFor(prediction);
    return Boolean(readiness?.eligible || readiness?.liveAttempt);
  });
  const confirming = publicView || !executionSignalsLoaded ? [] : ranked.filter((prediction) => {
    const readiness = readinessFor(prediction);
    return !readiness?.eligible && !readiness?.liveAttempt;
  });
  const displayedRanked = (publicView || !executionSignalsLoaded
    ? ranked : [...confirmedOrAttempted, ...(showConfirmingSignals ? confirming : [])])
    .filter((prediction) => signalRemovalAtMs(prediction) > now);
  const retainedSignals = displayedSignals.filter((item) =>
    !rankedKeys.has(item.key) && signalRemovalAtMs(item.prediction) > now);
  const displayedRows = [
    ...displayedRanked.map((prediction) => ({
      key: signalDisplayKey(prediction), prediction, capturedAtMs: calculatedAt,
      phase: signalDisplayPhase(prediction, true, now),
    })),
    ...retainedSignals.map((item) => ({
      ...item, phase: signalDisplayPhase(item.prediction, false, now),
    })),
  ];
  const firstRetainedIndex = displayedRanked.length;
  return <section className="mb-8 min-h-[450px] overflow-hidden rounded-xl border bg-card/80 shadow-[0_20px_70px_rgba(0,0,0,.18)]">
    <div className="flex flex-col justify-between gap-2 border-b px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex items-center gap-2"><div className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary"><Zap className="size-4"/></div><div><h2 className="text-xs font-semibold">Positive-edge signals</h2><p className="text-[9px] text-muted-foreground">Base signal: {Math.round(MIN_NET_EDGE * 100)}–{Math.round(MAX_NET_EDGE * 100)}pp net edge and ≥{Math.round(MIN_ESTIMATE_QUALITY * 100)}% quality. Confirmation waits {EXECUTION_WARMUP_MS / 1000}s, requires {REQUIRED_QUALIFYING_SNAPSHOTS} snapshots over {REQUIRED_OBSERVATION_SPAN_MS / 1000}s, and stops in the final {EXECUTION_LATE_CUTOFF_MS / 1000}s. Venue, portfolio, funding, risk, and reconciliation checks follow before any live order.</p></div></div>
      <div className={cn('flex items-center gap-2 font-mono text-[9px]', stale ? 'text-warn' : 'text-muted-foreground')} title={Number.isFinite(calculatedAt) ? new Date(calculatedAt).toLocaleString() : 'Invalid calculation timestamp'}><span className="relative flex size-2">{!stale && <span className="absolute inline-flex size-full animate-ping rounded-full bg-data opacity-50"/>}<span className={cn('relative inline-flex size-2 rounded-full', stale ? 'bg-warn' : 'bg-data')}/></span>{stale ? 'Expired' : `Calculated ${new Date(calculatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${Math.floor(calculationAgeMs / 1_000)}s ago`}
        {/* The manual fetch belongs with the staleness it answers: polling already keeps this current,
            so this exists for when polling or the collector has stopped. */}
        {onRefresh && <Button variant="ghost" size="icon" className="size-6" onClick={onRefresh} disabled={refreshing} title="Re-fetch live venue quotes and the oracle reference now" aria-label="Refresh market data"><RefreshCw className={cn('size-3', refreshing && 'animate-spin')}/></Button>}</div>
    </div>
    {!publicView && executionSignalsLoaded && ranked.length > 0 && <div className="flex items-center justify-between gap-3 border-b bg-background/20 px-4 py-2.5"><div><p className="text-[9px] font-medium">Confirmed or attempted signals · {confirmedOrAttempted.length}</p><p className="text-[8px] text-muted-foreground">Base signals awaiting confirmation are expanded by default.</p></div>{confirming.length > 0 && <Button variant="ghost" size="sm" className="h-7 text-[9px]" onClick={() => setShowConfirmingSignals((shown) => !shown)}>{showConfirmingSignals ? 'Hide' : 'Show'} {confirming.length} signal{confirming.length === 1 ? '' : 's'} awaiting confirmation</Button>}</div>}
    {displayedRows.length ? <div className="grid min-h-[390px] [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
      {!publicView && executionSignalsLoaded && ranked.length > 0 && confirmedOrAttempted.length === 0 && <div className="col-span-full flex min-h-24 items-center justify-center border-b p-5 text-center"><div><ShieldCheck className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs font-medium">No confirmed or attempted signal right now</p><p className="mt-1 text-[9px] text-muted-foreground">{confirming.length} base edge signal{confirming.length === 1 ? ' is' : 's are'} still awaiting confirmation.</p></div></div>}
      {displayedRows.map(({ prediction, key, phase, capturedAtMs }, index) => {
        const signalExpired = phase === 'signal-expired';
        const windowExpired = phase === 'window-expired';
        const inactive = signalExpired || windowExpired;
        const bestVenue = bestEntry(prediction);
        const side = bestVenue?.side ?? (prediction.modelProbabilityUp >= 0.5 ? 'UP' : 'DOWN');
        const isUp = side === 'UP';
        const readiness = executionSignals.find((item) => item.symbol === prediction.symbol && item.side === side && item.closesAt === prediction.market.closesAt);
        const execution = executionSignalDisplay(readiness);
        const portfolio = readiness?.portfolio;
        const portfolioLabel = portfolio?.state === 'portfolio-selected' ? `provisional portfolio${portfolio.rank ? ` #${portfolio.rank}` : ''}`
          : portfolio?.state === 'switch-candidate' ? 'switch candidate'
          : portfolio?.state === 'qualified' ? 'qualified only'
          : portfolio?.state === 'blocked' ? 'portfolio blocked'
          : 'portfolio checking';
        return <Fragment key={key}>{phase === 'current' && !publicView && executionSignalsLoaded && showConfirmingSignals && index === confirmedOrAttempted.length && <div className="col-span-full border-y bg-warn/[.03] px-4 py-2.5"><p className="text-[9px] font-medium text-warn">Signals awaiting confirmation</p><p className="text-[8px] text-muted-foreground">These pass the base edge policy but are not executable buys yet.</p></div>}{inactive && index === firstRetainedIndex && <div className="col-span-full border-y bg-background/30 px-4 py-2.5"><p className="text-[9px] font-medium text-muted-foreground">Expired signals</p><p className="text-[8px] text-muted-foreground">Last qualified snapshots remain inspectable until their market window closes.</p></div>}<div className={cn('min-h-[390px] border-b border-r p-4 transition-[opacity,filter,transform] duration-[2400ms] ease-out', windowExpired ? 'pointer-events-none translate-y-1 opacity-0 blur-[1px]' : 'opacity-100')}>
          <div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-muted-foreground">{windowExpired ? 'window expired' : signalExpired ? 'signal expired · retained until close' : `#${ranked.indexOf(prediction) + 1} edge strength`}</span><div className="flex flex-wrap justify-end gap-1">{inactive && <Badge variant="outline" className={cn('font-mono text-[8px]', windowExpired ? 'border-muted-foreground/20 text-muted-foreground' : 'border-warn/25 text-warn')}>{windowExpired ? 'window expired' : 'signal expired'}</Badge>}{!publicView && !inactive && <><Badge variant="outline" className={cn('font-mono text-[8px]', portfolio?.state === 'portfolio-selected' ? 'border-data/25 text-data' : portfolio?.state === 'switch-candidate' ? 'border-data/30 text-data' : portfolio?.state === 'blocked' ? 'border-warn/25 text-warn' : 'border-warn/25 text-warn')} title={portfolio?.reason}>{portfolioLabel}</Badge><Badge variant="outline" className={cn('font-mono text-[8px]', execution.className)} title={execution.detail}>{execution.label}</Badge></>}<Badge className={cn('border font-mono text-[9px]', isUp ? 'border-gain/20 bg-gain/10 text-gain' : 'border-loss/20 bg-loss/10 text-loss')}>{isUp ? 'UP' : 'DOWN'}</Badge></div></div>
          <div className="mt-3 flex items-center gap-2">{prediction.iconUrl && <img src={prediction.iconUrl} alt="" className="size-5 rounded-full"/>}<span className="text-sm font-semibold">{prediction.symbol}</span></div>
          <div className="mt-3 grid grid-cols-3 gap-1.5"><ProbabilityCell label="Money Noodle" probabilityUp={prediction.modelProbabilityUp} model/><ProbabilityCell label="Polymarket" probabilityUp={prediction.market.live ? prediction.market.probabilityUp : undefined} askUp={prediction.market.askUp} askDown={prediction.market.askDown} enabled={prediction.enabledTradingVenues.includes('polymarket')}/><ProbabilityCell label="Kalshi" probabilityUp={prediction.kalshi?.live ? prediction.kalshi.probabilityUp : undefined} askUp={prediction.kalshi?.askUp} askDown={prediction.kalshi?.askDown} enabled={prediction.enabledTradingVenues.includes('kalshi')} approximate/></div>
          {bestVenue && <p className="mt-2 font-mono text-[8px] text-data">{bestVenue.venue === 'kalshi' ? 'Kalshi' : 'Polymarket'} {bestVenue.side} {(bestVenue.price * 100).toFixed(1)}¢ + {(bestVenue.feeRate * 100).toFixed(1)}¢ fee · expected value {bestVenue.netEdge >= 0 ? '+' : ''}{(bestVenue.netEdge * 100).toFixed(1)}pp</p>}
          {!publicView && !inactive && <p className="mt-1 text-[8px] leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Provisional portfolio:</span> {portfolio?.reason ?? 'Waiting for constrained portfolio evaluation.'}</p>}
          {!publicView && !inactive && <p className="mt-1 text-[8px] leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Live execution:</span> {execution.detail}</p>}
          {signalExpired && <p className="mt-2 rounded-md border border-warn/15 bg-warn/[.03] p-2 text-[8px] leading-relaxed text-muted-foreground"><span className="font-semibold text-warn">Signal expired.</span> This is the last qualified snapshot; it remains for human inspection until the market window closes.</p>}
          <div className="mt-3 flex items-center justify-between text-[9px]"><span className="text-muted-foreground">Model confidence</span><span className="font-mono font-semibold text-foreground">{Math.round(prediction.confidence * 100)}%</span></div>
          <Progress value={prediction.confidence * 100} className="mt-1.5 h-1"/>
          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2 text-[9px] text-muted-foreground"><span className="flex items-center gap-1"><Clock3 className="size-2.5"/>closes in <Countdown closesAt={prediction.market.closesAt}/></span><span className="font-mono">signal calc {Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</span></div>
          {!publicView && prediction.kalshi?.ticker && <OrderBookLadder ticker={prediction.kalshi.ticker} side={side} expanded={expandedBookKey === key} active={!windowExpired} onToggle={() => setExpandedBookKey((current) => current === key ? undefined : key)}/>}
        </div></Fragment>;
      })}
    </div> : <div className="flex min-h-[390px] items-center justify-center p-6 text-center"><div><ShieldCheck className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs font-medium">{stale ? 'Calculation window expired' : 'No positive-edge buy right now'}</p><p className="mt-1 text-[10px] text-muted-foreground">{stale ? `The prior calculation exceeded ${DATA_FRESHNESS.observationBucketMs / 1_000} seconds and was cleared while fresh actionable data is requested.` : 'No current market clears every base buy-policy gate: selected-side probability, estimate quality, actionable price, and fee-aware net edge.'}</p>{stale && Number.isFinite(calculatedAt) && <p className="mt-1 font-mono text-[9px] text-warn">Last calculated {new Date(calculatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {Math.floor(calculationAgeMs / 1_000)}s ago</p>}{stale && onRefresh && <Button variant="outline" size="sm" className="mt-3" onClick={onRefresh} disabled={refreshing}><RefreshCw className={cn(refreshing && 'animate-spin')}/>Refresh now</Button>}</div></div>}
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
            <div><div className="flex items-center gap-2"><span className="text-xs font-semibold">{prediction.symbol}</span><span className={cn('font-mono text-[9px]', isUp ? 'text-gain' : 'text-loss')}>{isUp ? 'UP' : 'DOWN'}</span></div><Badge variant="outline" className={cn('mt-1.5', qualifies ? 'border-data/20 text-data' : 'text-muted-foreground')}>{qualifies ? 'passes gates' : 'below gates'}</Badge></div>
            <div><div className="flex items-center justify-between text-[9px]"><span className="text-muted-foreground">venue-independent</span><span className="font-mono font-semibold">{(likelihood * 100).toFixed(1)}%</span></div>{prediction.basis ? <><p className="mt-1 font-mono text-[9px] text-muted-foreground">basis {prediction.basis.basisPercent >= 0 ? '+' : ''}{prediction.basis.basisPercent.toFixed(3)}% · σ {prediction.basis.standardDeviationPercent.toFixed(3)}% · z {prediction.basis.zScore >= 0 ? '+' : ''}{prediction.basis.zScore.toFixed(2)} → {(prediction.basis.probabilityUp * 100).toFixed(1)}%</p><p className={cn('mt-1 font-mono text-[9px]', prediction.basis.volatilityRatio === undefined ? 'text-muted-foreground' : Math.abs(Math.log(prediction.basis.volatilityRatio)) > 0.4 ? 'text-warn/80' : 'text-muted-foreground')}>{prediction.basis.volatilityRatio === undefined ? 'σ vs market: not comparable' : `σ vs market: ${prediction.basis.volatilityRatio.toFixed(2)}× — edge comes only from this`}</p></> : <p className="mt-1 text-[9px] text-warn/80">No oracle reference · basis term withheld</p>}<p className="mt-1 font-mono text-[9px] text-muted-foreground">with venue blend {prediction.blendedProbabilityUp === undefined ? '—' : `${(prediction.blendedProbabilityUp * 100).toFixed(1)}%`}{prediction.venueDisagreement !== undefined ? ` · venues differ ${(prediction.venueDisagreement * 100).toFixed(0)}pp` : ''}</p></div>
            <div><div className="flex items-center justify-between text-[9px]"><span className="text-muted-foreground">base + data + sample − uncertainty</span><span className={cn('font-mono font-semibold', confidenceGap >= 0 ? 'text-data' : 'text-muted-foreground')}>{(prediction.confidence * 100).toFixed(1)}%</span></div><p className="mt-1 font-mono text-[9px] text-muted-foreground">clamp({(breakdown.base * 100).toFixed(1)} + {(breakdown.dataQuality * 100).toFixed(1)} + {(breakdown.sampleQuality * 100).toFixed(1)} − {(breakdown.uncertaintyPenalty * 100).toFixed(1)} = {(rawConfidence * 100).toFixed(1)}, 25, 86) = {(prediction.confidence * 100).toFixed(1)}%</p><p className={cn('mt-1 text-[9px]', confidenceGap >= 0 ? 'text-data/80' : 'text-muted-foreground/80')}>{Math.round(MIN_ESTIMATE_QUALITY * 100)}% threshold · {confidenceGap >= 0 ? '+' : ''}{(confidenceGap * 100).toFixed(1)}pp</p></div>
            <div><div className="grid grid-cols-2 gap-1.5"><ProbabilityCell label="Polymarket" probabilityUp={prediction.market.live ? prediction.market.probabilityUp : undefined} askUp={prediction.market.askUp} askDown={prediction.market.askDown} enabled={prediction.enabledTradingVenues.includes('polymarket')}/><ProbabilityCell label="Kalshi" probabilityUp={prediction.kalshi?.live ? prediction.kalshi.probabilityUp : undefined} askUp={prediction.kalshi?.askUp} askDown={prediction.kalshi?.askDown} enabled={prediction.enabledTradingVenues.includes('kalshi')} approximate/></div><p className={cn('mt-1.5 font-mono text-[8px]', priceRoom ? 'text-data/80' : 'text-muted-foreground/80')}>{entry ? `${entry.venue === 'kalshi' ? 'Kalshi' : 'Poly'} ${entry.side} ${(entry.price * 100).toFixed(1)}¢ + fee ${(entry.feeRate * 100).toFixed(1)}¢ → edge ${entry.netEdge >= 0 ? '+' : ''}${(entry.netEdge * 100).toFixed(1)}pp · ${priceRoom ? 'passes' : 'blocked'}` : 'No enabled actionable binary ask · blocked'}</p></div>
            <div className="sm:text-right"><p className="font-mono text-sm">{(edgeStrength(prediction) * 100).toFixed(2)}</p><p className="mt-0.5 text-[8px] text-muted-foreground">net edge × quality</p><div className="mt-2 flex gap-1 sm:justify-end"><span className={cn('size-1.5 rounded-full', edgeGap >= 0 ? 'bg-gain' : 'bg-loss')}/><span className={cn('size-1.5 rounded-full', confidenceGap >= 0 ? 'bg-data' : 'bg-muted-foreground/40')}/><span className={cn('size-1.5 rounded-full', priceRoom ? 'bg-data' : 'bg-muted-foreground/40')}/></div></div>
          </div>;
        })}</div>
        <p className="mt-3 px-1 text-[9px] leading-relaxed text-muted-foreground">Confidence is clamped to 25–86%. “Live” is a four-point source-availability bonus to confidence, not the prediction-market factor’s forecast weight. Venue probabilities are shown for research, while the binary buy gate uses the actionable ask for the selected UP/YES or DOWN/NO side on venues enabled in Budget. Disabled venues are dimmed and cannot qualify the calculation. The tradeable P(UP), and therefore P(DOWN)=1−P(UP), is computed without venue input because prices are execution costs rather than forecast features. Qualification requires expected value after venue fees plus at least {Math.round(MIN_SELECTED_SIDE_PROBABILITY * 100)}% independent probability for the selected side. Entries remain restricted to the {Math.round(MIN_ENTRY_PRICE * 100)}–{Math.round(MAX_ENTRY_PRICE * 100)}¢ range, and a claimed edge of {Math.round(MAX_NET_EDGE * 100)}pp or more is refused as model failure rather than opportunity. This table applies the strict defaults for withheld sides and assets; the Policy dialog reports what each track is actually running. Selling remains reduce-only and is never treated as an implicit opposite-side entry.</p>
      </div>
    </details>}
  </section>;
}

/**
 * One row per execution track. Signal quality above measures the forecast; these measure the money,
 * and the two modes are reported separately because they trade different bankrolls at different sizes.
 */
function TradeRecordRow({ record, label }: { record: TradeTrackRecord | TradeTrackSummary | undefined; label: string }) {
  const isLive = label === 'Live';
  const cash = (cents: number) => `${cents >= 0 ? '+' : '−'}$${Math.abs(cents / 100).toFixed(2)}`;
  const settled = record?.settled ?? 0;
  return <div className={cn('grid grid-cols-2 items-center gap-2 rounded-lg border px-3 py-2 sm:grid-cols-6',
    isLive ? 'border-live/25 bg-live/[.03]' : 'border-primary/20 bg-primary/[.02]')}>
    <div className="flex items-center gap-1.5">
      {isLive ? <ShieldAlert className="size-3.5 text-live"/> : <FlaskConical className="size-3.5 text-primary"/>}
      <span className={cn('text-[11px] font-semibold', isLive && 'text-live')}>{label}</span>
    </div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Settled</p><p className="font-mono text-xs">{settled}<span className="ml-1 text-[9px] text-muted-foreground">{record?.windows ?? 0}w</span></p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Win rate</p><p className="font-mono text-xs">{record?.winRate === null || record?.winRate === undefined ? '—' : `${(record.winRate * 100).toFixed(0)}%`}<span className="ml-1 text-[9px] text-muted-foreground">{record?.wins ?? 0}W {record?.losses ?? 0}L</span></p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Return on stake</p><p className={cn('font-mono text-xs', (record?.roi ?? 0) > 0 ? 'text-gain' : (record?.roi ?? 0) < 0 ? 'text-loss' : '')}>{record?.roi === null || record?.roi === undefined ? '—' : `${record.roi >= 0 ? '+' : ''}${(record.roi * 100).toFixed(1)}%`}</p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Realized P&amp;L</p><p className={cn('font-mono text-xs', (record?.realizedPnlCents ?? 0) > 0 ? 'text-gain' : (record?.realizedPnlCents ?? 0) < 0 ? 'text-loss' : '')}>{cash(record?.realizedPnlCents ?? 0)}</p></div>
    <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Predicted → realized</p><p className="font-mono text-[10px]">{record?.meanPredictedEdge == null ? '—' : `${(record.meanPredictedEdge * 100).toFixed(1)}pp`} <span className="text-muted-foreground">→</span> <span className={cn(settled === 0 ? 'text-muted-foreground' : (record?.meanRealizedReturn ?? 0) > 0 ? 'text-gain' : 'text-loss')}>{record?.meanRealizedReturn == null ? '—' : `${record.meanRealizedReturn >= 0 ? '+' : ''}${(record.meanRealizedReturn * 100).toFixed(1)}¢`}</span></p></div>
  </div>;
}

/** Only the scoring figures these two panels read, so both the signed summary and its public projection
 *  (which narrows `recent`) satisfy it. */
type SignalFigures = Pick<PerformanceSummary,
  'issued' | 'cycles' | 'resolved' | 'resolvedCycles' | 'accuracy' | 'cycleBalancedAccuracy'
  | 'brierScore' | 'currentCycleStreak' | 'calibrationWindows' | 'calibrationMinimum'
  | 'calibrationProgress' | 'calibrationReady'>;

/**
 * Scoring of the calculation rather than of the money, so it is identical for a signed operator and a
 * public visitor and is rendered from one component for both.
 */
function SignalQualityTiles({ signal }: { signal: SignalFigures }) {
  const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
    <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Updates tracked</p><p className="mt-1 font-mono text-lg">{signal.issued}<span className="ml-1 text-[9px] text-muted-foreground">· {signal.cycles} cycles</span></p></div>
    <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Update accuracy</p><p className="mt-1 font-mono text-lg">{percent(signal.accuracy)}<span className="ml-1 text-[9px] text-muted-foreground">n={signal.resolved}</span></p></div>
    <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Cycle-balanced</p><p className="mt-1 font-mono text-lg">{percent(signal.cycleBalancedAccuracy)}<span className="ml-1 text-[9px] text-muted-foreground">n={signal.resolvedCycles}</span></p></div>
    <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Brier score</p><p className="mt-1 font-mono text-lg">{signal.brierScore === null ? '—' : signal.brierScore.toFixed(3)}<span className="ml-1 text-[9px] text-muted-foreground">lower is better</span></p></div>
    <div className="rounded-lg border bg-background/40 px-3 py-2"><p className="text-[9px] uppercase tracking-wider text-muted-foreground">Cycle streak</p><p className={cn('mt-1 font-mono text-lg', signal.currentCycleStreak > 0 ? 'text-gain' : signal.currentCycleStreak < 0 ? 'text-loss' : '')}>{signal.currentCycleStreak > 0 ? `W${signal.currentCycleStreak}` : signal.currentCycleStreak < 0 ? `L${Math.abs(signal.currentCycleStreak)}` : '—'}<span className="ml-1 text-[9px] text-muted-foreground">forecast direction</span></p></div>
  </div>;
}

/** Shared by both track-record panels: how much independent evidence the calibration lock still wants. */
function CalibrationEvidence({ signal }: { signal: SignalFigures }) {
  return <div><div className="mb-1.5 flex items-center justify-between text-[9px] text-muted-foreground"><span>Calibration evidence</span><span className="font-mono">{signal.calibrationWindows}/{signal.calibrationMinimum} independent windows</span></div><Progress value={signal.calibrationProgress * 100} className="h-1"/><p className="mt-1.5 text-[9px] text-muted-foreground">{signal.calibrationReady ? 'Enough independent settlement windows to evaluate a held-out calibration candidate.' : `Live model adjustment is locked; ${signal.resolvedCycles} resolved asset-cycles do not substitute for independent windows.`}</p></div>;
}

/**
 * Public counterpart to the signed track record, identical except that the executed-money half is the
 * paper track alone: the live record is never fetched, so a visitor cannot mistake a shadow result for
 * real money. The full-history dialog is offered too, in its paper-only mode.
 */
function PublicPaperPerformancePanel({
  performance, error,
}: { performance: PublicPaperPerformanceSummary | null; error: string | null }) {
  if (!performance) return <section className="mb-8 rounded-xl border border-warn/25 bg-warn/[.04] p-4 text-[10px] text-muted-foreground"><div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn"/><div><p className="font-medium text-foreground">Published paper track unavailable</p><p className="mt-1">{error ?? 'No verified paper-performance projection is available. No empty track record is being inferred.'}</p></div></div></section>;
  return <section className="mb-8 rounded-xl border bg-card/60 p-4">
    <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
      <div className="flex min-w-52 items-center gap-3"><div className="grid size-9 place-items-center rounded-lg bg-secondary text-muted-foreground"><Target className="size-4"/></div><div><h2 className="text-xs font-semibold">Positive-edge track record</h2><p className="mt-0.5 text-[9px] text-muted-foreground">Signal quality below; executed money is the simulated paper track only</p></div></div>
      <div className="flex-1">
        <p className="mb-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">Signal quality · every qualifying calculation, whether or not it was traded</p>
        <SignalQualityTiles signal={performance.summary}/>
      </div>
    </div>
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Executed trades · simulated fills and fees against the paper bankroll</p>
      <TradeRecordRow record={performance.paperRecord} label="Paper"/>
      {error && <p className="flex items-start gap-1.5 text-[9px] leading-relaxed text-warn"><ShieldAlert className="mt-0.5 size-3 shrink-0"/>The last verified paper track is retained, but its latest refresh failed.</p>}
    </div>
    <div className="mt-4 grid gap-4 border-t pt-4 lg:grid-cols-[1fr_auto] lg:items-center">
      <CalibrationEvidence signal={performance.summary}/>
      <div className="flex flex-wrap items-center justify-end gap-2">{performance.summary.recent.length > 0 && <div className="scrollbar-none flex max-w-full gap-1.5 overflow-x-auto lg:max-w-sm"><span className="flex items-center gap-1 pr-1 text-[9px] text-muted-foreground"><History className="size-3"/>Recent</span>{performance.summary.recent.slice(0, 4).map((forecast) => <Badge key={forecast.id} variant="outline" className={cn('shrink-0 gap-1 font-mono', forecast.status === 'pending' ? 'text-muted-foreground' : forecast.correct ? 'border-gain/20 text-gain' : 'border-loss/20 text-loss')}>{forecast.symbol} {forecast.direction} · {forecast.status === 'pending' ? 'pending' : forecast.correct ? '✓' : '×'}</Badge>)}</div>}<PerformanceDialog publicView/></div>
    </div>
  </section>;
}

function PerformancePanel({ performance }: { performance: DashboardData['performance'] }) {
  const [records, setRecords] = useState<{ paperRecord?: TradeTrackSummary; liveRecord?: TradeTrackSummary }>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/performance/summary', { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as { paperRecord?: TradeTrackSummary; liveRecord?: TradeTrackSummary };
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
        <SignalQualityTiles signal={performance}/>
      </div>
    </div>
    <div className="mt-3 space-y-2 border-t pt-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Executed trades · real fills and fees, separate bankrolls</p>
      <TradeRecordRow record={records.liveRecord} label="Live"/>
      <TradeRecordRow record={records.paperRecord} label="Paper"/>
    </div>
    <div className="mt-4 grid gap-4 border-t pt-4 lg:grid-cols-[1fr_auto] lg:items-center">
      <CalibrationEvidence signal={performance}/>
      <div className="flex flex-wrap items-center justify-end gap-2">{performance.recent.length > 0 && <div className="scrollbar-none flex max-w-full gap-1.5 overflow-x-auto lg:max-w-sm"><span className="flex items-center gap-1 pr-1 text-[9px] text-muted-foreground"><History className="size-3"/>Recent</span>{performance.recent.slice(0, 4).map((forecast) => <Badge key={forecast.id} variant="outline" className={cn('shrink-0 gap-1 font-mono', forecast.status === 'pending' ? 'text-muted-foreground' : forecast.correct ? 'border-gain/20 text-gain' : 'border-loss/20 text-loss')}>{forecast.symbol} {forecast.direction} · {forecast.status === 'pending' ? 'pending' : forecast.correct ? '✓' : '×'}</Badge>)}</div>}<PerformanceDialog/></div>
    </div>
  </section>;
}

function predictionHasProvider(prediction: Prediction, providerId: TradingProviderId): boolean {
  switch (providerId) {
    case 'polymarket': return prediction.market.live;
    case 'kalshi': return prediction.kalshi?.live === true;
    case 'crypto-com': case 'forecastex': case 'robinhood': return false;
  }
}

function LoadingState() {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 7 }).map((_, index) => <Card key={index}><CardHeader><Skeleton className="h-8 w-28"/></CardHeader><CardContent><Skeleton className="h-10 w-32"/><Skeleton className="mt-6 h-16 w-full"/><Skeleton className="mt-5 h-10 w-full"/></CardContent></Card>)}</div>;
}

/** One funded read-model poll shared by automation status and per-candidate execution readiness. */
function useTradingControlSummary(active: boolean): TradingControlData | null {
  const [data, setData] = useState<TradingControlData | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    async function load() {
      try {
        const response = await fetch('/api/trading/control', { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as TradingControlData;
        if (!cancelled) setData(body);
      } catch { /* Keep the previous verified control projection. */ }
      finally { if (!cancelled) timer = window.setTimeout(() => void load(), DATA_FRESHNESS.dashboardPollMs); }
    }
    void load();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [active]);
  return data;
}

/**
 * `deskAvailable` is not `authenticated`. A signed-in reader on a stateless host has every right to the
 * desk panel and no worker to serve it, so the two must be asked separately or the panel disappears.
 * Statelessness is separate again: it starts browser refresh before the hard calculation expiry because
 * that host has no reliable in-process prefetch timer.
 */
export function Dashboard({ initialData, authenticated, deskAvailable, stateless }: { initialData: DashboardViewData | null; authenticated: boolean; deskAvailable: boolean; stateless: boolean }) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [cardModes, setCardModes] = useState<ExecutionMode[]>([]);
  const [providerScope, setProviderScope] = useState<TradingProviderId[]>([]);
  const [policyScope, setPolicyScope] = useState('current');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // One owner for each read model: duplicate component polls previously doubled ledger/database work.
  const publicPaper = usePublicPaperPerformanceSummary(!deskAvailable);
  const tradingControl = useTradingControlSummary(deskAvailable);

  useEffect(() => {
    if (data) return;
    fetch('/api/dashboard').then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load dashboard');
      setData(body);
    }).catch((reason) => setError(reason.message));
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const intervalMs = stateless ? DATA_FRESHNESS.calculationRefreshMs : DATA_FRESHNESS.dashboardPollMs;
    async function load() {
      try {
        const response = await fetch('/api/dashboard');
        if (!response.ok) return;
        const body = await response.json() as DashboardViewData;
        if (!cancelled) setData((current) => !current || Date.parse(body.generatedAt) >= Date.parse(current.generatedAt) ? body : current);
      } catch { /* Keep the previous verified snapshot on a transient polling failure. */ }
      finally {
        // Schedule from completion rather than a fixed phase. On a stateless host the request itself
        // builds the replacement, so an interval measured from request start can fire just before the
        // server cache threshold, reuse the old calculation, and then miss the 15-second expiry.
        if (!cancelled) timer = window.setTimeout(() => void load(), intervalMs);
      }
    }
    timer = window.setTimeout(() => void load(), intervalMs);
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [stateless]);

  const currentProviders = useMemo(() => data?.tradingProviders?.filter((provider) =>
    provider.marketCapabilities.some((capability) => capability.marketId === 'crypto-15m' && capability.marketData)) ?? [], [data]);
  const visibleCurrentProviders = useMemo(() => currentProviders.filter((provider) => cardModes.length === 0
    || cardModes.some((mode) => mode === 'live' ? provider.liveEnabled : provider.paperEnabled)), [cardModes, currentProviders]);
  const activeBuyPolicy = data?.policyManifest.activeBuyPolicyVersion;
  const selectedBuyPolicy = policyScope === 'current' ? activeBuyPolicy : policyScope;
  const currentPolicyMatches = !activeBuyPolicy || selectedBuyPolicy === activeBuyPolicy;
  const predictions = useMemo(() => currentPolicyMatches ? data?.predictions.filter((item) =>
    `${item.symbol} ${item.name}`.toLowerCase().includes(query.toLowerCase())
    && (cardModes.length === 0 && providerScope.length === 0 || visibleCurrentProviders.some((provider) =>
      (providerScope.length === 0 || providerScope.includes(provider.id)) && predictionHasProvider(item, provider.id)))) ?? [] : [],
  [cardModes.length, currentPolicyMatches, data, providerScope, query, visibleCurrentProviders]);
  const toggleCardMode = (mode: ExecutionMode) => setCardModes((current) =>
    current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode]);
  const toggleProviderScope = (providerId: TradingProviderId) => setProviderScope((current) =>
    current.includes(providerId) ? current.filter((item) => item !== providerId) : [...current, providerId]);

  /**
   * Forces the live venue quotes and the oracle reference only. CoinGecko and news keep their TTLs:
   * they move slowly, and defeating their caches on demand is what puts the desk near a rate limit.
   */
  function refresh() {
    setError('');
    startTransition(async () => {
      try {
        const response = await fetch('/api/dashboard?refresh=live');
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Refresh failed');
        setData((current) => !current || Date.parse(body.generatedAt) >= Date.parse(current.generatedAt) ? body : current);
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Refresh failed'); }
    });
  }

  return <main className="relative min-h-screen overflow-hidden">
    <div className="grid-fade pointer-events-none absolute inset-x-0 top-0 h-[520px]"/>
    <header className="relative border-b bg-background/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <a href="#" className="flex items-center gap-2.5" aria-label="Money Noodle home"><img src="/brand/money-noodle-icon-64.png" width="40" height="40" alt="" className="size-10 object-contain drop-shadow-[0_0_10px_rgba(53,169,75,.18)]"/><span className="flex flex-col"><span className="text-sm font-semibold leading-none tracking-tight"><span className="text-primary">Money</span> <span className="text-brand-green">Noodle</span></span><span className="mt-1 hidden text-[8px] font-medium uppercase leading-none tracking-[.16em] text-primary lg:block">Multiply your noodles.</span></span></a>
          <nav className="hidden items-center gap-1 min-[800px]:flex">{authenticated && <ResearchDialog/>}{authenticated && <AccountDialog/>}{authenticated ? <TradingControlDialog/> : <PaperBudgetDialog/>}</nav>
        </div>
        {/* One collapse point, at the same width the nav appears, so no destination is reachable at
            some widths and missing at others. Policy and data freshness are reference surfaces and
            live in the status row below, not here. */}
        <div className="flex items-center gap-1 min-[450px]:gap-2">
          <div className="relative min-[800px]:hidden"><Button variant="outline" size="icon" onClick={() => setMobileMenuOpen((open) => !open)} aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}>{mobileMenuOpen ? <X/> : <Menu/>}</Button>{mobileMenuOpen && <div className="absolute right-0 top-11 z-50 w-56 space-y-1 rounded-lg border bg-popover p-2 shadow-xl [&_.hidden]:inline [&_button]:w-full [&_button]:justify-start">{authenticated && <ResearchDialog/>}{authenticated && <AccountDialog/>}{authenticated ? <TradingControlDialog/> : <PaperBudgetDialog/>}</div>}</div>
          <ThemeToggle/>{authenticated ? <form action="/api/auth/logout" method="post"><Button variant="outline" size="sm" type="submit">Sign out</Button></form> : <Button asChild variant="outline" size="sm"><a href="/login">Sign in</a></Button>}
        </div>
      </div>
    </header>

    <div className="relative mx-auto max-w-[1500px] px-4 py-8 sm:px-6 sm:py-12">
      <section className="mb-8 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="max-w-2xl">
          <div className="mb-3 flex flex-wrap items-center gap-2"><Badge variant="outline" className="gap-1.5 border-primary/20 bg-primary/5 text-primary"><Sparkles/> {data?.modelVersion ?? 'Blend 0.2'}</Badge>{data?.policyManifest && <PolicyDialog manifest={data.policyManifest} providers={authenticated ? data.tradingProviders : undefined} variant="badge"/>}{data && <DataFreshnessDialog data={data} variant="badge"/>}{authenticated && <AllocationDialog variant="badge"/>}{authenticated && <SentinelsDialog variant="badge"/>}<span className="text-[10px] text-muted-foreground">15-minute crypto markets</span></div>
          <h1 className="text-3xl font-semibold tracking-[-.04em] text-primary sm:text-4xl">Noodle the numbers<br/><span className="text-brand-green">Evidence is on the table</span></h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-secondary-foreground">No secret ingredient: prediction-market prices, trend regimes, seasonal history, and breaking crypto news, each weighed in the open.</p>
        </div>
        <div className="w-full max-w-md">
          <p className="mb-2 text-[10px] uppercase tracking-[.16em] text-muted-foreground">Find a market</p>
          <div className="flex h-10 items-center gap-2 rounded-lg border bg-card px-3 focus-within:ring-1 focus-within:ring-ring"><Search className="size-4 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search BTC, Ethereum, Solana…" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"/><kbd className="rounded border bg-secondary px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">/</kbd></div>
        </div>
      </section>

      {authenticated && currentProviders.length > 0 && <section className="mb-5 rounded-lg border bg-card/45 p-3"><div className="flex flex-wrap items-center gap-1.5"><span className="mr-1 text-[8px] font-medium uppercase tracking-wider text-muted-foreground">Current card scope</span>{(['live', 'paper'] as const).map((mode) => <button type="button" key={mode} onClick={() => toggleCardMode(mode)} className={cn('rounded border px-2 py-1 font-mono text-[8px]', cardModes.length === 0 || cardModes.includes(mode) ? mode === 'live' ? 'border-live/30 text-live' : 'border-primary/25 text-primary' : 'text-muted-foreground opacity-55')}>{mode}</button>)}{currentProviders.map((provider) => <button type="button" key={provider.id} onClick={() => toggleProviderScope(provider.id)} className={cn('rounded border px-2 py-1 font-mono text-[8px]', (providerScope.length === 0 || providerScope.includes(provider.id)) && visibleCurrentProviders.some((item) => item.id === provider.id) ? 'border-data/25 text-data' : 'text-muted-foreground opacity-55')} title={`${provider.name} · ${provider.selectedVariantId}`}>{provider.id} · {provider.selectedVariantId}</button>)}{providerScope.length > 0 && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[8px]" onClick={() => setProviderScope([])}>All providers</Button>}<label className="ml-1 text-[8px] uppercase text-muted-foreground">Policy</label><select value={policyScope} onChange={(event) => setPolicyScope(event.target.value)} className="h-6 max-w-72 rounded border bg-background px-1.5 font-mono text-[8px]"><option value="current">Current · {activeBuyPolicy}</option>{data?.policyManifest.history.filter((entry) => entry.version !== activeBuyPolicy).map((entry) => <option key={entry.version} value={entry.version}>{entry.version}</option>)}</select></div><p className="mt-1.5 text-[8px] text-muted-foreground">View only: narrows current signal and market cards. Forecast probability, production ranking, execution readiness, and orders remain unchanged.</p></section>}

      {deskAvailable ? <AutomationStatus data={tradingControl}/> : <PublicAutomationStatus deskElsewhere={authenticated} performance={publicPaper.performance} performanceError={publicPaper.error}/>}
      {data && <PositiveEdgeBuys predictions={predictions} updatedAt={data.generatedAt} publicView={!deskAvailable} executionSignals={tradingControl?.executionSignals} executionSignalsLoaded={Boolean(tradingControl)} onRefresh={refresh} refreshing={isPending}/>}
      {authenticated && deskAvailable
        ? data?.performance && <PerformancePanel performance={data.performance}/>
        : <PublicPaperPerformancePanel performance={publicPaper.performance} error={publicPaper.error}/>}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2"><h2 className="text-sm font-medium">Current 15-minute markets</h2><Badge variant="secondary" className="font-mono">{predictions.length}</Badge></div>
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground"><span className="flex items-center gap-1"><Clock3 className="size-3"/>{data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Loading'}</span><span className="hidden items-center gap-1 sm:flex"><ShieldCheck className="size-3"/>Sorted by buy strength</span></div>
        </div>
        {error && <div className="mb-4 flex items-center gap-2 rounded-lg border border-loss/20 bg-loss/5 p-3 text-xs text-loss"><Info className="size-4"/>{error}</div>}
        {!data && !error ? <LoadingState/> : predictions.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{predictions.map((prediction) => <PredictionCard key={prediction.symbol} prediction={prediction} news={data?.news ?? []}/>)}</div> : <Card className="grid min-h-52 place-items-center p-6 text-center text-sm text-muted-foreground">{!currentPolicyMatches ? <span>No current cards use {selectedBuyPolicy}. Historical policy cohorts remain in decision history and performance.</span> : 'No matching markets.'}</Card>}
      </section>

      <HourlyThresholdMarkets query={query}/>

      <section className="mt-8 grid gap-3 md:grid-cols-3">
        <Card className="bg-card/60 p-4"><div className="flex items-start gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><BrainCircuit className="size-4"/></div><div><p className="text-xs font-medium">Transparent by default</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Every probability-point contribution is available in the thesis view.</p></div></div></Card>
        <Card className="bg-card/60 p-4"><div className="flex items-start gap-3"><div className="rounded-lg bg-secondary p-2 text-muted-foreground"><CheckCircle2 className="size-4"/></div><div><p className="text-xs font-medium">No invented history</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Unavailable seasonal evidence stays neutral while the local baseline grows.</p></div></div></Card>
        <Card className="bg-card/60 p-4"><div className="flex items-start gap-3"><div className="rounded-lg bg-secondary p-2 text-muted-foreground"><WalletCards className="size-4"/></div><div><p className="text-xs font-medium">Trading is isolated</p><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Future venue actions require preview, risk checks, and explicit confirmation.</p></div></div></Card>
      </section>

      <footer className="mt-10 flex flex-col justify-between gap-3 border-t py-6 text-[10px] leading-relaxed text-muted-foreground sm:flex-row"><p className="max-w-3xl">{data?.disclaimer ?? 'Research only—not financial advice.'}</p><div className="flex shrink-0 flex-col gap-1 sm:text-right"><p>Polymarket · Kalshi · CoinGecko · Kraken · CoinDesk</p><p>© 2026 noodle.money</p></div></footer>
    </div>
  </main>;
}
