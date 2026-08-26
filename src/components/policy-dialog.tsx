'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, ChevronDown, Clock3, Cpu, History, Layers3, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { Badge, inlineTrigger } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { ModelPromotionAction, ModelPromotionEntry, PolicyManifestModel, PolicyManifest, TradingProviderDescriptor, WalkForwardParameters } from '@/lib/types';
import { cn } from '@/lib/utils';

const shortPolicy = (version: string) => version.match(/v\d+$/)?.[0] ?? version;
const returnPercent = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

function PromotionEntry({ entry, current }: { entry: ModelPromotionEntry; current: boolean }) {
  const parameters = entry.parameters;
  return <div className={cn('rounded-xl border p-4', current && 'border-data/25 bg-data/[.03]')}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="break-all font-mono text-[10px] font-semibold">{entry.modelVersion}</p>
        <p className="mt-1 flex items-center gap-1 text-[9px] text-muted-foreground"><Clock3 className="size-3"/>{new Date(entry.at).toLocaleString()}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {current && <Badge variant="outline" className="border-data/25 text-data">in production</Badge>}
        <Badge variant="outline" className={cn('uppercase', entry.action === 'rolled-back' ? 'border-warn/30 text-warn' : 'text-muted-foreground')}>{entry.action}</Badge>
      </div>
    </div>
    <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{entry.reason}</p>
    {entry.evidence && <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg border bg-background/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Candidate</p><p className="font-mono text-[11px]">{returnPercent(entry.evidence.candidateMeanWindowReturn)}</p></div>
      <div className="rounded-lg border bg-background/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Baseline</p><p className="font-mono text-[11px]">{returnPercent(entry.evidence.baselineMeanWindowReturn)}</p></div>
      <div className="rounded-lg border bg-background/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Held-out trades</p><p className="font-mono text-[11px]">{entry.evidence.candidateTrades}</p></div>
      <div className="rounded-lg border bg-background/40 p-2"><p className="text-[8px] uppercase text-muted-foreground">Folds</p><p className="font-mono text-[11px]">{entry.evidence.positiveCandidateFolds}+ · {entry.evidence.candidateBeatBaselineFolds} beat</p></div>
    </div>}
    <p className="mt-2 break-words font-mono text-[8px] text-muted-foreground">
      temperature {parameters.temperature} · basis weight {parameters.basisWeight} · volatility ×{parameters.volatilityScale} · slow tilt ×{parameters.slowTiltScale} · cap {(parameters.probabilityCap * 100).toFixed(0)}–{((1 - parameters.probabilityCap) * 100).toFixed(0)}% · edge ≥{(parameters.minimumEdge * 100).toFixed(0)}pp · quality ≥{(parameters.minimumQuality * 100).toFixed(0)}%
    </p>
    {(entry.evidenceRunId || entry.supersedesId) && <p className="mt-1 break-all font-mono text-[8px] text-muted-foreground">
      {entry.evidenceRunId ? `Evidence run: ${entry.evidenceRunId}` : 'No evidence run cited'}{entry.supersedesId ? ` · supersedes ${entry.supersedesId}` : ''}
    </p>}
  </div>;
}

interface PromotionState {
  running: { modelVersion: string; parameters: WalkForwardParameters };
  ledger: ModelPromotionEntry[];
  eligibility: { eligible: boolean; runId?: string; criteria: Array<{ id: string; met: boolean; detail: string }> };
  latestRunId?: string;
  confirmations: Record<ModelPromotionAction, string>;
}

/**
 * The operator's write path into the promotion ledger.
 *
 * It submits the model the server reports as running rather than anything typed here, so the recorded
 * entry cannot describe a model production is not using. Everything else is the server's decision: the
 * route re-checks eligibility, quiescence, and the running model, and this form only makes the refusal
 * legible before the request is sent. Nothing renders for an unauthenticated viewer, because the GET
 * that feeds it is itself authenticated.
 */
