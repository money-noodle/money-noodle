'use client';

import { AlertTriangle, ChevronDown, FlaskConical, Pause, Radio, ShieldAlert } from 'lucide-react';
import { OrderDecisionDetails } from '@/components/order-decision-details';
import { TradeHistoryDialog } from '@/components/trade-history-dialog';
import { Badge } from '@/components/ui/badge';
import { usePublicPaperBudget } from '@/components/use-public-paper';
import { DATA_FRESHNESS } from '@/lib/freshness';
import { fundingOpenedLabel, fundingScopeLine, fundingScopeTitle } from '@/lib/funding-label';
import { latestOpenOrderVenueQuote } from '@/lib/open-order-quote';
import type {
  ExecutionSummary, PaperOrder, PaperOrderStatus, PublicPaperExecutionRecord,
  PublicPaperPerformanceSummary, TradingControlData,
} from '@/lib/types';
import { cn } from '@/lib/utils';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => usd.format(cents / 100);

/**
 * Aggregates only. The public paper projection has no order-level detail, so the panel is typed to what
 * it actually reads and outcome counts are optional: a track whose W/L is unknown omits the cluster
 * instead of reporting 0W 0L beside a non-zero settled count.
 */
type TrackFigures = Pick<ExecutionSummary, 'mode' | 'running' | 'depleted' | 'realizedPnlCents' | 'equityCents' | 'openOrders' | 'settledOrders'>
  & Partial<Pick<ExecutionSummary, 'wins' | 'losses' | 'blockedReason' | 'lifetimePnlCents' | 'pnlScope' | 'epochStartedAt' | 'fundingFirstOrderAt' | 'bankrollResets'>>;

/**
 * One self-contained panel per execution track. Paper and live are deliberately given separate
 * surfaces, colours, and labels: the two report different money, and a shared row of figures made it
 * too easy to read a simulated result as a real one.
 */
