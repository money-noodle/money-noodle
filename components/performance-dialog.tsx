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
import type { CyclePathReport, ForecastHistoryRow, MakerFillReport, PerformanceSlice, PerformanceSummary, SegmentGroup, TradeTrackRecord, WalkForwardEvaluationHistory } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Every metric in this dialog is unreadable until enough independent settlement windows exist.
 * Update counts run into the hundreds within minutes, which reads like a large sample when it is not.
 */
function SampleWarning({ summary }: { summary: PerformanceSummary }) {
  if (summary.evaluationMeaningful) return null;
  return <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3">
    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-200"/>
    <div>
      <p className="text-xs font-medium text-amber-100">Not enough settled cycles to mean anything yet</p>
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
  return <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3">
    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-200"/>
    <div>
      <p className="text-xs font-medium text-amber-100">Waiting for the worker&rsquo;s first published snapshot</p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">The paper track record is scored on the persistent Money Noodle worker and replicated here for reading. This dashboard has not received a snapshot yet, so the figures below are empty rather than zero.</p>
    </div>
  </div>;
}

function CalibrationStatus({ summary }: { summary: PerformanceSummary }) {
  return <div className={cn('mb-4 rounded-lg border p-3', summary.calibrationReady ? 'border-primary/20 bg-primary/[.03]' : 'border-amber-300/20 bg-amber-300/[.03]')}>
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
      return <div key={segment.label} className={cn('grid grid-cols-[1fr_44px_44px_62px_78px] gap-2 px-3 py-1.5 text-[10px]', credible && segment.meanRealizedReturn > 0 && 'bg-primary/[.05]')}>
        <span className="truncate" title={segment.label}>{segment.label}</span>
        <span className="text-right font-mono text-muted-foreground" title={`${segment.trades} trades across ${segment.windows} settlement windows`}>{segment.windows}w</span>
        <span className="text-right font-mono text-muted-foreground">{(segment.winRate * 100).toFixed(0)}%</span>
        <span className="text-right font-mono text-muted-foreground">{cents(segment.meanPredictedEdge)}</span>
        <span className={cn('text-right font-mono', !credible ? 'text-muted-foreground' : segment.meanRealizedReturn > 0 ? 'text-primary' : 'text-red-400')}>
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
  return <div className="mb-3 rounded-xl border border-amber-300/25 bg-amber-300/[.035] p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-xs font-semibold">Missed-good-buy monitor · observation only</h3><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{report.description}</p></div><Badge variant="outline" className="font-mono">{report.windows} window{report.windows === 1 ? '' : 's'}</Badge></div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Rejected candidates</p><p className="mt-0.5 font-mono text-base">{report.candidates}</p></div><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Profitable after fact</p><p className="mt-0.5 font-mono text-base">{report.profitableCandidates}/{report.candidates}</p></div><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Clustered return</p><p className={cn('mt-0.5 font-mono text-base', (report.meanCandidateReturn ?? 0) > 0 ? 'text-primary' : (report.meanCandidateReturn ?? 0) < 0 ? 'text-red-400' : '')}>{report.meanCandidateReturn === null ? '—' : `${report.meanCandidateReturn >= 0 ? '+' : ''}${(report.meanCandidateReturn * 100).toFixed(1)}%`}</p></div><div className="rounded-lg bg-background/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Best/window</p><p className={cn('mt-0.5 font-mono text-base', bestPositive ? 'text-primary' : 'text-red-400')}>{report.bestPerWindowMeanReturn === null ? '—' : `${report.bestPerWindowMeanReturn >= 0 ? '+' : ''}${(report.bestPerWindowMeanReturn * 100).toFixed(1)}%`}</p></div></div>
    <p className="mt-3 text-[9px] leading-relaxed text-muted-foreground">Each asset uses the snapshot nearest five minutes to settlement; “best/window” selects the largest apparent rejected edge in each correlated settlement timestamp. A later profitable outcome is hindsight, not evidence to weaken the 55% gate. Promotion requires sustained positive fee-aware return across independent windows, including unseen data.</p>
  </div>;
}

