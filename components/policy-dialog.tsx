'use client';

import { AlertTriangle, BookOpen, CheckCircle2, ChevronDown, Clock3, Cpu, History, Layers3 } from 'lucide-react';
import { Badge, inlineTrigger } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { ModelPromotionEntry, PolicyManifestModel, PolicyManifest, TradingProviderDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';

const shortPolicy = (version: string) => version.match(/v\d+$/)?.[0] ?? version;
const returnPercent = (value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

function PromotionEntry({ entry, current }: { entry: ModelPromotionEntry; current: boolean }) {
  const parameters = entry.parameters;
  return <div className={cn('rounded-xl border p-4', current && 'border-primary/25 bg-primary/[.03]')}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="break-all font-mono text-[10px] font-semibold">{entry.modelVersion}</p>
        <p className="mt-1 flex items-center gap-1 text-[9px] text-muted-foreground"><Clock3 className="size-3"/>{new Date(entry.at).toLocaleString()}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {current && <Badge variant="outline" className="border-primary/25 text-primary">in production</Badge>}
        <Badge variant="outline" className={cn('uppercase', entry.action === 'rolled-back' ? 'border-amber-300/30 text-amber-200' : 'text-muted-foreground')}>{entry.action}</Badge>
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

/**
 * The model's provenance, deliberately kept next to the buy-policy history: both answer the same
 * question about production, and an unrecorded model is stated rather than quietly rendered as absent.
 */
function ModelProvenance({ model }: { model: PolicyManifestModel }) {
  return <section>
    <div className="mb-2 flex items-center gap-2"><Cpu className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Forecast-model provenance</h3></div>
    {model.unrecorded && <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-300/25 bg-amber-300/[.04] p-4 text-amber-100">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0"/>
      <div>
        <p className="text-[10px] font-semibold">Production model has no promotion record</p>
        <p className="mt-1 text-[9px] leading-relaxed text-amber-100/80">
          {model.productionVersion} is what production runs, but {model.currentPromotion
            ? `the newest ledger entry promotes ${model.currentPromotion.modelVersion}.`
            : 'the promotion ledger is empty, so no recorded decision explains it.'} Promotion is manual and append-only; until an entry is written, this model’s justification lives outside the audit trail.
        </p>
      </div>
    </div>}
    {model.history.length
      ? <div className="space-y-2">{model.history.map((entry) => <PromotionEntry key={entry.id} entry={entry} current={entry.id === model.currentPromotion?.id && !model.unrecorded}/>)}</div>
      : <div className="rounded-xl border border-dashed p-4 text-center"><p className="text-[10px]">No promotions or rollbacks recorded</p><p className="mt-1 text-[9px] text-muted-foreground">Entries appear here when a walk-forward run is cited to change production. The evaluator never promotes on its own.</p></div>}
  </section>;
}
const statusStyle = (status: 'production' | 'paper' | 'observation') => status === 'production'
  ? 'border-primary/25 text-primary'
  : status === 'paper' ? 'border-brand-green/30 text-brand-green' : 'text-muted-foreground';

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
        <DialogDescription>Read-only production details and immutable policy history. This surface cannot promote, arm, or trade.</DialogDescription>
      </DialogHeader>
      <div className="max-h-[80vh] space-y-5 overflow-y-auto p-5">
        <section className="rounded-xl border border-primary/20 bg-primary/[.035] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-[9px] uppercase tracking-[.16em] text-muted-foreground">Active binary buy policy</p><p className="mt-1 break-all font-mono text-sm font-semibold text-primary">{manifest.activeBuyPolicyVersion}</p><p className="mt-1 flex items-center gap-1 text-[9px] text-muted-foreground"><Clock3 className="size-3"/>Activated {new Date(manifest.activeBuyPolicyActivatedAt).toLocaleString()}</p></div>
            <Badge variant="outline" className="border-primary/25 text-primary"><CheckCircle2/>production</Badge>
          </div>
          {providers && <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-background/50 p-3"><p className="text-[8px] uppercase text-muted-foreground">Live-enabled providers</p><p className="mt-1 text-xs">{live.join(', ') || 'None'}</p></div><div className="rounded-lg bg-background/50 p-3"><p className="text-[8px] uppercase text-muted-foreground">Paper providers</p><p className="mt-1 text-xs">{paper.join(', ') || 'None'}</p></div></div>}
        </section>

        <section><div className="mb-2 flex items-center gap-2"><Layers3 className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Active components</h3></div><div className="grid gap-3 lg:grid-cols-2">{manifest.components.map((item) => <div key={item.kind} className="rounded-xl border bg-background/35 p-4"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{item.label}</p><p className="mt-1 break-all font-mono text-[9px] text-muted-foreground">{item.version}</p></div><Badge variant="outline" className={cn('uppercase', statusStyle(item.status))}>{item.status}</Badge></div><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{item.summary}</p><div className="mt-3 divide-y rounded-lg border">{item.details.map((detail) => <div key={`${detail.label}:${detail.value}`} className="grid grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] gap-3 px-3 py-2 text-[9px]"><span className="text-muted-foreground">{detail.label}</span><span className="break-words text-right font-mono">{detail.value}</span></div>)}</div></div>)}</div></section>

        {providers && <section><div className="mb-2 flex items-center gap-2"><Layers3 className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Provider registry</h3></div><div className="grid gap-2 lg:grid-cols-2">{providers.map((provider) => <div key={provider.id} className="rounded-xl border p-4"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{provider.name}</p><p className="mt-1 font-mono text-[8px] text-muted-foreground">{provider.adapterVersion} · {provider.selectedVariantId}</p></div><Badge variant="outline" className={provider.liveEnabled ? 'border-red-400/30 text-red-300' : provider.paperEnabled ? 'border-brand-green/30 text-brand-green' : 'text-muted-foreground'}>{provider.liveEnabled ? 'live + paper' : provider.paperEnabled ? 'paper' : provider.implementation}</Badge></div><p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">{provider.readiness}</p><div className="mt-2 flex flex-wrap gap-1"><Badge variant="outline" className={provider.researchEnabled ? 'text-primary' : 'text-muted-foreground'}>research {provider.researchEnabled ? 'on' : 'off'}</Badge><Badge variant="outline" className={provider.paperEnabled ? 'text-brand-green' : 'text-muted-foreground'}>paper {provider.paperEnabled ? 'on' : 'off'}</Badge><Badge variant="outline" className={provider.liveEnabled ? 'text-red-300' : 'text-muted-foreground'}>live {provider.liveEnabled ? 'on' : 'off'}</Badge></div></div>)}</div></section>}

        {manifest.model && <ModelProvenance model={manifest.model}/>}

        <section><div className="mb-2 flex items-center gap-2"><History className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Buy-policy history</h3></div><div className="space-y-2">{manifest.history.map((entry) => <div key={entry.version} className="rounded-xl border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="break-all font-mono text-[10px] font-semibold">{entry.version}</p><p className="mt-1 text-[9px] text-muted-foreground">{new Date(entry.activatedAt).toLocaleString()}{entry.deactivatedAt ? ` → ${new Date(entry.deactivatedAt).toLocaleString()}` : ' → current'}</p></div><Badge variant="outline" className={entry.status === 'active' ? 'border-primary/25 text-primary' : 'text-muted-foreground'}>{entry.status}</Badge></div><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{entry.summary}</p><ul className="mt-2 space-y-1">{entry.changes.map((change) => <li key={change} className="flex gap-2 text-[9px]"><span className="mt-1 size-1 shrink-0 rounded-full bg-primary"/>{change}</li>)}</ul>{entry.evidence.length > 0 && <p className="mt-2 break-words font-mono text-[8px] text-muted-foreground">Evidence: {entry.evidence.join(' · ')}</p>}</div>)}</div></section>
      </div>
    </DialogContent>
  </Dialog>;
}
