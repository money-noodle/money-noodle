'use client';

import { useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, Clock3, Loader2, XCircle } from 'lucide-react';
import { PerformanceChart } from '@/components/performance-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DATA_FRESHNESS } from '@/lib/freshness';
import { MIN_ESTIMATE_QUALITY, MIN_NET_EDGE } from '@/lib/prediction-policy';
import type { EpochResult } from '@/lib/budget-epoch';
import type { PromotionEligibility } from '@/lib/model-promotion';
import type { CalendarEvaluationReport, ContractComparabilityReport, CyclePathReport, ForecastHistoryRow, MakerFillReport, MakerObservedFillSummary, ModelPromotionEntry, PerformanceSlice, PerformanceSummary, PersistenceCandidateReport, ProviderTradeRecord, SegmentGroup, TradeTrackRecord, WalkForwardEvaluationHistory } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Every metric in this dialog is unreadable until enough independent settlement windows exist.
 * Update counts run into the hundreds within minutes, which reads like a large sample when it is not.
 */
function SampleWarning({ summary }: { summary: PerformanceSummary }) {
  if (summary.evaluationMeaningful) return null;
  return <div className="mb-4 flex items-start gap-3 rounded-lg border border-warn/25 bg-warn/5 p-3">
    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn"/>
    <div>
      <p className="text-xs font-medium text-warn">Not enough settled cycles to mean anything yet</p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {summary.resolvedWindows} of {summary.evaluationMinimumWindows} settlement windows resolved. The {summary.resolvedCalculations} settled buy{summary.resolvedCalculations === 1 ? '' : 's'} below come from those {summary.resolvedWindows} window{summary.resolvedWindows === 1 ? '' : 's'} only, and crypto assets in the same window move together — so this is closer to {summary.resolvedWindows} observation{summary.resolvedWindows === 1 ? '' : 's'} than to {summary.resolvedCalculations}. Accuracy and Brier figures here are noise until the window count grows, and a 100% reading is expected at this size.
      </p>
    </div>
  </div>;
}

/**
 * Shown only when a hosted dashboard has no replicated snapshot to serve. It states what is missing and
 * who publishes it, rather than implying the paper track record does not exist.
 */
export function StaleProjectionNotice() {
  return <div className="mb-4 flex items-start gap-3 rounded-lg border p-3">
    <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>
    <div>
      <p className="text-xs font-medium">No published record yet</p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">This page shows the paper track record as published by the Money Noodle desk. Nothing has been published so far, so the figures below are empty rather than zero.</p>
    </div>
  </div>;
}

/**
 * States when the record was published.
 *
 * Deliberately framed as a fact rather than a warning. The figures are a point-in-time record of a desk
 * that runs elsewhere, which is what this page is for — not a cache that has fallen behind. The timestamp
 * is also the honest disclosure: a reader can see for themselves how recent it is, which a vague staleness
 * badge does not tell them.
 */
export function PublishedStamp({ generatedAt }: { generatedAt?: string }) {
  const published = generatedAt ? new Date(generatedAt) : undefined;
  if (!published || Number.isNaN(published.getTime())) return null;
  return <p className="mb-4 flex items-center gap-1.5 text-[10px] text-muted-foreground">
    <Clock3 className="size-3"/>
    Current as of <span className="font-mono text-foreground">{published.toLocaleString()}</span>, when the desk last published.
  </p>;
}

