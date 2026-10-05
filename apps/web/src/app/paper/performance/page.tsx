import { loadPerformancePageReads } from '../../../adapters/platform-api/load-dashboard-reads';
import { PaperPerformancePageView } from '../../../presentation/dashboard-views';

export const dynamic = 'force-dynamic';

export default async function PaperPerformancePage() {
  return PaperPerformancePageView(await loadPerformancePageReads());
}
