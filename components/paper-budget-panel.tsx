'use client';

import { useEffect, useState } from 'react';
import { CircleDollarSign, FlaskConical, Loader2, LockKeyhole, WalletCards } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DATA_FRESHNESS } from '@/lib/freshness';
import type { PublicPaperBudget, PublicPaperExecutionRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function usePaperBudget(active = true) {
  const [budget, setBudget] = useState<PublicPaperBudget | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch('/api/paper-budget', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as PublicPaperBudget;
        if (!cancelled) setBudget(data);
      } catch { /* Retain the last verified paper summary. */ }
      finally { if (!cancelled) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => void load(), DATA_FRESHNESS.dashboardPollMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);

  return { budget, loading };
}

function executionLabel(record: PublicPaperExecutionRecord): string {
  if (record.noFillReason === 'post_only_race') return 'post-only race';
  if (record.noFillReason === 'rested_no_fill') return 'rested · no fill';
  if (record.noFillReason === 'ioc_no_fill') return 'IOC · no fill';
  return record.status.replace('_', ' ');
}

function PaperExecutionLedger({ records }: { records: PublicPaperExecutionRecord[] }) {
  return <div className="mt-4 border-t pt-4"><div className="flex items-center justify-between gap-2"><div><h3 className="text-xs font-semibold">Recent paper executions</h3><p className="mt-0.5 text-[9px] text-muted-foreground">Newest 30 simulated intents. Live orders and provider/account identifiers are never shown.</p></div><span className="rounded border px-2 py-1 font-mono text-[8px] text-muted-foreground">{records.length} shown</span></div>{records.length ? <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border"><div className="divide-y">{records.map((record, index) => <div key={`${record.createdAt}:${record.symbol}:${record.side}:${index}`} className="grid gap-2 p-3 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><div className="flex flex-wrap items-center gap-1.5"><span className="text-xs font-semibold">{record.symbol}</span><span className={cn('rounded border px-1.5 py-0.5 text-[8px]', record.side === 'UP' ? 'text-primary' : 'text-red-400')}>{record.side}</span><span className="rounded border px-1.5 py-0.5 text-[8px] uppercase text-muted-foreground">{record.venue}</span><span className="rounded border px-1.5 py-0.5 text-[8px] text-muted-foreground">{executionLabel(record)}</span></div><p className="mt-1 font-mono text-[8px] text-muted-foreground">{new Date(record.createdAt).toLocaleString()} · ask {(record.askPrice * 100).toFixed(1)}¢{record.liquidityRole ? ` · ${record.liquidityRole}` : ''}</p></div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">Stake + fee</p><p className="font-mono text-xs">{dollars(record.stakeCents)} <span className="text-[8px] text-muted-foreground">({dollars(record.feeCents)})</span></p></div><div className="text-left sm:text-right"><p className="text-[8px] text-muted-foreground">P&amp;L</p><p className={cn('font-mono text-xs', (record.pnlCents ?? 0) > 0 ? 'text-primary' : (record.pnlCents ?? 0) < 0 ? 'text-red-400' : '')}>{record.pnlCents === undefined ? '—' : dollars(record.pnlCents)}</p></div></div>)}</div></div> : <div className="mt-3 rounded-lg border border-dashed p-5 text-center text-[10px] text-muted-foreground">No paper executions yet.</div>}</div>;
}

function PaperBudgetSummary({ budget, embedded = false, showLedger = false }: { budget: PublicPaperBudget; embedded?: boolean; showLedger?: boolean }) {
  return <Card className={cn(!embedded && 'mb-8', 'border-primary/20 bg-card/60 p-4')}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary"><FlaskConical className="size-4"/></div><div><h2 className="text-xs font-semibold">Paper budget</h2><p className="mt-0.5 text-[9px] text-muted-foreground">Read-only simulation summary. No real funds, account data, orders, or controls are shown.</p></div></div>
      <div className="flex items-center gap-1.5 text-[9px] text-primary"><LockKeyhole className="size-3.5"/>Read only · paper only</div>
    </div>
    {!budget.durable ? <div className="mt-4 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3 text-[10px] leading-relaxed text-muted-foreground">This hosted dashboard is stateless, so it cannot report the continuously collected local paper ledger. Run the persistent worker for paper tracking, or connect a durable shared store before publishing its results here.</div> : <>
      <div className="mt-4 grid grid-cols-2 gap-2 border-t pt-3 sm:grid-cols-4">
        <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Starting</p><p className="mt-1 font-mono text-sm">{dollars(budget.startingCents)}</p></div>
        <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Equity</p><p className="mt-1 font-mono text-sm">{dollars(budget.equityCents)}</p></div>
        <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Available</p><p className="mt-1 font-mono text-sm">{dollars(budget.availableCents)}</p></div>
        <div><p className="text-[8px] uppercase tracking-wider text-muted-foreground">Realized P&amp;L</p><p className={cn('mt-1 font-mono text-sm', budget.realizedPnlCents > 0 ? 'text-primary' : budget.realizedPnlCents < 0 ? 'text-red-400' : '')}>{dollars(budget.realizedPnlCents)}</p></div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-[9px] text-muted-foreground"><span>{budget.depleted ? 'Paper bankroll depleted' : budget.running ? 'Paper tracking active' : 'Paper tracking idle'} · {budget.openOrders} open simulated position{budget.openOrders === 1 ? '' : 's'} · {budget.settledOrders} settled · {dollars(budget.reservedCents)} reserved{budget.bankrollResets ? ` · ${budget.bankrollResets} bankroll reset${budget.bankrollResets === 1 ? '' : 's'}` : ''}</span><span className="font-mono">Next cap {dollars(budget.proposedStakeCents)}</span></div>
      <p className="mt-2 flex items-center gap-1.5 text-[8px] text-muted-foreground"><WalletCards className="size-3"/>Sign in to manage automation, provider permissions, live settings, or the paper bankroll.</p>
      {showLedger && <PaperExecutionLedger records={budget.recentExecutions}/>}
    </>}
  </Card>;
}

/** Aggregate public summary retained in the research dashboard body. */
export function PaperBudgetPanel() {
  const { budget } = usePaperBudget();
  return budget ? <PaperBudgetSummary budget={budget}/> : null;
}

/** Public counterpart to the signed Budget dialog: paper aggregate only, with no mutations. */
export function PaperBudgetDialog() {
  const [open, setOpen] = useState(false);
  const { budget, loading } = usePaperBudget(open);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="ghost" size="sm" title="Read-only paper budget"><CircleDollarSign/><span className="hidden sm:inline">Budget</span></Button></DialogTrigger>
    <DialogContent className="max-w-2xl p-0">
      <DialogHeader className="border-b p-5 pr-12"><DialogTitle className="flex items-center gap-2"><CircleDollarSign className="size-4 text-primary"/> Paper budget</DialogTitle><DialogDescription>Read-only paper budget and bounded simulated execution ledger. Live budgets, accounts, automation, and live order history require sign-in.</DialogDescription></DialogHeader>
      <div className="p-5">{loading && !budget ? <div className="grid h-40 place-items-center"><Loader2 className="animate-spin text-muted-foreground"/></div> : budget ? <PaperBudgetSummary budget={budget} embedded showLedger/> : <p className="text-center text-xs text-muted-foreground">Paper-budget data is unavailable right now.</p>}</div>
    </DialogContent>
  </Dialog>;
}