function CalibrationStatus({ summary }: { summary: PerformanceSummary }) {
  return <div className={cn('mb-4 rounded-lg border p-3', summary.calibrationReady ? 'border-data/20 bg-data/[.03]' : 'border-warn/20 bg-warn/[.03]')}>
    <div className="flex items-center justify-between gap-3"><p className="text-[10px] font-medium">Production calibration {summary.calibrationReady ? 'eligible for held-out evaluation' : 'locked'}</p><span className="font-mono text-[10px]">{summary.calibrationWindows}/{summary.calibrationMinimum} independent windows</span></div>
    <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">Unique settlement timestamps across all resolved calculations. The {summary.resolvedCycles} resolved asset-cycles and repeated updates remain diagnostics, not independent calibration samples.</p>
  </div>;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const cents = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}¢`;

/**
 * A segment only counts as evidence when it has several independent settlement windows and its mean
 * clears roughly two standard errors, so a single lucky window cannot look like a discovered rule.
 */
function SegmentTable({ group }: { group: SegmentGroup }) {
  return <div className="overflow-hidden rounded-lg border">
    <div className="border-b bg-background/60 px-3 py-2"><p className="text-[10px] font-medium">{group.dimension}</p><p className="text-[9px] text-muted-foreground">{group.description}</p></div>
    <div className="grid grid-cols-[1fr_44px_44px_62px_78px] gap-2 border-b px-3 py-1.5 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><span>Segment</span><span className="text-right">n</span><span className="text-right">win</span><span className="text-right">pred</span><span className="text-right">realized</span></div>
    <div className="divide-y">{group.segments.map((segment) => {
      const credible = segment.windows >= 5 && segment.standardError !== null && Math.abs(segment.meanRealizedReturn) > 2 * segment.standardError;
      return <div key={segment.label} className={cn('grid grid-cols-[1fr_44px_44px_62px_78px] gap-2 px-3 py-1.5 text-[10px]', credible && segment.meanRealizedReturn > 0 && 'bg-gain/[.05]')}>
        <span className="truncate" title={segment.label}>{segment.label}</span>
        <span className="text-right font-mono text-muted-foreground" title={`${segment.trades} trades across ${segment.windows} settlement windows`}>{segment.windows}w</span>
        <span className="text-right font-mono text-muted-foreground">{(segment.winRate * 100).toFixed(0)}%</span>
        <span className="text-right font-mono text-muted-foreground">{cents(segment.meanPredictedEdge)}</span>
        <span className={cn('text-right font-mono', !credible ? 'text-muted-foreground' : segment.meanRealizedReturn > 0 ? 'text-gain' : 'text-loss')}>
          {cents(segment.meanRealizedReturn)}{segment.standardError !== null ? <span className="text-[8px] text-muted-foreground"> ±{(segment.standardError * 100).toFixed(1)}</span> : null}
        </span>
      </div>;
    })}</div>
  </div>;
}

/**
 * Executed-trade track record for one mode. Paper and live are never blended, and neither is mixed
 * with the signal metrics: 500 qualifying calculations produced 13 trades, so the two populations
 * differ by more than an order of magnitude.
 */
function MissedBuyPanel({ summary }: { summary: PerformanceSummary }) {
  const report = summary.missedBuyCounterfactual;
  const bestPositive = (report.bestPerWindowMeanReturn ?? 0) > 0;
  return <div className="mb-3 rounded-xl border border-warn/25 bg-warn/[.035] p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-xs font-semibold">Missed-good-buy monitor · observation only</h3><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{report.description}</p></div><Badge variant="outline" className="font-mono">{report.windows} window{report.windows === 1 ? '' : 's'}</Badge></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Rejected candidates</p><p className="mt-0.5 font-mono text-base">{report.candidates}</p></div><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Profitable after fact</p><p className="mt-0.5 font-mono text-base">{report.profitableCandidates}/{report.candidates}</p></div><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Clustered return</p><p className={cn('mt-0.5 font-mono text-base', (report.meanCandidateReturn ?? 0) > 0 ? 'text-gain' : (report.meanCandidateReturn ?? 0) < 0 ? 'text-loss' : '')}>{report.meanCandidateReturn === null ? '—' : `${report.meanCandidateReturn >= 0 ? '+' : ''}${(report.meanCandidateReturn * 100).toFixed(1)}%`}</p></div><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Best/window</p><p className={cn('mt-0.5 font-mono text-base', bestPositive ? 'text-gain' : 'text-loss')}>{report.bestPerWindowMeanReturn === null ? '—' : `${report.bestPerWindowMeanReturn >= 0 ? '+' : ''}${(report.bestPerWindowMeanReturn * 100).toFixed(1)}%`}{report.bestPerWindowStandardError !== null && <span className="ml-1 text-[9px] text-muted-foreground">±{(report.bestPerWindowStandardError * 100).toFixed(1)}</span>}</p></div></div>
    <p className="mt-3 text-[9px] leading-relaxed text-muted-foreground">Each asset uses the snapshot nearest five minutes to settlement; “best/window” selects the largest apparent rejected edge in each correlated settlement timestamp. A later profitable outcome is hindsight, not evidence to weaken the 55% gate. Promotion requires sustained positive fee-aware return across independent windows, including unseen data.</p>
  </div>;
}

/**
 * One compact row per (provider, market) within a mode. Attempts and failures sit beside the P&L on
 * purpose: a provider that rejects or fails to fill much of what it is sent is not comparable to one
 * that fills it, and a combined record hides exactly that difference.
 */
function ProviderRecordRows({ records, label }: { records: ProviderTradeRecord[]; label: string }) {
  if (!records.length) return null;
  return <div className="mt-3 overflow-hidden rounded-lg border">
    <div className="border-b bg-background/60 px-3 py-2"><p className="text-[10px] font-medium">{label} by provider</p><p className="text-[9px] text-muted-foreground">Fills, unfilled maker attempts, and rejections kept separate per provider and market. Records written before provider identity existed are attributed to their venue.</p></div>
    <div className="grid grid-cols-[1fr_58px_56px_62px_70px] gap-2 border-b px-3 py-1.5 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><span>Provider · market</span><span className="text-right">settled</span><span className="text-right">win</span><span className="text-right">attempts</span><span className="text-right">P&amp;L</span></div>
    <div className="divide-y">{records.map(({ providerId, marketId, record }) => (
      <div key={`${providerId}:${marketId}`} className="grid grid-cols-[1fr_58px_56px_62px_70px] items-center gap-2 px-3 py-2 text-[10px]">
        <div><span className="font-semibold">{providerId}</span><span className="ml-1.5 font-mono text-[8px] text-muted-foreground">{marketId}</span></div>
        <span className="text-right font-mono">{record.settled}<span className="ml-0.5 text-[8px] text-muted-foreground">/{record.windows}w</span></span>
        <span className="text-right font-mono">{record.winRate === null ? '—' : `${(record.winRate * 100).toFixed(0)}%`}</span>
        <span className="text-right font-mono text-[9px]" title={`${record.unfilled} unfilled · ${record.rejected} rejected · ${record.sold} sold · ${record.pending} open`}>
          {record.unfilled || record.rejected
            ? <span className="text-warn">{record.unfilled}u {record.rejected}r</span>
            : <span className="text-muted-foreground">clean</span>}
        </span>
        <span className={cn('text-right font-mono', record.realizedPnlCents > 0 ? 'text-gain' : record.realizedPnlCents < 0 ? 'text-loss' : '')}>{usd.format(record.realizedPnlCents / 100)}</span>
      </div>
    ))}</div>
  </div>;
}

/**
 * One row per action-versus-alternative arm. The two exit policies are shown separately on purpose:
 * blending them averaged a positive and a negative policy into a single number that read as neutral.
 */
function ActionCounterfactualPanel({ record }: { record: TradeTrackRecord }) {
  return <div className="mt-3 rounded-lg border bg-background/40 p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Action versus rejected alternative</p>
      <span className="font-mono text-[8px] text-muted-foreground">{record.actionCounterfactualVersion}</span>
    </div>
    <div className="mt-2 grid grid-cols-[1fr_52px_46px_74px_84px] gap-2 border-b pb-1 text-[8px] uppercase text-muted-foreground">
      <span>Action · policy</span><span className="text-right">n/w</span><span className="text-right">Hit</span><span className="text-right">Total</span><span className="text-right">Per stake</span>
    </div>
    {record.actionCounterfactuals.map((armed) => (
      <div key={`${armed.action}:${armed.policy}`} className="grid grid-cols-[1fr_52px_46px_74px_84px] gap-2 py-1 text-[10px]" title={armed.description}>
        <span className="truncate">
          <span className="font-medium">{armed.action}</span>
          <span className="text-muted-foreground"> vs {armed.alternative} · {armed.policy}</span>
          {armed.basis === 'approximate' && <span className="ml-1 text-warn/70">≈</span>}
        </span>
        <span className="text-right font-mono text-muted-foreground">{armed.decisions}/{armed.windows}w</span>
        <span className="text-right font-mono text-muted-foreground" title={`Beat the alternative on ${armed.decisionsBeatingAlternative} of ${armed.decisions}`}>
          {armed.hitRate === null ? '—' : `${(armed.hitRate * 100).toFixed(0)}%`}
        </span>
        <span className={cn('text-right font-mono', armed.incrementalCents > 0 ? 'text-gain/70' : armed.incrementalCents < 0 ? 'text-loss/70' : 'text-muted-foreground')}>{`${armed.incrementalCents >= 0 ? '+' : ''}${armed.incrementalCents.toFixed(1)}¢`}</span>
        <span className={cn('text-right font-mono', !armed.credible ? 'text-muted-foreground' : (armed.meanIncrementalReturn ?? 0) > 0 ? 'text-gain' : 'text-loss')}>
          {armed.meanIncrementalReturn === null ? '—' : `${armed.meanIncrementalReturn >= 0 ? '+' : ''}${(armed.meanIncrementalReturn * 100).toFixed(0)}%`}
          {armed.incrementalReturnStandardError !== null && <span className="ml-0.5 text-[8px] text-muted-foreground">±{(armed.incrementalReturnStandardError * 100).toFixed(0)}</span>}
        </span>
      </div>
    ))}
    <p className="mt-1 text-[9px] text-muted-foreground">Positive means the action beat the alternative it rejected. <span className="text-foreground/70">Hit is how often, not how much — an exit is insurance and is expected to be right well under half the time while still paying, so a low hit rate beside a positive per-stake mean is the intended shape.</span> Per-stake means are clustered by settlement window; greyed-out rows do not clear two standard errors. Rows marked ≈ price the rejected exit from an observed bid rather than a settled outcome. Reporting only — no arm may change execution.</p>
  </div>;
}

function TradeRecordCard({ record }: { record: TradeTrackRecord }) {
  const live = record.mode === 'live';
  const credible = record.windows >= 5 && record.standardError !== null && Math.abs(record.meanRealizedReturn ?? 0) > 2 * record.standardError;
  return <div className={cn('rounded-xl border p-4', live ? 'border-live/25 bg-live/[.03]' : 'border-primary/20 bg-primary/[.02]')}>
    <div className="flex items-center justify-between gap-2">
      <div><h3 className={cn('text-xs font-semibold', live && 'text-live')}>{live ? 'Live trades · real money' : 'Paper trades · simulated shadow'}</h3>
        <p className="mt-0.5 text-[9px] text-muted-foreground">{record.settled} settled across {record.windows} settlement window{record.windows === 1 ? '' : 's'}{record.pending ? ` · ${record.pending} open` : ''}{record.sold ? ` · ${record.sold} sold` : ''}{record.unfilled ? ` · ${record.unfilled} unfilled` : ''}{record.rejected ? ` · ${record.rejected} rejected` : ''}{record.switchesEvaluated ? ` · ${record.switchesEvaluated} switch counterfactual${record.switchesEvaluated === 1 ? '' : 's'}` : ''}</p></div>
      <Badge variant="outline" className={cn('uppercase', live ? 'border-live/30 text-live' : 'border-primary/25 text-primary')}>{record.mode}</Badge>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Realized P&amp;L</p><p className={cn('mt-0.5 font-mono text-base', record.realizedPnlCents > 0 ? 'text-gain' : record.realizedPnlCents < 0 ? 'text-loss' : '')}>{usd.format(record.realizedPnlCents / 100)}</p></div>
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Return on stake</p><p className={cn('mt-0.5 font-mono text-base', (record.roi ?? 0) > 0 ? 'text-gain' : (record.roi ?? 0) < 0 ? 'text-loss' : '')}>{record.roi === null ? '—' : `${record.roi >= 0 ? '+' : ''}${(record.roi * 100).toFixed(1)}%`}</p></div>
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Win rate</p><p className="mt-0.5 font-mono text-base">{record.winRate === null ? '—' : `${(record.winRate * 100).toFixed(0)}%`}<span className="ml-1 text-[9px] text-muted-foreground">{record.wins}W {record.losses}L</span></p></div>
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Staked</p><p className="mt-0.5 font-mono text-base">{usd.format(record.stakedCents / 100)}</p></div>
    </div>
    <div className="mt-3 rounded-lg border bg-background/40 p-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Predicted vs realized edge</p>
      <p className="mt-1 font-mono text-[11px]">{record.meanPredictedEdge === null ? '—' : `${(record.meanPredictedEdge * 100).toFixed(1)}pp predicted`} <span className="text-muted-foreground">→</span> <span className={cn(!credible ? 'text-muted-foreground' : (record.meanRealizedReturn ?? 0) > 0 ? 'text-gain' : 'text-loss')}>{record.meanRealizedReturn === null ? '—' : `${record.meanRealizedReturn >= 0 ? '+' : ''}${(record.meanRealizedReturn * 100).toFixed(1)}¢ realized`}</span>{record.standardError !== null && <span className="text-[9px] text-muted-foreground"> ±{(record.standardError * 100).toFixed(1)}</span>}</p>
      <p className="mt-1 text-[9px] text-muted-foreground">{credible ? 'Clears two standard errors across independent windows.' : 'Not yet distinguishable from noise — needs at least 5 settlement windows.'}</p>
    </div>
    {record.switchesEvaluated > 0 && <div className="mt-3 rounded-lg border bg-background/40 p-3"><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Switch versus hold counterfactual</p><p className={cn('mt-1 font-mono text-sm', (record.meanSwitchVsHoldCents ?? 0) > 0 ? 'text-gain' : 'text-loss')}>{record.meanSwitchVsHoldCents === null ? '—' : `${record.meanSwitchVsHoldCents >= 0 ? '+' : ''}${record.meanSwitchVsHoldCents.toFixed(2)}¢`} <span className="text-[9px] text-muted-foreground">mean incremental P&amp;L across {record.switchesEvaluated}</span></p></div>}
    {record.actionCounterfactuals.length > 0 && <ActionCounterfactualPanel record={record}/>}
    {record.principalRecoveryExitsEvaluated > 0 && <div className="mt-3 rounded-lg border bg-background/40 p-3"><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Principal-recovery shadow versus full exit</p><p className={cn('mt-1 font-mono text-sm', (record.principalRecoveryVsFullExitCents ?? 0) > 0 ? 'text-gain' : 'text-loss')}>{record.principalRecoveryVsFullExitCents === null ? '—' : `${record.principalRecoveryVsFullExitCents >= 0 ? '+' : ''}${record.principalRecoveryVsFullExitCents.toFixed(2)}¢`} <span className="text-[9px] text-muted-foreground">counterfactual total across {record.principalRecoveryExitsEvaluated}; observation only</span></p></div>}
    {record.segments.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">{record.segments.map((segmentGroup) => <SegmentTable key={segmentGroup.dimension} group={segmentGroup}/>)}</div>}
  </div>;
}

const rate = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(0)}%`;
const signedRate = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;

