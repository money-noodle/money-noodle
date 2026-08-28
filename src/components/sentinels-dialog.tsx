'use client';

import { useState } from 'react';
import { Activity, ChevronDown, Loader2, Lock } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { SentinelProjection } from '@/lib/sentinel-registry';

const inlineTrigger = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 hover:bg-muted/40';

interface SentinelsResponse { version?: string; generatedAt?: string; sentinels?: SentinelProjection[]; error?: string }

const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null, digits = 2) => value === null ? '—' : value.toFixed(digits);
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

function elapsedDays(from: string | null): number | null {
  if (!from) return null;
  const days = (Date.now() - Date.parse(from)) / 86_400_000;
  return Number.isFinite(days) && days > 0 ? days : null;
}

function ProgressRow({ label, current, required, unit }: SentinelProjection['thresholds'][number]) {
  const ratio = required > 0 ? Math.min(1, current / required) : 0;
  const met = ratio >= 1;
  return <div className="space-y-1">
    <div className="flex items-baseline justify-between text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-mono tabular-nums', met ? 'text-profit' : 'text-foreground')}>
        {unit === 'fraction' ? `${pct(current)} / ${pct(required)}` : `${current} / ${required}`}
      </span>
    </div>
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', met ? 'bg-profit' : 'bg-primary/70')} style={{ width: `${ratio * 100}%` }}/>
    </div>
  </div>;
}

