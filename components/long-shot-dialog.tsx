'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Dices, Loader2, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, inlineTrigger } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface Segment {
  label: string; attempts: number; windows: number; exitedAtMark: number; settledUnexited: number;
  realizedPnlCents: number; stakedCents: number; clusteredMeanReturn: number | null; standardError: number | null;
}
/** Exit minus hold, paired on identical orders. Positive means the exit rule added value. */
interface ExitVersusHold {
  perDollar: number | null; standardError: number | null; windows: number; attempts: number;
  whenExercisedPerDollar: number | null; whenExercisedStandardError: number | null; whenExercisedAttempts: number;
  totalCents: number; unresolvedCounterfactual: number; exitAttemptedUnsold: number;
}
interface TrackReport {
  submitted: number; filled: number; unfilled: number; open: number; resolved: number;
  overall: Segment; byEntryGeneration: Segment[]; byRegime: Segment[]; byAsset: Segment[];
  peakBidBuckets: Array<{ atLeastCents: number; count: number }>;
  exitVersusHold?: ExitVersusHold;
  reviewAttemptsRequired: number; reviewUnlocked: boolean;
}
interface Track {
  mode: 'paper' | 'live'; equityCents: number; reservedCents: number; headroomCents: number;
  ticketCents: number; halted: boolean; haltThresholdCents: number; haltReason?: string;
  dailyLossCapCents: number; report: TrackReport;
}
/** One operator-defined hypothesis: buy inside an entry range, sell at an exit. */
interface AnalysisBand {
  id: string; label: string; entryLowCents: number; entryHighCents: number; exitCents: number;
}
interface AnalysisBandResult {
  band: AnalysisBand; candidates: number; windows: number; touched: number;
  touchRate: number | null; breakEvenRate: number | null; ratio: number | null;
  meanReturn: number | null; standardError: number | null; ungraded: number;
}
interface BandReport {
  bandsVersion: string; savedCount: number; lastSavedAt: string | null;
  candidateRows: number; gradedWindows: number; ticketCents: number; minimumSecondsRemaining: number;
  results: AnalysisBandResult[];
}
interface NearMoneyArm {
  stopBelowEntryCents: number | null; positions: number; windows: number; stopped: number;
  stopRate: number | null; meanReturn: number | null; standardError: number | null; ungraded: number;
}
interface NearMoneyReport {
  version: string;
  definition: { id: string; committedAt: string; entryLowCents: number; entryHighCents: number; minimumSecondsRemaining: number };
  prospective: NearMoneyArm[];
  retrospective: NearMoneyArm[];
}
interface LongShotResponse {
  policyVersion: string; enabled: boolean; liveEnabled?: boolean;
  /** Set when served from the replicated projection, which carries the paper lane only. */
  durable?: boolean; generatedAt?: string; paper?: Track;
  settings: {
    entryMarkCents: number; exitMarkCents: number; minimumSecondsRemaining: number;
    drawdownDivisor: number; minimumTicketCents: number; maximumOpenPerSettlementWindow: number;
    maximumEntriesPerAssetWindow: number; dailyLossTickets: number; excludedAssets: string[];
  };
  allocation: { startingCents: number; funded: boolean };
  tracks?: Track[];
  hold: {
    samples: number; resolvedSamples: number; unexecutedSamples: number;
    hold: { windows: number; samples: number; rate: number | null; clusteredMeanReturn: number | null };
    roundTrip: { windows: number; samples: number; rate: number | null; clusteredMeanReturn: number | null };
    /** Zero means the round-trip arm is unmeasured, not measured at zero. See design §10a. */
    peakObservedSamples?: number;
    advantage: number | null; reviewWindowsRequired: number; reviewUnlocked: boolean;
  };
  contractPaths: { windows: number; samples: number };
  bands?: BandReport;
  nearMoney?: NearMoneyReport;
  error?: string;
}

