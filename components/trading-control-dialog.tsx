'use client';

import { useState } from 'react';
import { CircleDollarSign, FlaskConical, Loader2, Pause, Play, Radio, Save, ShieldAlert, ShieldCheck, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import type { TradingControlData } from '@/lib/types';
import { cn } from '@/lib/utils';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => usd.format(cents / 100);
const preciseDollars = (cents: number) => Number.isInteger(cents) ? dollars(cents) : `$${(cents / 100).toFixed(4)}`;
const attemptOutcome = (status: string, noFillReason?: 'post_only_race' | 'rested_no_fill' | 'ioc_no_fill', filledCount?: number) =>
  noFillReason === 'post_only_race' ? 'post-only race'
    : noFillReason === 'rested_no_fill' ? 'rested · no fill'
      : noFillReason === 'ioc_no_fill' ? 'IOC · no fill'
      : (filledCount ?? 0) > 0 && status === 'open' ? 'filled'
        : status.replace('_', ' ');

export function TradingControlDialog() {
  const [data, setData] = useState<TradingControlData | null>(null);
  const [budget, setBudget] = useState('100');
  const [perTrade, setPerTrade] = useState('0.25');
  const [enabledVenues, setEnabledVenues] = useState<Array<'polymarket' | 'kalshi'>>(['polymarket', 'kalshi']);
  const [loading, setLoading] = useState(false);
  const [liveConfirm, setLiveConfirm] = useState('');
  const [paperBankroll, setPaperBankroll] = useState('100');
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/trading/control', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load trading controls');
      setData(body);
      if (body.control.startingBudgetCents > 0) setBudget((body.control.startingBudgetCents / 100).toFixed(2));
      if (body.control.perTradeCents > 0) setPerTrade((body.control.perTradeCents / 100).toFixed(2));
      setEnabledVenues(body.control.enabledVenues);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load trading controls'); }
    finally { setLoading(false); }
  }

  async function action(actionName: 'configure' | 'venues' | 'pause' | 'resume' | 'mode' | 'paper-reset' | 'reconcile', extra: Record<string, unknown> = {}): Promise<boolean> {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/trading/control', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: actionName, budgetDollars: Number(budget), perTradeDollars: Number(perTrade), enabledVenues, ...extra }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Control update failed');
      setData(body);
      setEnabledVenues(body.control.enabledVenues);
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Control update failed'); return false; }
    finally { setLoading(false); }
  }

  /**
   * Mode changes are refused while automation is running, so the pause is performed here as an
   * explicit, labelled step. Previously the button simply sat disabled with no way to discover why.
   */
  async function changeMode(mode: 'paper' | 'live') {
    if (data?.control.state === 'active' && !await action('pause')) return;
    if (await action('mode', { mode, confirmation: mode === 'live' ? liveConfirm : undefined })) setLiveConfirm('');
  }

  function toggleVenue(venue: 'polymarket' | 'kalshi') {
    setEnabledVenues((current) => current.includes(venue) ? current.filter((item) => item !== venue) : [...current, venue]);
  }

  const kalshiReadiness = data?.venues.find((venue) => venue.venue === 'kalshi');
  const liveMode = data?.control.mode === 'live';
  const stateColor = data?.control.state === 'active' ? 'border-primary/20 text-primary' : data?.control.state === 'depleted' ? 'border-red-400/20 text-red-400' : 'text-muted-foreground';
  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild><Button variant="ghost" size="sm" title="Budget and automation controls"><CircleDollarSign/><span className="hidden sm:inline">Budget</span></Button></DialogTrigger>
    <DialogContent className="max-w-4xl p-0">
      <DialogHeader className="border-b p-5 pr-12"><div className="flex items-start justify-between gap-3"><div><DialogTitle className="flex items-center gap-2"><CircleDollarSign className="size-4 text-primary"/> Budget and automation</DialogTitle><DialogDescription className="mt-1">A verified total risk budget with an explicit all-in cap for each purchase.</DialogDescription></div>{data && <Badge variant="outline" className={cn('uppercase', stateColor)}>{data.control.state}</Badge>}</div></DialogHeader>
      <div className="max-h-[82vh] overflow-y-auto p-5">
        {loading && !data ? <div className="grid h-64 place-items-center"><Loader2 className="animate-spin text-muted-foreground"/></div> : <>
          {(() => {
            const active = data?.control.state === 'active';
            const live = data?.control.mode === 'live';
            const recoveryArmed = !active && data?.control.autoResumeEligible && data.control.operatorIntent === 'active' && data.control.pauseOrigin === 'system';
            const armed = data?.venues.filter((venue) => venue.enabled && venue.tradeReady).map((venue) => venue.venue) ?? [];
            return <div className={cn('mb-4 flex items-start gap-3 rounded-lg border p-3', active && live ? 'border-red-400/40 bg-red-400/[.07]' : active ? 'border-primary/25 bg-primary/[.05]' : 'border-primary/15 bg-primary/[.035]')}>
              {active ? <Radio className="mt-0.5 size-4 shrink-0 text-primary"/> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary"/>}
              <div>
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium">{active && <span className="relative flex size-2"><span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', live ? 'bg-red-400' : 'bg-primary')}/><span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-red-400' : 'bg-primary')}/></span>}{active ? (live ? 'LIVE trading active — real orders with real money' : 'PAPER trading active — simulated orders, no real money') : recoveryArmed ? 'Safety suspension — guarded auto-resume armed' : 'Automation is not placing orders'}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{active
                  ? `Armed on ${armed.join(' + ') || 'no venue'}. Each qualifying buy reserves an all-in cap, posts up to ${data?.maximumLiveMakerAttempts ?? 1} managed passive Kalshi attempt${(data?.maximumLiveMakerAttempts ?? 1) === 1 ? '' : 's'}, cancels any remainder, and releases unused principal and fee reserve. Limits: 3 concurrent positions, ${dollars(data?.live?.proposedStakeCents ?? 0)} next purchase cap, ${data?.liveRisk.maximumCurrentEpochDrawdownPercent.toFixed(1) ?? '25.0'}% current-budget drawdown stop, ${dollars(data?.liveRisk.maximumLifetimeLossCents ?? 50)} lifetime-loss stop.`
                  : recoveryArmed ? 'The system retained your active intent but is placing no orders. It will resume only after authoritative reconciliation and every normal readiness check pass. Press Cancel auto-resume to withdraw permission.' : 'Resume starts the selected execution mode only when reconciliation and both live loss limits pass. Live remains protected by typed arming, environment opt-in, balance checks, per-purchase caps, and the kill switch.'}</p>
              </div>
            </div>;
          })()}
          {error && <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{error}</div>}
          {data && !data.liveRisk.allowed && <div className="mb-4 rounded-lg border border-red-400/30 bg-red-400/[.07] p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-red-200"><ShieldAlert className="size-4"/>Live loss circuit breaker</p>
            <ul className="mt-2 space-y-1">{data.liveRisk.reasons.map((reason) => <li key={reason} className="text-[9px] leading-relaxed text-red-100/80">{reason}</li>)}</ul>
            <p className="mt-2 font-mono text-[9px] text-muted-foreground">Current drawdown {preciseDollars(data.liveRisk.currentEpochDrawdownCents)} / {preciseDollars(data.liveRisk.maximumCurrentEpochDrawdownCents)} · lifetime P&amp;L {preciseDollars(data.liveRisk.lifetimeRealizedPnlCents)} / −{preciseDollars(data.liveRisk.maximumLifetimeLossCents)} limit</p>
            <p className="mt-1 text-[9px] text-muted-foreground">Reconciliation cannot auto-clear an economic risk stop. Review the evidence and deliberately change server-side limits before Resume can pass.</p>
          </div>}

          <div className="grid gap-3 lg:grid-cols-[1fr_1.35fr]">
            <div className="rounded-xl border p-4">
              <h3 className="text-xs font-semibold">Budget configuration</h3><p className="mt-1 text-[9px] text-muted-foreground">Reconfiguration resets tracked P&amp;L and requires no reserved trades.</p>
              <label className="mt-4 block text-[9px] uppercase tracking-wider text-muted-foreground">Total live budget</label>
              <div className="mt-1 flex h-10 items-center rounded-md border bg-background px-3"><span className="text-sm text-muted-foreground">$</span><input type="number" min="0.01" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm outline-none"/></div>
              <p className="mt-1.5 text-[9px] text-muted-foreground">Maximum real-money equity Money Noodle may risk. Saving verifies this amount against signed Kalshi available cash.</p>
              <label className="mt-3 block text-[9px] uppercase tracking-wider text-muted-foreground">All-in amount per purchase</label>
              <div className="mt-1 flex h-10 items-center rounded-md border bg-background px-3"><span className="text-sm text-muted-foreground">$</span><input type="number" min="0.02" max={budget || undefined} step="0.01" value={perTrade} onChange={(event) => setPerTrade(event.target.value)} className="min-w-0 flex-1 bg-transparent px-2 font-mono text-sm outline-none"/></div>
              <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">Includes contract principal and Kalshi fees. Kalshi quantity is sized in 0.01-contract increments so principal + estimated fee fits. Effective live cap: the lower of this value and the server safety ceiling ({dollars(data?.maximumLiveStakeCents ?? 25)}).</p>
              <label className="mt-3 block text-[9px] uppercase tracking-wider text-muted-foreground">Enabled trading venues</label>
              <div className="mt-1 grid grid-cols-2 gap-2">{(['polymarket', 'kalshi'] as const).map((venue) => { const enabled = enabledVenues.includes(venue); return <button type="button" key={venue} onClick={() => toggleVenue(venue)} disabled={data?.control.state === 'active'} className={cn('rounded-md border p-2.5 text-left transition disabled:opacity-50', enabled ? 'border-primary/25 bg-primary/5' : 'bg-background')}><div className="flex items-center justify-between"><span className="text-[10px] font-medium capitalize">{venue}</span><span className={cn('size-2 rounded-full', enabled ? 'bg-primary' : 'bg-muted-foreground/40')}/></div><p className="mt-1 text-[8px] text-muted-foreground">{enabled ? 'Eligible for new trades' : 'No new trades'}</p></button>; })}</div>
              {!enabledVenues.length && <p className="mt-1 text-[9px] text-red-300">Enable at least one venue.</p>}
              <div className="mt-3 grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => void action('venues')} disabled={loading || data?.control.state === 'active' || !enabledVenues.length}>Apply venues only</Button><Button onClick={() => void action('configure')} disabled={loading || data?.control.state === 'active' || Boolean(data?.control.reservedBudgetCents) || !enabledVenues.length || !(Number(budget) > 0) || !(Number(perTrade) >= 0.02) || Number(perTrade) > Number(budget)}>{loading ? <Loader2 className="animate-spin"/> : <Save/>}Save budget</Button></div>
            </div>

            <div className="rounded-xl border p-4">
              <div className="flex items-center justify-between"><div><h3 className="text-xs font-semibold">Working ledgers</h3><p className="mt-1 text-[9px] text-muted-foreground">Two independent bankrolls. Live risks real money; paper never touches it.</p></div><Badge variant="outline" className={cn('uppercase', data?.control.mode === 'live' ? 'border-red-400/30 text-red-300' : 'border-primary/25 text-primary')}>{data?.control.mode ?? 'paper'} armed</Badge></div>
              {([['Live', data?.live, `Venue budget · ${dollars(data?.control.perTradeCents ?? Math.round(Number(perTrade) * 100))} all-in per purchase`], ['Paper', data?.paper, `Shadow bankroll · same all-in purchase cap, separate simulated cash`]] as const).map(([label, track, note]) => {
                const isLive = label === 'Live';
                return <div key={label} className={cn('mt-3 rounded-lg border p-3', isLive ? 'border-red-400/25 bg-red-400/[.03]' : 'border-primary/20 bg-primary/[.02]')}>
                  <div className="flex items-center justify-between gap-2">
                    <p className={cn('flex items-center gap-1.5 text-[11px] font-semibold', isLive ? 'text-red-200' : '')}>{isLive ? <ShieldAlert className="size-3.5"/> : <FlaskConical className="size-3.5"/>}{label} ledger</p>
                    <Badge variant="outline" className={cn('text-[9px]', track?.running ? (isLive ? 'border-red-400/35 text-red-300' : 'border-primary/30 text-primary') : 'text-muted-foreground')}>{track?.running ? 'trading' : 'idle'}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Equity</p><p className="mt-0.5 font-mono text-base">{track ? dollars(track.equityCents) : '—'}</p></div>
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Available</p><p className="mt-0.5 font-mono text-base">{track ? dollars(track.availableCents) : '—'}</p></div>
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Reserved</p><p className="mt-0.5 font-mono text-base">{track ? dollars(track.reservedCents) : '—'}</p></div>
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Realized P&amp;L</p><p className={cn('mt-0.5 font-mono text-base', (track?.realizedPnlCents ?? 0) > 0 ? 'text-primary' : (track?.realizedPnlCents ?? 0) < 0 ? 'text-red-400' : '')}>{track ? dollars(track.realizedPnlCents) : '—'}</p></div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2"><span className="text-[9px] text-muted-foreground">{note}</span><span className="shrink-0 text-right"><span className="text-[8px] uppercase text-muted-foreground">Next all-in cap </span><span className={cn('font-mono text-base', isLive ? 'text-red-300' : 'text-primary')}>{track ? dollars(track.proposedStakeCents) : '—'}</span></span></div>
                </div>;
              })}
              <div className="mt-4 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2"><div><p className="text-[10px] font-medium">Execution mode</p><p className="mt-0.5 text-[9px] text-muted-foreground">Paper always runs and is tracked separately. Live places real orders.</p></div>
                  <Badge variant="outline" className={cn('uppercase', liveMode ? 'border-red-400/30 text-red-300' : 'border-primary/25 text-primary')}>{data?.control.mode ?? 'paper'}</Badge></div>
                {liveMode
                  ? <Button variant="outline" size="sm" className="mt-2 w-full" disabled={loading} onClick={() => void changeMode('paper')}>{data?.control.state === 'active' ? 'Pause and switch back to paper' : 'Switch back to paper'}</Button>
                  : data?.liveAvailable
                    ? <>
                      <div className="mt-2 flex gap-2"><input value={liveConfirm} onChange={(event) => setLiveConfirm(event.target.value)} placeholder="Type TRADE LIVE" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[10px] outline-none"/><Button size="sm" variant="outline" className="shrink-0 border-red-400/30 text-red-300" disabled={loading || liveConfirm !== 'TRADE LIVE'} onClick={() => void changeMode('live')}>{data?.control.state === 'active' ? 'Pause & arm' : 'Arm live'}</Button></div>
                      <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">{data?.control.state === 'active' ? 'Automation is running, so arming pauses it first. Press Resume afterwards to begin placing real orders.' : 'Arming only sets the mode. Press Resume afterwards to begin placing real orders.'}</p>
                    </>
                    : <ul className="mt-2 space-y-1">{(data?.liveBlockers ?? []).map((blocker) => <li key={blocker} className="flex gap-1.5 text-[9px] text-muted-foreground"><span className="mt-1 size-1 shrink-0 rounded-full bg-amber-300"/>{blocker}</li>)}</ul>}
              </div>
              <div className="mt-3 flex gap-2"><Button variant="outline" className="flex-1" onClick={() => void action('pause')} disabled={loading || (data?.control.state !== 'active' && !data?.control.autoResumeEligible)}><Pause/>{loading && data?.control.state === 'active' ? 'Pausing · draining…' : data?.control.autoResumeEligible ? 'Cancel auto-resume' : 'Pause live'}</Button><Button className="flex-1" onClick={() => void action('resume')} disabled={loading || !data?.canResume}><Play/>Resume</Button></div>
              {data?.control.pauseReason && <p className="mt-2 text-center text-[9px] text-muted-foreground">{data.control.pauseReason}</p>}
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border p-4"><div className="flex items-center gap-2"><WalletCards className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Account funding</h3></div><div className="mt-3 space-y-2">{data?.venues.map((venue) => <div key={venue.venue} className={cn('rounded-lg border bg-background/40 p-3', !venue.enabled && 'opacity-55')}><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium capitalize">{venue.venue}{venue.environment ? ` · ${venue.environment}` : ''}</span><div className="flex gap-1"><Badge variant="outline" className={venue.enabled ? 'border-primary/20 text-primary' : 'text-muted-foreground'}>{venue.enabled ? 'enabled' : 'disabled'}</Badge><Badge variant="outline" className={venue.tradeReady ? 'border-primary/20 text-primary' : 'text-muted-foreground'}>{venue.tradeReady ? 'trade ready' : venue.connected ? 'read only' : 'not connected'}</Badge></div></div><div className="mt-1 flex items-center justify-between gap-3"><p className="text-[9px] leading-relaxed text-muted-foreground">{venue.reason}</p><span className="shrink-0 font-mono text-xs">{venue.balanceCents === undefined ? '—' : dollars(venue.balanceCents)}</span></div></div>)}</div><details className="mt-3 rounded-lg border bg-background/30"><summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-medium">Kalshi signed connection setup</summary><div className="border-t p-3 text-[9px] leading-relaxed text-muted-foreground"><ol className="list-decimal space-y-1.5 pl-4"><li>Create a dedicated API key in the Kalshi account settings and download its RSA private-key PEM once.</li><li>Store the PEM outside this repository with owner-only permissions.</li><li>Set <code className="font-mono text-foreground">KALSHI_API_KEY_ID</code>, <code className="font-mono text-foreground">KALSHI_PRIVATE_KEY_PATH</code>, and <code className="font-mono text-foreground">KALSHI_BASE_URL</code> in <code className="font-mono text-foreground">.env.local</code>.</li><li>Restart Money Noodle, enable Kalshi above, and apply the venue selection.</li></ol><div className="mt-3 flex items-center justify-between gap-2"><span>Connector: <strong className={kalshiReadiness?.tradeReady ? 'text-primary' : 'text-foreground'}>{kalshiReadiness?.tradeReady ? `signed ${kalshiReadiness.environment} account ready` : kalshiReadiness?.reason ?? 'not checked'}</strong></span><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? <Loader2 className="animate-spin"/> : null}Test connection</Button></div><p className="mt-2">Credentials are read only on the server and are never returned to this dialog.</p></div></details><div className="mt-3 flex items-center justify-between text-[10px]"><span className="text-muted-foreground">Usable connected cash</span><span className="font-mono">{data ? dollars(data.totalUsableBalanceCents) : '—'}</span></div>{data && <Progress value={data.control.availableBudgetCents ? Math.min(100, data.totalUsableBalanceCents / data.control.availableBudgetCents * 100) : 0} className="mt-2"/>}</div>
            <div className="rounded-xl border p-4"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><ShieldCheck className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Resume readiness</h3></div><Badge variant="outline" className={cn('uppercase', data?.reconciliation?.phase === 'ready' ? 'border-primary/25 text-primary' : data?.reconciliation?.phase === 'blocked' ? 'border-red-400/25 text-red-300' : 'border-amber-300/25 text-amber-200')}>reconciliation {data?.reconciliation?.phase ?? 'pending'}</Badge></div>{data?.executionDrain && <div className={cn('mt-3 rounded-lg border p-3', data.executionDrain.restartSafe ? 'border-primary/20 bg-primary/[.03]' : data.executionDrain.phase === 'blocked' ? 'border-red-400/20 bg-red-400/[.03]' : 'border-amber-300/20 bg-amber-300/[.03]')}><div className="flex items-center justify-between gap-2"><p className="text-[9px] font-medium">Execution drain · {data.executionDrain.phase}</p><Badge variant="outline" className={data.executionDrain.restartSafe ? 'border-primary/25 text-primary' : 'text-muted-foreground'}>{data.executionDrain.restartSafe ? 'restart safe' : `${data.executionDrain.workingTransactions} working`}</Badge></div><p className="mt-1 text-[8px] leading-relaxed text-muted-foreground">{data.executionDrain.reason}</p>{data.executionDrain.completedAt && <p className="mt-1 font-mono text-[8px] text-muted-foreground">Completed {new Date(data.executionDrain.completedAt).toLocaleString()}</p>}</div>}{data?.reconciliation && <div className="mt-3 rounded-lg border bg-background/40 p-3"><p className="text-[9px] leading-relaxed text-muted-foreground">{data.reconciliation.reason}</p>{data.reconciliation.nextScheduledAt && <p className="mt-1 font-mono text-[8px] text-muted-foreground">Next periodic check {new Date(data.reconciliation.nextScheduledAt).toLocaleString()} · consecutive failures {data.reconciliation.consecutivePeriodicFailures ?? 0}</p>}{data.reconciliation.phase === 'ready' && <p className="mt-1 font-mono text-[8px] text-primary">Kalshi cash {data.reconciliation.venueBalanceCents === undefined ? '—' : preciseDollars(data.reconciliation.venueBalanceCents)} · {data.reconciliation.localOpenPositions ?? 0} local open · {data.reconciliation.restingOrdersCanceled ?? 0} resting canceled · {data.reconciliation.recoveredFills ?? 0} recovered</p>}<Button variant="outline" size="sm" className="mt-2 w-full" disabled={loading || data.reconciliation.phase === 'running' || data.control.state === 'active'} onClick={() => void action('reconcile')}>{loading || data.reconciliation.phase === 'running' ? <Loader2 className="animate-spin"/> : <ShieldCheck/>}Run authoritative reconciliation</Button></div>}{data?.blockers.length ? <ul className="mt-3 space-y-2">{data.blockers.map((blocker) => <li key={blocker} className="flex gap-2 text-[9px] leading-relaxed text-muted-foreground"><span className="mt-1 size-1.5 shrink-0 rounded-full bg-red-400"/>{blocker}</li>)}</ul> : <p className="mt-3 text-[10px] text-primary">All readiness checks passed.</p>}</div>
          </div>

          {([['Live execution ledger', data?.live, 'Real orders on Kalshi. Runs only while automation is active in live mode.'], ['Paper shadow ledger', data?.paper, 'Runs continuously, including while live is paused, so measurement never stops.']] as const).map(([title, track, note]) => track && <div key={title} className={cn('mt-3 rounded-xl border p-4', track.mode === 'live' ? 'border-red-400/30 bg-red-400/[.03]' : 'border-primary/20 bg-primary/[.02]')}><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className={cn('flex items-center gap-1.5 text-xs font-semibold', track.mode === 'live' ? 'text-red-200' : '')}>{track.mode === 'live' ? <ShieldAlert className="size-3.5"/> : <FlaskConical className="size-3.5"/>}{title}</h3><p className="mt-1 text-[9px] text-muted-foreground">{note}</p></div><div className="flex gap-1.5"><Badge variant="outline" className={track.running ? 'border-primary/20 text-primary' : 'text-muted-foreground'}>{track.running ? 'running' : 'idle'}</Badge><Badge variant="outline">{track.openOrders} open</Badge><Badge variant="outline">{track.wins}W · {track.losses}L</Badge><Badge variant="outline" className={track.realizedPnlCents > 0 ? 'text-primary' : track.realizedPnlCents < 0 ? 'text-red-400' : ''}>{dollars(track.realizedPnlCents)} P&amp;L</Badge></div></div>{track.mode === 'live' && track.blockedReason && <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3"><p className="text-[10px] font-medium text-amber-100">No live order placed on the last cycle</p><p className="mt-0.5 text-[9px] text-muted-foreground">{track.blockedReason}</p></div>}{track.mode === 'paper' && track.depleted && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3"><div className="flex-1"><p className="text-[10px] font-medium text-amber-100">Paper bankroll depleted</p><p className="mt-0.5 text-[9px] text-muted-foreground">Reset to resume shadow tracking. Order history is kept{track.bankrollResets ? ` · ${track.bankrollResets} prior reset${track.bankrollResets === 1 ? '' : 's'}` : ''}.</p></div><div className="flex h-8 items-center rounded-md border bg-background px-2"><span className="text-[10px] text-muted-foreground">$</span><input type="number" min="1" step="1" value={paperBankroll} onChange={(event) => setPaperBankroll(event.target.value)} className="w-16 bg-transparent px-1 font-mono text-[10px] outline-none"/></div><Button size="sm" variant="outline" disabled={loading || !(Number(paperBankroll) > 0)} onClick={() => void action('paper-reset', { paperBankrollDollars: Number(paperBankroll) })}>Reset paper</Button></div>}{track.recentOrders.length ? <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border"><div className="divide-y">{track.recentOrders.map((order) => <div key={order.id} className="grid gap-2 p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center"><div><div className="flex items-center gap-2"><span className="text-xs font-semibold">{order.symbol}</span><Badge variant="outline" className={order.side === 'UP' ? 'text-primary' : 'text-red-300'}>{order.side}</Badge><Badge variant="outline" className="uppercase">{order.venue}</Badge><Badge variant="outline" className={order.status === 'won' ? 'text-primary' : order.status === 'lost' || order.status === 'rejected' || order.status === 'uncertain' ? 'text-red-400' : order.status === 'unfilled' || order.status === 'sold' ? 'text-amber-200' : 'text-muted-foreground'}>{attemptOutcome(order.status, order.noFillReason, order.filledCount)}</Badge>{order.recoveredAfterRetry && <Badge variant="outline" className="border-primary/25 text-primary">recovered on retry</Badge>}</div><p className="mt-1 font-mono text-[8px] text-muted-foreground">{new Date(order.createdAt).toLocaleString()} · {order.side} ask {(order.askPrice * 100).toFixed(1)}¢ · spread {(order.spread * 100).toFixed(1)}¢{order.venueOrderId ? ` · order ${order.venueOrderId.slice(0, 8)}` : ''}{order.liquidityRole ? ` · ${order.liquidityRole}` : ''}</p>{order.profitLockArmedAt && <p className="mt-1 font-mono text-[8px] text-amber-200">75% profit lock armed · peak {order.peakNetProfitPercent === undefined ? '—' : `+${(order.peakNetProfitPercent * 100).toFixed(1)}%`}</p>}{order.reason && <p className={cn('mt-1 text-[8px]', order.status === 'rejected' ? 'text-red-300' : 'text-muted-foreground')}>{order.reason}</p>}{(order.attemptHistory?.length ?? 0) > 1 && <p className="mt-1 font-mono text-[8px] text-muted-foreground">{order.attemptHistory!.map((attempt) => `attempt ${attempt.attemptNumber} ${attemptOutcome(attempt.status, attempt.noFillReason, attempt.filledCount)}`).join(' → ')}</p>}</div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">Contracts</p><p className="font-mono text-xs">{order.quantity}</p></div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">Stake + fee</p><p className="font-mono text-xs">{preciseDollars(order.actualStakeCents ?? order.stakeCents)} <span className="text-[8px] text-muted-foreground">({preciseDollars(order.actualFeeCents ?? order.feeCents)})</span></p></div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">P&amp;L</p><p className={cn('font-mono text-xs', (order.pnlCents ?? 0) > 0 ? 'text-primary' : (order.pnlCents ?? 0) < 0 ? 'text-red-400' : '')}>{order.pnlCents === undefined && order.actualPnlCents === undefined ? '—' : preciseDollars(order.actualPnlCents ?? order.pnlCents ?? 0)}</p></div></div>)}</div></div> : <div className="mt-3 rounded-lg border border-dashed p-5 text-center text-[10px] text-muted-foreground">No orders in this ledger yet.</div>}</div>)}

          {data?.recentAudit.length ? <details className="mt-3 rounded-xl border"><summary className="cursor-pointer list-none px-4 py-3 text-[10px] text-muted-foreground">Recent control audit ({data.recentAudit.length})</summary><div className="divide-y border-t">{data.recentAudit.map((entry) => <div key={entry.id} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[120px_1fr_auto]"><span className="font-mono text-[9px] uppercase">{entry.type}</span><span className="text-[9px] text-muted-foreground">{entry.reason}</span><span className="font-mono text-[8px] text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</span></div>)}</div></details> : null}
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}
