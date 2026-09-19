/**
 * Bounded, rate-limited reporting of telemetry degradation.
 *
 * Three rules the acceptance depends on:
 *
 *   * Telemetry failure never changes application status semantics. This
 *     records a fact; it returns nothing an application path can branch on to
 *     report itself unhealthy, and it is not rollback authority.
 *   * It never reports through the exporter that failed. A failing exporter
 *     that logs through itself is an unbounded loop.
 *   * It is rate limited. Repeated identical failures collapse into a count, so
 *     a broken collector cannot flood a log or accumulate work.
 */

import { TELEMETRY_LIMITS } from './telemetry-limits.js';

export interface DegradationEvent {
  /** Stable, allowlisted reason code. Never provider text. */
  readonly reason: DegradationReason;
  /** How many occurrences this report stands for, including suppressed ones. */
  readonly occurrences: number;
  readonly signal: 'traces' | 'metrics' | 'logs' | 'auth';
}

export type DegradationReason =
  | 'auth-token-unavailable'
  | 'auth-token-timeout'
  | 'endpoint-rejected'
  | 'export-failed'
  | 'export-timeout'
  | 'payload-too-large'
  | 'queue-overflow'
  | 'shutdown-incomplete';

export interface TelemetryDegradation {
  /** Records one degradation. Always safe to call; never throws. */
  report(signal: DegradationEvent['signal'], reason: DegradationReason): void;
  /** Everything recorded so far, for the health surface and for tests. */
  snapshot(): readonly DegradationEvent[];
  /** True once any degradation has been recorded in this process. */
  readonly degraded: boolean;
}

export interface DegradationOptions {
  /** Where a report goes. Never the OTLP exporter. */
  readonly sink?: (event: DegradationEvent) => void;
  readonly now?: () => number;
}

export function createTelemetryDegradation(options: DegradationOptions = {}): TelemetryDegradation {
  const now = options.now ?? Date.now;
  const sink = options.sink;
  const counts = new Map<string, { occurrences: number; reported: number; windowStart: number }>();
  let degraded = false;

  return {
    get degraded() {
      return degraded;
    },

    report(signal, reason) {
      degraded = true;
      const key = `${signal}:${reason}`;
      const at = now();
      const entry = counts.get(key) ?? { occurrences: 0, reported: 0, windowStart: at };

      if (at - entry.windowStart >= TELEMETRY_LIMITS.degradationWindowMillis) {
        entry.windowStart = at;
        entry.reported = 0;
      }
      entry.occurrences += 1;
      counts.set(key, entry);

      if (entry.reported >= TELEMETRY_LIMITS.maxDegradationReportsPerWindow) return;
      entry.reported += 1;

      try {
        sink?.({ occurrences: entry.occurrences, reason, signal });
      } catch {
        // A failing degradation sink must not become an application failure.
        // There is deliberately nowhere further to escalate.
      }
    },

    snapshot() {
      return [...counts.entries()].map(([key, entry]) => {
        const [signal, reason] = key.split(':');
        return {
          occurrences: entry.occurrences,
          reason: reason as DegradationReason,
          signal: signal as DegradationEvent['signal'],
        };
      });
    },
  };
}
