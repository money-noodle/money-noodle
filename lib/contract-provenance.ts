import { createHash } from 'node:crypto';
import type { ContractComparability, ContractProvenanceRecord, ContractProvenanceRef, TradingVenue } from './types';

export const CONTRACT_PROVENANCE_VERSION = 'contract-provenance-v1';

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedClose(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

/** Fingerprints only settlement-defining fields; capture time and live quote values are excluded. */
export function createContractProvenance(input: {
  venue: TradingVenue;
  contractId: string;
  marketUrl: string;
  closesAt: string;
  rulesSource: string;
  rulesText: string;
  referenceSource?: string;
  referenceValue?: number;
  settlementWindowSeconds?: number;
  comparability: ContractComparability;
  capturedAt?: string;
}): ContractProvenanceRecord {
  const canonical = {
    venue: input.venue,
    contractId: input.contractId.trim(),
    marketUrl: input.marketUrl,
    closesAt: normalizedClose(input.closesAt),
    rulesSource: input.rulesSource,
    rulesText: normalizeText(input.rulesText),
    referenceSource: normalizeText(input.referenceSource) || undefined,
    referenceValue: Number.isFinite(input.referenceValue) ? input.referenceValue : undefined,
    settlementWindowSeconds: Number.isFinite(input.settlementWindowSeconds) ? input.settlementWindowSeconds : undefined,
    comparability: input.comparability,
  };
  const rulesFingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return {
    version: CONTRACT_PROVENANCE_VERSION,
    registryId: `${canonical.venue}:${canonical.contractId}:${rulesFingerprint}`,
    ...canonical,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    rulesFingerprint,
  };
}

export function contractProvenanceRef(record: ContractProvenanceRecord): ContractProvenanceRef {
  const { rulesText: _rulesText, ...reference } = record;
  return reference;
}
