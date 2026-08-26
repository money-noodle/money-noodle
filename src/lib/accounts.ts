import 'server-only';
import type { SignatureType as PolymarketSignatureType } from '@polymarket/clob-client';
import { kalshiConfigured, kalshiEnvironment, kalshiRequest } from './kalshi-api';
import type { AccountsData, AccountPosition, VenueAccount } from './types';
import { getCryptoComAccount } from './cryptocom-api';
import { getRobinhoodAccount } from './robinhood-api';

// Signing and base-URL resolution live in one place so account reads and order placement can never
// diverge onto different environments or credentials.
const kalshiFetch = <T>(path: string): Promise<T> => kalshiRequest<T>(path);

async function getKalshiAccount(): Promise<VenueAccount> {
  const configured = kalshiConfigured();
  if (!configured) return { venue: 'kalshi', environment: kalshiEnvironment(), configured: false, connected: false, tradeAuthenticated: false, positions: [], openOrders: 0, error: 'Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in .env.local, then restart Money Noodle.' };
  try {
    const [balanceBody, positionsBody, ordersBody] = await Promise.all([
      kalshiFetch<{ balance?: number; balance_dollars?: string }>('/portfolio/balance'),
      kalshiFetch<{ market_positions?: Array<Record<string, unknown>> }>('/portfolio/positions?limit=200'),
      kalshiFetch<{ orders?: Array<Record<string, unknown>> }>('/portfolio/orders?status=resting&limit=200'),
    ]);
    const positions: AccountPosition[] = (positionsBody.market_positions ?? []).filter((row) => Number(row.position_fp ?? row.position ?? 0) !== 0).map((row) => {
      const size = Number(row.position_fp ?? row.position ?? 0);
      const exposure = Number(row.market_exposure_dollars ?? Number(row.market_exposure ?? 0) / 100);
      const pnl = Number(row.realized_pnl_dollars ?? Number(row.realized_pnl ?? 0) / 100);
      return {
        venue: 'kalshi', id: String(row.ticker ?? ''), title: String(row.ticker ?? 'Kalshi position'),
        side: size >= 0 ? 'YES' : 'NO', size: Math.abs(size), averagePrice: size ? Math.abs(exposure / size) : 0,
        currentPrice: 0, currentValue: Math.abs(exposure), pnl,
      };
    });
    return {
      venue: 'kalshi', environment: kalshiEnvironment(), configured: true, connected: true, tradeAuthenticated: true,
      balance: Number(balanceBody.balance_dollars ?? Number(balanceBody.balance ?? 0) / 100),
      positions, openOrders: ordersBody.orders?.length ?? 0,
    };
  } catch (error) {
    return { venue: 'kalshi', environment: kalshiEnvironment(), configured: true, connected: false, tradeAuthenticated: false, positions: [], openOrders: 0, error: error instanceof Error ? error.message : 'Kalshi connection failed' };
  }
}

async function polymarketPositions(address: string): Promise<AccountPosition[]> {
  const url = new URL('https://data-api.polymarket.com/positions');
  url.searchParams.set('user', address);
  url.searchParams.set('sizeThreshold', '0.01');
  url.searchParams.set('limit', '500');
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Polymarket account API returned ${response.status}`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    venue: 'polymarket', id: String(row.asset ?? row.conditionId ?? ''), title: String(row.title ?? row.slug ?? 'Polymarket position'),
    side: String(row.outcome ?? ''), size: Number(row.size ?? 0), averagePrice: Number(row.avgPrice ?? 0),
    currentPrice: Number(row.curPrice ?? row.currentPrice ?? 0), currentValue: Number(row.currentValue ?? 0),
    pnl: Number(row.cashPnl ?? 0) + Number(row.realizedPnl ?? 0),
  }));
}

async function getPolymarketAccount(): Promise<VenueAccount> {
  const publicAddress = process.env.POLYMARKET_WALLET_ADDRESS?.trim();
  const rawPrivateKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  const configured = Boolean(publicAddress || rawPrivateKey);
  if (!configured) return { venue: 'polymarket', configured: false, connected: false, tradeAuthenticated: false, positions: [], openOrders: 0 };
  try {
    if (!rawPrivateKey) {
      const positions = await polymarketPositions(publicAddress!);
      return { venue: 'polymarket', configured: true, connected: true, tradeAuthenticated: false, positions, openOrders: 0 };
    }
    const privateKey = (rawPrivateKey.startsWith('0x') ? rawPrivateKey : `0x${rawPrivateKey}`) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('POLYMARKET_PRIVATE_KEY is not a 32-byte hex private key');
    const [{ ClobClient, AssetType, SignatureType }, { createWalletClient, http }, { polygon }, { privateKeyToAccount }] = await Promise.all([
      import('@polymarket/clob-client'), import('viem'), import('viem/chains'), import('viem/accounts'),
    ]);
    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({ account, chain: polygon, transport: http(process.env.POLYGON_RPC_URL) });
    const host = process.env.POLYMARKET_CLOB_URL ?? 'https://clob.polymarket.com';
    const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 0) as PolymarketSignatureType;
    if (![SignatureType.EOA, SignatureType.POLY_PROXY, SignatureType.POLY_GNOSIS_SAFE].includes(signatureType)) throw new Error('POLYMARKET_SIGNATURE_TYPE must be 0, 1, or 2');
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS?.trim() || publicAddress || account.address;
    const suppliedCreds = process.env.POLYMARKET_API_KEY && process.env.POLYMARKET_API_SECRET && process.env.POLYMARKET_API_PASSPHRASE ? {
      key: process.env.POLYMARKET_API_KEY,
      secret: process.env.POLYMARKET_API_SECRET,
      passphrase: process.env.POLYMARKET_API_PASSPHRASE,
    } : null;
    const l1Client = new ClobClient(host, 137, walletClient);
    const creds = suppliedCreds ?? await l1Client.createOrDeriveApiKey();
    const client = new ClobClient(host, 137, walletClient, creds, signatureType, funder);
    const [balanceAllowance, openOrders, positions] = await Promise.all([
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      client.getOpenOrders(),
      polymarketPositions(funder),
    ]);
    if (!balanceAllowance || typeof balanceAllowance.balance !== 'string') throw new Error('Polymarket CLOB did not return a collateral balance');
    return {
      venue: 'polymarket', configured: true, connected: true, tradeAuthenticated: true,
      balance: Number(balanceAllowance.balance) / 1_000_000,
      positions, openOrders: openOrders.length,
    };
  } catch (error) {
    return { venue: 'polymarket', configured: true, connected: false, tradeAuthenticated: false, positions: [], openOrders: 0, error: error instanceof Error ? error.message : 'Polymarket connection failed' };
  }
}

export async function getAccounts(): Promise<AccountsData> {
  // Read-only for every configured provider. An account read is not an execution route: trading-control
  // filters this list down to venues that actually have one.
  const venues = await Promise.all([getPolymarketAccount(), getKalshiAccount(), getCryptoComAccount(), getRobinhoodAccount()]);
  return { generatedAt: new Date().toISOString(), tradingEnabled: false, venues };
}
