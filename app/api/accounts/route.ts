import { NextResponse } from 'next/server';
import { getAccounts } from '@/lib/accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getAccounts(), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