function MakerExecutionPanel({ report }: { report: MakerFillReport }) {
  return <div className="mt-3 space-y-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[10px] font-medium">Maker execution and adverse-selection funnel</p><p className="mt-0.5 text-[9px] text-muted-foreground">Maker remains live. Strict taker recommendations are shadow-only until their resolved counterfactual return supports explicit activation.</p></div><Badge variant="outline" className="font-mono">{report.submittedAttempts} submitted</Badge></div>
    <div className="rounded-md border border-data/15 bg-data/[.03] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[9px] font-medium">Adaptive maker/taker shadow</p><p className="text-[8px] text-muted-foreground">{report.adaptiveExecution.policyVersion} · marketable IOC limits are price-capped and disabled live in maker mode</p></div><Badge variant="outline" className="font-mono">{report.adaptiveExecution.currentPolicy.recommendations} current-policy taker</Badge></div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div><p className="text-[8px] uppercase text-muted-foreground">Current resolved</p><p className="font-mono text-sm">{report.adaptiveExecution.currentPolicy.resolvedRecommendations}<span className="text-[8px] text-muted-foreground"> / {report.adaptiveExecution.currentPolicy.resolvedWindows}w</span></p></div>
        <div><p className="text-[8px] uppercase text-muted-foreground">Current taker return</p><p className={cn('font-mono text-sm', (report.adaptiveExecution.currentPolicy.meanTakerCounterfactualReturn ?? 0) > 0 ? 'text-gain' : report.adaptiveExecution.currentPolicy.meanTakerCounterfactualReturn === null ? '' : 'text-loss')}>{report.adaptiveExecution.currentPolicy.meanTakerCounterfactualReturn === null ? '—' : `${report.adaptiveExecution.currentPolicy.meanTakerCounterfactualReturn >= 0 ? '+' : ''}${(report.adaptiveExecution.currentPolicy.meanTakerCounterfactualReturn * 100).toFixed(1)}%`}{report.adaptiveExecution.currentPolicy.takerCounterfactualReturnStandardError !== null && <span className="text-[8px] text-muted-foreground"> ±{(report.adaptiveExecution.currentPolicy.takerCounterfactualReturnStandardError * 100).toFixed(1)}</span>}</p></div>
        <div><p className="text-[8px] uppercase text-muted-foreground">Current vs maker</p><p className={cn('font-mono text-sm', (report.adaptiveExecution.currentPolicy.meanTakerAdvantageOverMaker ?? 0) > 0 ? 'text-gain' : report.adaptiveExecution.currentPolicy.meanTakerAdvantageOverMaker === null ? '' : 'text-loss')}>{report.adaptiveExecution.currentPolicy.meanTakerAdvantageOverMaker === null ? '—' : `${report.adaptiveExecution.currentPolicy.meanTakerAdvantageOverMaker >= 0 ? '+' : ''}${(report.adaptiveExecution.currentPolicy.meanTakerAdvantageOverMaker * 100).toFixed(1)}%`}{report.adaptiveExecution.currentPolicy.takerAdvantageOverMakerStandardError !== null && <span className="text-[8px] text-muted-foreground"> ±{(report.adaptiveExecution.currentPolicy.takerAdvantageOverMakerStandardError * 100).toFixed(1)}</span>}</p></div>
        <div><p className="text-[8px] uppercase text-muted-foreground">Actual takers</p><p className="font-mono text-sm">{report.adaptiveExecution.actualTakerFills}/{report.adaptiveExecution.actualTakerOrders}</p><p className="text-[8px] text-muted-foreground">return {report.adaptiveExecution.meanActualTakerReturn === null ? '—' : `${report.adaptiveExecution.meanActualTakerReturn >= 0 ? '+' : ''}${(report.adaptiveExecution.meanActualTakerReturn * 100).toFixed(1)}%`}</p></div>
      </div>
      <p className="mt-2 text-[8px] leading-relaxed text-muted-foreground">Current buy policy: {report.adaptiveExecution.currentPolicy.buyPolicyVersion}. Historical context: {report.adaptiveExecution.resolvedTakerRecommendations} recommendations across {report.adaptiveExecution.resolvedTakerWindows} windows returned {report.adaptiveExecution.meanTakerCounterfactualReturn === null ? '—' : `${report.adaptiveExecution.meanTakerCounterfactualReturn >= 0 ? '+' : ''}${(report.adaptiveExecution.meanTakerCounterfactualReturn * 100).toFixed(1)}%`}{report.adaptiveExecution.takerCounterfactualReturnStandardError !== null ? ` ±${(report.adaptiveExecution.takerCounterfactualReturnStandardError * 100).toFixed(1)}` : ''}; paired advantage over actual maker execution was {report.adaptiveExecution.meanTakerAdvantageOverMaker === null ? '—' : `${report.adaptiveExecution.meanTakerAdvantageOverMaker >= 0 ? '+' : ''}${(report.adaptiveExecution.meanTakerAdvantageOverMaker * 100).toFixed(1)}%`}{report.adaptiveExecution.takerAdvantageOverMakerStandardError !== null ? ` ±${(report.adaptiveExecution.takerAdvantageOverMakerStandardError * 100).toFixed(1)}` : ''}. Every mean and ± is clustered by settlement window. Historical policy mixtures cannot authorize activation.</p>
    </div>
    <div className="rounded-md border border-data/15 bg-data/[.03] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[9px] font-medium">Prospective paper/live execution pairs</p><p className="text-[8px] text-muted-foreground">Exact decision IDs only; unlike the legacy overlay, the denominator includes both no-fills.</p></div><Badge variant="outline" className="font-mono">{report.executionMirrorPairs.decidedPairs}/{report.executionMirrorPairs.pairedIntents} decided</Badge></div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><p className="text-[8px] uppercase text-muted-foreground">Fill cells</p><p className="font-mono text-sm">{report.executionMirrorPairs.bothFilled}/{report.executionMirrorPairs.paperOnlyFills}/{report.executionMirrorPairs.liveOnlyFills}/{report.executionMirrorPairs.neitherFilled}</p><p className="text-[8px] text-muted-foreground">both / paper / live / neither</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Agreement</p><p className="font-mono text-sm">{rate(report.executionMirrorPairs.fillAgreement)}</p><p className="text-[8px] text-muted-foreground">live-fill capture {rate(report.executionMirrorPairs.paperCaptureOfLiveFills)}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Decision parity</p><p className="font-mono text-sm">{report.executionMirrorPairs.sameRoute}/{report.executionMirrorPairs.pairedIntents} route</p><p className="text-[8px] text-muted-foreground">{report.executionMirrorPairs.sameRequestedQuantity}/{report.executionMirrorPairs.pairedIntents} quantity</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Unpaired / ambiguous</p><p className="font-mono text-sm">{report.executionMirrorPairs.paperOnlyIntents}p · {report.executionMirrorPairs.liveOnlyIntents}l · {report.executionMirrorPairs.ambiguousPairIds}a</p><p className="text-[8px] text-muted-foreground">price Δ {report.executionMirrorPairs.meanPaperMinusLiveFillPrice === null ? '—' : `${(report.executionMirrorPairs.meanPaperMinusLiveFillPrice * 100).toFixed(2)}¢`}</p></div></div>
      <p className="mt-2 font-mono text-[8px] text-muted-foreground">{report.executionMirrorPairs.version} · observation only · production changed: no</p>
    </div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Accepted</p><p className="font-mono text-base">{report.acceptedAttempts}/{report.submittedAttempts}</p><p className="text-[8px] text-muted-foreground">{rate(report.acceptanceRate)}</p></div>
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Filled | accepted</p><p className="font-mono text-base">{report.partialFills + report.completeFills}/{report.acceptedAttempts}</p><p className="text-[8px] text-muted-foreground">{rate(report.fillRateGivenAcceptance)}</p></div>
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Post-only races</p><p className="font-mono text-base">{report.postOnlyRaces}</p><p className="text-[8px] text-muted-foreground">never entered queue</p></div>
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Fill shape</p><p className="font-mono text-base">{report.completeFills} full · {report.partialFills} partial</p><p className="text-[8px] text-muted-foreground">{report.restedNoFillAttempts} rested no fill</p></div>
    </div>
    <div className="rounded-md border bg-background/40 p-2.5"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[9px] font-medium">Execution and position observation coverage</p><p className="text-[8px] text-muted-foreground">Displayed size is a queue-ahead proxy, never exact private priority.</p></div><Badge variant="outline" className="font-mono">{report.executionAudit.attemptsWithDepth}/{report.executionAudit.attemptsWithPath} depth</Badge></div><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><p className="text-[8px] uppercase text-muted-foreground">Repriced attempts</p><p className="font-mono text-sm">{report.executionAudit.repricedAttempts}</p><p className="text-[8px] text-muted-foreground">rest {report.executionAudit.meanRestingDurationMs === null ? '—' : `${(report.executionAudit.meanRestingDurationMs / 1000).toFixed(1)}s`}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Displayed ahead</p><p className="font-mono text-sm">{report.executionAudit.meanDisplayedAhead === null ? '—' : report.executionAudit.meanDisplayedAhead.toFixed(1)}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Cancel latency</p><p className="font-mono text-sm">{report.executionAudit.meanCancellationLatencyMs === null ? '—' : `${report.executionAudit.meanCancellationLatencyMs.toFixed(0)}ms`}</p><p className="text-[8px] text-muted-foreground">{report.executionAudit.cancellationsObserved} observed</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Position paths</p><p className="font-mono text-sm">{report.executionAudit.positionSnapshots}</p><p className="text-[8px] text-muted-foreground">{report.executionAudit.positionsObserved} positions</p></div></div></div>
    <div className="rounded-md border bg-background/40 p-2.5"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[9px] font-medium">Settlement adverse selection</p><p className="text-[8px] text-muted-foreground">Filled positions versus the counterfactual result of accepted orders that did not fill.</p></div><span className={cn('font-mono text-sm', (report.pairedWinRateGap ?? report.adverseSelectionWinRateGap ?? 0) < 0 ? 'text-loss' : 'text-gain')}>{signedRate(report.pairedWinRateGap ?? report.adverseSelectionWinRateGap)}{report.pairedWinRateGapStandardError !== null ? <span className="text-[8px] text-muted-foreground"> ±{(report.pairedWinRateGapStandardError * 100).toFixed(1)}</span> : null}</span></div><div className="mt-2 grid grid-cols-2 gap-2"><div><p className="text-[8px] uppercase text-muted-foreground">Filled cohort</p><p className="font-mono text-sm">win {rate(report.filledWinRate)} · return {report.meanFilledReturn === null ? '—' : `${report.meanFilledReturn >= 0 ? '+' : ''}${(report.meanFilledReturn * 100).toFixed(1)}%`}</p><p className="text-[8px] text-muted-foreground">{report.resolvedFilledAttempts} attempts · {report.resolvedFilledWindows} windows</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Accepted, no fill</p><p className="font-mono text-sm">win {rate(report.acceptedNoFillCounterfactualWinRate)} · return {report.meanAcceptedNoFillCounterfactualReturn === null ? '—' : `${report.meanAcceptedNoFillCounterfactualReturn >= 0 ? '+' : ''}${(report.meanAcceptedNoFillCounterfactualReturn * 100).toFixed(1)}%`}</p><p className="text-[8px] text-muted-foreground">{report.resolvedAcceptedNoFillAttempts} attempts · {report.resolvedAcceptedNoFillWindows} windows</p></div></div><p className="mt-2 text-[8px] leading-relaxed text-muted-foreground">The headline gap is paired within the same settlement window when possible ({report.pairedAdverseSelectionWindows} paired windows); ± is its window-clustered standard error. A negative gap means filled orders won less often than accepted non-fills on their purchased side. Raw cohorts remain descriptive, and none of this changes execution.</p></div>
    <div className="rounded-md border"><div className="border-b px-2 py-1.5 text-[9px] font-medium">First-passage proxy · accepted orders only</div><div className="grid grid-cols-2 gap-2 p-2"><div><p className="text-[8px] uppercase text-muted-foreground">Mean predicted touch</p><p className="font-mono text-sm">{rate(report.meanPredictedProbability)}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Observed queue fills</p><p className="font-mono text-sm">{report.fills}/{report.attempts} · {rate(report.observedFillRate)}</p></div></div>{report.buckets.length > 0 && <div className="divide-y border-t">{report.buckets.map((bucket) => <div key={bucket.label} className="grid grid-cols-[1fr_60px_70px] gap-2 px-2 py-1.5 text-[9px]"><span>{bucket.label} · {bucket.attempts} accepted</span><span className="text-right font-mono">touch {(bucket.meanPredictedProbability * 100).toFixed(0)}%</span><span className="text-right font-mono">fill {(bucket.observedFillRate * 100).toFixed(0)}%</span></div>)}</div>}</div>
    {report.segments.length > 0 && <details className="rounded-md border"><summary className="cursor-pointer px-2 py-2 text-[9px] font-medium">Execution segments ({report.segments.length})</summary><div className="divide-y border-t">{report.segments.map((segment) => <div key={`${segment.dimension}:${segment.label}`} className="grid grid-cols-[1fr_48px_48px_58px_62px] gap-2 px-2 py-1.5 text-[8px]"><span>{segment.dimension} · {segment.label}</span><span className="text-right font-mono">{segment.accepted}/{segment.submitted} acc</span><span className="text-right font-mono">{segment.fills} fill</span><span className="text-right font-mono">win {rate(segment.filledWinRate)}</span><span className="text-right font-mono">{segment.meanFilledReturn === null ? '—' : `${segment.meanFilledReturn >= 0 ? '+' : ''}${(segment.meanFilledReturn * 100).toFixed(0)}%`}</span></div>)}</div></details>}
  </div>;
}