function TrackPanel({ track, title, subtitle, equityLabel }: { track: TrackFigures | undefined; title: string; subtitle: string; equityLabel: string }) {
  const isLive = track?.mode === 'live';
  const running = Boolean(track?.running);
  const pnl = track?.realizedPnlCents ?? 0;
  // Only worth a second figure when the two actually differ in meaning. A track whose bankroll has never
  // been re-funded reports the same number twice, which reads as a discrepancy rather than a detail.
  const epochScoped = track?.pnlScope === 'budget-epoch';
  const lifetimePnl = track?.lifetimePnlCents;
  const funded = fundingOpenedLabel(track?.epochStartedAt);
  const scopeLine = fundingScopeLine({
    pnlScope: track?.pnlScope, epochStartedAt: track?.epochStartedAt,
    fundingFirstOrderAt: track?.fundingFirstOrderAt, bankrollResets: track?.bankrollResets,
  });
  return <div className={cn('flex-1 rounded-lg border p-3',
    running && isLive ? 'border-live/45 bg-live/[.06]' : running ? 'border-primary/30 bg-primary/[.04]' : 'border-border bg-background/40')}>
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <div className={cn('grid size-6 place-items-center rounded-md',
          isLive ? 'bg-live/15 text-live' : 'bg-primary/12 text-primary', !running && 'opacity-60')}>
          {isLive ? <ShieldAlert className="size-3.5"/> : <FlaskConical className="size-3.5"/>}
        </div>
        <div>
          <p className={cn('text-[11px] font-semibold', isLive ? 'text-live' : 'text-foreground')}>{title}</p>
          <p className="text-[9px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <Badge variant="outline" className={cn('gap-1 text-[9px]', running ? (isLive ? 'border-live/35 text-live' : 'border-primary/30 text-primary') : 'text-muted-foreground')}>
        {/* Class names are written out in full so Tailwind can statically extract them. */}
        {running && <span className="relative flex size-1.5"><span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', isLive ? 'bg-live' : 'bg-primary')}/><span className={cn('relative inline-flex size-1.5 rounded-full', isLive ? 'bg-live' : 'bg-primary')}/></span>}
        {running ? 'trading' : 'idle'}
      </Badge>
    </div>

    <div className="mt-3 flex items-end justify-between gap-3">
      <div>
        {/* The headline is the figure that reconciles with the equity beside it. Lifetime spans earlier
            fundings and ties to nothing, so it sits in the footer rather than competing here. */}
        <p className="text-[8px] uppercase tracking-wider text-muted-foreground">{epochScoped ? 'Budget P&L' : 'Realized P&L'}</p>
        <p className={cn('font-mono text-xl leading-tight', pnl > 0 ? 'text-gain' : pnl < 0 ? 'text-loss' : 'text-foreground')}>{dollars(pnl)}</p>
      </div>
      <div className="text-right">
        <p className="text-[8px] uppercase tracking-wider text-muted-foreground">{equityLabel}</p>
        <p className="font-mono text-sm">{dollars(track?.equityCents ?? 0)}</p>
      </div>
    </div>

    {/* Dates both figures above, which is the only thing that makes them readable: each counts from the
        moment its funding opened, not from the start of the track. A track whose record holds no opening
        timestamp names the span and its first trade instead of guessing a funding date. */}
    <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground" title={fundingScopeTitle({ epochStartedAt: track?.epochStartedAt, fundingFirstOrderAt: track?.fundingFirstOrderAt })}>
      {scopeLine}
    </p>

    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 font-mono text-[9px] text-muted-foreground">
      <span>{track?.openOrders ?? 0} open</span><span>·</span>
      <span>{track?.settledOrders ?? 0} settled</span>
      {track?.wins !== undefined && <><span>·</span>
        <span className={cn(track.wins > (track.losses ?? 0) && 'text-gain')}>{track.wins}W</span>
        <span className={cn((track.losses ?? 0) > 0 && 'text-loss')}>{track.losses ?? 0}L</span></>}
      {epochScoped && lifetimePnl !== undefined && <><span>·</span>
        <span title={funded ? `Across every funding — unlike the headline, which covers only the current budget. ${funded}.` : 'Across every funding.'}>
          lifetime <span className={cn(lifetimePnl > 0 ? 'text-gain' : lifetimePnl < 0 ? 'text-loss' : '')}>{dollars(lifetimePnl)}</span>
        </span></>}
    </div>

    {track?.depleted && <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-relaxed text-warn/90"><AlertTriangle className="mt-px size-3 shrink-0"/>Bankroll depleted — reset in Budget to resume.</p>}
    {!track?.depleted && track?.blockedReason && <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-relaxed text-warn/90"><AlertTriangle className="mt-px size-3 shrink-0"/>{track.blockedReason}</p>}
  </div>;
}

function OpenOrderRow({ order }: { order: PaperOrder }) {
  const ownedProbability = order.latestOwnedSideProbability ?? (order.side === 'UP' ? order.modelProbabilityUp : 1 - order.modelProbabilityUp);
  const exactStake = order.actualStakeCents ?? order.stakeCents;
  const entryProbability = order.entryDecision?.selectedSideProbability ?? (order.side === 'UP' ? order.modelProbabilityUp : 1 - order.modelProbabilityUp);
  const entryFeeRate = order.entryDecision?.feeRate ?? ((order.actualFeeCents ?? order.feeCents) / Math.max(1, order.potentialPayoutCents));
  const entryNetEdge = order.entryDecision?.netEdge ?? entryProbability - (order.issuanceAskPrice ?? order.askPrice) - entryFeeRate;
  const entryPriceCents = order.actualPurchaseCents !== undefined && order.quantity > 0
    ? order.actualPurchaseCents / order.quantity
    : (order.authoritativeFillPrice ?? order.initialSubmittedPrice ?? order.askPrice) * 100;
  const venueQuote = latestOpenOrderVenueQuote(order);
  const venueQuoteAgeSeconds = venueQuote
    ? Math.max(0, Math.floor((Date.now() - Date.parse(venueQuote.observedAt)) / 1_000)) : undefined;
  const venueQuoteStale = venueQuoteAgeSeconds !== undefined
    && venueQuoteAgeSeconds > DATA_FRESHNESS.observationBucketMs / 1_000;
  const state = order.exitPending ? 'exit pending' : order.status === 'pending_reservation' ? 'entry pending' : order.status;
  return <div className="rounded-md border bg-background/45 px-3 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={cn('h-4 px-1.5 font-mono text-[8px]', order.executionMode === 'live' ? 'border-live/30 text-live' : 'border-primary/25 text-primary')}>{order.executionMode}</Badge>
        <span className="text-[10px] font-semibold">{order.symbol} {order.side}</span>
        <span className="font-mono text-[8px] uppercase text-muted-foreground">{order.venue}</span>
      </div>
      <Badge variant="outline" className={cn('h-4 px-1.5 font-mono text-[8px]', state.includes('pending') || state === 'uncertain' ? 'border-warn/30 text-warn' : 'text-muted-foreground')}>{state}</Badge>
    </div>
    <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[9px] sm:grid-cols-4">
      <span><span className="text-muted-foreground">qty </span>{order.quantity.toFixed(2)}</span>
      <span><span className="text-muted-foreground">cost </span>{exactStake.toFixed(2)}¢</span>
      <span><span className="text-muted-foreground">entry </span>{entryPriceCents.toFixed(1)}¢</span>
      <span><span className="text-muted-foreground">entry P({order.side}) </span>{(entryProbability * 100).toFixed(1)}%</span>
      <span className="col-span-2 sm:col-span-3"><span className="text-muted-foreground">closes </span>{new Date(order.closesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      {order.latestNetProfitPercent !== undefined && <span className={cn(order.latestNetProfitPercent > 0 ? 'text-gain' : order.latestNetProfitPercent < 0 ? 'text-loss' : '')}><span className="text-muted-foreground">executable </span>{order.latestNetProfitPercent >= 0 ? '+' : ''}{(order.latestNetProfitPercent * 100).toFixed(1)}%</span>}
    </div>
    <div className="mt-1 grid grid-cols-2 gap-1 font-mono text-[8px] sm:grid-cols-3"><span><span className="text-muted-foreground">entry edge </span><span className={entryNetEdge >= 0.05 ? 'text-gain' : ''}>{entryNetEdge >= 0 ? '+' : ''}{(entryNetEdge * 100).toFixed(1)}pp</span></span><span><span className="text-muted-foreground">quality </span>{(order.confidence * 100).toFixed(1)}%</span><span><span className="text-muted-foreground">current P({order.side}) </span>{(ownedProbability * 100).toFixed(1)}%</span></div>
    {venueQuote
      ? <div className={cn('mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1 font-mono text-[9px]', venueQuoteStale ? 'border-warn/20 bg-warn/[.03]' : 'border-data/20 bg-data/[.03]')} title={`Latest owned-side ${order.venue} quote captured by the ${venueQuote.source === 'position' ? 'open-position' : 'order-management'} cycle at ${new Date(venueQuote.observedAt).toLocaleString()}.`}><span className={cn('size-1.5 rounded-full', venueQuoteStale ? 'bg-warn' : 'bg-data')}/><span className="text-muted-foreground">{venueQuoteStale ? 'venue quote' : 'venue now'}</span><strong className="font-medium text-foreground">{(venueQuote.bid * 100).toFixed(1)}¢ bid</strong><span className="text-muted-foreground">{(venueQuote.ask * 100).toFixed(1)}¢ ask</span><span className={cn('ml-auto text-[8px]', venueQuoteStale ? 'text-warn' : 'text-muted-foreground')}>{venueQuoteAgeSeconds}s ago</span></div>
      : <div className="mt-1.5 rounded border border-dashed px-2 py-1 font-mono text-[8px] text-muted-foreground">Venue quote awaiting the first execution/open-position observation.</div>}
    <p className="mt-1 truncate font-mono text-[8px] text-muted-foreground" title={order.contractId}>{order.contractId}</p>
    {order.entryExecutionDecision && <p className="mt-1 text-[8px] text-muted-foreground">Execution: <span className="uppercase text-foreground">{order.entryExecutionDecision.executedStyle}</span>{order.entryExecutionDecision.recommendedStyle !== order.entryExecutionDecision.executedStyle ? ` · shadow recommends ${order.entryExecutionDecision.recommendedStyle}` : ''}</p>}
    {order.profitLockArmedAt && <p className="mt-1 text-[8px] text-warn">75% profit lock armed · high water {order.peakNetProfitPercent === undefined ? '—' : `+${(order.peakNetProfitPercent * 100).toFixed(1)}%`}</p>}
    <OrderDecisionDetails order={order}/>
  </div>;
}

function OpenOrdersPanel({ live, paper }: { live?: ExecutionSummary; paper?: ExecutionSummary }) {
  const openStatuses = new Set(['pending_reservation', 'uncertain', 'open']);
  const liveOrders = (live?.recentOrders ?? []).filter((order) => openStatuses.has(order.status));
  const paperOrders = (paper?.recentOrders ?? []).filter((order) => openStatuses.has(order.status));
  const total = liveOrders.length + paperOrders.length;
  return <details className="group border-t">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 marker:content-none hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold">Open orders</span>
        <Badge variant="outline" className="h-4 min-w-4 justify-center px-1 font-mono text-[8px]">{total}</Badge>
        <span className="text-[9px] text-muted-foreground">Live {liveOrders.length} · Paper {paperOrders.length}</span>
      </div>
      <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180"/>
    </summary>
    <div className="space-y-3 border-t bg-background/20 p-3">
      {!total && <p className="py-2 text-center text-[9px] text-muted-foreground">No open positions or unresolved order intents.</p>}
      {!!liveOrders.length && <div><p className="mb-1.5 text-[8px] font-semibold uppercase tracking-wider text-live">Live · real money</p><div className="grid gap-2 lg:grid-cols-2">{liveOrders.map((order) => <OpenOrderRow key={order.id} order={order}/>)}</div></div>}
      {!!paperOrders.length && <div><p className="mb-1.5 text-[8px] font-semibold uppercase tracking-wider text-primary">Paper · simulated shadow</p><div className="grid gap-2 lg:grid-cols-2">{paperOrders.map((order) => <OpenOrderRow key={order.id} order={order}/>)}</div></div>}
    </div>
  </details>;
}

/**
 * Makes the automation state unmistakable on the main page: whether orders are being placed at all,
 * whether they are simulated or real, and which venues are actually armed.
 */
export function AutomationStatus({ data }: { data: TradingControlData | null }) {
  if (!data) return null;
  const { control } = data;
  const active = control.state === 'active';
  const recovering = !active && control.operatorIntent === 'active' && control.pauseOrigin === 'system' && control.autoResumeEligible;
  const liveRunning = Boolean(data.live?.running);
  const regimeGate = data.regimeGate;
  const regimeCooling = regimeGate?.phase === 'closed';
  const armed = data.venues.filter((venue) => venue.enabled && venue.tradeReady).map((venue) => venue.venue);

  return <section className="mb-6 overflow-hidden rounded-xl border bg-card/60">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className={cn('grid size-6 place-items-center rounded-md', active ? 'bg-primary/12 text-primary' : 'bg-secondary text-muted-foreground')}>
          {active ? <Radio className="size-3.5"/> : <Pause className="size-3.5"/>}
        </div>
        <span className="text-xs font-semibold">{active ? regimeCooling ? 'Automation active — new entries cooling off' : 'Automation active' : recovering ? 'Automation safety-suspended — auto-resume armed' : control.state === 'depleted' ? 'Automation stopped — budget depleted' : control.state === 'unconfigured' ? 'Automation not configured' : 'Automation paused'}</span>
        <span className="text-[10px] text-muted-foreground">{armed.length ? armed.join(' + ') : 'no armed venue'} · every {DATA_FRESHNESS.dashboardPollMs / 1000}s{!active && data.executionDrain ? ` · ${data.executionDrain.restartSafe ? 'restart safe' : data.executionDrain.phase}` : ''}</span>
      </div>
      <div className="flex items-center gap-2"><TradeHistoryDialog/><span className={cn('font-mono text-[9px] uppercase tracking-wider', liveRunning ? 'text-live' : 'text-muted-foreground')}>
        {liveRunning ? 'real money at risk' : 'no real money at risk'}
      </span></div>
    </div>
    <div className="flex flex-col gap-3 p-3 sm:flex-row">
      <TrackPanel track={data.live} title="Live" subtitle="Real orders · real money" equityLabel="Budget equity"/>
      <TrackPanel track={data.paper} title="Paper" subtitle="Simulated shadow · always on" equityLabel="Shadow bankroll"/>
    </div>
    <OpenOrdersPanel live={data.live} paper={data.paper}/>
    {regimeGate && regimeGate.phase !== 'disabled' && <div className={cn('flex items-start gap-2 border-t px-4 py-2.5 text-[9px]', regimeCooling ? 'bg-warn/[.04] text-warn' : regimeGate.phase === 'warming' ? 'text-muted-foreground' : 'text-data')}><ShieldAlert className="mt-px size-3 shrink-0"/><span><strong className="uppercase">Adaptive regime gate {regimeGate.phase}</strong> · {regimeGate.reason}{regimeGate.weightedMeanEdge === null ? '' : ` · recent edge ${(regimeGate.weightedMeanEdge * 100).toFixed(1)}pp`}{regimeGate.negativeReturnConfidence === null ? '' : ` · negative confidence ${(regimeGate.negativeReturnConfidence * 100).toFixed(1)}%`} · {regimeGate.resolvedWindows}/{regimeGate.configured.minimumPolicyWindows} policy windows{regimeGate.pendingWindows ? ` · ${regimeGate.pendingWindows} pending` : ''}</span></div>}
    {data.reconciliation && <div className={cn('flex items-start gap-2 border-t px-4 py-2.5 text-[9px]', data.reconciliation.phase === 'ready' ? 'text-data' : 'text-warn')}><ShieldAlert className="mt-px size-3 shrink-0"/><span><strong className="uppercase">Kalshi reconciliation {data.reconciliation.phase}</strong> · {data.reconciliation.reason}{data.reconciliation.nextScheduledAt ? ` · next periodic ${new Date(data.reconciliation.nextScheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}{data.reconciliation.consecutivePeriodicFailures ? ` · ${data.reconciliation.consecutivePeriodicFailures} periodic failure` : ''}</span></div>}
  </section>;
}

/**
 * One sanitized simulated intent. The public projection carries no contract, decision snapshot, or
 * venue identifier, so this row deliberately reports less than its signed counterpart above.
 */
function PublicOpenOrderRow({ record }: { record: PublicPaperExecutionRecord }) {
  return <div className="rounded-md border bg-background/45 px-3 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="h-4 border-primary/25 px-1.5 font-mono text-[8px] text-primary">paper</Badge>
        <span className="text-[10px] font-semibold">{record.symbol} {record.side}</span>
        <span className="font-mono text-[8px] uppercase text-muted-foreground">{record.venue}</span>
      </div>
      <Badge variant="outline" className={cn('h-4 px-1.5 font-mono text-[8px]', record.status === 'pending_reservation' || record.status === 'uncertain' ? 'border-warn/30 text-warn' : 'text-muted-foreground')}>{record.status === 'pending_reservation' ? 'entry pending' : record.status}</Badge>
    </div>
    <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[9px] sm:grid-cols-4">
      <span><span className="text-muted-foreground">qty </span>{record.quantity.toFixed(2)}</span>
      <span><span className="text-muted-foreground">cost </span>{record.stakeCents.toFixed(2)}¢</span>
      <span><span className="text-muted-foreground">entry </span>{(record.askPrice * 100).toFixed(1)}¢</span>
      <span><span className="text-muted-foreground">fee </span>{record.feeCents.toFixed(2)}¢</span>
      <span className="col-span-2 sm:col-span-4"><span className="text-muted-foreground">closes </span>{new Date(record.closesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    </div>
  </div>;
}

/**
 * Said to a reader who is signed in but reading a host that keeps no ledger. Deliberately not the API's
 * `STATELESS_WORKER_MESSAGE`: that module is server-only, and this is a different sentence — it answers
 * "where did my desk go", not "why was this request refused".
 */
const DESK_ELSEWHERE = 'You are signed in, but this host keeps no ledger, so it has no live track, control state, or order history to show. The desk panel runs on the worker that publishes this record.';

/**
 * Paper counterpart to the signed automation panel. Everything here is simulated: there is no live track
 * to report, no venue arming state, and no controls, so the panel says so rather than leaving a visitor
 * to assume the empty half is a real-money result.
 */
export function PublicAutomationStatus({
  deskElsewhere = false, performance, performanceError,
}: {
  deskElsewhere?: boolean;
  performance: PublicPaperPerformanceSummary | null;
  performanceError: string | null;
}) {
  const { budget, error: budgetError } = usePublicPaperBudget();

  // An absent projection is not an empty bankroll. Say unavailable instead of rendering zeros or a gap.
  if (!budget) return <section className="mb-6 rounded-xl border border-warn/25 bg-warn/[.04] px-4 py-3 text-[10px] text-muted-foreground">
    <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn"/><div>
      <p className="font-medium text-foreground">Published paper budget unavailable</p>
      <p className="mt-1">{budgetError ?? 'The dashboard has not received a verified paper-budget projection. No zero balance is being inferred.'}</p>
      {deskElsewhere && <p className="mt-1">{DESK_ELSEWHERE}</p>}
    </div></div>
  </section>;
  const openStatuses = new Set<PaperOrderStatus>(['pending_reservation', 'uncertain', 'open']);
  const openRecords = budget.recentExecutions.filter((record) => openStatuses.has(record.status));
  // Outcome counts come from the paper track record; without it the W/L cluster is omitted rather than
  // reported as 0W 0L against a non-zero settled count.
  const paperRecord = performance?.durable ? performance.paperRecord : undefined;
  const track = {
    mode: 'paper' as const, running: budget.running, depleted: budget.depleted,
    realizedPnlCents: budget.realizedPnlCents, equityCents: budget.equityCents,
    openOrders: budget.openOrders, settledOrders: budget.settledOrders,
    wins: paperRecord?.wins, losses: paperRecord?.losses,
    // The projection carries the reset count but no funding or first-order timestamp, so the public
    // panel says how many times the bankroll was reset without dating a funding it cannot see.
    bankrollResets: budget.bankrollResets,
  };

  return <section className="mb-6 overflow-hidden rounded-xl border bg-card/60">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className={cn('grid size-6 place-items-center rounded-md', budget.running ? 'bg-primary/12 text-primary' : 'bg-secondary text-muted-foreground')}>
          {budget.running ? <Radio className="size-3.5"/> : <Pause className="size-3.5"/>}
        </div>
        <span className="text-xs font-semibold">{budget.depleted ? 'Paper automation stopped — bankroll depleted' : budget.running ? 'Paper automation active' : 'Paper automation idle'}</span>
        <span className="text-[10px] text-muted-foreground">simulated shadow · every {DATA_FRESHNESS.dashboardPollMs / 1000}s</span>
      </div>
      {/* Scoped to this track on purpose. The signed panel reports whether live money is at risk; saying
          so here would either state something untrue or disclose the live state to a public reader. */}
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">simulated funds only</span>
    </div>
    <div className="flex flex-col gap-3 p-3">
      <TrackPanel track={track} title="Paper" subtitle="Simulated shadow · always on" equityLabel="Shadow bankroll"/>
      {deskElsewhere && <p className="px-1 text-[9px] leading-relaxed text-muted-foreground">{DESK_ELSEWHERE}</p>}
      {(budgetError || performanceError) && <p className="flex items-start gap-1.5 px-1 text-[9px] leading-relaxed text-warn"><AlertTriangle className="mt-0.5 size-3 shrink-0"/>The last verified paper record is retained, but its latest refresh failed.</p>}
    </div>
    <details className="group border-t">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 marker:content-none hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold">Open simulated positions</span>
          <Badge variant="outline" className="h-4 min-w-4 justify-center px-1 font-mono text-[8px]">{openRecords.length}</Badge>
        </div>
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180"/>
      </summary>
      <div className="space-y-3 border-t bg-background/20 p-3">
        {openRecords.length ? <div>
          <p className="mb-1.5 text-[8px] font-semibold uppercase tracking-wider text-primary">Paper · simulated shadow</p>
          <div className="grid gap-2 lg:grid-cols-2">
            {openRecords.map((record) => <PublicOpenOrderRow key={`${record.createdAt}:${record.symbol}:${record.side}:${record.venue}`} record={record}/>)}
          </div>
        </div> : <p className="py-2 text-center text-[9px] text-muted-foreground">No open simulated positions or unresolved order intents.</p>}
      </div>
    </details>
  </section>;
}