function ArmTable({ sentinel }: { sentinel: SentinelProjection }) {
  const rows = sentinel.tracks.flatMap((track) => track.arms.map((arm) => ({ track: track.mode, ...arm })));
  if (!rows.length) return null;
  return <div className="overflow-x-auto">
    <table className="w-full border-collapse text-[10px]">
      <thead>
        <tr className="border-b text-muted-foreground">
          <th className="py-1 pr-2 text-left font-medium">Arm</th>
          <th className="py-1 pr-2 text-left font-medium">Track</th>
          <th className="py-1 pr-2 text-right font-medium">Windows</th>
          <th className="py-1 pr-2 text-right font-medium">Divergent</th>
          <th className="py-1 pr-2 text-right font-medium">Mean ± SE</th>
          <th className="py-1 pr-2 text-right font-medium">t</th>
          <th className="py-1 text-right font-medium">Clears {sentinel.holmBestArmT ?? '—'}</th>
        </tr>
      </thead>
      <tbody className="font-mono tabular-nums">
        {rows.map((row) => <tr key={`${row.track}-${row.armId}`} className="border-b border-border/40 last:border-0">
          <td className="py-1 pr-2 font-sans">{row.armId}</td>
          <td className="py-1 pr-2 font-sans text-muted-foreground">{row.track}</td>
          <td className="py-1 pr-2 text-right">{row.windows}</td>
          <td className="py-1 pr-2 text-right">{row.divergentWindows ?? '—'}</td>
          <td className="py-1 pr-2 text-right">{num(row.meanReturn, 4)} ± {num(row.standardError, 4)}</td>
          <td className="py-1 pr-2 text-right">{num(row.tStatistic)}</td>
          <td className={cn('py-1 text-right', row.clears ? 'text-profit' : 'text-muted-foreground')}>{row.clears ? 'yes' : 'no'}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function SentinelCard({ sentinel }: { sentinel: SentinelProjection }) {
  const days = elapsedDays(sentinel.openedAt);
  const closed = sentinel.lifecycle !== 'collecting';
  return <div className={cn('rounded-lg border p-3', closed && 'bg-muted/20')}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-[11px] font-semibold">{sentinel.name}</p>
      <span className={cn('rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wide',
        sentinel.lifecycle === 'collecting' ? 'border-primary/30 text-primary'
          : sentinel.lifecycle === 'locked-for-review' ? 'border-warn/40 text-warn'
          : 'border-border text-muted-foreground')}>{sentinel.lifecycle}</span>
    </div>
    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{sentinel.question}</p>

    {/* Timeline: opened, elapsed, and the straight-line projection when one exists. */}
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-muted-foreground">
      <span>opened <span className="font-mono text-foreground">{day(sentinel.openedAt)}</span></span>
      {days !== null && <span>running <span className="font-mono text-foreground">{days.toFixed(1)}d</span></span>}
      {sentinel.projectedCompleteAt && <span>thresholds met about <span className="font-mono text-foreground">{day(sentinel.projectedCompleteAt)}</span></span>}
      <span>store <span className="font-mono text-foreground">{sentinel.store}</span></span>
    </div>

    {sentinel.closedReason && <p className="mt-2 rounded border border-warn/30 bg-warn/[.04] p-2 text-[9px] leading-relaxed text-warn/90">
      <Lock className="mr-1 inline size-2.5"/>{sentinel.closedReason}
    </p>}

    {sentinel.thresholds.length > 0 && <div className="mt-3 space-y-2">
      {sentinel.thresholds.map((threshold) => <ProgressRow key={threshold.label} {...threshold}/>)}
    </div>}

    {sentinel.observations.length > 0 && <div className="mt-3 flex flex-wrap gap-4">
      {sentinel.observations.map((observation) => <span key={observation.label} className="text-[10px] text-muted-foreground">
        {observation.label} <span className="font-mono tabular-nums text-foreground">{observation.value.toLocaleString()}</span>
      </span>)}
    </div>}

    {sentinel.kind === 'observation' && <p className="mt-2 text-[9px] italic text-muted-foreground">
      Observation only — this instrument has no candidate arms to compare.
    </p>}

    {sentinel.tracks.length > 0 && <div className="mt-3"><ArmTable sentinel={sentinel}/></div>}
  </div>;
}

/**
 * Prospective-evidence instruments and their progress.
 *
 * Renders entirely from the sentinel registry projection, so a new sentinel is a registry entry rather
 * than new UI. Deliberately read-only: promotion is a manual versioned act recorded in an immutable
 * ledger, so nothing here can arm, disarm, promote, reset, or retire an instrument.
 */
export function SentinelsDialog({ variant = 'badge' }: { variant?: 'button' | 'badge' }) {
  const [data, setData] = useState<SentinelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/sentinels', { cache: 'no-store' });
      const body = await response.json() as SentinelsResponse;
      if (!response.ok) throw new Error(body.error || 'Unable to load sentinels');
      setData(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load sentinels'); }
    finally { setLoading(false); }
  }

  const all = data?.sentinels ?? [];
  const running = all.filter((sentinel) => sentinel.lifecycle === 'collecting' || sentinel.lifecycle === 'locked-for-review');
  const closed = all.filter((sentinel) => !running.includes(sentinel));

  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild>
      {variant === 'badge'
        ? <button type="button" title="Prospective evidence instruments and their progress" className={cn(inlineTrigger, 'text-[9px]')}>
            <Activity className="size-2.5 shrink-0"/>Sentinels<ChevronDown className="size-2.5 shrink-0"/>
          </button>
        : <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] hover:bg-muted/40"><Activity className="size-3"/>Sentinels</button>}
    </DialogTrigger>
    <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm"><Activity className="size-4"/>Sentinels</DialogTitle>
        <DialogDescription className="text-[11px]">
          Each sentinel records what a candidate rule would have done, prospectively, so a decision rests on
          committed evidence rather than a retrospective screen. Reaching every threshold opens a review; it
          never promotes anything on its own.
        </DialogDescription>
      </DialogHeader>

      {loading && <p className="flex items-center gap-2 py-6 text-[11px] text-muted-foreground"><Loader2 className="size-3 animate-spin"/>Loading…</p>}
      {error && <p className="py-4 text-[11px] text-loss">{error}</p>}

      {data && !loading && <div className="space-y-3">
        {running.map((sentinel) => <SentinelCard key={sentinel.id} sentinel={sentinel}/>)}

        {closed.length > 0 && <div>
          <button type="button" onClick={() => setShowClosed((open) => !open)}
            className="flex w-full items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] text-muted-foreground hover:bg-muted/40">
            <ChevronDown className={cn('size-3 transition-transform', showClosed && 'rotate-180')}/>
            {closed.length} closed sentinel{closed.length === 1 ? '' : 's'}
          </button>
          {showClosed && <div className="mt-2 space-y-3">
            {closed.map((sentinel) => <SentinelCard key={sentinel.id} sentinel={sentinel}/>)}
          </div>}
        </div>}
      </div>}
    </DialogContent>
  </Dialog>;
}
