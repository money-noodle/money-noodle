import { PlatformStatusCard } from './platform-status-card';
import {
  presentPlatformStatus,
  type PlatformStatusObservation,
} from './platform-status-view-model';

export interface PlatformPageContentProps {
  readonly loadStatus: () => Promise<PlatformStatusObservation | undefined>;
}

export async function PlatformPageContent({ loadStatus }: PlatformPageContentProps) {
  const status = presentPlatformStatus(await loadStatus());

  return (
    <main>
      <h1>Money Noodle</h1>
      <p className="lede">A clear view of the platform, one trustworthy noodle at a time.</p>
      <PlatformStatusCard status={status} />
    </main>
  );
}
