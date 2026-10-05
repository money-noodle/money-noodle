import { loadBudgetPageRead } from '../../../adapters/platform-api/load-dashboard-reads';
import { PaperBudgetPageView } from '../../../presentation/dashboard-views';

export const dynamic = 'force-dynamic';

export default async function PaperBudgetPage() {
  return PaperBudgetPageView({ budget: await loadBudgetPageRead() });
}
