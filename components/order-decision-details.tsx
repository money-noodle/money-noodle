'use client';

import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { PaperOrder } from '@/lib/types';
import { cn } from '@/lib/utils';

const percent = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const points = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
const cents = (value: number) => `${value.toFixed(2)}¢`;

export function OrderDecisionDetails({ order, defaultOpen = false }: { order: PaperOrder; defaultOpen?: boolean }) {
  const snapshot = order.entryDecision;
  const selectedProbability = snapshot?.selectedSideProbability ?? (order.side === 'UP' ? order.modelProbabilityUp : 1 - order.modelProbabilityUp);
  const feeRate = snapshot?.feeRate ?? ((order.actualFeeCents ?? order.feeCents) / Math.max(1, order.potentialPayoutCents));
  const decisionAsk = snapshot?.actionableAsk ?? order.askPrice;
  const netEdge = snapshot?.netEdge ?? selectedProbability - decisionAsk - feeRate;
  const spread = snapshot?.spread ?? order.spread;
  const basis = snapshot?.basis;
  const settlement = snapshot?.settlementAverageEstimate ?? order.settlementAverageEstimate;
  const execution = order.entryExecutionDecision;

  return <details open={defaultOpen} className="group mt-2 rounded-md border bg-background/35">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 marker:content-none">
      <span className="text-[9px] font-medium">Edge-buy decision and calculations</span>
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={cn('h-4 px-1.5 font-mono text-[8px]', netEdge >= 0.05 ? 'border-primary/25 text-primary' : 'text-muted-foreground')}>{points(netEdge)} edge</Badge>
        <ChevronDown className="size-3 text-muted-foreground transition-transform group-open:rotate-180"/>
      </div>
    </summary>
    <div className="space-y-2 border-t p-2.5">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <DecisionValue label={`P(${order.side})`} value={percent(selectedProbability)} emphasis/>
        <DecisionValue label="Actionable ask" value={percent(decisionAsk)}/>
        <DecisionValue label="Estimated fee" value={percent(feeRate)}/>
        <DecisionValue label="Net edge" value={points(netEdge)} emphasis={netEdge >= 0.05}/>
        <DecisionValue label="Estimate quality" value={percent(snapshot?.confidence ?? order.confidence)}/>
        <DecisionValue label="Spread" value={points(spread).replace('pp', '¢')}/>
        <DecisionValue label="Evidence" value={snapshot ? `${snapshot.qualifyingSnapshots} snapshots` : 'legacy order'}/>
        <DecisionValue label="Median edge" value={snapshot?.medianNetEdge === null || snapshot?.medianNetEdge === undefined ? '—' : points(snapshot.medianNetEdge)}/>
      </div>

      <div className="rounded-md border p-2">
        <div className="flex flex-wrap items-center justify-between gap-1"><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Decision identity</p><span className="font-mono text-[8px] text-muted-foreground">{snapshot?.version ?? 'legacy reconstruction'}</span></div>
        <p className="mt-1 break-all font-mono text-[8px] text-muted-foreground">{snapshot?.policyVersion ?? 'Policy version was not persisted'} · calculated {new Date(snapshot?.calculationAt ?? order.calculationAt).toLocaleString()}</p>
        {snapshot && <p className="mt-1 font-mono text-[8px] text-muted-foreground">P(UP) {percent(snapshot.probabilityUp)} · P(DOWN) {percent(snapshot.probabilityDown)} · {snapshot.secondsRemaining.toFixed(0)}s remaining</p>}
      </div>

      {basis && <div className="rounded-md border p-2">
        <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Contract-basis calculation</p>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[8px] sm:grid-cols-4">
          <span>reference {basis.referencePrice}</span><span>current {basis.currentPrice}</span>
          <span>basis {basis.basisPercent >= 0 ? '+' : ''}{basis.basisPercent.toFixed(4)}%</span><span>z {basis.zScore.toFixed(3)}</span>
          <span>σ {basis.standardDeviationPercent.toFixed(4)}%</span><span>{basis.volatilitySamples} vol samples</span>
          <span>basis P(UP) {percent(basis.probabilityUp)}</span><span>{basis.secondsRemaining.toFixed(0)}s left</span>
        </div>
        <p className="mt-1 text-[8px] text-muted-foreground">{basis.referenceSource}</p>
      </div>}

      {settlement && <div className="rounded-md border p-2">
        <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Settlement-average observation</p>
        <p className="mt-1 font-mono text-[8px]">P(UP) {percent(settlement.probabilityUp)} · expected {settlement.expectedAveragePrice} · σ {settlement.standardDeviationPercent.toFixed(4)}% · {settlement.method}</p>
        <p className="mt-1 text-[8px] text-muted-foreground">Observation-only at entry; it did not authorize the buy.</p>
      </div>}

      {!!snapshot?.factors.length && <details className="rounded-md border">
        <summary className="cursor-pointer list-none px-2 py-1.5 text-[8px] font-medium">Forecast factors ({snapshot.factors.length})</summary>
        <p className="border-t px-2 py-1.5 text-[7px] leading-relaxed text-muted-foreground">Factor details are the issuance display snapshot. The prediction-market factor is a benchmark and was excluded from tradeable P(UP), P(DOWN), and edge.</p>
        <div className="divide-y border-t">{snapshot.factors.map((factor) => <div key={factor.id} className="p-2">
          <div className="flex items-center justify-between gap-2"><span className="text-[9px] font-medium">{factor.label}</span><span className="font-mono text-[8px]">{factor.contribution >= 0 ? '+' : ''}{factor.contribution.toFixed(2)}pp · w {factor.weight.toFixed(2)} · q {percent(factor.confidence, 0)}</span></div>
          <p className="mt-0.5 text-[8px] text-muted-foreground">{factor.summary}</p>
          <p className="mt-0.5 text-[8px] leading-relaxed text-muted-foreground/80">{factor.detail}</p>
          <p className="mt-0.5 font-mono text-[7px] text-muted-foreground">{factor.source}</p>
        </div>)}</div>
      </details>}

      {execution && <div className="rounded-md border p-2">
        <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Execution decision</p>
        <p className="mt-1 text-[8px] leading-relaxed">{execution.reason}</p>
        <p className="mt-1 font-mono text-[8px] text-muted-foreground">executed {execution.executedStyle} · recommended {execution.recommendedStyle} · taker edge {points(execution.takerNetEdge)} · maker edge {points(execution.makerNetEdge)} · fill cohort {execution.makerCohort} ({execution.makerSamples})</p>
      </div>}

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <DecisionValue label="Submitted limit" value={percent(order.askPrice)}/>
        <DecisionValue label="Actual principal" value={cents(order.actualPurchaseCents ?? order.askPrice * order.quantity * 100)}/>
        <DecisionValue label="Actual fee" value={cents(order.actualFeeCents ?? order.feeCents)}/>
        <DecisionValue label="Potential payout" value={cents(order.potentialPayoutCents)}/>
      </div>
    </div>
  </details>;
}

function DecisionValue({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return <div className="rounded bg-secondary/35 p-1.5"><p className="text-[7px] uppercase tracking-wider text-muted-foreground">{label}</p><p className={cn('mt-0.5 font-mono text-[9px]', emphasis && 'text-primary')}>{value}</p></div>;
}
