import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getExecutionOrders } from '@/lib/paper-execution';
import { strategyOrders } from '@/lib/execution-report';
import { EDGE_BINARY_BUY } from '@/lib/strategy-registry';
import { getExitPolicySentinelReport } from '@/lib/exit-policy-sentinel-store';
import { getMakerRestrictionSentinelReport } from '@/lib/maker-restriction-sentinel-store';
import { getMakerLifecycleSentinelReport } from '@/lib/maker-lifecycle-sentinel-store';
import { getEdgeSpikeSentinelReport } from '@/lib/edge-spike-sentinel-store';
import { getHourlyThresholdObservationStore } from '@/lib/hourly-threshold-observation-store';
import {
  SENTINELS, SENTINEL_REGISTRY_VERSION, holmBestArmThreshold, projectCompletion, sentinelThresholds,
  type SentinelArmProjection, type SentinelProjection, type SentinelThresholdProgress, type SentinelTrackProjection,
} from '@/lib/sentinel-registry';
import type { ExitCandidateReport } from '@/lib/exit-policy-sentinel';
import type { MakerRestrictionArmReport } from '@/lib/maker-restriction-sentinel';
import type { MakerLifecycleArmReport } from '@/lib/maker-lifecycle-sentinel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only projection of every prospective-evidence instrument, for the Sentinels view.
 *
 * This route can only read. It exposes no control that could arm, disarm, promote, reset, or retire a
 * sentinel, because promotion is a manual versioned act recorded in an immutable ledger and must never
 * become a button. Stateless hosts are denied: sentinel stores are worker-local durable state.
 */
const tStatistic = (mean: number | null, error: number | null): number | null =>
  mean === null || error === null || !(error > 1e-15) ? null : Number((mean / error).toFixed(2));

/** Both arm reports already share the fields a projection needs; neither is reshaped to fit the other. */
function armProjection(report: ExitCandidateReport | MakerRestrictionArmReport | MakerLifecycleArmReport, bar: number | null): SentinelArmProjection {
  const t = tStatistic(report.incrementalMeanReturn, report.incrementalStandardError);
  return {
    armId: report.candidateId,
    windows: report.windows,
    divergentWindows: report.divergentWindows,
    meanReturn: report.incrementalMeanReturn,
    standardError: report.incrementalStandardError,
    tStatistic: t,
    clears: t !== null && bar !== null && t >= bar,
  };
}

function countThreshold(label: string, current: number, required: number): SentinelThresholdProgress {
  return { label, current, required, met: current >= required, unit: 'count' };
}

/** A coverage row is met on its own ratio; hardcoding false reported 100% coverage as unmet. */
function coverageThreshold(label: string, current: number, required: number): SentinelThresholdProgress {
  return { label, current, required, met: current + 1e-12 >= required, unit: 'fraction' };
}

/** Any arm clearing its own counts opens a review for the instrument; the report owns that judgement. */
const anyArmUnlocked = (tracks: { candidates: { reviewUnlocked: boolean }[] }[]): boolean =>
  tracks.some((track) => track.candidates.some((candidate) => candidate.reviewUnlocked));

