import { loadPlatformStatus } from '../adapters/platform-api/load-platform-status';
import { readPlatformApiOrigin } from '../adapters/platform-api/read-platform-api-origin';
import { PlatformPageContent } from '../presentation/platform-page-content';
import type { PlatformStatusObservation } from '../presentation/platform-status-view-model';

export const dynamic = 'force-dynamic';

async function loadConfiguredStatus(): Promise<PlatformStatusObservation | undefined> {
  try {
    return await loadPlatformStatus({
      baseUrl: readPlatformApiOrigin(process.env.PLATFORM_API_ORIGIN, process.env.NODE_ENV),
    });
  } catch {
    return undefined;
  }
}

export default async function PlatformPage() {
  return PlatformPageContent({ loadStatus: loadConfiguredStatus });
}