/**
 * Observed fills, replacing the tile previously labelled "Maker-touch benchmark".
 *
 * That tile showed `bid-priced return x fill probability`, which prices the fill as a random draw the
 * desk's adverse-selection measurements refute, and which — being a positive scaling — could never
 * disagree with the ask benchmark beside it. What replaces it is the return **conditional on an observed
 * fill**. Sources are shown apart and never added: the backfill is a coarser 60-second replay whose fills
 * are an upper bound. See docs/maker-post-observation-design.md.
 */
function ObservedFillPanel({ summary, backfill, modelledCoverage }: { summary: MakerObservedFillSummary; backfill: MakerObservedFillSummary; modelledCoverage: number | null }) {
  const row = (label: string, entry: MakerObservedFillSummary, note: string) => {
    const decided = entry.ladderFilled + entry.ladderUnfilled;
    const staticDecided = entry.staticFilled + entry.staticUnfilled;
    return <div key={entry.source} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-[9px]">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-[8px] text-muted-foreground">
          {decided > 0 ? `ladder ${entry.ladderFilled}/${decided} filled` : 'ladder not scored'}
          {staticDecided > 0 ? ` · static ${entry.staticFilled}/${staticDecided} filled` : ''}
          {entry.unobservedIntents > 0 ? ` · ${entry.unobservedIntents} unobserved` : ''}
        </p>
        <p className="text-[8px] text-muted-foreground">{note}</p>
      </div>
      <div className="text-right">
        <p className={cn('font-mono text-sm', (entry.meanRealizedProfitPerContract ?? 0) > 0 ? 'text-gain' : entry.meanRealizedProfitPerContract === null ? '' : 'text-loss')}>
          {entry.meanRealizedProfitPerContract === null ? '—' : cents(entry.meanRealizedProfitPerContract)}
        </p>
        <p className="font-mono text-[8px] text-muted-foreground">
          {entry.meanRealizedProfitPerContract === null ? 'no observed fill yet' : `conditional on fill · ${entry.realizedWindows} windows${entry.realizedStandardError === null ? '' : ` · ±${(entry.realizedStandardError * 100).toFixed(1)}¢ SE`}`}
        </p>
      </div>
    </div>;
  };
  return <div className="rounded-lg border">
    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
      <p className="text-[9px] font-medium">Observed fills</p>
      <Badge variant="outline" className="font-mono text-[8px]">modelled fill coverage {modelledCoverage === null ? '—' : `${(modelledCoverage * 100).toFixed(0)}%`}</Badge>
    </div>
    <div className="divide-y">
      {row('Live, 2-second path', summary, 'Post walked from the bid toward the ask over six checks, scored against observed prints.')}
      {row('Backfill, 60-second sampler', backfill, 'Static arm only, one 60-second print window against a 12-second horizon: an upper bound, never pooled with the row above.')}
    </div>
    <p className="border-t px-3 py-2 text-[8px] text-muted-foreground">A simulated post is not a filled order: it cannot see hidden size, and it cannot know our own resting size would have changed the book.</p>
  </div>;
}

function PersistenceCandidatePanel({ report }: { report: PersistenceCandidateReport }) {
  const makerCoverage = report.candidateIntents ? report.modelledMakerIntents / report.candidateIntents : null;
  return <div className="space-y-3">
    <div className="rounded-lg border border-data/15 bg-data/[.03] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[10px] font-medium">Two-consecutive-snapshot candidate</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">Prospective evaluation only. It records where two qualifying snapshots would authorize an entry while production continues to require three. It places no order, reserves no budget, and cannot change either track.</p></div><Badge variant="outline" className="font-mono">{report.resolvedIncrementalWindows}/{report.minimumReviewWindows} incremental windows</Badge></div>
      <p className="mt-2 font-mono text-[8px] text-muted-foreground">{report.candidateVersion} · production {report.productionPolicyVersion} · collecting since {new Date(report.startedAt).toLocaleString()}</p>
    </div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Candidate intents</p><p className="mt-1 font-mono text-lg">{report.candidateIntents}</p><p className="text-[8px] text-muted-foreground">{report.incrementalIntents} earlier than production</p></div>
      <div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Resolved incremental</p><p className="mt-1 font-mono text-lg">{report.resolvedIncrementalIntents}</p><p className="text-[8px] text-muted-foreground">{report.resolvedIncrementalWindows} independent windows</p></div>
      <div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Ask benchmark</p><p className={cn('mt-1 font-mono text-lg', (report.meanIncrementalAskProfitPerContract ?? 0) > 0 ? 'text-gain' : report.meanIncrementalAskProfitPerContract === null ? '' : 'text-loss')}>{report.meanIncrementalAskProfitPerContract === null ? '—' : cents(report.meanIncrementalAskProfitPerContract)}</p><p className="text-[8px] text-muted-foreground">per $1 payout{report.incrementalAskStandardError === null ? '' : ` · ±${(report.incrementalAskStandardError * 100).toFixed(1)}¢ SE`}</p></div>
      <div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Bid-priced return</p><p className={cn('mt-1 font-mono text-lg', (report.meanIncrementalBidPricedProfitPerContract ?? 0) > 0 ? 'text-gain' : report.meanIncrementalBidPricedProfitPerContract === null ? '' : 'text-loss')}>{report.meanIncrementalBidPricedProfitPerContract === null ? '—' : cents(report.meanIncrementalBidPricedProfitPerContract)}</p><p className="text-[8px] text-muted-foreground">the price effect alone · no fill assumption</p></div>
    </div>
    <ObservedFillPanel summary={report.observedFill} backfill={report.backfilledFill} modelledCoverage={makerCoverage}/>
    <div className="rounded-lg border p-3"><div className="flex items-center justify-between gap-2"><p className="text-[9px] font-medium">Production comparison</p><Badge variant="outline" className={report.reviewReady ? 'border-warn/30 text-warn' : 'text-muted-foreground'}>{report.reviewReady ? 'sample ready for manual review' : 'collecting'}</Badge></div><p className="mt-1 text-[9px] text-muted-foreground">Production later reached its three-snapshot gate on {report.productionCaughtUp}/{report.incrementalIntents} incremental intents{report.meanProductionDelayMs === null ? '.' : `, after an average ${(report.meanProductionDelayMs / 1000).toFixed(0)} seconds.`} Reaching {report.minimumReviewWindows} windows only opens a manual review; it never promotes the candidate.</p><p className="mt-2 font-mono text-[8px] text-data">Production changed: no</p></div>
    {report.recent.length > 0 && <details className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-[9px] font-medium">Recent candidate intents ({report.recent.length})</summary><div className="divide-y border-t">{report.recent.map((intent) => <div key={intent.id} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-[9px]"><div><span className="font-medium">{intent.symbol} {intent.side}</span><span className="ml-2 font-mono text-muted-foreground">{(intent.askPrice * 100).toFixed(1)}¢ ask · {(intent.predictedNetEdge * 100).toFixed(1)}pp edge</span><p className="text-[8px] text-muted-foreground">{new Date(intent.createdAt).toLocaleString()} · {intent.productionEligibleAtCandidate ? 'production already eligible' : intent.productionEligibleAt ? `production caught up in ${Math.round((intent.productionDelayMs ?? 0) / 1000)}s` : 'incremental so far'}</p></div><div className="text-right font-mono text-[8px]"><p>{intent.makerFillProbability === null || intent.makerFillProbability === undefined ? 'fill —' : `fill ${(intent.makerFillProbability * 100).toFixed(0)}%`}</p><p className="text-muted-foreground">{intent.outcome ?? 'pending'}</p></div></div>)}</div></details>}
  </div>;
}