export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });

  try {
    // The same strategy-narrowed cohort the Performance view feeds these reports. Passing the whole ledger
    // admitted rows that view excludes, so one instrument reported different windows and coverage in the two
    // dialogs with nothing to say which was authoritative.
    const orders = strategyOrders(await getExecutionOrders({ includeArchivedEvidence: false }), EDGE_BINARY_BUY);
    // One failing store must not blank the whole view: each projection is settled independently.
    const [exit, maker, lifecycle, spike, hourly] = await Promise.allSettled([
      getExitPolicySentinelReport(orders),
      getMakerRestrictionSentinelReport(orders),
      getMakerLifecycleSentinelReport(orders),
      getEdgeSpikeSentinelReport(),
      getHourlyThresholdObservationStore(),
    ]);

    const sentinels: SentinelProjection[] = SENTINELS.map((descriptor) => {
      const bar = descriptor.arms.length ? holmBestArmThreshold(descriptor.arms.length) : null;
      const limits = sentinelThresholds(descriptor.id);
      let openedAt: string | null = null;
      let tracks: SentinelTrackProjection[] = [];
      let thresholds: SentinelThresholdProgress[] = [];
      let observations: { label: string; value: number }[] = [];
      let reviewUnlocked = false;

      if (descriptor.id === 'exit-policy-sentinel-v2' && exit.status === 'fulfilled') {
        openedAt = exit.value.startedAt;
        tracks = (['live', 'paper'] as const).map((mode) => {
          const track = exit.value.tracks[mode];
          return {
            mode, positions: track.positions, completePositions: track.completePositions, coverage: track.coverage,
            arms: track.candidates.map((candidate) => armProjection(candidate, bar)),
          };
        });
        const windows = Math.max(...tracks.map((track) => Math.max(0, ...track.arms.map((arm) => arm.windows))), 0);
        const divergent = Math.max(...tracks.map((track) => Math.max(0, ...track.arms.map((arm) => arm.divergentWindows ?? 0))), 0);
        if (limits) thresholds = [
          countThreshold('Complete windows', windows, limits.windows),
          countThreshold('Divergent windows', divergent, limits.divergentWindows),
          coverageThreshold('Cycle coverage', Math.min(...tracks.map((track) => track.coverage ?? 0)), limits.coverage),
        ];
        reviewUnlocked = anyArmUnlocked([exit.value.tracks.live, exit.value.tracks.paper]);
      }

      if (descriptor.id === 'maker-restriction-sentinel-v1' && maker.status === 'fulfilled') {
        openedAt = maker.value.startedAt;
        // This instrument counts records rather than positions, and reports no cycle coverage.
        tracks = (['live', 'paper'] as const).map((mode) => {
          const track = maker.value.tracks[mode];
          return {
            mode, positions: track.records, completePositions: track.resolvedRecords, coverage: null,
            arms: track.candidates.map((candidate) => armProjection(candidate, bar)),
          };
        });
        const windows = Math.max(...tracks.map((track) => Math.max(0, ...track.arms.map((arm) => arm.windows))), 0);
        if (limits) thresholds = [countThreshold('Complete windows', windows, limits.windows)];
        reviewUnlocked = anyArmUnlocked([maker.value.tracks.live, maker.value.tracks.paper]);
      }

      if (descriptor.id === 'maker-lifecycle-sentinel-v1' && lifecycle.status === 'fulfilled') {
        openedAt = lifecycle.value.startedAt;
        tracks = (['live', 'paper'] as const).map((mode) => {
          const track = lifecycle.value.tracks[mode];
          return {
            mode, positions: track.records, completePositions: track.resolvedRecords, coverage: track.coverage,
            arms: track.candidates.map((candidate) => armProjection(candidate, bar)),
          };
        });
        const windows = Math.max(...tracks.map((track) => Math.max(0, ...track.arms.map((arm) => arm.windows))), 0);
        const divergent = Math.max(...tracks.map((track) => Math.max(0, ...track.arms.map((arm) => arm.divergentWindows ?? 0))), 0);
        if (limits) thresholds = [
          countThreshold('Complete windows', windows, limits.windows),
          countThreshold('Divergent windows', divergent, limits.divergentWindows),
          coverageThreshold('Observation coverage', Math.min(...tracks.map((track) => track.coverage ?? 0)), limits.coverage),
        ];
        reviewUnlocked = anyArmUnlocked([lifecycle.value.tracks.live, lifecycle.value.tracks.paper]);
      }

      if (descriptor.id === 'edge-spike-sentinel-v1' && spike.status === 'fulfilled') {
        const report = spike.value;
        reviewUnlocked = report.reviewUnlocked;
        thresholds = [countThreshold('Resolved samples', report.resolvedSamples, report.reviewWindowsRequired)];
        observations = [
          { label: 'Samples', value: report.samples },
          { label: 'Resolved', value: report.resolvedSamples },
        ];
        const t = tStatistic(report.advantage, report.standardError);
        tracks = [{
          mode: 'live', positions: report.samples, completePositions: report.resolvedSamples, coverage: null,
          arms: [{
            armId: 'gate advantage (admitted − declined)', windows: report.resolvedSamples, divergentWindows: null,
            meanReturn: report.advantage, standardError: report.standardError, tStatistic: t,
            clears: t !== null && bar !== null && t >= bar,
          }],
        }];
      }

      if (descriptor.id === 'hourly-threshold-observation-v1' && hourly.status === 'fulfilled') {
        // Observation-only: no arms, so counts are reported plainly rather than dressed as a comparison.
        const observedAt = hourly.value.observations.map((observation) => observation.observedAt).sort();
        openedAt = observedAt[0] ?? null;
        observations = [
          { label: 'Observations', value: hourly.value.observations.length },
          { label: 'Exact outcomes', value: hourly.value.outcomes.length },
        ];
      }

      return {
        ...descriptor,
        // A collecting instrument whose arms have cleared their counts is awaiting a maintainer, not still
        // collecting. The registry constant cannot know that; the projection can.
        lifecycle: descriptor.lifecycle === 'collecting' && reviewUnlocked ? 'locked-for-review' : descriptor.lifecycle,
        openedAt,
        reviewUnlocked,
        thresholds,
        tracks,
        observations,
        // A retired instrument gets no projection: it will never reach its thresholds.
        projectedCompleteAt: descriptor.lifecycle === 'collecting' ? projectCompletion(openedAt, thresholds) : null,
        holmBestArmT: bar,
      };
    });

    return NextResponse.json({ version: SENTINEL_REGISTRY_VERSION, generatedAt: new Date().toISOString(), sentinels },
      { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Sentinel projection failed:', error);
    return NextResponse.json({ error: 'Sentinels unavailable.' }, { status: 500 });
  }
}
