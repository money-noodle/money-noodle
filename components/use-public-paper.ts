'use client';

import { useEffect, useState } from 'react';
import { DATA_FRESHNESS } from '@/lib/freshness';
import type { PublicPaperBudget, PublicPaperPerformance } from '@/lib/types';

/**
 * Every public paper surface polls an unauthenticated endpoint on the same dashboard cadence, so the
 * fetch, retain, and teardown behaviour lives here once instead of being copied per panel. A transient
 * failure keeps the last verified payload rather than blanking a panel, which would read as automation
 * having stopped.
 */
function usePublicPaperData<T>(path: string, active: boolean, intervalMs: number): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as T;
        if (!cancelled) setData(body);
      } catch { /* Retain the last verified payload. */ }
      finally { if (!cancelled) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [path, active, intervalMs]);

  return { data, loading };
}

/** The track record is a few hundred kilobytes and only moves when a 15-minute window settles, so it is
 *  polled well below the dashboard cadence rather than re-downloaded every cycle by every visitor. */
const TRACK_RECORD_POLL_MS = 60_000;

/** Paper bankroll aggregate and the newest sanitized simulated intents. */
export function usePublicPaperBudget(active = true): { budget: PublicPaperBudget | null; loading: boolean } {
  const { data, loading } = usePublicPaperData<PublicPaperBudget>('/api/paper-budget', active, DATA_FRESHNESS.dashboardPollMs);
  return { budget: data, loading };
}

/** Full forecast scoring plus the paper-only executed-money record. */
export function usePublicPaperPerformance(active = true): { performance: PublicPaperPerformance | null; loading: boolean } {
  const { data, loading } = usePublicPaperData<PublicPaperPerformance>('/api/paper-performance', active, TRACK_RECORD_POLL_MS);
  return { performance: data, loading };
}
