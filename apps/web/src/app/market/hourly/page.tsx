import { loadHourlyPageRead } from '../../../adapters/platform-api/load-dashboard-reads';
import { HourlyThresholdsPageView } from '../../../presentation/dashboard-views';

export const dynamic = 'force-dynamic';

export default async function HourlyThresholdsPage() {
  return HourlyThresholdsPageView({ markets: await loadHourlyPageRead() });
}
