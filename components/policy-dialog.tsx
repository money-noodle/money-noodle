'use client';

import { BookOpen, CheckCircle2, Clock3, History, Layers3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { PolicyManifest, TradingProviderDescriptor } from '@/lib/types';
import { cn } from '@/lib/utils';

const shortPolicy = (version: string) => version.match(/v\d+$/)?.[0] ?? version;
const statusStyle = (status: 'production' | 'paper' | 'observation') => status === 'production'
  ? 'border-primary/25 text-primary'
  : status === 'paper' ? 'border-brand-green/30 text-brand-green' : 'text-muted-foreground';

export function PolicyDialog({ manifest, providers, compact = false }: { manifest: PolicyManifest; providers: TradingProviderDescriptor[]; compact?: boolean }) {
  const live = providers.filter((provider) => provider.liveEnabled).map((provider) => provider.name);
  const paper = providers.filter((provider) => provider.paperEnabled).map((provider) => provider.name);
  return <Dialog>
    <DialogTrigger asChild>
      <Button variant="outline" size="sm" title={`Active policy ${manifest.activeBuyPolicyVersion}`} className="gap-1.5">
        <BookOpen/><span className={cn(compact && 'hidden sm:inline')}>Policy</span>
        <Badge variant="secondary" className="px-1.5 font-mono text-[8px]">{shortPolicy(manifest.activeBuyPolicyVersion)}</Badge>
      </Button>
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
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-lg bg-background/50 p-3"><p className="text-[8px] uppercase text-muted-foreground">Live-enabled providers</p><p className="mt-1 text-xs">{live.join(', ') || 'None'}</p></div><div className="rounded-lg bg-background/50 p-3"><p className="text-[8px] uppercase text-muted-foreground">Paper providers</p><p className="mt-1 text-xs">{paper.join(', ') || 'None'}</p></div></div>
        </section>

        <section><div className="mb-2 flex items-center gap-2"><Layers3 className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Active components</h3></div><div className="grid gap-3 lg:grid-cols-2">{manifest.components.map((item) => <div key={item.kind} className="rounded-xl border bg-background/35 p-4"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{item.label}</p><p className="mt-1 break-all font-mono text-[9px] text-muted-foreground">{item.version}</p></div><Badge variant="outline" className={cn('uppercase', statusStyle(item.status))}>{item.status}</Badge></div><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{item.summary}</p><div className="mt-3 divide-y rounded-lg border">{item.details.map((detail) => <div key={`${detail.label}:${detail.value}`} className="grid grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] gap-3 px-3 py-2 text-[9px]"><span className="text-muted-foreground">{detail.label}</span><span className="break-words text-right font-mono">{detail.value}</span></div>)}</div></div>)}</div></section>

        <section><div className="mb-2 flex items-center gap-2"><Layers3 className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Provider registry</h3></div><div className="grid gap-2 lg:grid-cols-2">{providers.map((provider) => <div key={provider.id} className="rounded-xl border p-4"><div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{provider.name}</p><p className="mt-1 font-mono text-[8px] text-muted-foreground">{provider.adapterVersion} · {provider.selectedVariantId}</p></div><Badge variant="outline" className={provider.liveEnabled ? 'border-red-400/30 text-red-300' : provider.paperEnabled ? 'border-brand-green/30 text-brand-green' : 'text-muted-foreground'}>{provider.liveEnabled ? 'live + paper' : provider.paperEnabled ? 'paper' : provider.implementation}</Badge></div><p className="mt-2 text-[9px] leading-relaxed text-muted-foreground">{provider.readiness}</p><div className="mt-2 flex flex-wrap gap-1"><Badge variant="outline" className={provider.researchEnabled ? 'text-primary' : 'text-muted-foreground'}>research {provider.researchEnabled ? 'on' : 'off'}</Badge><Badge variant="outline" className={provider.paperEnabled ? 'text-brand-green' : 'text-muted-foreground'}>paper {provider.paperEnabled ? 'on' : 'off'}</Badge><Badge variant="outline" className={provider.liveEnabled ? 'text-red-300' : 'text-muted-foreground'}>live {provider.liveEnabled ? 'on' : 'off'}</Badge></div></div>)}</div></section>

        <section><div className="mb-2 flex items-center gap-2"><History className="size-4 text-muted-foreground"/><h3 className="text-xs font-semibold">Buy-policy history</h3></div><div className="space-y-2">{manifest.history.map((entry) => <div key={entry.version} className="rounded-xl border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="break-all font-mono text-[10px] font-semibold">{entry.version}</p><p className="mt-1 text-[9px] text-muted-foreground">{new Date(entry.activatedAt).toLocaleString()}{entry.deactivatedAt ? ` → ${new Date(entry.deactivatedAt).toLocaleString()}` : ' → current'}</p></div><Badge variant="outline" className={entry.status === 'active' ? 'border-primary/25 text-primary' : 'text-muted-foreground'}>{entry.status}</Badge></div><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{entry.summary}</p><ul className="mt-2 space-y-1">{entry.changes.map((change) => <li key={change} className="flex gap-2 text-[9px]"><span className="mt-1 size-1 shrink-0 rounded-full bg-primary"/>{change}</li>)}</ul>{entry.evidence.length > 0 && <p className="mt-2 break-words font-mono text-[8px] text-muted-foreground">Evidence: {entry.evidence.join(' · ')}</p>}</div>)}</div></section>
      </div>
    </DialogContent>
  </Dialog>;
}
