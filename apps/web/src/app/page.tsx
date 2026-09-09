import { loadPlatformStatus } from '../adapters/platform-api/load-platform-status';
import { readRuntimeConfig } from '../adapters/config/read-runtime-config';
import { PlatformPageContent } from '../presentation/platform-page-content';
import type { PlatformStatusObservation } from '../presentation/platform-status-view-model';

export const dynamic = 'force-dynamic';

async function loadConfiguredStatus(): Promise<PlatformStatusObservation | undefined> {
  try {
    return await loadPlatformStatus({
      baseUrl: readRuntimeConfig(process.env).platformApiOrigin,
    });
  } catch {
    return undefined;
  }
}

export default async function PlatformPage() {
  return PlatformPageContent({ loadStatus: loadConfiguredStatus });
}