function TradeRecordCard({ record }: { record: TradeTrackRecord }) {
  const live = record.mode === 'live';
  const credible = record.windows >= 5 && record.standardError !== null && Math.abs(record.meanRealizedReturn ?? 0) > 2 * record.standardError;
  return <div className={cn('rounded-xl border p-4', live ? 'border-red-400/25 bg-red-400/[.03]' : 'border-primary/20 bg-primary/[.02]')}>
    <div className="flex items-center justify-between gap-2">
      <div><h3 className={cn('text-xs font-semibold', live && 'text-red-200')}>{live ? 'Live trades · real money' : 'Paper trades · simulated shadow'}</h3>
        <p className="mt-0.5 text-[9px] text-muted-foreground">{record.settled} settled across {record.windows} settlement window{record.windows === 1 ? '' : 's'}{record.pending ? ` · ${record.pending} open` : ''}{record.sold ? ` · ${record.sold} sold` : ''}{record.unfilled ? ` · ${record.unfilled} unfilled` : ''}{record.rejected ? ` · ${record.rejected} rejected` : ''}{record.switchesEvaluated ? ` · ${record.switchesEvaluated} switch counterfactual${record.switchesEvaluated === 1 ? '' : 's'}` : ''}</p></div>
      <Badge variant="outline" className={cn('uppercase', live ? 'border-red-400/30 text-red-300' : 'border-primary/25 text-primary')}>{record.mode}</Badge>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Realized P&amp;L</p><p className={cn('mt-0.5 font-mono text-base', record.realizedPnlCents > 0 ? 'text-primary' : record.realizedPnlCents < 0 ? 'text-red-400' : '')}>{usd.format(record.realizedPnlCents / 100)}</p></div>
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Return on stake</p><p className={cn('mt-0.5 font-mono text-base', (record.roi ?? 0) > 0 ? 'text-primary' : (record.roi ?? 0) < 0 ? 'text-red-400' : '')}>{record.roi === null ? '—' : `${record.roi >= 0 ? '+' : ''}${(record.roi * 100).toFixed(1)}%`}</p></div>
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Win rate</p><p className="mt-0.5 font-mono text-base">{record.winRate === null ? '—' : `${(record.winRate * 100).toFixed(0)}%`}<span className="ml-1 text-[9px] text-muted-foreground">{record.wins}W {record.losses}L</span></p></div>
      <div className="rounded-lg bg-secondary/40 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Staked</p><p className="mt-0.5 font-mono text-base">{usd.format(record.stakedCents / 100)}</p></div>
    </div>
    <div className="mt-3 rounded-lg border bg-background/40 p-3">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Predicted vs realized edge</p>
      <p className="mt-1 font-mono text-[11px]">{record.meanPredictedEdge === null ? '—' : `${(record.meanPredictedEdge * 100).toFixed(1)}pp predicted`} <span className="text-muted-foreground">→</span> <span className={cn(!credible ? 'text-muted-foreground' : (record.meanRealizedReturn ?? 0) > 0 ? 'text-primary' : 'text-red-400')}>{record.meanRealizedReturn === null ? '—' : `${record.meanRealizedReturn >= 0 ? '+' : ''}${(record.meanRealizedReturn * 100).toFixed(1)}¢ realized`}</span>{record.standardError !== null && <span className="text-[9px] text-muted-foreground"> ±{(record.standardError * 100).toFixed(1)}</span>}</p>
      <p className="mt-1 text-[9px] text-muted-foreground">{credible ? 'Clears two standard errors across independent windows.' : 'Not yet distinguishable from noise — needs at least 5 settlement windows.'}</p>
    </div>
    {record.switchesEvaluated > 0 && <div className="mt-3 rounded-lg border bg-background/40 p-3"><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Switch versus hold counterfactual</p><p className={cn('mt-1 font-mono text-sm', (record.meanSwitchVsHoldCents ?? 0) > 0 ? 'text-primary' : 'text-red-400')}>{record.meanSwitchVsHoldCents === null ? '—' : `${record.meanSwitchVsHoldCents >= 0 ? '+' : ''}${record.meanSwitchVsHoldCents.toFixed(2)}¢`} <span className="text-[9px] text-muted-foreground">mean incremental P&amp;L across {record.switchesEvaluated}</span></p></div>}
    {record.standaloneExitsEvaluated > 0 && <div className="mt-3 rounded-lg border bg-background/40 p-3"><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Standalone exit versus hold</p><p className={cn('mt-1 font-mono text-sm', (record.standaloneExitVsHoldCents ?? 0) > 0 ? 'text-primary' : 'text-red-400')}>{record.standaloneExitVsHoldCents === null ? '—' : `${record.standaloneExitVsHoldCents >= 0 ? '+' : ''}${record.standaloneExitVsHoldCents.toFixed(2)}¢`} <span className="text-[9px] text-muted-foreground">total · {record.meanStandaloneExitVsHoldCents === null ? '—' : `${record.meanStandaloneExitVsHoldCents >= 0 ? '+' : ''}${record.meanStandaloneExitVsHoldCents.toFixed(2)}¢ mean`} across {record.standaloneExitsEvaluated}</span></p></div>}
    {record.principalRecoveryExitsEvaluated > 0 && <div className="mt-3 rounded-lg border bg-background/40 p-3"><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Principal-recovery shadow versus full exit</p><p className={cn('mt-1 font-mono text-sm', (record.principalRecoveryVsFullExitCents ?? 0) > 0 ? 'text-primary' : 'text-red-400')}>{record.principalRecoveryVsFullExitCents === null ? '—' : `${record.principalRecoveryVsFullExitCents >= 0 ? '+' : ''}${record.principalRecoveryVsFullExitCents.toFixed(2)}¢`} <span className="text-[9px] text-muted-foreground">counterfactual total across {record.principalRecoveryExitsEvaluated}; observation only</span></p></div>}
    {record.segments.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">{record.segments.map((segmentGroup) => <SegmentTable key={segmentGroup.dimension} group={segmentGroup}/>)}</div>}
  </div>;
}

const rate = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(0)}%`;
const signedRate = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;

function MakerExecutionPanel({ report }: { report: MakerFillReport }) {
  return <div className="mt-3 space-y-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[10px] font-medium">Maker execution and adverse-selection funnel</p><p className="mt-0.5 text-[9px] text-muted-foreground">Maker remains live. Strict taker recommendations are shadow-only until their resolved counterfactual return supports explicit activation.</p></div><Badge variant="outline" className="font-mono">{report.submittedAttempts} submitted</Badge></div>
    <div className="rounded-md border border-primary/15 bg-primary/[.03] p-2.5"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[9px] font-medium">Adaptive maker/taker shadow</p><p className="text-[8px] text-muted-foreground">{report.adaptiveExecution.policyVersion} · marketable IOC limits are price-capped and disabled live in maker mode</p></div><Badge variant="outline" className="font-mono">{report.adaptiveExecution.takerRecommendations}/{report.adaptiveExecution.shadowEvaluations} taker</Badge></div><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><p className="text-[8px] uppercase text-muted-foreground">Resolved shadows</p><p className="font-mono text-sm">{report.adaptiveExecution.resolvedTakerRecommendations}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Taker counterfactual</p><p className={cn('font-mono text-sm', (report.adaptiveExecution.meanTakerCounterfactualReturn ?? 0) > 0 ? 'text-primary' : report.adaptiveExecution.meanTakerCounterfactualReturn === null ? '' : 'text-red-400')}>{report.adaptiveExecution.meanTakerCounterfactualReturn === null ? '—' : `${report.adaptiveExecution.meanTakerCounterfactualReturn >= 0 ? '+' : ''}${(report.adaptiveExecution.meanTakerCounterfactualReturn * 100).toFixed(1)}%`}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Actual takers</p><p className="font-mono text-sm">{report.adaptiveExecution.actualTakerFills}/{report.adaptiveExecution.actualTakerOrders}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Actual return</p><p className="font-mono text-sm">{report.adaptiveExecution.meanActualTakerReturn === null ? '—' : `${report.adaptiveExecution.meanActualTakerReturn >= 0 ? '+' : ''}${(report.adaptiveExecution.meanActualTakerReturn * 100).toFixed(1)}%`}</p></div></div></div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Accepted</p><p className="font-mono text-base">{report.acceptedAttempts}/{report.submittedAttempts}</p><p className="text-[8px] text-muted-foreground">{rate(report.acceptanceRate)}</p></div>
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Filled | accepted</p><p className="font-mono text-base">{report.partialFills + report.completeFills}/{report.acceptedAttempts}</p><p className="text-[8px] text-muted-foreground">{rate(report.fillRateGivenAcceptance)}</p></div>
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Post-only races</p><p className="font-mono text-base">{report.postOnlyRaces}</p><p className="text-[8px] text-muted-foreground">never entered queue</p></div>
      <div className="rounded-md bg-secondary/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Fill shape</p><p className="font-mono text-base">{report.completeFills} full · {report.partialFills} partial</p><p className="text-[8px] text-muted-foreground">{report.restedNoFillAttempts} rested no fill</p></div>
    </div>
    <div className="rounded-md border bg-background/40 p-2.5"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[9px] font-medium">Settlement adverse selection</p><p className="text-[8px] text-muted-foreground">Filled positions versus the counterfactual result of accepted orders that did not fill.</p></div><span className={cn('font-mono text-sm', (report.pairedWinRateGap ?? report.adverseSelectionWinRateGap ?? 0) < 0 ? 'text-red-400' : 'text-primary')}>{signedRate(report.pairedWinRateGap ?? report.adverseSelectionWinRateGap)}{report.pairedWinRateGapStandardError !== null ? <span className="text-[8px] text-muted-foreground"> ±{(report.pairedWinRateGapStandardError * 100).toFixed(1)}</span> : null}</span></div><div className="mt-2 grid grid-cols-2 gap-2"><div><p className="text-[8px] uppercase text-muted-foreground">Filled cohort</p><p className="font-mono text-sm">win {rate(report.filledWinRate)} · return {report.meanFilledReturn === null ? '—' : `${report.meanFilledReturn >= 0 ? '+' : ''}${(report.meanFilledReturn * 100).toFixed(1)}%`}</p><p className="text-[8px] text-muted-foreground">{report.resolvedFilledAttempts} attempts · {report.resolvedFilledWindows} windows</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Accepted, no fill</p><p className="font-mono text-sm">win {rate(report.acceptedNoFillCounterfactualWinRate)} · return {report.meanAcceptedNoFillCounterfactualReturn === null ? '—' : `${report.meanAcceptedNoFillCounterfactualReturn >= 0 ? '+' : ''}${(report.meanAcceptedNoFillCounterfactualReturn * 100).toFixed(1)}%`}</p><p className="text-[8px] text-muted-foreground">{report.resolvedAcceptedNoFillAttempts} attempts · {report.resolvedAcceptedNoFillWindows} windows</p></div></div><p className="mt-2 text-[8px] leading-relaxed text-muted-foreground">The headline gap is paired within the same settlement window when possible ({report.pairedAdverseSelectionWindows} paired windows); ± is its window-clustered standard error. A negative gap means filled orders won less often than accepted non-fills on their purchased side. Raw cohorts remain descriptive, and none of this changes execution.</p></div>
    <div className="rounded-md border"><div className="border-b px-2 py-1.5 text-[9px] font-medium">First-passage proxy · accepted orders only</div><div className="grid grid-cols-2 gap-2 p-2"><div><p className="text-[8px] uppercase text-muted-foreground">Mean predicted touch</p><p className="font-mono text-sm">{rate(report.meanPredictedProbability)}</p></div><div><p className="text-[8px] uppercase text-muted-foreground">Observed queue fills</p><p className="font-mono text-sm">{report.fills}/{report.attempts} · {rate(report.observedFillRate)}</p></div></div>{report.buckets.length > 0 && <div className="divide-y border-t">{report.buckets.map((bucket) => <div key={bucket.label} className="grid grid-cols-[1fr_60px_70px] gap-2 px-2 py-1.5 text-[9px]"><span>{bucket.label} · {bucket.attempts} accepted</span><span className="text-right font-mono">touch {(bucket.meanPredictedProbability * 100).toFixed(0)}%</span><span className="text-right font-mono">fill {(bucket.observedFillRate * 100).toFixed(0)}%</span></div>)}</div>}</div>
    {report.segments.length > 0 && <details className="rounded-md border"><summary className="cursor-pointer px-2 py-2 text-[9px] font-medium">Execution segments ({report.segments.length})</summary><div className="divide-y border-t">{report.segments.map((segment) => <div key={`${segment.dimension}:${segment.label}`} className="grid grid-cols-[1fr_48px_48px_58px_62px] gap-2 px-2 py-1.5 text-[8px]"><span>{segment.dimension} · {segment.label}</span><span className="text-right font-mono">{segment.accepted}/{segment.submitted} acc</span><span className="text-right font-mono">{segment.fills} fill</span><span className="text-right font-mono">win {rate(segment.filledWinRate)}</span><span className="text-right font-mono">{segment.meanFilledReturn === null ? '—' : `${segment.meanFilledReturn >= 0 ? '+' : ''}${(segment.meanFilledReturn * 100).toFixed(0)}%`}</span></div>)}</div></details>}
  </div>;
}

function WalkForwardPanel({ history }: { history: WalkForwardEvaluationHistory }) {
  const latest = history.runs.at(-1);
  return <div className="space-y-3">
    <div className="rounded-lg border border-primary/15 bg-primary/[.03] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-medium">Automatic expanding-window evaluation</p><p className="mt-1 text-[9px] text-muted-foreground">Activates at {history.activationWindows} independent windows and repeats every {history.checkpointEveryWindows}. Evaluation is automatic; production promotion is always explicit.</p></div><Badge variant="outline" className="font-mono">next {history.nextCheckpointWindows}w</Badge></div>
    </div>
    {!latest ? <div className="grid h-36 place-items-center rounded-lg border border-dashed text-center"><div><Clock3 className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs">Evaluator dormant</p><p className="mt-1 text-[10px] text-muted-foreground">{history.currentWindows}/{history.activationWindows} independent windows collected. The first run starts automatically at the gate.</p></div></div>
      : <><div className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-[10px] font-medium">Latest checkpoint · {latest.checkpointWindows} windows</p><p className="mt-0.5 font-mono text-[8px] text-muted-foreground">{latest.datasetFingerprint} · {new Date(latest.generatedAt).toLocaleString()}</p></div><Badge variant="outline" className={latest.decision === 'candidate_passed_review_thresholds' ? 'border-primary/25 text-primary' : 'text-muted-foreground'}>{latest.decision.replaceAll('_', ' ')}</Badge></div><p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">{latest.reason}</p><p className="mt-1 font-mono text-[8px] text-muted-foreground">Replay inputs: {latest.exactReplayObservations} exact · {latest.reconstructedReplayObservations} historical reconstruction · max baseline error {latest.maximumBaselineReplayError.toExponential(2)}</p><p className="mt-2 text-[9px] font-medium text-amber-100">Production changed: no</p></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Baseline return</p><p className="mt-1 font-mono text-lg">{cents(latest.baseline.meanWindowReturn)}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Candidate return</p><p className={cn('mt-1 font-mono text-lg', latest.candidate.meanWindowReturn > latest.baseline.meanWindowReturn ? 'text-primary' : 'text-red-400')}>{cents(latest.candidate.meanWindowReturn)}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Positive folds</p><p className="mt-1 font-mono text-lg">{latest.positiveCandidateFolds}/{latest.folds.length}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Beat baseline</p><p className="mt-1 font-mono text-lg">{latest.candidateBeatBaselineFolds}/{latest.folds.length}</p></div></div>
      <div className="overflow-hidden rounded-lg border"><div className="grid grid-cols-[36px_1fr_54px_64px_64px] gap-2 border-b bg-background/60 px-3 py-2 font-mono text-[8px] uppercase text-muted-foreground"><span>Fold</span><span>Train → test</span><span className="text-right">Trades</span><span className="text-right">Base</span><span className="text-right">Candidate</span></div><div className="divide-y">{latest.folds.map((fold) => <div key={fold.index} className="grid grid-cols-[36px_1fr_54px_64px_64px] gap-2 px-3 py-2 text-[9px]"><span>{fold.index}</span><span className="font-mono text-muted-foreground">{fold.trainingWindows}w → {fold.testingWindows}w</span><span className="text-right font-mono">{fold.candidate.trades}</span><span className="text-right font-mono">{cents(fold.baseline.meanWindowReturn)}</span><span className={cn('text-right font-mono', fold.candidate.meanWindowReturn > fold.baseline.meanWindowReturn ? 'text-primary' : 'text-red-400')}>{cents(fold.candidate.meanWindowReturn)}</span></div>)}</div></div>
      <p className="font-mono text-[8px] text-muted-foreground">Recommended for review only: temperature {latest.recommendedParameters.temperature} · basis weight {latest.recommendedParameters.basisWeight} · volatility ×{latest.recommendedParameters.volatilityScale} · slow tilt ×{latest.recommendedParameters.slowTiltScale} · cap {(latest.recommendedParameters.probabilityCap * 100).toFixed(0)}–{((1 - latest.recommendedParameters.probabilityCap) * 100).toFixed(0)}% · edge ≥{(latest.recommendedParameters.minimumEdge * 100).toFixed(0)}pp · quality ≥{(latest.recommendedParameters.minimumQuality * 100).toFixed(0)}%</p></>}
    {history.runs.length > 1 && <div className="rounded-lg border p-3"><p className="text-[9px] font-medium">Versioned history</p><div className="mt-2 flex flex-wrap gap-1.5">{[...history.runs].reverse().map((run) => <Badge key={run.id} variant="outline" className="font-mono">{run.checkpointWindows}w · {run.decision === 'candidate_passed_review_thresholds' ? 'review' : 'baseline'}</Badge>)}</div></div>}
  </div>;
}

function SliceTable({ title, rows }: { title: string; rows: PerformanceSlice[] }) {
  return <div className="overflow-hidden rounded-lg border"><div className="border-b bg-background/50 px-3 py-2 text-[10px] font-medium">{title}</div>{rows.length ? <div className="divide-y">{rows.map((row) => <div key={row.label} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-3 py-2.5 text-[10px]"><span>{row.label}</span><span className="font-mono text-muted-foreground">{row.correct}/{row.resolved}</span><span className={cn('w-12 text-right font-mono', row.accuracy >= 0.6 ? 'text-primary' : row.accuracy < 0.5 ? 'text-red-400' : '')}>{(row.accuracy * 100).toFixed(0)}%</span></div>)}</div> : <p className="p-4 text-center text-[10px] text-muted-foreground">Waiting for resolved outcomes</p>}</div>;
}

/**
 * One dialog for both audiences. The public payload is the signed one minus its two live surfaces, so
 * `publicView` changes the endpoint and drops the live trade record and the maker-execution tab, which
 * is built exclusively from live Kalshi orders. Everything else — calibration, benchmarks, segments,
 * cycle regimes, walk-forward evaluations, and the full signal history — scores the forecast rather than
 * real money and is identical for both.
 */
export function PerformanceDialog({ publicView = false }: { publicView?: boolean }) {
  const [data, setData] = useState<{ summary: PerformanceSummary; forecasts: ForecastHistoryRow[]; paperRecord?: TradeTrackRecord; liveRecord?: TradeTrackRecord; cyclePaths?: CyclePathReport; makerFillReport?: MakerFillReport; modelEvaluations: WalkForwardEvaluationHistory; durable?: boolean } | null>(null);
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
      <DialogHeader className="border-b p-5 pr-12"><DialogTitle>Positive-edge performance</DialogTitle><DialogDescription>{publicView ? 'Immutable qualifying calculations and the simulated paper track, grouped without excluding losses or pending outcomes. Live results require sign-in.' : 'Immutable qualifying calculations, grouped without excluding losses or pending outcomes.'}</DialogDescription></DialogHeader>
      <div className="p-5">
        {loading && !data ? <div className="grid h-64 place-items-center"><Loader2 className="animate-spin text-muted-foreground"/></div> : error ? <p className="rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{error}</p> : data && <>{publicView && data.durable === false && <StaleProjectionNotice/>}<SampleWarning summary={data.summary}/><CalibrationStatus summary={data.summary}/><MissedBuyPanel summary={data.summary}/><Tabs defaultValue="breakdown">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-0.5"><TabsTrigger value="trades">Trades</TabsTrigger><TabsTrigger value="walk-forward">Walk-forward</TabsTrigger>{!publicView && <TabsTrigger value="maker">Maker execution</TabsTrigger>}<TabsTrigger value="breakdown">Signal quality</TabsTrigger><TabsTrigger value="benchmarks">Benchmarks</TabsTrigger><TabsTrigger value="segments">Segments</TabsTrigger><TabsTrigger value="regimes">Cycle regimes</TabsTrigger><TabsTrigger value="history">Signal history ({data.forecasts.length})</TabsTrigger></TabsList>
          <TabsContent value="trades">
            <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">{publicView ? 'Executed simulated trades only, taken from the paper order ledger. These include modelled fill prices and venue fees, so they answer what the shadow bankroll did — not how good the forecast looked.' : 'Executed trades only, taken from the order ledger, with paper and live kept completely separate. These include real fill prices and venue fees, so they answer what the money did — not how good the forecast looked.'}</p>
            <div className="space-y-3">{data.liveRecord && <TradeRecordCard record={data.liveRecord}/>}{data.paperRecord && <TradeRecordCard record={data.paperRecord}/>}</div>
          </TabsContent>
          <TabsContent value="breakdown">
            <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">Forecast quality across every qualifying calculation, independent of whether it became a trade. Use the Trades tab for realized money.</p>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5"><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Resolved updates</p><p className="mt-1 font-mono text-xl">{data.summary.resolved}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Update accuracy</p><p className="mt-1 font-mono text-xl">{data.summary.accuracy === null ? '—' : `${(data.summary.accuracy * 100).toFixed(1)}%`}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Cycle-balanced</p><p className="mt-1 font-mono text-xl">{data.summary.cycleBalancedAccuracy === null ? '—' : `${(data.summary.cycleBalancedAccuracy * 100).toFixed(1)}%`}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Brier</p><p className="mt-1 font-mono text-xl">{data.summary.brierScore?.toFixed(3) ?? '—'}</p></div><div className="rounded-lg border p-3"><p className="text-[9px] text-muted-foreground">Log loss</p><p className="mt-1 font-mono text-xl">{data.summary.logLoss?.toFixed(3) ?? '—'}</p></div></div>
            <div className="mb-3"><div className="mb-2 flex items-center justify-between"><p className="text-[10px] font-medium">Accuracy over time</p><div className="flex gap-3 text-[9px] text-muted-foreground"><span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-foreground"/>Cumulative</span><span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-primary"/>Rolling 25</span></div></div><PerformanceChart data={data.summary.timeline}/></div>
            <div className="grid gap-3 sm:grid-cols-2"><SliceTable title="By asset" rows={data.summary.byAsset}/><SliceTable title="By direction" rows={data.summary.byDirection}/><SliceTable title="By confidence" rows={data.summary.byConfidenceBucket}/><SliceTable title="By model version" rows={data.summary.byModelVersion}/></div>
          </TabsContent>
          <TabsContent value="benchmarks">
            <div className="mb-3 rounded-lg border border-primary/15 bg-primary/[.03] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] font-medium">Did claimed edge actually pay?</p><span className="font-mono text-[9px] text-muted-foreground">{data.summary.realizedEdgeTrades} settled buys · {data.summary.resolvedWindows} window{data.summary.resolvedWindows === 1 ? '' : 's'}</span></div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div><p className="text-[8px] uppercase text-muted-foreground">Mean predicted edge</p><p className="mt-0.5 font-mono text-lg">{data.summary.meanPredictedEdge === null ? '—' : `${data.summary.meanPredictedEdge >= 0 ? '+' : ''}${(data.summary.meanPredictedEdge * 100).toFixed(1)}pp`}</p></div>
                <div><p className="text-[8px] uppercase text-muted-foreground">Mean realized return</p><p className={cn('mt-0.5 font-mono text-lg', (data.summary.meanRealizedReturn ?? 0) > 0 ? 'text-primary' : (data.summary.meanRealizedReturn ?? 0) < 0 ? 'text-red-400' : '')}>{data.summary.meanRealizedReturn === null ? '—' : `${data.summary.meanRealizedReturn >= 0 ? '+' : ''}${(data.summary.meanRealizedReturn * 100).toFixed(1)}¢/$1`}</p></div>
                <div><p className="text-[8px] uppercase text-muted-foreground">Edge realized</p><p className="mt-0.5 font-mono text-lg">{data.summary.meanPredictedEdge && data.summary.meanRealizedReturn !== null ? `${(data.summary.meanRealizedReturn / data.summary.meanPredictedEdge * 100).toFixed(0)}%` : '—'}</p></div>
              </div>
              {data.summary.edgeBuckets.length > 0 && <div className="mt-3 overflow-hidden rounded-lg border bg-background/40"><div className="grid grid-cols-[1fr_50px_70px_80px_60px] gap-2 border-b px-3 py-1.5 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><span>Predicted edge</span><span className="text-right">n</span><span className="text-right">Predicted</span><span className="text-right">Realized</span><span className="text-right">Win</span></div><div className="divide-y">{data.summary.edgeBuckets.map((bucket) => <div key={bucket.label} className="grid grid-cols-[1fr_50px_70px_80px_60px] gap-2 px-3 py-1.5 text-[10px]"><span>{bucket.label}</span><span className="text-right font-mono text-muted-foreground">{bucket.trades}</span><span className="text-right font-mono">{(bucket.predictedEdge * 100).toFixed(1)}pp</span><span className={cn('text-right font-mono', bucket.realizedReturn > 0 ? 'text-primary' : 'text-red-400')}>{bucket.realizedReturn >= 0 ? '+' : ''}{(bucket.realizedReturn * 100).toFixed(1)}¢</span><span className="text-right font-mono text-muted-foreground">{(bucket.winRate * 100).toFixed(0)}%</span></div>)}</div></div>}
              <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">Realized return is cash per $1 staked at the modelled entry, net of estimated venue fees. Predicted edge that does not convert into realized return means the estimate is not beating the price, regardless of how accurate it looks.</p>
            </div>
            <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">Scored only on the positive-edge buys the desk took ({data.summary.resolvedCalculations} settled across {data.summary.resolvedWindows} settlement window{data.summary.resolvedWindows === 1 ? '' : 's'}). On those same contracts, a model that cannot beat the venue price it paid has no demonstrated edge. Non-qualifying calculations are still recorded for future calibration work but are excluded from this track record.</p>
            <div className="overflow-hidden rounded-lg border">
              <div className="grid grid-cols-[1fr_60px_70px_70px_70px] gap-2 border-b bg-background/60 px-3 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground"><span>Forecaster</span><span className="text-right">n</span><span className="text-right">Accuracy</span><span className="text-right">Brier</span><span className="text-right">Log loss</span></div>
              <div className="divide-y">{data.summary.benchmarks.map((row) => {
                const best = Math.min(...data.summary.benchmarks.map((item) => item.brierScore ?? Infinity));
                const leader = row.brierScore !== null && row.brierScore === best;
                return <div key={row.label} className={cn('grid grid-cols-[1fr_60px_70px_70px_70px] gap-2 px-3 py-2.5 text-[10px]', leader && 'bg-primary/[.04]')}>
                  <span className={cn('font-medium', leader && 'text-primary')}>{row.label}{leader ? ' · best' : ''}</span>
                  <span className="text-right font-mono text-muted-foreground">{row.resolved}</span>
                  <span className="text-right font-mono">{row.accuracy === null ? '—' : `${(row.accuracy * 100).toFixed(1)}%`}</span>
                  <span className="text-right font-mono">{row.brierScore?.toFixed(3) ?? '—'}</span>
                  <span className="text-right font-mono">{row.logLoss?.toFixed(3) ?? '—'}</span>
                </div>;
              })}</div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="overflow-hidden rounded-lg border"><div className="border-b bg-background/60 px-3 py-2 text-[10px] font-medium">Accuracy by time to settlement</div><div className="divide-y">{data.summary.byLeadTime.map((row) => <div key={row.label} className="grid grid-cols-[1fr_50px_60px_60px] gap-2 px-3 py-2 text-[10px]"><span>{row.label}</span><span className="text-right font-mono text-muted-foreground">{row.resolved}</span><span className="text-right font-mono">{(row.accuracy * 100).toFixed(1)}%</span><span className="text-right font-mono text-muted-foreground">{row.brierScore?.toFixed(3) ?? '—'}</span></div>)}</div></div>
              <div className="overflow-hidden rounded-lg border"><div className="border-b bg-background/60 px-3 py-2 text-[10px] font-medium">Calibration · forecast vs observed</div><div className="divide-y">{data.summary.calibrationBins.map((row) => <div key={row.label} className="grid grid-cols-[1fr_50px_60px_60px] gap-2 px-3 py-2 text-[10px]"><span>{row.label}</span><span className="text-right font-mono text-muted-foreground">{row.resolved}</span><span className="text-right font-mono">{(row.meanForecast * 100).toFixed(0)}%</span><span className={cn('text-right font-mono', Math.abs(row.meanForecast - row.observedRate) > 0.12 ? 'text-red-400' : 'text-primary')}>{(row.observedRate * 100).toFixed(0)}%</span></div>)}</div></div>
            </div>
            <p className="mt-2 text-[9px] text-muted-foreground">Calibration compares the mean forecast in each bin against how often UP actually occurred. Values that drift apart indicate systematic over- or under-confidence.</p>
          </TabsContent>
          <TabsContent value="segments">
            <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">Realized cash return per $1 staked, broken down by conditions observable before the trade. This is edge discovery: rather than assuming the model beats the venue, it looks for the specific conditions where buys actually paid. Statistics are clustered by settlement window — <span className="font-mono">n</span> counts windows, not trades — because trades inside one window share the same market move. A row is only highlighted once it has at least 5 windows and clears two standard errors; everything else is noise.</p>
            {data.summary.segments.length ? <div className="grid gap-3 sm:grid-cols-2">{data.summary.segments.map((group) => <SegmentTable key={group.dimension} group={group}/>)}</div>
              : <div className="grid h-40 place-items-center rounded-lg border border-dashed text-center"><div><BarChart3 className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs">No settled buys to segment yet</p><p className="mt-1 text-[10px] text-muted-foreground">Segments appear once positive-edge buys begin resolving.</p></div></div>}
          </TabsContent>
          <TabsContent value="regimes">
            <div className="mb-3 rounded-lg border border-amber-300/20 bg-amber-300/[.03] p-3"><p className="text-[10px] font-medium text-amber-100">Observation only — not a trading input</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">These aligned 15-second paths measure sign reversals, lag-one autocorrelation, trend efficiency, range, and cycle-local volatility. They are persisted with forecast snapshots for independent-window validation but do not alter probability, estimate quality, ranking, or execution.</p></div>
            {data.cyclePaths ? <><div className="mb-3 grid grid-cols-3 gap-2"><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Cycles recorded</p><p className="mt-1 font-mono text-xl">{data.cyclePaths.totalCycles}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Completed</p><p className="mt-1 font-mono text-xl">{data.cyclePaths.completedCycles}</p></div><div className="rounded-lg border p-3"><p className="text-[8px] uppercase text-muted-foreground">Path points</p><p className="mt-1 font-mono text-xl">{data.cyclePaths.totalPoints}</p></div></div><div className="overflow-hidden rounded-lg border"><div className="grid grid-cols-[58px_1fr_54px_54px_54px_62px] gap-2 border-b bg-background/60 px-3 py-2 font-mono text-[8px] uppercase text-muted-foreground"><span>Asset</span><span>Regime</span><span className="text-right">points</span><span className="text-right">flips</span><span className="text-right">eff.</span><span className="text-right">σ15m</span></div><div className="divide-y">{data.cyclePaths.latestByAsset.map((item) => <div key={item.symbol} className="grid grid-cols-[58px_1fr_54px_54px_54px_62px] gap-2 px-3 py-2 text-[10px]"><span className="font-semibold">{item.symbol}</span><span className="text-muted-foreground">{item.features.regime}</span><span className="text-right font-mono">{item.features.observationCount}</span><span className="text-right font-mono">{item.features.signFlipRate === null ? '—' : item.features.signFlipRate.toFixed(2)}</span><span className="text-right font-mono">{item.features.trendEfficiency === null ? '—' : item.features.trendEfficiency.toFixed(2)}</span><span className="text-right font-mono">{item.features.localVolatility15mPercent === null ? '—' : `${item.features.localVolatility15mPercent.toFixed(2)}%`}</span></div>)}</div></div><p className="mt-2 font-mono text-[8px] text-muted-foreground">Policy {data.cyclePaths.policyVersion}</p></> : <div className="grid h-32 place-items-center rounded-lg border border-dashed text-[10px] text-muted-foreground">Waiting for aligned path observations.</div>}

          </TabsContent>
          {!publicView && <TabsContent value="maker">{data.makerFillReport ? <MakerExecutionPanel report={data.makerFillReport}/> : <div className="grid h-32 place-items-center rounded-lg border border-dashed text-[10px] text-muted-foreground">Waiting for live maker attempts.</div>}</TabsContent>}
          <TabsContent value="walk-forward"><WalkForwardPanel history={data.modelEvaluations}/></TabsContent>
          <TabsContent value="history"><div className="max-h-[55vh] overflow-y-auto rounded-lg border">{data.forecasts.length ? <div className="divide-y">{data.forecasts.map((forecast) => <div key={forecast.id} className="grid gap-3 p-3.5 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center"><div className="min-w-0"><div className="flex items-center gap-2"><span className="text-xs font-semibold">{forecast.symbol}</span><Badge variant="outline" className="font-mono">{forecast.direction}</Badge><span className="font-mono text-[10px] text-muted-foreground">{Math.round(forecast.directionalLikelihood * 100)}%</span></div><p className="mt-1 truncate text-[9px] text-muted-foreground">Issued {new Date(forecast.issuedAt).toLocaleString()} · {forecast.modelVersion} · {forecast.policyVersion}</p></div><div className="text-left sm:text-right"><p className="text-[9px] text-muted-foreground">Confidence</p><p className="font-mono text-xs">{Math.round(forecast.confidence * 100)}%</p></div><div className="text-left sm:text-right"><p className="text-[9px] text-muted-foreground">Outcome</p><p className="font-mono text-xs">{forecast.outcome ?? 'Pending'}</p></div><div>{forecast.status === 'pending' ? <Badge variant="secondary" className="gap-1"><Clock3/> pending</Badge> : forecast.correct ? <Badge className="gap-1 border-primary/20 bg-primary/10 text-primary"><CheckCircle2/> correct</Badge> : forecast.status === 'invalid' ? <Badge variant="outline">invalid</Badge> : <Badge className="gap-1 border-red-400/20 bg-red-400/10 text-red-400"><XCircle/> incorrect</Badge>}</div></div>)}</div> : <div className="grid h-44 place-items-center text-center"><div><BarChart3 className="mx-auto size-5 text-muted-foreground"/><p className="mt-2 text-xs">No positive-edge buys yet</p><p className="mt-1 text-[10px] text-muted-foreground">History begins when a {DATA_FRESHNESS.observationBucketMs / 1000}-second update clears the {Math.round(MIN_NET_EDGE * 100)}pp net-of-fees edge and {Math.round(MIN_ESTIMATE_QUALITY * 100)}% estimate-quality thresholds.</p></div></div>}</div></TabsContent>
        </Tabs></>}
      </div>
    </DialogContent>
  </Dialog>;
}
