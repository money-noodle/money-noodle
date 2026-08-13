'use client';

import { ChevronDown, Clock3, Database, Info, MonitorDot } from 'lucide-react';
import { Badge, inlineTrigger } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DATA_CADENCE, DATA_FRESHNESS } from '@/lib/freshness';
import type { DashboardData } from '@/lib/types';
import { cn } from '@/lib/utils';

function sourceLive(id: string, status: DashboardData['sourceStatus']): boolean | null {
  if (id === 'polymarket') return status.polymarket;
  if (id === 'kalshi') return status.kalshi;
  if (id === 'coingecko') return status.coinGecko;
  if (id === 'news') return status.news;
  if (id === 'kraken') return status.historical;
  if (id === 'contract-reference') return status.contractReference;
  if (id === 'volatility') return status.volatility;
  if (id === 'model' || id === 'recommendations' || id === 'paper-execution' || id === 'local-history') return true;
  return null;
}

/** Sources whose loss materially degrades the forecast, paired with a readable name. */
const CRITICAL_SOURCES: Array<{ key: keyof DashboardData['sourceStatus']; label: string }> = [
  { key: 'contractReference', label: 'oracle reference' },
  { key: 'volatility', label: 'realized volatility' },
  { key: 'polymarket', label: 'Polymarket' },
  { key: 'kalshi', label: 'Kalshi' },
  { key: 'coinGecko', label: 'CoinGecko' },
];

type DataFreshnessData = Pick<DashboardData, 'generatedAt' | 'collector' | 'sourceStatus'>;

export function DataFreshnessDialog({ data, variant = 'button' }: { data: DataFreshnessData; variant?: 'button' | 'badge' }) {
  // The health dot lives on the control that explains it, instead of a separate header label that
  // duplicated this state and read as though it described trading rather than data.
  const degraded = CRITICAL_SOURCES.filter((source) => !data.sourceStatus[source.key]).map((source) => source.label);
  const collectorDown = !data.collector.running;
  const healthy = !degraded.length && !collectorDown;
  const summary = healthy
    ? 'All data sources live and collecting'
    : [degraded.length ? `Degraded: ${degraded.join(', ')}` : null, collectorDown ? 'Background collector not running' : null].filter(Boolean).join(' · ');
  return <Dialog>
    <DialogTrigger asChild>
      {variant === 'badge'
        ? <button type="button" title={`Data freshness and collection cadence — ${summary}`} className={cn(inlineTrigger, 'text-[9px]')}>
            <span className={cn('inline-flex size-1.5 shrink-0 rounded-full', healthy ? 'bg-primary' : 'bg-amber-300')}/>
            data {healthy ? 'live' : 'degraded'}<ChevronDown className="size-2.5 shrink-0"/>
          </button>
        : <Button variant="ghost" size="sm" className="text-muted-foreground" title={`Data freshness and collection cadence — ${summary}`}><span className="relative flex size-1.5"><span className={cn('inline-flex size-1.5 rounded-full', healthy ? 'bg-primary' : 'bg-amber-300')}/></span><Clock3/><span className="hidden lg:inline">Data</span></Button>}
    </DialogTrigger>
    <DialogContent className="max-w-3xl p-0">
      <DialogHeader className="border-b p-5 pr-12"><DialogTitle className="flex items-center gap-2"><Database className="size-4 text-primary"/> Data freshness and collection</DialogTitle><DialogDescription>Runtime values used by the application—not documentation-only estimates.</DialogDescription></DialogHeader>
      <div className="p-5">
        {!healthy && <div className="mb-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-[10px] leading-relaxed text-amber-100/80">{summary}. The model withholds terms it cannot source rather than substituting estimates, so forecasts stay honest but less confident while a source is down.</div>}
        <div className={cn('mb-4 flex items-start gap-3 rounded-lg border p-3', data.collector.running ? 'border-primary/15 bg-primary/5' : 'border-amber-300/15 bg-amber-300/5')}><MonitorDot className={cn('mt-0.5 size-4 shrink-0', data.collector.running ? 'text-primary' : 'text-amber-200')}/><div><p className="text-xs font-medium">{data.collector.running ? 'Server background collection is active' : data.collector.enabled ? 'Background collector is starting or unavailable' : 'Browser collection fallback is active'}</p><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{data.collector.running ? `Market snapshots, edge calculations, and paper execution checks continue every ${data.collector.intervalMs / 1000} seconds while the local Next.js server is running, even if this dashboard tab is closed. Stopping the server pauses collection.` : `The ${DATA_FRESHNESS.dashboardPollMs / 1000}-second loop currently depends on this browser tab. Closing it pauses collection until the background collector or dashboard runs again.`}</p>{data.collector.lastSuccessAt && <p className="mt-1 font-mono text-[8px] text-muted-foreground">Last background success: {new Date(data.collector.lastSuccessAt).toLocaleString()}</p>}{data.collector.lastError && <p className="mt-1 text-[9px] text-red-300">Last error: {data.collector.lastError}</p>}</div></div>
        <div className="overflow-hidden rounded-lg border">
          <div className="hidden grid-cols-[150px_125px_85px_1fr] gap-3 border-b bg-background/60 px-3 py-2 font-mono text-[8px] uppercase tracking-wider text-muted-foreground sm:grid"><span>Source</span><span>Cadence</span><span>Mode</span><span>Used for</span></div>
          <div className="divide-y">{DATA_CADENCE.map((item) => {
            const live = sourceLive(item.id, data.sourceStatus);
            return <div key={item.id} className="grid gap-1.5 px-3 py-3 sm:grid-cols-[150px_125px_85px_1fr] sm:items-center sm:gap-3">
              <div className="flex items-center gap-2"><span className={cn('size-1.5 rounded-full', live === true ? 'bg-primary' : live === false ? 'bg-red-400' : 'bg-muted-foreground')}/><span className="text-[11px] font-medium">{item.source}</span></div>
              <span className="font-mono text-[9px] text-foreground/90">{item.cadenceLabel}</span>
              <Badge variant="outline" className="w-fit font-mono text-[8px]">{item.mode}</Badge>
              <p className="text-[9px] leading-relaxed text-muted-foreground">{item.purpose}</p>
            </div>;
          })}</div>
        </div>
        <div className="mt-4 flex items-start gap-2 text-[9px] leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3 shrink-0"/><p>The prediction model recalculates every {DATA_FRESHNESS.dashboardPollMs / 1000} seconds, but slower upstream inputs retain their listed cache cadence. Polymarket and Kalshi are requested on every live poll. Venue context inside Blend 0.2 is smoothed over {DATA_FRESHNESS.venueSmoothingWindowMs / 60_000} minutes.</p></div>
        <div className="mt-3 flex flex-wrap justify-between gap-2 border-t pt-3 font-mono text-[8px] text-muted-foreground"><span>Snapshot generated {new Date(data.generatedAt).toLocaleString()}</span><span>{data.sourceStatus.cache ? 'One or more cached inputs used' : 'All inputs fetched for this request'}</span></div>
      </div>
    </DialogContent>
  </Dialog>;
}
