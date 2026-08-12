'use client';

import { useEffect, useState } from 'react';
import { FlaskConical, LockKeyhole, WalletCards } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { DATA_FRESHNESS } from '@/lib/freshness';
import { cn } from '@/lib/utils';
import type { PublicPaperBudget } from '@/lib/types';

const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export function PaperBudgetPanel() {
  const [budget, setBudget] = useState<PublicPaperBudget | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/paper-budget', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as PublicPaperBudget;
        if (!cancelled) setBudget(data);
      } catch { /* Retain the last verified paper summary. */ }
    }
    void load();
    const timer = window.setInterval(() => void load(), DATA_FRESHNESS.dashboardPollMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  if (!budget) return null;
  return <Card className="mb-8 border-primary/20 bg-card/60 p-4">
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
    </>}
  </Card>;
}