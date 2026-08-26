'use client';

import { useEffect, useState } from 'react';
import { DATA_FRESHNESS } from '@/lib/freshness';
import type { PublicPaperBudget, PublicPaperPerformanceSummary } from '@/lib/types';

/**
 * Every public paper surface polls an unauthenticated endpoint on the same dashboard cadence, so the
 * fetch, retain, and teardown behaviour lives here once instead of being copied per panel. A transient
 * failure keeps the last verified payload rather than blanking a panel, which would read as automation
 * having stopped.
 */
function usePublicPaperData<T>(path: string, active: boolean, intervalMs: number): {
  data: T | null; loading: boolean; error: string | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(path);
        const body = await response.json() as T & { error?: string };
        if (!response.ok) throw new Error(body.error || 'Published paper data is unavailable.');
        if (!cancelled) { setData(body); setError(null); }
      } catch (reason) {
        // Retain the last verified payload, but never hide that its refresh failed.
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Published paper data is unavailable.');
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    const timer = window.setInterval(() => void load(), intervalMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [path, active, intervalMs]);

  return { data, loading, error };
}

/** Homepage counters are bounded and shared by both public panels; full history is loaded only on demand. */
const TRACK_RECORD_POLL_MS = 60_000;

/** Paper bankroll aggregate and the newest sanitized simulated intents. */
export function usePublicPaperBudget(active = true): {
  budget: PublicPaperBudget | null; loading: boolean; error: string | null;
} {
  const { data, loading, error } = usePublicPaperData<PublicPaperBudget>(
    '/api/paper-budget', active, DATA_FRESHNESS.dashboardPollMs,
  );
  return { budget: data, loading, error };
}

/** Bounded homepage scoring plus the compact paper execution record. */
export function usePublicPaperPerformanceSummary(active = true): {
  performance: PublicPaperPerformanceSummary | null; loading: boolean; error: string | null;
} {
  const { data, loading, error } = usePublicPaperData<PublicPaperPerformanceSummary>(
    '/api/paper-performance/summary', active, TRACK_RECORD_POLL_MS,
  );
  return { performance: data, loading, error };
}
