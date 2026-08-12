import { Dashboard } from '@/components/dashboard';
import { isAuthenticated } from '@/lib/auth';
import { getDashboard, publicDashboardData } from '@/lib/dashboard';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [dashboard, authenticated] = await Promise.all([getDashboard().catch((error) => {
    console.error('Initial dashboard load failed:', error);
    return null;
  }), isAuthenticated()]);
  const initialData = dashboard && !authenticated ? publicDashboardData(dashboard) : dashboard;
  return <Dashboard initialData={initialData} authenticated={authenticated}/>;
}
