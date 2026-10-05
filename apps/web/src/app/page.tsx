import { loadHomeReads, platformApiOrigin } from '../adapters/platform-api/load-dashboard-reads';
import { loadPlatformStatus } from '../adapters/platform-api/load-platform-status';
import { HomeView } from '../presentation/dashboard-views';
import type { PlatformStatusObservation } from '../presentation/platform-status-view-model';

export const dynamic = 'force-dynamic';

async function loadConfiguredStatus(): Promise<PlatformStatusObservation | undefined> {
  const baseUrl = platformApiOrigin();
  if (baseUrl === undefined) return undefined;
  try {
    return await loadPlatformStatus({ baseUrl });
  } catch {
    return undefined;
  }
}

export default async function HomePage() {
  // Four independent reads, all bounded and all concurrent, so the page waits for the
  // slowest rather than the sum and a failing read costs only its own panel.
  const [status, reads] = await Promise.all([loadConfiguredStatus(), loadHomeReads()]);
  return HomeView({ ...reads, status });
}