function CalendarEvaluationPanel({ report }: { report: CalendarEvaluationReport }) {
  const cohortTable = (title: string, rows: CalendarEvaluationReport['timeBands']) => <div className="overflow-hidden rounded-lg border">
    <div className="border-b bg-background/50 px-3 py-2 text-[9px] font-medium">{title}</div>
    <div className="grid grid-cols-[1fr_42px_50px_58px_72px] gap-2 border-b px-3 py-1.5 font-mono text-[8px] uppercase text-muted-foreground"><span>Cohort</span><span className="text-right">dates</span><span className="text-right">cand.</span><span className="text-right">Brier</span><span className="text-right">ask return</span></div>
    <div className="divide-y">{rows.map((row) => <div key={row.key} className="grid grid-cols-[1fr_42px_50px_58px_72px] gap-2 px-3 py-2 text-[9px]"><span>{row.label}<span className="ml-1 text-[8px] text-muted-foreground">{row.noCandidateWindows} none</span></span><span className="text-right font-mono">{row.calendarDates}</span><span className="text-right font-mono">{row.resolvedCandidateWindows}</span><span className="text-right font-mono">{row.brierScore?.toFixed(3) ?? '—'}</span><span className={cn('text-right font-mono', (row.meanAskProfitPerContract ?? 0) > 0 ? 'text-gain' : row.meanAskProfitPerContract === null ? '' : 'text-loss')}>{row.meanAskProfitPerContract === null ? '—' : `${row.meanAskProfitPerContract >= 0 ? '+' : ''}${(row.meanAskProfitPerContract * 100).toFixed(1)}¢`}</span></div>)}</div>
  </div>;
  return <div className="space-y-3">
    <div className="rounded-lg border border-data/15 bg-data/[.03] p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[10px] font-medium">Prospective calendar-effects evaluation</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">One immutable five-minute forecast per asset/window plus one current-policy candidate or explicit no-candidate marker per settlement window. Observation only: this ledger cannot gate, size, reserve, trade, or promote.</p></div><Badge variant="outline" className="font-mono">{report.distinctCalendarDates}/{report.minimumTimeReviewDates} dates</Badge></div><p className="mt-2 font-mono text-[8px] text-muted-foreground">{report.collectionVersion} · {report.timeZone} · policy {report.productionPolicyVersion}</p></div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Fixed forecasts</p><p className="mt-1 font-mono text-lg">{report.resolvedForecasts}/{report.fixedForecasts}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Observed windows</p><p className="mt-1 font-mono text-lg">{report.observedWindows}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Resolved candidates</p><p className="mt-1 font-mono text-lg">{report.resolvedCandidateWindows}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">No candidate</p><p className="mt-1 font-mono text-lg">{report.noCandidateWindows}</p></div></div>
    <div className="grid gap-3 sm:grid-cols-2">{cohortTable('Four-hour bands', report.timeBands)}{cohortTable('Day of week', report.weekdays)}</div>
    <div className="rounded-lg border p-3"><p className="text-[9px] font-medium">Review locks</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">Time-of-day review requires {report.minimumTimeReviewDates} distinct dates and {report.minimumCandidateWindowsPerCohort} resolved candidates in every band. Weekday review requires {report.minimumWeekdayOccurrences} occurrences and the same candidate count for every weekday. Passing only opens manual held-out review.</p><p className="mt-2 font-mono text-[8px] text-data">Production changed: no</p></div>
  </div>;
}

