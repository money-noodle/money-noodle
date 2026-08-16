'use client';

import { useState } from 'react';
import { ChevronDown, Dices, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge, inlineTrigger } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface Segment {
  label: string; attempts: number; windows: number; exitedAtMark: number; settledUnexited: number;
  realizedPnlCents: number; stakedCents: number; clusteredMeanReturn: number | null; standardError: number | null;
}
interface TrackReport {
  submitted: number; filled: number; unfilled: number; open: number; resolved: number;
  overall: Segment; byEntryGeneration: Segment[]; byRegime: Segment[]; byAsset: Segment[];
  peakBidBuckets: Array<{ atLeastCents: number; count: number }>;
  reviewAttemptsRequired: number; reviewUnlocked: boolean;
}
interface Track {
  mode: 'paper' | 'live'; equityCents: number; reservedCents: number; headroomCents: number;
  ticketCents: number; halted: boolean; haltThresholdCents: number; haltReason?: string;
  dailyLossCapCents: number; report: TrackReport;
}
interface LongShotResponse {
  policyVersion: string; enabled: boolean; liveEnabled: boolean;
  settings: {
    entryMarkCents: number; exitMarkCents: number; minimumSecondsRemaining: number;
    drawdownDivisor: number; minimumTicketCents: number; maximumOpenPerSettlementWindow: number;
    maximumEntriesPerAssetWindow: number; dailyLossTickets: number; excludedAssets: string[];
  };
  allocation: { startingCents: number; funded: boolean };
  tracks: Track[];
  hold: {
    samples: number; resolvedSamples: number; unexecutedSamples: number;
    hold: { windows: number; samples: number; rate: number | null; clusteredMeanReturn: number | null };
    roundTrip: { windows: number; samples: number; rate: number | null; clusteredMeanReturn: number | null };
    advantage: number | null; reviewWindowsRequired: number; reviewUnlocked: boolean;
  };
  contractPaths: { windows: number; samples: number };
  error?: string;
}

