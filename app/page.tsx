import { Dashboard } from '@/components/dashboard';
import { isAuthenticated } from '@/lib/auth';
import { getDashboard, publicDashboardData } from '@/lib/dashboard';
import { isStatelessDeployment } from '@/lib/runtime-environment';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [dashboard, authenticated] = await Promise.all([getDashboard().catch((error) => {
    console.error('Initial dashboard load failed:', error);
    return null;
  }), isAuthenticated()]);
  const initialData = dashboard && !authenticated ? publicDashboardData(dashboard) : dashboard;
  // Signing in does not conjure a desk. A stateless host has no control, ledger, or live track to read,
  // so the desk panel is decided here rather than by a client that can only discover the 503 by asking
  // for it every fifteen seconds — and, finding it, render nothing.
  return <Dashboard initialData={initialData} authenticated={authenticated} deskAvailable={authenticated && !isStatelessDeployment()}/>;
}