function ContractComparabilityPanel({ report }: { report: ContractComparabilityReport }) {
  return <div className="space-y-3">
    <div className="rounded-lg border border-warn/20 bg-warn/[.03] p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[10px] font-medium">Venue target integrity · observation only</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{report.comparison.reason} Kraken path averages are proxies for venue oracles, never substituted outcomes or trading inputs.</p></div><Badge variant="outline" className="font-mono">{report.comparison.comparability}</Badge></div><p className="mt-2 font-mono text-[8px] text-data">Production changed: no</p></div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Rule metadata</p><p className="mt-1 font-mono text-lg">{report.metadataContracts}/{report.totalContracts}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Paired windows</p><p className="mt-1 font-mono text-lg">{report.pairedOutcomeWindows}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Venue disagreements</p><p className="mt-1 font-mono text-lg">{report.venueOutcomeDisagreements}/{report.pairedOutcomeAssetWindows}</p><p className="text-[8px] text-muted-foreground">asset-windows</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Window alignment</p><p className="mt-1 font-mono text-lg">{report.comparison.settlementWindowAligned === null ? 'unknown' : report.comparison.settlementWindowAligned ? 'aligned' : 'different'}</p></div></div>
    <div className="grid gap-3 sm:grid-cols-2">{report.venues.map((venue) => <div key={venue.venue} className="rounded-lg border p-3"><div className="flex items-center justify-between"><p className="text-[10px] font-medium capitalize">{venue.venue}</p><Badge variant="outline" className="font-mono">{venue.resolvedWindows}w</Badge></div><div className="mt-3 grid grid-cols-2 gap-3"><div><p className="text-[8px] uppercase text-muted-foreground">Kraken/reference drift</p><p className="mt-1 font-mono text-sm">{venue.meanAbsoluteReferenceDriftPercent === null ? '—' : `${venue.meanAbsoluteReferenceDriftPercent.toFixed(4)}% abs`}</p><p className="text-[8px] text-muted-foreground">{venue.directReferenceDriftSamples} direct samples</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Proxy outcome agreement</p><p className="mt-1 font-mono text-sm">{venue.proxyOutcomeAgreement === null ? '—' : `${(venue.proxyOutcomeAgreement * 100).toFixed(1)}%`}</p><p className="text-[8px] text-muted-foreground">{venue.proxyOutcomeSamples} asset-windows</p></div></div></div>)}</div>
    {report.recent.length > 0 && <details className="rounded-lg border"><summary className="cursor-pointer px-3 py-2 text-[9px] font-medium">Recent reference/path comparisons ({report.recent.length})</summary><div className="divide-y border-t">{report.recent.map((row) => <div key={row.id} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-[9px]"><div><span className="font-medium">{row.symbol} · {row.venue}</span><span className="ml-2 font-mono text-muted-foreground">{row.settlementPriceMethod} · {row.settlementWindowSeconds ?? '—'}s</span><p className="text-[8px] text-muted-foreground">{new Date(row.closesAt).toLocaleString()} · {row.referenceDriftPercent === undefined ? 'venue reference unpublished' : `Kraken reference drift ${row.referenceDriftPercent >= 0 ? '+' : ''}${row.referenceDriftPercent.toFixed(4)}%`}</p></div><div className="text-right font-mono text-[8px]"><p>{row.proxyOutcome ?? '—'} proxy / {row.venueOutcome ?? '—'} venue</p><p className="text-muted-foreground">{row.proxyAgreed === undefined ? 'pending' : row.proxyAgreed ? 'agreed' : 'disagreed'}</p></div></div>)}</div></details>}
  </div>;
}

function WalkForwardPanel({ history, eligibility, ledger = [] }: { history: WalkForwardEvaluationHistory; eligibility?: PromotionEligibility; ledger?: ModelPromotionEntry[] }) {
  const latest = history.runs.at(-1);
  // Whether this run actually changed production is a fact of the promotion ledger, never an assumption.
  const citedBy = latest ? ledger.filter((entry) => entry.evidenceRunId === latest.id) : [];
  return <div className="space-y-3">
    <div className="rounded-lg border border-data/15 bg-data/[.03] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-medium">Automatic expanding-window evaluation</p><p className="mt-1 text-[9px] text-muted-foreground">Activates at {history.activationWindows} independent windows and repeats every {history.checkpointEveryWindows}. Evaluation is automatic; production promotion is always explicit.</p></div><Badge variant="outline" className="font-mono">next {history.nextCheckpointWindows}w</Badge></div>
    </div>
    {!latest ? <div className="grid h-36 place-items-center rounded-lg border border-dashed text-center"><div><Clock3 className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs">Evaluator dormant</p><p className="mt-1 text-[10px] text-muted-foreground">{history.currentWindows}/{history.activationWindows} independent windows collected. The first run starts automatically at the gate.</p></div></div>
      : <><div className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-medium">Latest checkpoint · {latest.checkpointWindows} windows</p><p className="mt-0.5 font-mono text-[8px] text-muted-foreground">{latest.datasetFingerprint} · {new Date(latest.generatedAt).toLocaleString()}</p></div><Badge variant="outline" className={latest.decision === 'candidate_passed_review_thresholds' ? 'border-data/25 text-data' : 'text-muted-foreground'}>{latest.decision.replaceAll('_', ' ')}</Badge></div><p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">{latest.reason}</p><p className="mt-1 font-mono text-[8px] text-muted-foreground">Replay inputs: {latest.exactReplayObservations} exact · {latest.reconstructedReplayObservations} historical reconstruction · max baseline error {latest.maximumBaselineReplayError.toExponential(2)}</p><p className={cn('mt-2 text-[9px] font-medium', citedBy.length ? 'text-data' : 'text-warn')}>{citedBy.length
        ? `Production changed: ${citedBy.map((entry) => `${entry.action} ${entry.modelVersion}`).join(', ')}`
        : 'Production changed: no'}</p></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Baseline return</p><p className="mt-1 font-mono text-lg">{cents(latest.baseline.meanWindowReturn)}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Candidate return</p><p className={cn('mt-1 font-mono text-lg', latest.candidate.meanWindowReturn > latest.baseline.meanWindowReturn ? 'text-gain' : 'text-loss')}>{cents(latest.candidate.meanWindowReturn)}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Positive folds</p><p className="mt-1 font-mono text-lg">{latest.positiveCandidateFolds}/{latest.folds.length}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Beat baseline</p><p className="mt-1 font-mono text-lg">{latest.candidateBeatBaselineFolds}/{latest.folds.length}</p></div></div>
      <div className="overflow-hidden rounded-lg border"><div className="grid grid-cols-[36px_1fr_54px_64px_64px] gap-2 border-b bg-background/60 px-3 py-2 font-mono text-[8px] uppercase text-muted-foreground"><span>Fold</span><span>Train → test</span><span className="text-right">Trades</span><span className="text-right">Base</span><span className="text-right">Candidate</span></div><div className="divide-y">{latest.folds.map((fold) => <div key={fold.index} className="grid grid-cols-[36px_1fr_54px_64px_64px] gap-2 px-3 py-2 text-[9px]"><span>{fold.index}</span><span className="font-mono text-muted-foreground">{fold.trainingWindows}w → {fold.testingWindows}w</span><span className="text-right font-mono">{fold.candidate.trades}</span><span className="text-right font-mono">{cents(fold.baseline.meanWindowReturn)}</span><span className={cn('text-right font-mono', fold.candidate.meanWindowReturn > fold.baseline.meanWindowReturn ? 'text-gain' : 'text-loss')}>{cents(fold.candidate.meanWindowReturn)}</span></div>)}</div></div>
      {eligibility && <div className={cn('rounded-lg border p-3', eligibility.eligible ? 'border-data/25 bg-data/[.03]' : 'border-warn/20 bg-warn/[.03]')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-[10px] font-medium">Promotion eligibility</p><p className="mt-0.5 text-[9px] text-muted-foreground">Stricter than the evaluator&rsquo;s own review decision, and never automatic: this states only whether the run may be cited to change production.</p></div>
          <Badge variant="outline" className={eligibility.eligible ? 'border-data/25 text-data' : 'border-warn/30 text-warn'}>{eligibility.eligible ? 'may be cited' : 'not citable'}</Badge>
        </div>
        <div className="mt-2 divide-y rounded-md border">{eligibility.criteria.map((criterion) => <div key={criterion.id} className="flex items-start justify-between gap-3 px-2.5 py-1.5 text-[9px]">
          <span className="text-muted-foreground">{criterion.detail}</span>
          {criterion.met ? <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-data"/> : <XCircle className="mt-0.5 size-3 shrink-0 text-warn"/>}
        </div>)}</div>
      </div>}
      <p className="font-mono text-[8px] text-muted-foreground">Recommended for review only: temperature {latest.recommendedParameters.temperature} · basis weight {latest.recommendedParameters.basisWeight} · volatility ×{latest.recommendedParameters.volatilityScale} · slow tilt ×{latest.recommendedParameters.slowTiltScale} · cap {(latest.recommendedParameters.probabilityCap * 100).toFixed(0)}–{((1 - latest.recommendedParameters.probabilityCap) * 100).toFixed(0)}% · edge ≥{(latest.recommendedParameters.minimumEdge * 100).toFixed(0)}pp · quality ≥{(latest.recommendedParameters.minimumQuality * 100).toFixed(0)}%</p></>}
    {history.runs.length > 1 && <div className="rounded-lg border p-3"><p className="text-[9px] font-medium">Versioned history</p><div className="mt-2 flex flex-wrap gap-1.5">{[...history.runs].reverse().map((run) => <Badge key={run.id} variant="outline" className="font-mono">{run.checkpointWindows}w · {run.decision === 'candidate_passed_review_thresholds' ? 'review' : 'baseline'}</Badge>)}</div></div>}
  </div>;
}

function SliceTable({ title, rows }: { title: string; rows: PerformanceSlice[] }) {
  return <div className="overflow-hidden rounded-lg border"><div className="border-b bg-background/50 px-3 py-2 text-[10px] font-medium">{title}</div>{rows.length ? <div className="divide-y">{rows.map((row) => <div key={row.label} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-3 py-2.5 text-[10px]"><span>{row.label}</span><span className="font-mono text-muted-foreground">{row.correct}/{row.resolved}</span><span className={cn('w-12 text-right font-mono', row.accuracy >= 0.6 ? 'text-gain' : row.accuracy < 0.5 ? 'text-loss' : '')}>{(row.accuracy * 100).toFixed(0)}%</span></div>)}</div> : <p className="p-4 text-center text-[10px] text-muted-foreground">Waiting for resolved outcomes</p>}</div>;
}

/**
 * One dialog for both audiences. `publicView` changes the endpoint and drops the live trade record,
 * maker-execution report, target-integrity registry report, and worker-local prospective policy/calendar evaluations. Everything else — calibration,
 * benchmarks, segments, cycle regimes, walk-forward evaluations, and the full signal history — scores
 * the forecast rather than real money and is identical for both.
 */
/**
 * A missing shard rollup does not fail loudly: the lifetime summary is still produced, just from fewer
 * shards. Under-reporting a lifetime figure silently is worse than showing a degraded dashboard, so the
 * only real protection is saying so where the figures are read.
 */
function DegradedStorageNotice({ storage }: { storage: { missingRollups: number; shards: number; reason: string } }) {
  return <div className="mb-3 rounded-lg border border-warn/30 bg-warn/[.04] p-3">
    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warn">
      <AlertTriangle className="size-3"/>Lifetime figures are incomplete
    </p>
    <p className="mt-1 text-[10px] leading-relaxed text-warn/90">
      {storage.reason} Every figure below is missing those rows. Re-run <span className="font-mono">npm run verify:forecast-storage</span> to rebuild them.
    </p>
  </div>;
}


/**
 * Funding history for both tracks, in one table because they answer the same question.
 *
 * A generation is opened by a different act per track — reconfiguring the trading control for live, a
 * bankroll reset for paper — and closing one restarts its P&L without erasing what it did. The realized
 * column is the whole-cent budget view, which is the one that reconciles with a generation's starting
 * balance; the exact reporting view lives in the track records above and legitimately differs.
 *
 * The live half is passed empty on the public view rather than merely absent from the payload: a
 * surface that publishes real-money fundings only because an endpoint happened not to return them is
 * one endpoint change away from leaking. The paper half is public by design.
 */
function FundingHistory({ live, paper }: { live: EpochResult[]; paper: EpochResult[] }) {
  const rows = [...live.map((epoch) => ({ epoch, mode: 'live' as const })), ...paper.map((epoch) => ({ epoch, mode: 'paper' as const }))];
  if (!rows.length) return null;
  return <div className="mt-4 rounded-lg border">
    <div className="border-b px-3 py-2">
      <h3 className="text-xs font-semibold">Funding history</h3>
      <p className="mt-0.5 text-[9px] text-muted-foreground">Every funding of each budget. Live is funded by reconfiguring the control, paper by resetting the bankroll. Realized is the whole-cent budget view and includes any bankroll correction, so it reconciles with that funding&apos;s starting balance. It will not equal the exact realized figure in the record above, which reports what the orders themselves recorded.</p>
    </div>
    <div className="overflow-x-auto"><table className="w-full min-w-[38rem] text-[10px]">
      <thead className="text-muted-foreground"><tr className="border-b">
        <th className="px-3 py-1.5 text-left font-medium">Track</th>
        <th className="px-3 py-1.5 text-left font-medium">Funding</th>
        <th className="px-3 py-1.5 text-right font-medium">Trades</th>
        <th className="px-3 py-1.5 text-right font-medium">Settled</th>
        <th className="px-3 py-1.5 text-right font-medium">Staked</th>
        <th className="px-3 py-1.5 text-right font-medium">Realized</th>
      </tr></thead>
      <tbody>{rows.map(({ epoch, mode }) => <tr key={`${mode}:${epoch.epochId}`} className="border-b last:border-0">
        <td className="px-3 py-1.5"><Badge variant="outline" className={cn('h-4 px-1.5 text-[8px] uppercase', mode === 'live' ? 'border-live/30 text-live' : 'border-primary/25 text-primary')}>{mode}</Badge></td>
        <td className="px-3 py-1.5"><span className="font-mono">{epoch.firstAt ? new Date(epoch.firstAt).toLocaleDateString() : '—'}</span>{epoch.current && <span className="ml-1.5 text-[8px] uppercase text-data">current</span>}<p className="truncate font-mono text-[8px] text-muted-foreground" title={epoch.epochId}>{epoch.epochId}</p></td>
        <td className="px-3 py-1.5 text-right font-mono">{epoch.trades}</td>
        <td className="px-3 py-1.5 text-right font-mono">{epoch.settled}</td>
        <td className="px-3 py-1.5 text-right font-mono">{usd.format(epoch.stakedCents / 100)}</td>
        <td className={cn('px-3 py-1.5 text-right font-mono', epoch.budgetPnlCents > 0 ? 'text-gain' : epoch.budgetPnlCents < 0 ? 'text-loss' : '')}>{usd.format(epoch.budgetPnlCents / 100)}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}

export function PerformanceDialog({ publicView = false }: { publicView?: boolean }) {
  const [data, setData] = useState<{ summary: PerformanceSummary; forecasts: ForecastHistoryRow[]; paperRecord?: TradeTrackRecord; liveRecord?: TradeTrackRecord; cyclePaths?: CyclePathReport; contractComparability?: ContractComparabilityReport; makerFillReport?: MakerFillReport; persistenceCandidate?: PersistenceCandidateReport; calendarEvaluation?: CalendarEvaluationReport; modelEvaluations?: WalkForwardEvaluationHistory; promotionEligibility?: PromotionEligibility; promotionLedger?: ModelPromotionEntry[]; paperProviderRecords?: ProviderTradeRecord[]; liveProviderRecords?: ProviderTradeRecord[]; liveEpochs?: EpochResult[]; paperEpochs?: EpochResult[]; durable?: boolean; generatedAt?: string; forecastStorage?: { layout: string; openRows: number; sealedRows: number; shards: number; missingRollups: number; degraded: boolean; reason: string } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch(publicView ? '/api/paper-performance' : '/api/performance', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load history');
      setData(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load history'); }
    finally { setLoading(false); }
  }

  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild><Button variant="outline" size="sm"><BarChart3/> Full track record</Button></DialogTrigger>
    <DialogContent className="max-w-4xl p-0">
      <DialogHeader className="border-b p-5 pr-12"><DialogTitle>Positive-edge performance</DialogTitle><DialogDescription>{publicView ? 'Immutable qualifying calculations and the simulated paper track, grouped without excluding losses or pending outcomes.' : 'Immutable qualifying calculations, grouped without excluding losses or pending outcomes.'}</DialogDescription></DialogHeader>
      <div className="p-5">
        {loading && !data ? <div className="grid h-64 place-items-center"><Loader2 className="animate-spin text-muted-foreground"/></div> : error ? <p className="rounded-lg border border-loss/20 bg-loss/5 p-3 text-xs text-loss">{error}</p> : data && <>{publicView && (data.durable === false ? <StaleProjectionNotice/> : <PublishedStamp generatedAt={data.generatedAt}/>)}{!publicView && data.forecastStorage?.degraded && <DegradedStorageNotice storage={data.forecastStorage}/>}<SampleWarning summary={data.summary}/><CalibrationStatus summary={data.summary}/><MissedBuyPanel summary={data.summary}/><Tabs defaultValue="breakdown">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-0.5"><TabsTrigger value="trades">Trades</TabsTrigger>{!publicView && <><TabsTrigger value="policy-candidate">Policy candidate</TabsTrigger><TabsTrigger value="calendar">Calendar</TabsTrigger><TabsTrigger value="targets">Target integrity</TabsTrigger><TabsTrigger value="walk-forward">Walk-forward</TabsTrigger><TabsTrigger value="maker">Maker execution</TabsTrigger></>}<TabsTrigger value="breakdown">Signal quality</TabsTrigger><TabsTrigger value="benchmarks">Benchmarks</TabsTrigger><TabsTrigger value="segments">Segments</TabsTrigger><TabsTrigger value="regimes">Cycle regimes</TabsTrigger><TabsTrigger value="history">Signal history ({data.forecasts.length})</TabsTrigger></TabsList>
          <TabsContent value="trades">
            <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">{publicView ? 'Executed simulated trades only, taken from the paper order ledger. These include modelled fill prices and venue fees, so they answer what the shadow bankroll did — not how good the forecast looked.' : 'Executed trades only, taken from the order ledger, with paper and live kept completely separate. These include real fill prices and venue fees, so they answer what the money did — not how good the forecast looked.'}</p>
            <div className="space-y-3">
              {/* The public endpoint already omits live data, but the render boundary enforces the same
                  rule independently so a stale or widened response can never add a live card. */}
              {!publicView && data.liveRecord && <div><TradeRecordCard record={data.liveRecord}/><ProviderRecordRows records={data.liveProviderRecords ?? []} label="Live"/></div>}
              <FundingHistory live={publicView ? [] : data.liveEpochs ?? []} paper={data.paperEpochs ?? []}/>
              {data.paperRecord && <div><TradeRecordCard record={data.paperRecord}/><ProviderRecordRows records={data.paperProviderRecords ?? []} label="Paper"/></div>}
            </div>
          </TabsContent>
          <TabsContent value="breakdown">
            <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">Forecast quality across every qualifying calculation, independent of whether it became a trade. Use the Trades tab for realized money.</p>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5"><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Resolved updates</p><p className="mt-1 font-mono text-xl">{data.summary.resolved}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Update accuracy</p><p className="mt-1 font-mono text-xl">{data.summary.accuracy === null ? '—' : `${(data.summary.accuracy * 100).toFixed(1)}%`}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Cycle-balanced</p><p className="mt-1 font-mono text-xl">{data.summary.cycleBalancedAccuracy === null ? '—' : `${(data.summary.cycleBalancedAccuracy * 100).toFixed(1)}%`}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Brier</p><p className="mt-1 font-mono text-xl">{data.summary.brierScore?.toFixed(3) ?? '—'}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Log loss</p><p className="mt-1 font-mono text-xl">{data.summary.logLoss?.toFixed(3) ?? '—'}</p></div></div>
            <div className="mb-3"><div className="mb-2 flex items-center justify-between"><p className="text-[10px] font-medium">Accuracy over time</p><div className="flex gap-3 text-[9px] text-muted-foreground"><span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-foreground"/>Cumulative</span><span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-data"/>Rolling 25</span></div></div><PerformanceChart data={data.summary.timeline}/></div>
            <div className="grid gap-3 sm:grid-cols-2"><SliceTable title="By asset" rows={data.summary.byAsset}/><SliceTable title="By direction" rows={data.summary.byDirection}/><SliceTable title="By confidence" rows={data.summary.byConfidenceBucket}/><SliceTable title="By model version" rows={data.summary.byModelVersion}/></div>
          </TabsContent>
          <TabsContent value="benchmarks">
            <div className="mb-3 rounded-lg border border-data/15 bg-data/[.03] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] font-medium">Did claimed edge actually pay?</p><span className="font-mono text-[9px] text-muted-foreground">{data.summary.realizedEdgeTrades} settled buys · {data.summary.resolvedWindows} window{data.summary.resolvedWindows === 1 ? '' : 's'}</span></div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div><p className="text-[8px] uppercase text-muted-foreground">Mean predicted edge</p><p className="mt-0.5 font-mono text-lg">{data.summary.meanPredictedEdge === null ? '—' : `${data.summary.meanPredictedEdge >= 0 ? '+' : ''}${(data.summary.meanPredictedEdge * 100).toFixed(1)}pp`}</p></div>
                <div><p className="text-[8px] uppercase text-muted-foreground">Mean realized return</p><p className={cn('mt-0.5 font-mono text-lg', (data.summary.meanRealizedReturn ?? 0) > 0 ? 'text-gain' : (data.summary.meanRealizedReturn ?? 0) < 0 ? 'text-loss' : '')}>{data.summary.meanRealizedReturn === null ? '—' : `${data.summary.meanRealizedReturn >= 0 ? '+' : ''}${(data.summary.meanRealizedReturn * 100).toFixed(1)}¢/$1`}</p></div>
                <div><p className="text-[8px] uppercase text-muted-foreground">Edge realized</p><p className="mt-0.5 font-mono text-lg">{data.summary.meanPredictedEdge && data.summary.meanRealizedReturn !== null ? `${(data.summary.meanRealizedReturn / data.summary.meanPredictedEdge * 100).toFixed(0)}%` : '—'}</p></div>
              </div>
              {data.summary.edgeBuckets.length > 0 && <div className="mt-3 overflow-hidden rounded-lg border bg-background/40"><div className="grid grid-cols-[1fr_50px_70px_80px_60px] gap-2 border-b px-3 py-1.5 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><span>Predicted edge</span><span className="text-right">n</span><span className="text-right">Predicted</span><span className="text-right">Realized</span><span className="text-right">Win</span></div><div className="divide-y">{data.summary.edgeBuckets.map((bucket) => <div key={bucket.label} className="grid grid-cols-[1fr_50px_70px_80px_60px] gap-2 px-3 py-1.5 text-[10px]"><span>{bucket.label}</span><span className="text-right font-mono text-muted-foreground">{bucket.trades}</span><span className="text-right font-mono">{(bucket.predictedEdge * 100).toFixed(1)}pp</span><span className={cn('text-right font-mono', bucket.realizedReturn > 0 ? 'text-gain' : 'text-loss')}>{bucket.realizedReturn >= 0 ? '+' : ''}{(bucket.realizedReturn * 100).toFixed(1)}¢</span><span className="text-right font-mono text-muted-foreground">{(bucket.winRate * 100).toFixed(0)}%</span></div>)}</div></div>}
              <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">Realized return is cash per $1 staked at the modelled entry, net of estimated venue fees. Predicted edge that does not convert into realized return means the estimate is not beating the price, regardless of how accurate it looks.</p>
            </div>
            <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">Scored only on the positive-edge buys the desk took ({data.summary.resolvedCalculations} settled across {data.summary.resolvedWindows} settlement window{data.summary.resolvedWindows === 1 ? '' : 's'}). On those same contracts, a model that cannot beat the venue price it paid has no demonstrated edge. Non-qualifying calculations are still recorded for future calibration work but are excluded from this track record.</p>
            <div className="overflow-hidden rounded-lg border">
              <div className="grid grid-cols-[1fr_60px_70px_70px_70px] gap-2 border-b bg-background/60 px-3 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><span>Forecaster</span><span className="text-right">n</span><span className="text-right">Accuracy</span><span className="text-right">Brier</span><span className="text-right">Log loss</span></div>
              <div className="divide-y">{data.summary.benchmarks.map((row) => {
                const best = Math.min(...data.summary.benchmarks.map((item) => item.brierScore ?? Infinity));
                const leader = row.brierScore !== null && row.brierScore === best;
                return <div key={row.label} className={cn('grid grid-cols-[1fr_60px_70px_70px_70px] gap-2 px-3 py-2.5 text-[10px]', leader && 'bg-data/[.04]')}>
                  <span className={cn('font-medium', leader && 'text-data')}>{row.label}{leader ? ' · best' : ''}</span>
                  <span className="text-right font-mono text-muted-foreground">{row.resolved}</span>
                  <span className="text-right font-mono">{row.accuracy === null ? '—' : `${(row.accuracy * 100).toFixed(1)}%`}</span>
                  <span className="text-right font-mono">{row.brierScore?.toFixed(3) ?? '—'}</span>
                  <span className="text-right font-mono">{row.logLoss?.toFixed(3) ?? '—'}</span>
                </div>;
              })}</div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="overflow-hidden rounded-lg border"><div className="border-b bg-background/60 px-3 py-2 text-[10px] font-medium">Accuracy by time to settlement</div><div className="divide-y">{data.summary.byLeadTime.map((row) => <div key={row.label} className="grid grid-cols-[1fr_50px_60px_60px] gap-2 px-3 py-2 text-[10px]"><span>{row.label}</span><span className="text-right font-mono text-muted-foreground">{row.resolved}</span><span className="text-right font-mono">{(row.accuracy * 100).toFixed(1)}%</span><span className="text-right font-mono text-muted-foreground">{row.brierScore?.toFixed(3) ?? '—'}</span></div>)}</div></div>
              <div className="overflow-hidden rounded-lg border"><div className="border-b bg-background/60 px-3 py-2 text-[10px] font-medium">Calibration · forecast vs observed</div><div className="divide-y">{data.summary.calibrationBins.map((row) => <div key={row.label} className="grid grid-cols-[1fr_50px_60px_60px] gap-2 px-3 py-2 text-[10px]"><span>{row.label}</span><span className="text-right font-mono text-muted-foreground">{row.resolved}</span><span className="text-right font-mono">{(row.meanForecast * 100).toFixed(0)}%</span><span className={cn('text-right font-mono', Math.abs(row.meanForecast - row.observedRate) > 0.12 ? 'text-warn' : 'text-data')}>{(row.observedRate * 100).toFixed(0)}%</span></div>)}</div></div>
            </div>
            <p className="mt-2 text-[9px] text-muted-foreground">Calibration compares the mean forecast in each bin against how often UP actually occurred. Values that drift apart indicate systematic over- or under-confidence.</p>
          </TabsContent>
          <TabsContent value="segments">
            <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">Realized cash return per $1 staked, broken down by conditions observable before the trade. This is edge discovery: rather than assuming the model beats the venue, it looks for the specific conditions where buys actually paid. Statistics are clustered by settlement window — <span className="font-mono">n</span> counts windows, not trades — because trades inside one window share the same market move. A row is only highlighted once it has at least 5 windows and clears two standard errors; everything else is noise.</p>
            {data.summary.segments.length ? <div className="grid gap-3 sm:grid-cols-2">{data.summary.segments.map((group) => <SegmentTable key={group.dimension} group={group}/>)}</div>
              : <div className="grid h-40 place-items-center rounded-lg border border-dashed text-center"><div><BarChart3 className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs">No settled buys to segment yet</p><p className="mt-1 text-[10px] text-muted-foreground">Segments appear once positive-edge buys begin resolving.</p></div></div>}
          </TabsContent>
          <TabsContent value="regimes">
            <div className="mb-3 rounded-lg border border-warn/20 bg-warn/[.03] p-3"><p className="text-[10px] font-medium text-warn">Observation only — not a trading input</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">These aligned 15-second paths measure sign reversals, lag-one autocorrelation, trend efficiency, range, and cycle-local volatility. They are persisted with forecast snapshots for independent-window validation but do not alter probability, estimate quality, ranking, or execution.</p></div>
            {data.cyclePaths ? <><div className="mb-3 grid grid-cols-3 gap-2"><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Cycles recorded</p><p className="mt-1 font-mono text-xl">{data.cyclePaths.totalCycles}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Completed</p><p className="mt-1 font-mono text-xl">{data.cyclePaths.completedCycles}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Path points</p><p className="mt-1 font-mono text-xl">{data.cyclePaths.totalPoints}</p></div></div><div className="overflow-hidden rounded-lg border"><div className="grid grid-cols-[58px_1fr_54px_54px_54px_62px] gap-2 border-b bg-background/60 px-3 py-2 font-mono text-[8px] uppercase text-muted-foreground"><span>Asset</span><span>Regime</span><span className="text-right">points</span><span className="text-right">flips</span><span className="text-right">eff.</span><span className="text-right">σ15m</span></div><div className="divide-y">{data.cyclePaths.latestByAsset.map((item) => <div key={item.symbol} className="grid grid-cols-[58px_1fr_54px_54px_54px_62px] gap-2 px-3 py-2 text-[10px]"><span className="font-semibold">{item.symbol}</span><span className="text-muted-foreground">{item.features.regime}</span><span className="text-right font-mono">{item.features.observationCount}</span><span className="text-right font-mono">{item.features.signFlipRate === null ? '—' : item.features.signFlipRate.toFixed(2)}</span><span className="text-right font-mono">{item.features.trendEfficiency === null ? '—' : item.features.trendEfficiency.toFixed(2)}</span><span className="text-right font-mono">{item.features.localVolatility15mPercent === null ? '—' : `${item.features.localVolatility15mPercent.toFixed(2)}%`}</span></div>)}</div></div><p className="mt-2 font-mono text-[8px] text-muted-foreground">Policy {data.cyclePaths.policyVersion}</p></> : <div className="grid h-32 place-items-center rounded-lg border border-dashed text-[10px] text-muted-foreground">Waiting for aligned path observations.</div>}

          </TabsContent>
          {!publicView && <TabsContent value="maker">{data.makerFillReport ? <MakerExecutionPanel report={data.makerFillReport}/> : <div className="grid h-32 place-items-center rounded-lg border border-dashed text-[10px] text-muted-foreground">Waiting for live maker attempts.</div>}</TabsContent>}
          {!publicView && data.persistenceCandidate && <TabsContent value="policy-candidate"><PersistenceCandidatePanel report={data.persistenceCandidate}/></TabsContent>}
          {!publicView && data.calendarEvaluation && <TabsContent value="calendar"><CalendarEvaluationPanel report={data.calendarEvaluation}/></TabsContent>}
          {!publicView && data.contractComparability && <TabsContent value="targets"><ContractComparabilityPanel report={data.contractComparability}/></TabsContent>}
          {!publicView && data.modelEvaluations && <TabsContent value="walk-forward"><WalkForwardPanel history={data.modelEvaluations} eligibility={data.promotionEligibility} ledger={data.promotionLedger}/></TabsContent>}
          <TabsContent value="history"><div className="max-h-[55vh] overflow-y-auto rounded-lg border">{data.forecasts.length ? <div className="divide-y">{data.forecasts.map((forecast) => <div key={forecast.id} className="grid gap-3 p-3.5 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center"><div className="min-w-0"><div className="flex items-center gap-2"><span className="text-xs font-semibold">{forecast.symbol}</span><Badge variant="outline" className="font-mono">{forecast.direction}</Badge><span className="font-mono text-[10px] text-muted-foreground">{Math.round(forecast.directionalLikelihood * 100)}%</span></div><p className="mt-1 truncate text-[9px] text-muted-foreground">Issued {new Date(forecast.issuedAt).toLocaleString()} · {forecast.modelVersion} · {forecast.policyVersion}</p></div><div className="text-left sm:text-right"><p className="text-[9px] text-muted-foreground">Confidence</p><p className="font-mono text-xs">{Math.round(forecast.confidence * 100)}%</p></div><div className="text-left sm:text-right"><p className="text-[9px] text-muted-foreground">Outcome</p><p className="font-mono text-xs">{forecast.outcome ?? 'Pending'}</p></div><div>{forecast.status === 'pending' ? <Badge variant="secondary" className="gap-1"><Clock3/> pending</Badge> : forecast.correct ? <Badge className="gap-1 border-gain/20 bg-gain/10 text-gain"><CheckCircle2/> correct</Badge> : forecast.status === 'invalid' ? <Badge variant="outline">invalid</Badge> : <Badge className="gap-1 border-loss/20 bg-loss/10 text-loss"><XCircle/> incorrect</Badge>}</div></div>)}</div> : <div className="grid h-44 place-items-center text-center"><div><BarChart3 className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs">No positive-edge buys yet</p><p className="mt-1 text-[10px] text-muted-foreground">History begins when a {DATA_FRESHNESS.observationBucketMs / 1000}-second update clears the {Math.round(MIN_NET_EDGE * 100)}pp net-of-fees edge and {Math.round(MIN_ESTIMATE_QUALITY * 100)}% estimate-quality thresholds.</p></div></div>}</div></TabsContent>
        </Tabs></>}
      </div>
    </DialogContent>
  </Dialog>;
}
