import { Dashboard } from '@/components/dashboard';
import { getDashboard } from '@/lib/dashboard';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const initialData = await getDashboard().catch((error) => {
    console.error('Initial dashboard load failed:', error);
    return null;
  });
  return <Dashboard initialData={initialData}/>;
}