function ModelPromotionControls() {
  const [state, setState] = useState<PromotionState | null>(null);
  const [action, setAction] = useState<ModelPromotionAction>('promoted');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [supersedesId, setSupersedesId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recorded, setRecorded] = useState<ModelPromotionEntry | null>(null);

  useEffect(() => {
    let active = true;
    void fetch('/api/model/promotion', { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<PromotionState> : null)
      .then((body) => { if (active && body) setState(body); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  if (!state) return null;

  const required = state.confirmations[action];
  const rollback = action === 'rolled-back';
  const unmet = state.eligibility.criteria.filter((item) => !item.met);
  // Mirrors the server's rules so the button explains itself; the route enforces them regardless.
  const blocked = !reason.trim() || confirmation !== required
    || (rollback ? !supersedesId : !state.latestRunId || !state.eligibility.eligible);

  async function submit() {
    if (!state) return;
    setBusy(true); setError(''); setRecorded(null);
    try {
      const response = await fetch('/api/model/promotion', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action, modelVersion: state.running.modelVersion, parameters: state.running.parameters,
          reason, confirmation,
          evidenceRunId: rollback ? undefined : state.latestRunId,
          supersedesId: rollback ? supersedesId : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to record the model decision.');
      setState({ ...state, ledger: body.ledger });
      setRecorded(body.entry);
      setReason(''); setConfirmation(''); setSupersedesId('');
    } catch (reasonCaught) {
      setError(reasonCaught instanceof Error ? reasonCaught.message : 'Unable to record the model decision.');
    } finally { setBusy(false); }
  }

  return <div className="mt-3 rounded-xl border border-warn/25 bg-warn/[.03] p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn"/>
        <div>
          <p className="text-[10px] font-semibold text-warn">Record a promotion or rollback</p>
          <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
            Production parameters are compile-time constants, so this records a decision about the deployed model — it cannot change what production forecasts with. Requires paused automation and a quiescent, restart-safe drain.
          </p>
        </div>
      </div>
      <div className="flex gap-1">
        {(['promoted', 'rolled-back'] as const).map((option) => (
          <Button key={option} size="sm" variant={action === option ? 'secondary' : 'ghost'} className="h-7 text-[9px]"
            onClick={() => { setAction(option); setConfirmation(''); setError(''); }}>
            {option === 'promoted' ? 'Promote' : 'Roll back'}
          </Button>
        ))}
      </div>
    </div>

    <p className="mt-3 break-all font-mono text-[8px] text-muted-foreground">
      Records {state.running.modelVersion} · basis {state.running.parameters.basisWeight} · temperature {state.running.parameters.temperature} · edge ≥{(state.running.parameters.minimumEdge * 100).toFixed(0)}pp{rollback ? '' : ` · evidence run ${state.latestRunId ?? 'none recorded'}`}
    </p>

    {!rollback && <div className="mt-2 space-y-1">
      {state.eligibility.criteria.map((item) => (
        <p key={item.id} className={cn('flex items-start gap-1.5 text-[9px]', item.met ? 'text-muted-foreground' : 'text-warn')}>
          {item.met ? <CheckCircle2 className="mt-0.5 size-2.5 shrink-0 text-data"/> : <XCircle className="mt-0.5 size-2.5 shrink-0"/>}
          {item.detail}
        </p>
      ))}
      {unmet.length > 0 && <p className="text-[9px] text-warn/70">Promotion is refused until every criterion holds. Rollback is not gated on evidence, so a bad model can always be reverted.</p>}
    </div>}

    {rollback && <div className="mt-2">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground">Entry this rollback supersedes</p>
      {state.ledger.length
        ? <select value={supersedesId} onChange={(event) => setSupersedesId(event.target.value)}
            className="mt-1 h-8 w-full rounded-md border bg-background px-2 font-mono text-[10px] outline-none">
            <option value="">Select an entry…</option>
            {[...state.ledger].reverse().map((entry) => (
              <option key={entry.id} value={entry.id}>{new Date(entry.at).toLocaleString()} · {entry.action} {entry.modelVersion}</option>
            ))}
          </select>
        : <p className="mt-1 text-[9px] text-muted-foreground">The ledger is empty, so there is nothing to roll back.</p>}
    </div>}

    <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000}
      placeholder={rollback ? 'Why is this model being reverted? Name the evidence that changed.' : 'Why does this model belong in production? Cite the held-out evidence.'}
      className="mt-2 min-h-16 w-full resize-none rounded-md border bg-background p-2 text-[10px] leading-relaxed outline-none placeholder:text-muted-foreground"/>

    <div className="mt-2 flex flex-wrap gap-2">
      <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`Type ${required}`}
        className="h-8 min-w-48 flex-1 rounded-md border bg-background px-2 font-mono text-[10px] outline-none"/>
      <Button size="sm" variant="outline" className="shrink-0 border-warn/30 text-warn" disabled={busy || blocked} onClick={() => void submit()}>
        {busy && <Loader2 className="animate-spin"/>}{rollback ? 'Record rollback' : 'Record promotion'}
      </Button>
    </div>

    {error && <p className="mt-2 flex items-start gap-1.5 text-[9px] text-loss"><AlertTriangle className="mt-0.5 size-3 shrink-0"/>{error}</p>}
    {recorded && <p className="mt-2 flex items-start gap-1.5 text-[9px] text-data"><CheckCircle2 className="mt-0.5 size-3 shrink-0"/>Recorded {recorded.action} for {recorded.modelVersion}. The provenance list updates on the next dashboard refresh.</p>}
  </div>;
}

/**
 * The model's provenance, deliberately kept next to the buy-policy history: both answer the same
 * question about production, and an unrecorded model is stated rather than quietly rendered as absent.
 */
function ModelProvenance({ model }: { model: PolicyManifestModel }) {
  return <section>
    <div className="mb-2 flex items-center gap-2"><Cpu className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Forecast-model provenance</h3></div>
    {model.unrecorded && <div className="mb-2 flex items-start gap-2 rounded-xl border border-warn/25 bg-warn/[.04] p-4 text-warn">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0"/>
      <div>
        <p className="text-[10px] font-semibold">Production model has no promotion record</p>
        <p className="mt-1 text-[9px] leading-relaxed text-warn/80">
          {model.productionVersion} is what production runs, but {model.currentPromotion
            ? `the newest ledger entry promotes ${model.currentPromotion.modelVersion}.`
            : 'the promotion ledger is empty, so no recorded decision explains it.'} Promotion is manual and append-only; until an entry is written, this model’s justification lives outside the audit trail.
        </p>
      </div>
    </div>}
    {model.history.length
      ? <div className="space-y-2">{model.history.map((entry) => <PromotionEntry key={entry.id} entry={entry} current={entry.id === model.currentPromotion?.id && !model.unrecorded}/>)}</div>
      : <div className="rounded-xl border border-dashed p-4 text-center"><p className="text-[10px]">No promotions or rollbacks recorded</p><p className="mt-1 text-[9px] text-muted-foreground">Entries appear here when a walk-forward run is cited to change production. The evaluator never promotes on its own.</p></div>}
    <ModelPromotionControls/>
  </section>;
}
const statusStyle = (status: 'production' | 'paper' | 'observation') => status === 'production'
  ? 'border-data/25 text-data'
  : status === 'paper' ? 'border-primary/30 text-primary' : 'text-muted-foreground';

/**
 * `badge` is the production placement: the hero already prints the active policy version, so that
 * label becomes the control rather than the header carrying a second copy of the same identity.
 */
export function PolicyDialog({ manifest, providers, variant = 'button' }: { manifest: PolicyManifest; providers?: TradingProviderDescriptor[]; variant?: 'button' | 'badge' }) {
  const live = providers?.filter((provider) => provider.liveEnabled).map((provider) => provider.name) ?? [];
  const paper = providers?.filter((provider) => provider.paperEnabled).map((provider) => provider.name) ?? [];
  return <Dialog>
    <DialogTrigger asChild>
      {variant === 'badge'
        ? <button type="button" title={`Active policy ${manifest.activeBuyPolicyVersion} — open policy details`} className={cn(inlineTrigger, 'font-mono text-[8px]')}>
            {manifest.activeBuyPolicyVersion}<ChevronDown className="size-2.5 shrink-0"/>
          </button>
        : <Button variant="outline" size="sm" title={`Active policy ${manifest.activeBuyPolicyVersion}`} className="gap-1.5">
            <BookOpen/><span>Policy</span>
            <Badge variant="secondary" className="px-1.5 font-mono text-[8px]">{shortPolicy(manifest.activeBuyPolicyVersion)}</Badge>
          </Button>}
    </DialogTrigger>
    <DialogContent className="max-w-5xl p-0">
      <DialogHeader className="border-b p-5 pr-12">
        <DialogTitle className="flex items-center gap-2"><Layers3 className="size-4 text-primary"/>Active policy and provider variants</DialogTitle>
        <DialogDescription>Production details and immutable policy history. A signed-in operator may record a model promotion or rollback here; this surface cannot arm, size, or trade, and recording a decision never changes what production forecasts with.</DialogDescription>
      </DialogHeader>
      <div className="max-h-[80vh] space-y-5 overflow-y-auto p-5">
        <section className="rounded-xl border border-data/20 bg-data/[.035] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-[9px] uppercase tracking-[.16em] text-muted-foreground">Active binary buy policy</p><p className="mt-1 break-all font-mono text-sm font-semibold text-data">{manifest.activeBuyPolicyVersion}</p><p className="mt-1 flex items-center gap-1 text-[9px] text-muted-foreground"><Clock3 className="size-3"/>Activated {new Date(manifest.activeBuyPolicyActivatedAt).toLocaleString()}</p></div>
            <Badge variant="outline" className="border-data/25 text-data"><CheckCircle2/>production</Badge>
          </div>
          {providers && <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-background/50 p-3"><p className="text-[8px] uppercase text-muted-foreground">Live-enabled providers</p><p className="mt-1 text-xs">{live.join(', ') || 'None'}</p></div><div className="rounded-lg bg-background/50 p-3"><p className="text-[8px] uppercase text-muted-foreground">Paper providers</p><p className="mt-1 text-xs">{paper.join(', ') || 'None'}</p></div></div>}
        </section>

        <section><div className="mb-2 flex items-center gap-2"><Layers3 className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Active components</h3></div><div className="grid gap-3 lg:grid-cols-2">{manifest.components.map((item) => <div key={item.kind} className="rounded-xl border bg-background/35 p-4"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{item.label}</p><p className="mt-1 break-all font-mono text-[9px] text-muted-foreground">{item.version}</p></div><Badge variant="outline" className={cn('uppercase', statusStyle(item.status))}>{item.status}</Badge></div><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{item.summary}</p><div className="mt-3 divide-y rounded-lg border">{item.details.map((detail) => <div key={`${detail.label}:${detail.value}`} className="grid grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] gap-3 px-3 py-2 text-[9px]"><span className="text-muted-foreground">{detail.label}</span><span className="break-words text-right font-mono">{detail.value}</span></div>)}</div></div>)}</div></section>

        {providers && <section><div className="mb-2 flex items-center gap-2"><Layers3 className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Provider registry</h3></div><div className="grid gap-2 lg:grid-cols-2">{providers.map((provider) => <div key={provider.id} className="rounded-xl border p-4"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{provider.name}</p><p className="mt-1 font-mono text-[8px] text-muted-foreground">{provider.adapterVersion} · {provider.selectedVariantId}</p></div><Badge variant="outline" className={provider.liveEnabled ? 'border-live/30 text-live' : provider.paperEnabled ? 'border-brand-green/30 text-brand-green' : 'text-muted-foreground'}>{provider.liveEnabled ? 'live + paper' : provider.paperEnabled ? 'paper' : provider.implementation}</Badge></div><p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">{provider.readiness}</p><div className="mt-2 flex flex-wrap gap-1"><Badge variant="outline" className={provider.researchEnabled ? 'text-data' : 'text-muted-foreground'}>research {provider.researchEnabled ? 'on' : 'off'}</Badge><Badge variant="outline" className={provider.paperEnabled ? 'text-brand-green' : 'text-muted-foreground'}>paper {provider.paperEnabled ? 'on' : 'off'}</Badge><Badge variant="outline" className={provider.liveEnabled ? 'text-live' : 'text-muted-foreground'}>live {provider.liveEnabled ? 'on' : 'off'}</Badge></div></div>)}</div></section>}

        {manifest.model && <ModelProvenance model={manifest.model}/>}

        <section><div className="mb-2 flex items-center gap-2"><History className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Buy-policy history</h3></div><div className="space-y-2">{manifest.history.map((entry) => <div key={entry.version} className="rounded-xl border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="break-all font-mono text-[10px] font-semibold">{entry.version}</p><p className="mt-1 text-[9px] text-muted-foreground">{new Date(entry.activatedAt).toLocaleString()}{entry.deactivatedAt ? ` → ${new Date(entry.deactivatedAt).toLocaleString()}` : ' → current'}</p></div><Badge variant="outline" className={entry.status === 'active' ? 'border-data/25 text-data' : 'text-muted-foreground'}>{entry.status}</Badge></div><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{entry.summary}</p><ul className="mt-2 space-y-1">{entry.changes.map((change) => <li key={change} className="flex gap-2 text-[9px]"><span className="mt-1 size-1 shrink-0 rounded-full bg-data"/>{change}</li>)}</ul>{entry.evidence.length > 0 && <p className="mt-2 break-words font-mono text-[8px] text-muted-foreground">Evidence: {entry.evidence.join(' · ')}</p>}</div>)}</div></section>
      </div>
    </DialogContent>
  </Dialog>;
}