const cents = (value: number) => `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(0)}¢`;
const percent = (value: number | null) => (value === null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}%`);
const rate = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' | 'warn' }) {
  return <div className="rounded-lg border bg-background/40 p-2">
    <p className="text-[8px] uppercase text-muted-foreground">{label}</p>
    <p className={cn('font-mono text-[11px]',
      tone === 'good' && 'text-primary', tone === 'bad' && 'text-red-400', tone === 'warn' && 'text-amber-300')}>{value}</p>
    {hint && <p className="mt-0.5 text-[8px] text-muted-foreground">{hint}</p>}
  </div>;
}

function TrackPanel({ track, breakEven }: { track: Track; breakEven: number }) {
  const report = track.report;
  const overall = report.overall;
  return <div className={cn('rounded-xl border p-4', track.halted && 'border-red-400/25 bg-red-400/[.03]')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide">{track.mode}</p>
      {track.halted
        ? <Badge variant="outline" className="border-red-400/30 text-red-400">halted</Badge>
        : <Badge variant="outline" className="text-muted-foreground">ticket {cents(track.ticketCents)}</Badge>}
    </div>
    {track.halted && track.haltReason && <p className="mt-2 text-[10px] leading-relaxed text-red-400/90">{track.haltReason}</p>}

    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Equity" value={cents(track.equityCents)} hint={`halts under ${cents(track.haltThresholdCents)}`}/>
      <Stat label="Committed" value={cents(track.reservedCents)} hint={`${cents(track.headroomCents)} free`}/>
      <Stat label="Daily loss cap" value={cents(track.dailyLossCapCents)}/>
      <Stat label="Realized" value={cents(overall.realizedPnlCents)}
        tone={overall.realizedPnlCents > 0 ? 'good' : overall.realizedPnlCents < 0 ? 'bad' : undefined}/>
    </div>

    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Submitted" value={String(report.submitted)} hint={`${report.unfilled} unfilled`}/>
      <Stat label="Open" value={String(report.open)}/>
      <Stat label="Sold at mark" value={String(overall.exitedAtMark)} hint={`${overall.settledUnexited} settled`}/>
      <Stat label="Return / $1" value={percent(overall.clusteredMeanReturn)}
        hint={overall.windows ? `${overall.windows} window${overall.windows === 1 ? '' : 's'}` : undefined}
        tone={overall.clusteredMeanReturn === null ? undefined : overall.clusteredMeanReturn > 0 ? 'good' : 'bad'}/>
    </div>

    {/* What prices a different exit mark without another month of collection. */}
    {report.peakBidBuckets.some((bucket) => bucket.count > 0) && <div className="mt-3">
      <p className="text-[9px] uppercase text-muted-foreground">How close the unsold came</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {report.peakBidBuckets.map((bucket) => <Badge key={bucket.atLeastCents} variant="outline" className="font-mono text-[9px] text-muted-foreground">
          ≥{bucket.atLeastCents}¢ · {bucket.count}
        </Badge>)}
      </div>
    </div>}

    <p className="mt-3 text-[9px] text-muted-foreground">
      {report.resolved} of {report.reviewAttemptsRequired} resolved attempts before first review
      {report.reviewUnlocked ? ' · review unlocked' : ''} · break-even {(breakEven * 100).toFixed(1)}%
    </p>
  </div>;
}

/**
 * Read-only long-shot policy surface. Loads on open, like the other signed evaluation dialogs, so the
 * dashboard's fifteen-second polling payload is not inflated by evidence nobody has asked to see.
 */
export function LongShotDialog({ variant = 'button' }: { variant?: 'button' | 'badge' }) {
  const [data, setData] = useState<LongShotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/long-shot', { cache: 'no-store' });
      const body = await response.json() as LongShotResponse;
      if (!response.ok) throw new Error(body.error || 'Unable to load the long-shot report');
      setData(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load the long-shot report'); }
    finally { setLoading(false); }
  }

  // Break-even touch rate at the configured marks, for a ticket bought at the entry mark. Stated so the
  // reported return is read against the bar it has to clear rather than against zero.
  const breakEven = data ? data.settings.entryMarkCents / data.settings.exitMarkCents : 0;

  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild>
      {variant === 'badge'
        ? <button type="button" title="Long-shot round-trip policy — open evidence and arming" className={cn(inlineTrigger, 'text-[9px]')}>
            <Dices className="size-2.5 shrink-0"/>Long shot<ChevronDown className="size-2.5 shrink-0"/>
          </button>
        : <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] hover:bg-muted/40"><Dices className="size-3"/>Long shot</button>}
    </DialogTrigger>
    <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm"><Dices className="size-4"/>Long-shot round trip</DialogTitle>
        <DialogDescription className="text-[11px]">
          A second strategy on the same market: buy a side that gets cheap early in the cycle, sell it into
          a large excursion before settlement. It uses no model probability — the trigger is a venue price
          and a clock.
        </DialogDescription>
      </DialogHeader>

      {loading && <p className="flex items-center gap-2 py-6 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin"/>Loading…</p>}
      {error && <p className="py-4 text-[11px] text-red-400">{error}</p>}

      {data && !loading && <div className="space-y-4">
        {/* Arming is stated first and separately per track: enabling the policy arms paper only. */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn('gap-1', data.enabled ? 'border-primary/25 text-primary' : 'text-muted-foreground')}>
            {data.enabled ? <ShieldCheck className="size-3"/> : <ShieldAlert className="size-3"/>}paper {data.enabled ? 'armed' : 'off'}
          </Badge>
          <Badge variant="outline" className={cn('gap-1', data.liveEnabled ? 'border-amber-300/40 text-amber-300' : 'text-muted-foreground')}>
            {data.liveEnabled ? <ShieldAlert className="size-3"/> : <ShieldCheck className="size-3"/>}live {data.liveEnabled ? 'ARMED' : 'off'}
          </Badge>
          <Badge variant="outline" className="font-mono text-[9px] text-muted-foreground">{data.policyVersion}</Badge>
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Buy at or under <span className="font-mono">{data.settings.entryMarkCents}¢</span>, sell at{' '}
          <span className="font-mono">{data.settings.exitMarkCents}¢</span>, entering only with at least{' '}
          <span className="font-mono">{Math.round(data.settings.minimumSecondsRemaining / 60)}</span> minutes left.
          Funded at <span className="font-mono">{cents(data.allocation.startingCents)}</span>; ticket is equity ÷{' '}
          {data.settings.drawdownDivisor}, floored at {cents(data.settings.minimumTicketCents)}. At most{' '}
          {data.settings.maximumOpenPerSettlementWindow} open per settlement window and{' '}
          {data.settings.maximumEntriesPerAssetWindow} entries per asset window.
        </p>

        {data.tracks.map((track) => <TrackPanel key={track.mode} track={track} breakEven={breakEven}/>)}

        {/* Approach (ii): the same triggers held to settlement, committed at trigger time. */}
        <div className="rounded-xl border p-4">
          <p className="text-[11px] font-semibold">Hold comparison</p>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            The identical triggers held to settlement instead of sold at the mark, recorded when the trigger
            fires rather than when an order fills — so triggers the desk could not take stay in the sample.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Triggers" value={String(data.hold.samples)} hint={`${data.hold.unexecutedSamples} not taken`}/>
            <Stat label="Resolved" value={String(data.hold.resolvedSamples)}/>
            <Stat label="Hold return" value={percent(data.hold.hold.clusteredMeanReturn)} hint={`win ${rate(data.hold.hold.rate)}`}/>
            <Stat label="Round trip" value={percent(data.hold.roundTrip.clusteredMeanReturn)} hint={`reached ${rate(data.hold.roundTrip.rate)}`}/>
          </div>
          <p className="mt-2 text-[9px] text-muted-foreground">
            Selling early beats holding by {percent(data.hold.advantage)} per $1 staked ·{' '}
            {data.hold.roundTrip.windows} of {data.hold.reviewWindowsRequired} independent windows before first review
          </p>
        </div>

        <p className="text-[9px] text-muted-foreground">
          Contract paths: {data.contractPaths.windows} windows, {data.contractPaths.samples} samples. Both sides
          are sampled every 15 seconds whether or not anything qualifies, so any candidate entry or exit mark
          stays measurable from one dataset. Observation only — nothing here can arm, fund, size, or trade.
        </p>
      </div>}
    </DialogContent>
  </Dialog>;
}