const cents = (value: number) => `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(0)}¢`;
const percent = (value: number | null) => (value === null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)}%`);
const rate = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' | 'warn' }) {
  return <div className="rounded-lg border bg-background/40 p-2">
    <p className="text-[8px] uppercase text-muted-foreground">{label}</p>
    <p className={cn('font-mono text-[11px]',
      tone === 'good' && 'text-gain', tone === 'bad' && 'text-loss', tone === 'warn' && 'text-warn')}>{value}</p>
    {hint && <p className="mt-0.5 text-[8px] text-muted-foreground">{hint}</p>}
  </div>;
}

function TrackPanel({ track, breakEven }: { track: Track; breakEven: number }) {
  const report = track.report;
  const overall = report.overall;
  return <div className={cn('rounded-xl border p-4', track.halted && 'border-loss/25 bg-loss/[.03]')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide">{track.mode}</p>
      {track.halted
        ? <Badge variant="outline" className="border-loss/30 text-loss">halted</Badge>
        : <Badge variant="outline" className="text-muted-foreground">ticket {cents(track.ticketCents)}</Badge>}
    </div>
    {track.halted && track.haltReason && <p className="mt-2 text-[10px] leading-relaxed text-loss/90">{track.haltReason}</p>}

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
 * Approach (ii): the same triggers held to settlement, committed at trigger time.
 *
 * The round-trip arm depends on `peakOwnedSideBidCents` being recorded against each sentinel. Where no
 * resolved sentinel carries one, `reachedExitMark` is false for every sample, the round-trip arm collapses
 * onto the hold arm, and the difference between them is an identical zero that nothing measured. This
 * panel reported exactly that between 2026-08-15 and 2026-08-17. So the comparison renders only when a
 * peak has actually been observed, and says so plainly otherwise. See docs/long-shot-policy-design.md §10a.
 */
function HoldComparison({ hold, executed }: { hold: LongShotResponse['hold']; executed: ExitVersusHold[] }) {
  const measured = (hold.peakObservedSamples ?? 0) > 0;
  // The tracks are shown separately elsewhere; here only a track that actually resolved something can say
  // anything, and the two lanes are never summed into one figure.
  const realized = executed.filter((arm) => arm.attempts > 0);
  return <div className="rounded-xl border p-4">
    <p className="text-[11px] font-semibold">Exit versus hold</p>
    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
      Whether selling at the mark beat simply holding the same trigger to settlement — the question the
      policy exists to answer. Measured two ways, which are reported apart and never added together.
    </p>

    <p className="mt-3 text-[9px] uppercase text-muted-foreground">
      Triggers · unbiased by execution, sampled every 15s
    </p>
    <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Triggers" value={String(hold.samples)} hint={`${hold.unexecutedSamples} not taken`}/>
      <Stat label="Resolved" value={String(hold.resolvedSamples)}/>
      <Stat label="Hold return" value={percent(hold.hold.clusteredMeanReturn)} hint={`win ${rate(hold.hold.rate)}`}/>
      <Stat label="Round trip" value={measured ? percent(hold.roundTrip.clusteredMeanReturn) : '—'}
        hint={measured ? `reached ${rate(hold.roundTrip.rate)}` : 'not yet measured'}
        tone={measured ? undefined : 'warn'}/>
    </div>
    {measured
      ? <p className="mt-2 text-[9px] text-muted-foreground">
          Exit minus hold: <span className="font-mono text-foreground">{percent(hold.advantage)}</span> per $1 staked ·{' '}
          {hold.roundTrip.windows} of {hold.reviewWindowsRequired} independent windows before first review ·
          a floor, since a trigger holds no position for the one-second poll to sample
        </p>
      : <p className="mt-2 text-[9px] leading-relaxed text-warn/90">
          No resolved trigger carries an observed peak bid, so the round trip cannot yet be distinguished
          from the hold. This is a gap in the evidence, not a result of zero — treat the comparison as
          unmeasured until peaks accumulate.
        </p>}

    {realized.map((arm, index) => <div key={index} className="mt-4">
      <p className="text-[9px] uppercase text-muted-foreground">
        Executed orders · realized money, one-second exit
      </p>
      <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Attempts" value={String(arm.attempts)}
          hint={arm.windows ? `${arm.windows} window${arm.windows === 1 ? '' : 's'}` : undefined}/>
        <Stat label="Exit minus hold" value={percent(arm.perDollar)}
          hint={arm.standardError === null ? 'per $1 staked' : `±${(arm.standardError * 100).toFixed(1)}pp`}
          tone={arm.perDollar === null ? undefined : arm.perDollar > 0 ? 'good' : arm.perDollar < 0 ? 'bad' : undefined}/>
        <Stat label="When it fired" value={percent(arm.whenExercisedPerDollar)}
          hint={`${arm.whenExercisedAttempts} sold`}
          tone={arm.whenExercisedPerDollar === null ? undefined : arm.whenExercisedPerDollar > 0 ? 'good' : 'bad'}/>
        <Stat label="Cash effect" value={cents(arm.totalCents)}
          tone={arm.totalCents > 0 ? 'good' : arm.totalCents < 0 ? 'bad' : undefined}/>
      </div>
      {(arm.unresolvedCounterfactual > 0 || arm.exitAttemptedUnsold > 0) && <p className="mt-1 text-[9px] text-warn/90">
        Excluded: {arm.unresolvedCounterfactual > 0 && `${arm.unresolvedCounterfactual} awaiting settlement`}
        {arm.unresolvedCounterfactual > 0 && arm.exitAttemptedUnsold > 0 && ' · '}
        {arm.exitAttemptedUnsold > 0 && `${arm.exitAttemptedUnsold} with an unclosed venue exit`}
      </p>}
    </div>)}
  </div>;
}


/**
 * Operator-defined analysis bands, and their measured results.
 *
 * **This is a screening surface and promotes nothing** (AGENTS §5.5). Two things follow from that and are
 * deliberately on the face of it rather than in a doc: the number of configurations ever evaluated, which
 * is the multiple-comparison denominator, and the live rule sitting in the list by default, because a
 * candidate has to beat the live rule rather than beat nothing.
 *
 * Saving recomputes in memory — the stored candidate summaries carry no band, entry mark, or entry window
 * — so a new band is measured against all recorded history immediately and needs no backfill.
 */
function BandsPanel({ report, onSaved }: { report: BandReport; onSaved: (next: LongShotResponse) => void }) {
  const [draft, setDraft] = useState<AnalysisBand[]>(report.results.map((row) => row.band));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);

  // A save returns the rebuilt report; adopt it so the table cannot drift from what was persisted.
  useEffect(() => { setDraft(report.results.map((row) => row.band)); setDirty(false); }, [report]);

  const update = (index: number, patch: Partial<AnalysisBand>) => {
    setDraft((bands) => bands.map((band, position) => position === index ? { ...band, ...patch } : band));
    setDirty(true);
  };

  async function save() {
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/long-shot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bands: draft }),
      });
      const body = await response.json() as LongShotResponse;
      if (!response.ok) throw new Error(body.error || 'Unable to save bands');
      onSaved(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save bands'); }
    finally { setSaving(false); }
  }

  const number = (value: number, onChange: (next: number) => void, title: string) =>
    <input type="number" min={0} max={99} value={value} title={title} aria-label={title}
      onChange={(event) => onChange(Math.floor(Number(event.target.value)))}
      className="w-11 rounded border bg-background/60 px-1 py-0.5 text-right font-mono text-[10px]"/>;

  return <div className="rounded-xl border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] font-semibold">Bands</p>
      <Badge variant="outline" className="font-mono text-[9px] text-muted-foreground">
        {report.candidateRows} candidates · {report.gradedWindows} graded windows
      </Badge>
    </div>
    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
      Each band is one hypothesis: buy when the ask first lands inside the entry range with at least{' '}
      {Math.round(report.minimumSecondsRemaining / 60)} minutes left, sell if the bid later reaches the exit.
      Scored on a {cents(report.ticketCents)} ticket against every recorded window. Saving remeasures
      immediately — nothing is re-collected.
    </p>

    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] text-[10px]">
        <thead>
          <tr className="text-[8px] uppercase text-muted-foreground">
            <th className="pb-1 text-left font-normal">Band</th>
            <th className="pb-1 text-right font-normal">Entry</th>
            <th className="pb-1 text-right font-normal">Exit</th>
            <th className="pb-1 text-right font-normal">n</th>
            <th className="pb-1 text-right font-normal">Windows</th>
            <th className="pb-1 text-right font-normal">Touch</th>
            <th className="pb-1 text-right font-normal">Break-even</th>
            <th className="pb-1 text-right font-normal">Ratio</th>
            <th className="pb-1 text-right font-normal">Return / $1</th>
            <th className="pb-1"/>
          </tr>
        </thead>
        <tbody className="font-mono">
          {draft.map((band, index) => {
            const measured = report.results.find((row) => row.band.id === band.id);
            const stale = dirty;
            return <tr key={band.id} className="border-t">
              <td className="py-1 pr-2">
                <input value={band.label} aria-label="Band label"
                  onChange={(event) => update(index, { label: event.target.value })}
                  className="w-32 rounded border bg-background/60 px-1 py-0.5 font-sans text-[10px]"/>
              </td>
              <td className="py-1 text-right whitespace-nowrap">
                {number(band.entryLowCents, (value) => update(index, { entryLowCents: value }), 'Entry low, exclusive')}
                <span className="mx-0.5 text-muted-foreground">–</span>
                {number(band.entryHighCents, (value) => update(index, { entryHighCents: value }), 'Entry high, inclusive')}
              </td>
              <td className="py-1 pl-1 text-right">
                {number(band.exitCents, (value) => update(index, { exitCents: value }), 'Exit mark')}
              </td>
              {measured && !stale
                ? <>
                    <td className="py-1 text-right">{measured.candidates}</td>
                    <td className="py-1 text-right">{measured.windows}</td>
                    <td className="py-1 text-right">{rate(measured.touchRate)}</td>
                    <td className="py-1 text-right text-muted-foreground">{rate(measured.breakEvenRate)}</td>
                    <td className={cn('py-1 text-right',
                      measured.ratio !== null && measured.ratio >= 1 ? 'text-gain' : 'text-muted-foreground')}>
                      {measured.ratio === null ? '—' : measured.ratio.toFixed(2)}
                    </td>
                    <td className={cn('py-1 text-right whitespace-nowrap',
                      measured.meanReturn === null ? 'text-muted-foreground'
                        : measured.meanReturn > 0 ? 'text-gain' : 'text-loss')}>
                      {percent(measured.meanReturn)}
                      {measured.standardError !== null && <span className="text-muted-foreground">
                        {' ±'}{(measured.standardError * 100).toFixed(0)}
                      </span>}
                      {measured.ungraded > 0 && <span className="text-warn/80" title={`${measured.ungraded} candidates await settlement`}>
                        {' '}·{measured.ungraded}
                      </span>}
                    </td>
                  </>
                : <td colSpan={6} className="py-1 text-right text-[9px] text-muted-foreground">
                    {stale ? 'save to measure' : '—'}
                  </td>}
              <td className="py-1 pl-2 text-right">
                <button type="button" title="Remove band" aria-label="Remove band"
                  onClick={() => { setDraft((bands) => bands.filter((_, position) => position !== index)); setDirty(true); }}
                  className="text-muted-foreground hover:text-loss"><Trash2 className="size-3"/></button>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => {
        setDraft((bands) => [...bands, {
          id: `band-${Date.now()}`, label: 'new band', entryLowCents: 0, entryHighCents: 10, exitCents: 90,
        }]);
        setDirty(true);
      }} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] hover:bg-muted/40">
        <Plus className="size-3"/>Add band
      </button>
      <button type="button" onClick={() => void save()} disabled={saving || !dirty}
        className={cn('inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px]',
          dirty ? 'border-primary/40 text-primary hover:bg-primary/10' : 'text-muted-foreground', saving && 'opacity-60')}>
        {saving && <Loader2 className="size-3 animate-spin"/>}Save and measure
      </button>
      {error && <span className="text-[10px] text-loss">{error}</span>}
    </div>

    <p className="mt-3 text-[9px] leading-relaxed text-muted-foreground">
      <span className="text-warn/90">{report.savedCount} configuration{report.savedCount === 1 ? '' : 's'} evaluated so far.</span>{' '}
      That is the number of comparisons this screening has made, and the bar a band must clear rises with it —
      one ratio above 1.00 among many tried is not evidence. Touch rates are floors at the sampling cadence.
      Screening may filter an idea and may never promote one: nothing here changes what the desk trades.
    </p>
  </div>;
}


/**
 * Approach (iii): buy near-money, hold to settlement, optionally stop out.
 *
 * The rule was committed on a date before the windows it is judged on closed, which is the only thing that
 * separates a prospective test from a sweep that found a good-looking cell (AGENTS §5.5). Both arms are
 * shown, and the retrospective one is labelled as screening because that is all it can ever be — the band
 * was chosen by looking at it.
 */
function NearMoneyPanel({ report }: { report: NearMoneyReport }) {
  const row = (arm: NearMoneyArm, key: string, dim: boolean) => <tr key={key} className={cn('border-t', dim && 'opacity-70')}>
    <td className="py-1 pr-2">{arm.stopBelowEntryCents === null
      ? <span className="text-foreground">hold</span>
      : <span>stop −{arm.stopBelowEntryCents}¢</span>}</td>
    <td className="py-1 text-right">{arm.positions}</td>
    <td className="py-1 text-right">{arm.windows}</td>
    <td className="py-1 text-right">{arm.stopRate === null ? '—' : rate(arm.stopRate)}</td>
    <td className={cn('py-1 text-right whitespace-nowrap',
      arm.meanReturn === null ? 'text-muted-foreground' : arm.meanReturn > 0 ? 'text-gain' : 'text-loss')}>
      {percent(arm.meanReturn)}
      {arm.standardError !== null && <span className="text-muted-foreground"> ±{(arm.standardError * 100).toFixed(1)}</span>}
    </td>
    <td className="py-1 text-right text-muted-foreground">{arm.ungraded || ''}</td>
  </tr>;

  const head = <tr className="text-[8px] uppercase text-muted-foreground">
    <th className="pb-1 text-left font-normal">Arm</th>
    <th className="pb-1 text-right font-normal">n</th>
    <th className="pb-1 text-right font-normal">Windows</th>
    <th className="pb-1 text-right font-normal">Stopped</th>
    <th className="pb-1 text-right font-normal">Return / $1</th>
    <th className="pb-1 text-right font-normal">Ungraded</th>
  </tr>;

  return <div className="rounded-xl border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] font-semibold">Near-money hold — committed sentinel</p>
      <Badge variant="outline" className="font-mono text-[9px] text-muted-foreground">{report.definition.id}</Badge>
    </div>
    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
      Buy a side whose ask first lands in{' '}
      <span className="font-mono">{report.definition.entryLowCents}–{report.definition.entryHighCents}¢</span> with at
      least {Math.round(report.definition.minimumSecondsRemaining / 60)} minutes left, and hold to settlement —
      with or without a stop, expressed in cents below what was paid. Stops are quoted against the entry ask
      because the bid sits under it from the moment of entry, so a stop &quot;back to what I paid&quot; fires on
      essentially every position and measures the spread.
    </p>

    <p className="mt-3 text-[9px] uppercase text-muted-foreground">
      Prospective · windows closing after {new Date(report.definition.committedAt).toLocaleString()}
    </p>
    <div className="mt-1 overflow-x-auto">
      <table className="w-full min-w-[420px] font-mono text-[10px]"><thead>{head}</thead>
        <tbody>{report.prospective.map((arm, index) => row(arm, `p${index}`, false))}</tbody></table>
    </div>
    <p className="mt-1 text-[9px] leading-relaxed text-data/80">
      This is the only arm that could ever promote anything: the rule was written down before these windows
      closed. It starts empty and fills at roughly the market&apos;s own rate.
    </p>

    <p className="mt-3 text-[9px] uppercase text-muted-foreground">Retrospective · screening only</p>
    <div className="mt-1 overflow-x-auto">
      <table className="w-full min-w-[420px] font-mono text-[10px]"><thead>{head}</thead>
        <tbody>{report.retrospective.map((arm, index) => row(arm, `r${index}`, true))}</tbody></table>
    </div>
    <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
      These windows closed before the rule existed, and the band was chosen by looking at them, so they can
      filter the idea and can never promote it. The stop is also priced optimistically — it assumes a fill
      at the stop level and cannot see a dip between samples, both of which flatter it.
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
  // The hosted projection carries the paper lane only; the worker carries both.
  const tracks = data?.tracks ?? (data?.paper ? [data.paper] : []);

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
      {error && <p className="py-4 text-[11px] text-loss">{error}</p>}

      {data && !loading && <div className="space-y-4">
        {/* Arming is stated first and separately per track: enabling the policy arms paper only. */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn('gap-1', data.enabled ? 'border-data/25 text-data' : 'text-muted-foreground')}>
            {data.enabled ? <ShieldCheck className="size-3"/> : <ShieldAlert className="size-3"/>}paper {data.enabled ? 'armed' : 'off'}
          </Badge>
          {data.liveEnabled !== undefined && <Badge variant="outline" className={cn('gap-1', data.liveEnabled ? 'border-warn/40 text-warn' : 'text-muted-foreground')}>
            {data.liveEnabled ? <ShieldAlert className="size-3"/> : <ShieldCheck className="size-3"/>}live {data.liveEnabled ? 'ARMED' : 'off'}
          </Badge>}
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

        {/* The hosted projection carries the paper lane only; the worker carries both. */}
        {tracks.map((track) => <TrackPanel key={track.mode} track={track} breakEven={breakEven}/>)}
        {data.durable && !data.tracks && <p className="text-[9px] leading-relaxed text-muted-foreground">
          Paper lane, current as of{' '}
          <span className="font-mono text-foreground">{data.generatedAt ? new Date(data.generatedAt).toLocaleString() : 'the last publish'}</span>.
          The live lane runs on the desk and is not published here.
        </p>}

        {/* Approach (ii): the same triggers held to settlement, committed at trigger time. */}
        <HoldComparison hold={data.hold} executed={tracks
          .map((track) => track.report.exitVersusHold)
          .filter((arm): arm is ExitVersusHold => arm !== undefined)}/>

        {data.bands && <BandsPanel report={data.bands} onSaved={setData}/>}
        {data.nearMoney && <NearMoneyPanel report={data.nearMoney}/>}

        <p className="text-[9px] text-muted-foreground">
          Contract paths: {data.contractPaths.windows} windows, {data.contractPaths.samples} samples. Both sides
          are sampled every 15 seconds whether or not anything qualifies, so any candidate entry or exit mark
          stays measurable from one dataset. Observation only — nothing here can arm, fund, size, or trade.
        </p>
      </div>}
    </DialogContent>
  </Dialog>;
}
