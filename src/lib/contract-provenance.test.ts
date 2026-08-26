import { describe, expect, it } from 'vitest';
import { compareContractTargets, contractProvenanceMatches, contractProvenanceRef, createContractProvenance, parseContractSettlementMetadata } from './contract-provenance';

const input = {
  venue: 'kalshi' as const,
  contractId: 'KXBTC15M-TEST',
  marketUrl: 'https://kalshi.com/markets/kxbtc15m',
  closesAt: '2026-01-01T00:15:00Z',
  rulesSource: 'https://api.example.test/markets/KXBTC15M-TEST',
  rulesText: 'YES if the settlement value is above the reference value.',
  referenceSource: 'Published floor strike',
  referenceValue: 100,
  comparability: 'approximate' as const,
};

describe('contract provenance fingerprints', () => {
  it('is stable across capture times and whitespace-only rule changes', () => {
    const first = createContractProvenance({ ...input, capturedAt: '2026-01-01T00:00:01Z' });
    const second = createContractProvenance({ ...input, rulesText: ' YES   if the settlement value is above the reference value. ', capturedAt: '2026-01-01T00:00:02Z' });
    expect(first.rulesFingerprint).toBe(second.rulesFingerprint);
    expect(first.registryId).toBe(second.registryId);
    expect(first.capturedAt).not.toBe(second.capturedAt);
  });

  it('creates a new immutable identity when settlement rules change', () => {
    const first = createContractProvenance(input);
    const changed = createContractProvenance({ ...input, rulesText: `${input.rulesText} Final value is a 60-second average.` });
    expect(changed.rulesFingerprint).not.toBe(first.rulesFingerprint);
    expect(changed.registryId).not.toBe(first.registryId);
  });

  it('parses Kalshi simple-average and Polymarket TWAP windows', () => {
    expect(parseContractSettlementMetadata(
      "If the simple average of the sixty seconds before close is higher. The value is rounded to the nearest 4 decimal places.",
    )).toEqual({ settlementPriceMethod: 'simple-average', referenceWindowSeconds: 60, settlementWindowSeconds: 60, roundingDecimals: 4 });
    expect(parseContractSettlementMetadata(
      'The time-weighted average price resolves from Chainlink.', 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
    )).toMatchObject({ settlementPriceMethod: 'time-weighted-average', referenceWindowSeconds: 60, settlementWindowSeconds: 60 });
  });

  it('classifies aligned windows with different oracles and methods as approximate', () => {
    const poly = createContractProvenance({
      ...input, venue: 'polymarket', contractId: 'poly',
      rulesText: 'Chainlink time-weighted average price.', referenceSource: 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
    });
    const kalshi = createContractProvenance({
      ...input, rulesText: "Simple average of the sixty seconds of CF Benchmarks' BTCUSDRTI before close.",
      referenceSource: 'CF Benchmarks RTI',
    });
    expect(compareContractTargets(poly, kalshi)).toMatchObject({
      comparability: 'approximate', closeAligned: true, settlementWindowAligned: true,
      referenceWindowAligned: true, oracleAligned: false, methodAligned: false,
    });
  });

  it('fails comparison closed when published averaging windows differ', () => {
    const poly = createContractProvenance({ ...input, venue: 'polymarket', contractId: 'poly', settlementWindowSeconds: 30, referenceWindowSeconds: 30 });
    const kalshi = createContractProvenance({ ...input, settlementWindowSeconds: 60, referenceWindowSeconds: 60 });
    expect(compareContractTargets(poly, kalshi)).toMatchObject({ comparability: 'not-comparable', settlementWindowAligned: false });
  });

  it('keeps full rules in the registry record but not repeated forecast references', () => {
    const record = createContractProvenance(input);
    const reference = contractProvenanceRef(record);
    expect(record.rulesText).toContain('settlement value');
    expect(reference).not.toHaveProperty('rulesText');
    expect(reference.rulesFingerprint).toBe(record.rulesFingerprint);
  });

  it('matches outcomes against both full and compacted registry references', () => {
    const reference = contractProvenanceRef(createContractProvenance(input));
    expect(contractProvenanceMatches(reference, 'kalshi', input.contractId)).toBe(true);
    expect(contractProvenanceMatches({ registryId: reference.registryId }, 'kalshi', input.contractId)).toBe(true);
    expect(contractProvenanceMatches({ registryId: reference.registryId }, 'kalshi', 'OTHER')).toBe(false);
    expect(contractProvenanceMatches({ registryId: reference.registryId }, 'polymarket', input.contractId)).toBe(false);
  });
});
