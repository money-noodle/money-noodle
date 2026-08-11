import { describe, expect, it } from 'vitest';
import { contractProvenanceRef, createContractProvenance } from './contract-provenance';

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

  it('keeps full rules in the registry record but not repeated forecast references', () => {
    const record = createContractProvenance(input);
    const reference = contractProvenanceRef(record);
    expect(record.rulesText).toContain('settlement value');
    expect(reference).not.toHaveProperty('rulesText');
    expect(reference.rulesFingerprint).toBe(record.rulesFingerprint);
  });
});
