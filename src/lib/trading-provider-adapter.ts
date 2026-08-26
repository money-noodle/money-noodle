import type { ContractComparability, PositionSide, TradingProviderId } from './types';

export type TradingProviderCapability = 'market-data' | 'paper' | 'account-read' | 'live-order' | 'reconciliation';

export interface NormalizedProviderContract {
  providerId: TradingProviderId;
  providerVariantId: string;
  contractId: string;
  symbol: string;
  title: string;
  marketUrl: string;
  opensAt?: string;
  closesAt: string;
  rulesFingerprint: string;
  referenceSource?: string;
  settlementWindowSeconds?: number;
  comparability: ContractComparability;
  tickSize: number;
  minimumQuantity: number;
}

export interface NormalizedProviderQuote {
  providerId: TradingProviderId;
  providerVariantId: string;
  contractId: string;
  observedAt: string;
  probabilityUp: number;
  bidUp?: number;
  askUp?: number;
  bidDown?: number;
  askDown?: number;
  liquidity?: number;
  volume?: number;
}

export interface ProviderOrderRequest {
  providerId: TradingProviderId;
  providerVariantId: string;
  contractId: string;
  side: PositionSide;
  quantity: number;
  limitPrice: number;
  timeInForce: 'GTC' | 'IOC';
  postOnly: boolean;
  reduceOnly: boolean;
  clientOrderId: string;
}

export interface ProviderOrderReceipt {
  providerId: TradingProviderId;
  providerVariantId: string;
  providerOrderId: string;
  clientOrderId: string;
  acceptedAt: string;
  status: 'accepted' | 'rejected' | 'uncertain';
  reason?: string;
}

export interface ProviderAccountSnapshot {
  providerId: TradingProviderId;
  observedAt: string;
  availableCashCents?: number;
  positions: Array<{ contractId: string; side: PositionSide; quantity: number }>;
  restingOrderIds: string[];
}

/**
 * Provider adapters normalize reads and mutations without erasing provider semantics. Optional methods
 * are capability-gated; callers must never infer live support merely because market data is available.
 */
export interface TradingProviderAdapter {
  readonly providerId: TradingProviderId;
  readonly adapterVersion: string;
  readonly capabilities: ReadonlySet<TradingProviderCapability>;
  listContracts(): Promise<NormalizedProviderContract[]>;
  getQuote(contract: NormalizedProviderContract): Promise<NormalizedProviderQuote | null>;
  getOutcome(contract: NormalizedProviderContract): Promise<'UP' | 'DOWN' | 'invalid' | null>;
  getAccount?(): Promise<ProviderAccountSnapshot>;
  placeOrder?(request: ProviderOrderRequest): Promise<ProviderOrderReceipt>;
  cancelOrder?(providerOrderId: string): Promise<void>;
}

export function adapterSupports(adapter: TradingProviderAdapter, capability: TradingProviderCapability): boolean {
  return adapter.capabilities.has(capability);
}

export function assertAdapterCapability(adapter: TradingProviderAdapter, capability: TradingProviderCapability): void {
  if (!adapterSupports(adapter, capability)) throw new Error(`${adapter.providerId} adapter ${adapter.adapterVersion} does not support ${capability}.`);
}
