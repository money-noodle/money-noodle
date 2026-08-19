'use client';

import { useState } from 'react';
import { CircleDollarSign, FlaskConical, Loader2, Pause, Play, Radio, Save, ShieldAlert, ShieldCheck, WalletCards } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AllocationDialog } from '@/components/allocation-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { fundingScopeLine, fundingScopeTitle } from '@/lib/funding-label';
import type { TradingControlData, TradingProviderDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => usd.format(cents / 100);
const preciseDollars = (cents: number) => Number.isInteger(cents) ? dollars(cents) : `$${(cents / 100).toFixed(4)}`;
const attemptOutcome = (status: string, noFillReason?: 'post_only_race' | 'rested_no_fill' | 'pre_submit_quote_moved' | 'ioc_no_fill', filledCount?: number) =>
  noFillReason === 'post_only_race' ? 'post-only race'
    : noFillReason === 'rested_no_fill' ? 'rested · no fill'
      : noFillReason === 'pre_submit_quote_moved' ? 'quote moved · not submitted'
      : noFillReason === 'ioc_no_fill' ? 'IOC accepted · no fill'
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

  async function updateTradingProvider(provider: TradingProviderDescriptor, field: 'researchEnabled' | 'paperEnabled' | 'liveEnabled', value: boolean) {
    const requiredConfirmation = `ENABLE LIVE ${provider.id.toUpperCase()}`;
    const confirmation = field === 'liveEnabled' && value
      ? window.prompt(`Type ${requiredConfirmation} exactly to enable real-money execution for ${provider.name}.`) ?? ''
      : undefined;
    if (field === 'liveEnabled' && value && confirmation !== requiredConfirmation) {
      setError(`${provider.name} live enablement was not confirmed.`);
      return;
    }
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/trading/providers', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: provider.id, [field]: value, selectedVariantId: provider.selectedVariantId,
          confirmation,
          reason: `${field} ${value ? 'enabled' : 'disabled'} by operator in Budget.`,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Provider update failed');
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Provider update failed'); }
    finally { setLoading(false); }
  }

  const kalshiReadiness = data?.venues.find((venue) => venue.venue === 'kalshi');
  const liveMode = data?.control.mode === 'live';
  const stateColor = data?.control.state === 'active' ? 'border-data/20 text-data' : data?.control.state === 'depleted' ? 'border-warn/20 text-warn' : 'text-muted-foreground';
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
            return <div className={cn('mb-4 flex items-start gap-3 rounded-lg border p-3', active && live ? 'border-live/40 bg-live/[.07]' : active ? 'border-primary/25 bg-primary/[.05]' : 'border-primary/15 bg-primary/[.035]')}>
              {active ? <Radio className="mt-0.5 size-4 shrink-0 text-primary"/> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary"/>}
              <div>
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium">{active && <span className="relative flex size-2"><span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', live ? 'bg-live' : 'bg-primary')}/><span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-live' : 'bg-primary')}/></span>}{active ? (live ? 'LIVE trading active — real orders with real money' : 'PAPER trading active — simulated orders, no real money') : recoveryArmed ? 'Safety suspension — guarded auto-resume armed' : 'Automation is not placing orders'}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{active
                  ? `Armed on ${armed.join(' + ') || 'no venue'}. Each qualifying buy reserves an all-in cap, posts up to ${data?.maximumLiveMakerAttempts ?? 1} managed passive Kalshi attempt${(data?.maximumLiveMakerAttempts ?? 1) === 1 ? '' : 's'}, cancels any remainder, and releases unused principal and fee reserve. Limits: ${data?.portfolioConstraints?.maximumPositions ?? 3} concurrent, ${data?.portfolioConstraints?.maximumSameWindow ?? 2} per window, ${data?.portfolioConstraints?.maximumSameGroupPerWindow ?? 1} per correlation group, ${dollars(data?.live?.proposedStakeCents ?? 0)} next purchase cap, ${data?.liveRisk.maximumCurrentEpochDrawdownPercent.toFixed(1) ?? '25.0'}% current-budget drawdown stop, ${dollars(data?.liveRisk.maximumLifetimeLossCents ?? 50)} lifetime-loss stop.`
                  : recoveryArmed ? 'The system retained your active intent but is placing no orders. It will resume only after authoritative reconciliation and every normal readiness check pass. Press Cancel auto-resume to withdraw permission.' : 'Resume starts the selected execution mode only when reconciliation and both live loss limits pass. Live remains protected by typed arming, environment opt-in, balance checks, per-purchase caps, and the kill switch.'}</p>
              </div>
            </div>;
          })()}
          {error && <div className="mb-4 rounded-lg border border-loss/20 bg-loss/5 p-3 text-xs text-loss">{error}</div>}
          {data && !data.liveRisk.allowed && <div className="mb-4 rounded-lg border border-loss/30 bg-loss/[.07] p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-loss"><ShieldAlert className="size-4"/>Live loss circuit breaker</p>
            <ul className="mt-2 space-y-1">{data.liveRisk.reasons.map((reason) => <li key={reason} className="text-[9px] leading-relaxed text-loss/80">{reason}</li>)}</ul>
            <p className="mt-2 font-mono text-[9px] text-muted-foreground">Current drawdown {preciseDollars(data.liveRisk.currentEpochDrawdownCents)} / {preciseDollars(data.liveRisk.maximumCurrentEpochDrawdownCents)} · lifetime P&amp;L {preciseDollars(data.liveRisk.lifetimeRealizedPnlCents)} / −{preciseDollars(data.liveRisk.maximumLifetimeLossCents)} limit</p>
            <p className="mt-1 text-[9px] text-muted-foreground">Reconciliation cannot auto-clear an economic risk stop. Review the evidence and deliberately change server-side limits before Resume can pass.</p>
          </div>}
          {data?.regimeGate && data.regimeGate.phase !== 'disabled' && <div className={cn('mb-4 rounded-lg border p-3', data.regimeGate.phase === 'closed' ? 'border-warn/30 bg-warn/[.06]' : 'border-data/20 bg-data/[.03]')}>
            <div className="flex flex-wrap items-center justify-between gap-2"><p className={cn('flex items-center gap-2 text-xs font-semibold', data.regimeGate.phase === 'closed' ? 'text-warn' : 'text-data')}><ShieldAlert className="size-4"/>Adaptive regime gate</p><Badge variant="outline" className="uppercase">{data.regimeGate.phase}</Badge></div>
            <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">{data.regimeGate.reason}</p>
            <p className="mt-2 font-mono text-[9px] text-muted-foreground">Current-policy windows {data.regimeGate.resolvedWindows}/{data.regimeGate.configured.minimumPolicyWindows} · effective {data.regimeGate.effectiveWindows.toFixed(1)} · recent edge {data.regimeGate.weightedMeanEdge === null ? '—' : `${(data.regimeGate.weightedMeanEdge * 100).toFixed(1)}pp`} · negative confidence {data.regimeGate.negativeReturnConfidence === null ? '—' : `${(data.regimeGate.negativeReturnConfidence * 100).toFixed(1)}%`}</p>
            <p className="mt-1 text-[9px] text-muted-foreground">This soft gate blocks only new entries. It keeps operator intent active, continues exits and reconciliation, and reopens automatically from independent sentinel evidence.</p>
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
              <label className="mt-3 block text-[9px] uppercase tracking-wider text-muted-foreground">Trading providers</label>
              <p className="mt-1 text-[8px] leading-relaxed text-muted-foreground">Research, paper, and live permissions are independent. Changes require a paused, quiescent execution engine. Planned providers fail closed.</p>
              <div className="mt-2 space-y-2">{data?.tradingProviders?.map((provider) => <div key={provider.id} className="rounded-lg border bg-background/40 p-2.5"><div className="flex items-start justify-between gap-2"><div><p className="text-[10px] font-medium">{provider.name}</p><p className="mt-0.5 font-mono text-[7px] text-muted-foreground">{provider.selectedVariantId}</p></div><Badge variant="outline" className="text-[8px]">{provider.implementation}</Badge></div><p className="mt-1 text-[8px] leading-relaxed text-muted-foreground">{provider.readiness}</p><div className="mt-2 grid grid-cols-3 gap-1">{([
                ['researchEnabled', 'Research', provider.capabilities.marketData], ['paperEnabled', 'Paper', provider.capabilities.paper], ['liveEnabled', 'Live', provider.capabilities.live],
              ] as const).map(([field, label, supported]) => { const enabled = provider[field]; return <button type="button" key={field} disabled={loading || data.control.state === 'active' || !data.executionDrain?.restartSafe || !supported} onClick={() => void updateTradingProvider(provider, field, !enabled)} className={cn('rounded border px-1.5 py-1.5 text-[8px] transition disabled:cursor-not-allowed disabled:opacity-40', enabled ? field === 'liveEnabled' ? 'border-live/35 bg-live/[.06] text-live' : 'border-primary/25 bg-primary/[.05] text-primary' : 'text-muted-foreground')}>{label} · {supported ? enabled ? 'on' : 'off' : 'unavailable'}</button>; })}</div></div>)}</div>
              <div className="mt-3"><Button className="w-full" onClick={() => void action('configure')} disabled={loading || data?.control.state === 'active' || Boolean(data?.control.reservedBudgetCents) || !(Number(budget) > 0) || !(Number(perTrade) >= 0.02) || Number(perTrade) > Number(budget)}>{loading ? <Loader2 className="animate-spin"/> : <Save/>}Save budget</Button></div>
              {/* This dialog sets the size of the pot; splitting it across markets and strategies lives next door. */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-2.5">
                <p className="text-[9px] leading-relaxed text-muted-foreground">Split this budget across markets and strategies.</p>
                <AllocationDialog variant="badge"/>
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <div className="flex items-center justify-between"><div><h3 className="text-xs font-semibold">Working ledgers</h3><p className="mt-1 text-[9px] text-muted-foreground">Two independent bankrolls. Live risks real money; paper never touches it.</p></div><Badge variant="outline" className={cn('uppercase', data?.control.mode === 'live' ? 'border-live/30 text-live' : 'border-primary/25 text-primary')}>{data?.control.mode ?? 'paper'} armed</Badge></div>
              {([['Live', data?.live, `Venue budget · ${dollars(data?.control.perTradeCents ?? Math.round(Number(perTrade) * 100))} all-in per purchase`], ['Paper', data?.paper, `Shadow bankroll · same all-in purchase cap, separate simulated cash`]] as const).map(([label, track, note]) => {
                const isLive = label === 'Live';
                return <div key={label} className={cn('mt-3 rounded-lg border p-3', isLive ? 'border-live/25 bg-live/[.03]' : 'border-primary/20 bg-primary/[.02]')}>
                  <div className="flex items-center justify-between gap-2">
                    <p className={cn('flex items-center gap-1.5 text-[11px] font-semibold', isLive ? 'text-live' : '')}>{isLive ? <ShieldAlert className="size-3.5"/> : <FlaskConical className="size-3.5"/>}{label} ledger</p>
                    <Badge variant="outline" className={cn('text-[9px]', track?.running ? (isLive ? 'border-live/35 text-live' : 'border-primary/30 text-primary') : 'text-muted-foreground')}>{track?.running ? 'trading' : 'idle'}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Equity</p><p className="mt-0.5 font-mono text-base">{track ? dollars(track.equityCents) : '—'}</p></div>
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Available</p><p className="mt-0.5 font-mono text-base">{track ? dollars(track.availableCents) : '—'}</p></div>
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Reserved</p><p className="mt-0.5 font-mono text-base">{track ? dollars(track.reservedCents) : '—'}</p></div>
                    {/* Two different quantities, never one. The first is the only one that reconciles:
                        starting + this epoch's P&L is the equity above it. Lifetime spans earlier
                        fundings and deliberately does not tie to anything on this row. */}
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">{track?.pnlScope === 'budget-epoch' ? 'Budget P&L' : 'Realized P&L'}</p><p className={cn('mt-0.5 font-mono text-base', (track?.realizedPnlCents ?? 0) > 0 ? 'text-gain' : (track?.realizedPnlCents ?? 0) < 0 ? 'text-loss' : '')}>{track ? dollars(track.realizedPnlCents) : '—'}</p><p className="mt-0.5 text-[8px] leading-relaxed text-muted-foreground" title={fundingScopeTitle(track ?? {})}>{fundingScopeLine(track ?? {})}</p></div>
                    <div className="rounded-md bg-secondary/50 p-2.5"><p className="text-[8px] uppercase text-muted-foreground">Lifetime P&L</p><p className={cn('mt-0.5 font-mono text-base', (track?.lifetimePnlCents ?? 0) > 0 ? 'text-gain' : (track?.lifetimePnlCents ?? 0) < 0 ? 'text-loss' : '')}>{track ? dollars(track.lifetimePnlCents) : '—'}</p><p className="mt-0.5 text-[8px] text-muted-foreground">{track?.pnlScope === 'budget-epoch' ? 'across all fundings' : 'same as above'}</p></div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2"><span className="text-[9px] text-muted-foreground">{note}</span><span className="shrink-0 text-right"><span className="text-[8px] uppercase text-muted-foreground">Next all-in cap </span><span className={cn('font-mono text-base', isLive ? 'text-live' : 'text-primary')}>{track ? dollars(track.proposedStakeCents) : '—'}</span></span></div>
                </div>;
              })}
              <div className="mt-4 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2"><div><p className="text-[10px] font-medium">Execution mode</p><p className="mt-0.5 text-[9px] text-muted-foreground">Paper always runs and is tracked separately. Live places real orders.</p></div>
                  <Badge variant="outline" className={cn('uppercase', liveMode ? 'border-live/30 text-live' : 'border-primary/25 text-primary')}>{data?.control.mode ?? 'paper'}</Badge></div>
                {liveMode
                  ? <Button variant="outline" size="sm" className="mt-2 w-full" disabled={loading} onClick={() => void changeMode('paper')}>{data?.control.state === 'active' ? 'Pause and switch back to paper' : 'Switch back to paper'}</Button>
                  : data?.liveAvailable
                    ? <>
                      <div className="mt-2 flex gap-2"><input value={liveConfirm} onChange={(event) => setLiveConfirm(event.target.value)} placeholder="Type TRADE LIVE" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[10px] outline-none"/><Button size="sm" variant="outline" className="shrink-0 border-live/30 text-live" disabled={loading || liveConfirm !== 'TRADE LIVE'} onClick={() => void changeMode('live')}>{data?.control.state === 'active' ? 'Pause & arm' : 'Arm live'}</Button></div>
                      <p className="mt-1.5 text-[9px] leading-relaxed text-muted-foreground">{data?.control.state === 'active' ? 'Automation is running, so arming pauses it first. Press Resume afterwards to begin placing real orders.' : 'Arming only sets the mode. Press Resume afterwards to begin placing real orders.'}</p>
                    </>
                    : <ul className="mt-2 space-y-1">{(data?.liveBlockers ?? []).map((blocker) => <li key={blocker} className="flex gap-1.5 text-[9px] text-muted-foreground"><span className="mt-1 size-1 shrink-0 rounded-full bg-warn"/>{blocker}</li>)}</ul>}
              </div>
              <div className="mt-3 flex gap-2"><Button variant="outline" className="flex-1" onClick={() => void action('pause')} disabled={loading || (data?.control.state !== 'active' && !data?.control.autoResumeEligible)}><Pause/>{loading && data?.control.state === 'active' ? 'Pausing · draining…' : data?.control.autoResumeEligible ? 'Cancel auto-resume' : 'Pause live'}</Button><Button className="flex-1" onClick={() => void action('resume')} disabled={loading || !data?.canResume}><Play/>Resume</Button></div>
              {data?.control.pauseReason && <p className="mt-2 text-center text-[9px] text-muted-foreground">{data.control.pauseReason}</p>}
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border p-4"><div className="flex items-center gap-2"><WalletCards className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Account funding</h3></div><div className="mt-3 space-y-2">{data?.venues.map((venue) => <div key={venue.venue} className={cn('rounded-lg border bg-background/40 p-3', !venue.enabled && 'opacity-55')}><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium capitalize">{venue.venue}{venue.environment ? ` · ${venue.environment}` : ''}</span><div className="flex gap-1"><Badge variant="outline" className={venue.enabled ? 'border-data/20 text-data' : 'text-muted-foreground'}>{venue.enabled ? 'enabled' : 'disabled'}</Badge><Badge variant="outline" className={venue.tradeReady ? 'border-data/20 text-data' : 'text-muted-foreground'}>{venue.tradeReady ? 'trade ready' : venue.connected ? 'read only' : 'not connected'}</Badge></div></div><div className="mt-1 flex items-center justify-between gap-3"><p className="text-[9px] leading-relaxed text-muted-foreground">{venue.reason}</p><span className="shrink-0 font-mono text-xs">{venue.balanceCents === undefined ? '—' : dollars(venue.balanceCents)}</span></div></div>)}</div><details className="mt-3 rounded-lg border bg-background/30"><summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-medium">Kalshi signed connection setup</summary><div className="border-t p-3 text-[9px] leading-relaxed text-muted-foreground"><ol className="list-decimal space-y-1.5 pl-4"><li>Create a dedicated API key in the Kalshi account settings and download its RSA private-key PEM once.</li><li>Store the PEM outside this repository with owner-only permissions.</li><li>Set <code className="font-mono text-foreground">KALSHI_API_KEY_ID</code>, <code className="font-mono text-foreground">KALSHI_PRIVATE_KEY_PATH</code>, and <code className="font-mono text-foreground">KALSHI_BASE_URL</code> in <code className="font-mono text-foreground">.env.local</code>.</li><li>Restart Money Noodle, enable Kalshi above, and apply the venue selection.</li></ol><div className="mt-3 flex items-center justify-between gap-2"><span>Connector: <strong className={kalshiReadiness?.tradeReady ? 'text-data' : 'text-foreground'}>{kalshiReadiness?.tradeReady ? `signed ${kalshiReadiness.environment} account ready` : kalshiReadiness?.reason ?? 'not checked'}</strong></span><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? <Loader2 className="animate-spin"/> : null}Test connection</Button></div><p className="mt-2">Credentials are read only on the server and are never returned to this dialog.</p></div></details><div className="mt-3 flex items-center justify-between text-[10px]"><span className="text-muted-foreground">Usable connected cash</span><span className="font-mono">{data ? dollars(data.totalUsableBalanceCents) : '—'}</span></div>{data && <Progress value={data.control.availableBudgetCents ? Math.min(100, data.totalUsableBalanceCents / data.control.availableBudgetCents * 100) : 0} className="mt-2"/>}</div>
            <div className="rounded-xl border p-4"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><ShieldCheck className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Resume readiness</h3></div><Badge variant="outline" className={cn('uppercase', data?.reconciliation?.phase === 'ready' ? 'border-data/25 text-data' : data?.reconciliation?.phase === 'blocked' ? 'border-loss/25 text-loss' : 'border-warn/25 text-warn')}>reconciliation {data?.reconciliation?.phase ?? 'pending'}</Badge></div>{data?.executionDrain && <div className={cn('mt-3 rounded-lg border p-3', data.executionDrain.restartSafe ? 'border-data/20 bg-data/[.03]' : data.executionDrain.phase === 'blocked' ? 'border-loss/20 bg-loss/[.03]' : 'border-warn/20 bg-warn/[.03]')}><div className="flex items-center justify-between gap-2"><p className="text-[9px] font-medium">Execution drain · {data.executionDrain.phase}</p><Badge variant="outline" className={data.executionDrain.restartSafe ? 'border-data/25 text-data' : 'text-muted-foreground'}>{data.executionDrain.restartSafe ? 'restart safe' : `${data.executionDrain.workingTransactions} working`}</Badge></div><p className="mt-1 text-[8px] leading-relaxed text-muted-foreground">{data.executionDrain.reason}</p>{data.executionDrain.completedAt && <p className="mt-1 font-mono text-[8px] text-muted-foreground">Completed {new Date(data.executionDrain.completedAt).toLocaleString()}</p>}</div>}{data?.reconciliation && <div className="mt-3 rounded-lg border bg-background/40 p-3"><p className="text-[9px] leading-relaxed text-muted-foreground">{data.reconciliation.reason}</p>{data.reconciliation.nextScheduledAt && <p className="mt-1 font-mono text-[8px] text-muted-foreground">Next periodic check {new Date(data.reconciliation.nextScheduledAt).toLocaleString()} · consecutive failures {data.reconciliation.consecutivePeriodicFailures ?? 0}</p>}{data.reconciliation.phase === 'ready' && <p className="mt-1 font-mono text-[8px] text-data">Kalshi cash {data.reconciliation.venueBalanceCents === undefined ? '—' : preciseDollars(data.reconciliation.venueBalanceCents)} · {data.reconciliation.localOpenPositions ?? 0} local open · {data.reconciliation.restingOrdersCanceled ?? 0} resting canceled · {data.reconciliation.recoveredFills ?? 0} recovered</p>}<Button variant="outline" size="sm" className="mt-2 w-full" disabled={loading || data.reconciliation.phase === 'running' || data.control.state === 'active'} onClick={() => void action('reconcile')}>{loading || data.reconciliation.phase === 'running' ? <Loader2 className="animate-spin"/> : <ShieldCheck/>}Run authoritative reconciliation</Button></div>}{data?.blockers.length ? <ul className="mt-3 space-y-2">{data.blockers.map((blocker) => <li key={blocker} className="flex gap-2 text-[9px] leading-relaxed text-muted-foreground"><span className="mt-1 size-1.5 shrink-0 rounded-full bg-loss"/>{blocker}</li>)}</ul> : <p className="mt-3 text-[10px] text-data">All readiness checks passed.</p>}</div>
          </div>

          {([['Live execution ledger', data?.live, 'Real orders on Kalshi. Runs only while automation is active in live mode.'], ['Paper shadow ledger', data?.paper, 'Runs continuously, including while live is paused, so measurement never stops.']] as const).map(([title, track, note]) => track && <div key={title} className={cn('mt-3 rounded-xl border p-4', track.mode === 'live' ? 'border-live/30 bg-live/[.03]' : 'border-primary/20 bg-primary/[.02]')}><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className={cn('flex items-center gap-1.5 text-xs font-semibold', track.mode === 'live' ? 'text-live' : '')}>{track.mode === 'live' ? <ShieldAlert className="size-3.5"/> : <FlaskConical className="size-3.5"/>}{title}</h3><p className="mt-1 text-[9px] text-muted-foreground">{note}</p></div><div className="flex gap-1.5"><Badge variant="outline" className={track.running ? 'border-data/20 text-data' : 'text-muted-foreground'}>{track.running ? 'running' : 'idle'}</Badge><Badge variant="outline">{track.openOrders} open</Badge><Badge variant="outline">{track.wins}W · {track.losses}L</Badge><Badge variant="outline" className={track.realizedPnlCents > 0 ? 'text-gain' : track.realizedPnlCents < 0 ? 'text-loss' : ''}>{dollars(track.realizedPnlCents)} {track.pnlScope === 'budget-epoch' ? 'budget' : ''} P&amp;L</Badge></div></div>{track.mode === 'live' && track.blockedReason && <div className="mt-3 rounded-lg border border-warn/25 bg-warn/5 p-3"><p className="text-[10px] font-medium text-warn">No live order placed on the last cycle</p><p className="mt-0.5 text-[9px] text-muted-foreground">{track.blockedReason}</p></div>}{track.mode === 'paper' && track.depleted && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn/25 bg-warn/5 p-3"><div className="flex-1"><p className="text-[10px] font-medium text-warn">Paper bankroll depleted</p><p className="mt-0.5 text-[9px] text-muted-foreground">Reset to resume shadow tracking. Order history is kept{track.bankrollResets ? ` · ${track.bankrollResets} prior reset${track.bankrollResets === 1 ? '' : 's'}` : ''}.</p></div><div className="flex h-8 items-center rounded-md border bg-background px-2"><span className="text-[10px] text-muted-foreground">$</span><input type="number" min="1" step="1" value={paperBankroll} onChange={(event) => setPaperBankroll(event.target.value)} className="w-16 bg-transparent px-1 font-mono text-[10px] outline-none"/></div><Button size="sm" variant="outline" disabled={loading || !(Number(paperBankroll) > 0)} onClick={() => void action('paper-reset', { paperBankrollDollars: Number(paperBankroll) })}>Reset paper</Button></div>}{track.recentOrders.length ? <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border"><div className="divide-y">{track.recentOrders.map((order) => <div key={order.id} className="grid gap-2 p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center"><div><div className="flex items-center gap-2"><span className="text-xs font-semibold">{order.symbol}</span><Badge variant="outline" className={order.side === 'UP' ? 'text-gain' : 'text-loss'}>{order.side}</Badge><Badge variant="outline" className="uppercase">{order.venue}</Badge><Badge variant="outline" className={order.status === 'won' ? 'text-gain' : order.status === 'lost' ? 'text-loss' : order.status === 'rejected' || order.status === 'uncertain' ? 'text-warn' : order.status === 'unfilled' || order.status === 'sold' ? 'text-warn' : 'text-muted-foreground'}>{attemptOutcome(order.status, order.noFillReason, order.filledCount)}</Badge>{order.recoveredAfterRetry && <Badge variant="outline" className="border-data/25 text-data">recovered on retry</Badge>}</div><p className="mt-1 font-mono text-[8px] text-muted-foreground">{new Date(order.createdAt).toLocaleString()} · {order.side} ask {(order.askPrice * 100).toFixed(1)}¢ · spread {(order.spread * 100).toFixed(1)}¢{order.venueOrderId ? ` · order ${order.venueOrderId.slice(0, 8)}` : ''}{order.liquidityRole ? ` · ${order.liquidityRole}` : ''}</p>{order.profitLockArmedAt && <p className="mt-1 font-mono text-[8px] text-warn">75% profit lock armed · peak {order.peakNetProfitPercent === undefined ? '—' : `+${(order.peakNetProfitPercent * 100).toFixed(1)}%`}</p>}{order.reason && <p className={cn('mt-1 text-[8px]', order.status === 'rejected' ? 'text-warn' : 'text-muted-foreground')}>{order.reason}</p>}{(order.attemptHistory?.length ?? 0) > 1 && <p className="mt-1 font-mono text-[8px] text-muted-foreground">{order.attemptHistory!.map((attempt) => `attempt ${attempt.attemptNumber} ${attemptOutcome(attempt.status, attempt.noFillReason, attempt.filledCount)}`).join(' → ')}</p>}</div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">Contracts</p><p className="font-mono text-xs">{order.quantity}</p></div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">Stake + fee</p><p className="font-mono text-xs">{preciseDollars(order.actualStakeCents ?? order.stakeCents)} <span className="text-[8px] text-muted-foreground">({preciseDollars(order.actualFeeCents ?? order.feeCents)})</span></p></div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">P&amp;L</p><p className={cn('font-mono text-xs', (order.pnlCents ?? 0) > 0 ? 'text-gain' : (order.pnlCents ?? 0) < 0 ? 'text-loss' : '')}>{order.pnlCents === undefined && order.actualPnlCents === undefined ? '—' : preciseDollars(order.actualPnlCents ?? order.pnlCents ?? 0)}</p></div></div>)}</div></div> : <div className="mt-3 rounded-lg border border-dashed p-5 text-center text-[10px] text-muted-foreground">No orders in this ledger yet.</div>}</div>)}

          {data?.recentAudit.length ? <details className="mt-3 rounded-xl border"><summary className="cursor-pointer list-none px-4 py-3 text-[10px] text-muted-foreground">Recent control audit ({data.recentAudit.length})</summary><div className="divide-y border-t">{data.recentAudit.map((entry) => <div key={entry.id} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[120px_1fr_auto]"><span className="font-mono text-[9px] uppercase">{entry.type}</span><span className="text-[9px] text-muted-foreground">{entry.reason}</span><span className="font-mono text-[8px] text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</span></div>)}</div></details> : null}
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}
