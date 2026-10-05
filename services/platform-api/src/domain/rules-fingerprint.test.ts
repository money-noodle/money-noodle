// The settlement identity, and what it is allowed to react to.
//
// The property worth protecting is narrow: the fingerprint must change when a term
// that decides settlement changes, and must not change when anything else does. Both
// halves are tested, because a fingerprint that moves with the quote is useless and
// one that ignores a rewritten reference index is worse than useless.

import { describe, expect, it } from 'vitest';

import {
  canonicalRulesText,
  contractSettlementIdentity,
  readReferenceWindowSeconds,
  readRoundingDecimals,
  readSettlementPriceMethod,
  type SettlementTerms,
} from './rules-fingerprint.js';

const terms: SettlementTerms = Object.freeze({
  closesAt: new Date('2026-10-05T18:00:00.000Z'),
  contractId: '  KXBTC-26OCT0518-T64000  ',
  marketUrl: 'https://kalshi.com/markets/kxbtc',
  referenceSource: 'CF Benchmarks RTI 60-second simple average',
  referenceValue: 64_000,
  rulesSource: 'https://api.elections.kalshi.com/trade-api/v2/markets/KXBTC-26OCT0518-T64000',
  rulesText:
    'If the settlement price is above 64000, the market resolves Yes.\n' +
    'The settlement price is the simple average of the prices collected over the final 60 seconds, ' +
    'rounded to the nearest 2 decimal places.',
  settlementWindowSeconds: 60,
});

describe('canonicalRulesText', () => {
  it('collapses whitespace so re-wrapped prose hashes the same', () => {
    expect(canonicalRulesText('  one   two\n\tthree  ', '', undefined, 'four')).toBe(
      'one two three four',
    );
  });
});

describe('readSettlementPriceMethod', () => {
  it('reads the venue keyword conventions', () => {
    expect(readSettlementPriceMethod('settled on the TWAP of the final minute')).toBe(
      'time-weighted-average',
    );
    expect(readSettlementPriceMethod('a time-weighted average price')).toBe(
      'time-weighted-average',
    );
    expect(readSettlementPriceMethod('the simple average of the window')).toBe('simple-average');
    expect(readSettlementPriceMethod('the average of the 60 prices')).toBe('simple-average');
    expect(readSettlementPriceMethod('prices are collected each second')).toBe('simple-average');
    expect(readSettlementPriceMethod('the price at the end of the hour')).toBe('point-in-time');
    expect(readSettlementPriceMethod('the closing price of the hour')).toBe('point-in-time');
    expect(readSettlementPriceMethod('the last price printed')).toBe('point-in-time');
  });

  it('says unknown rather than guessing', () => {
    // A default here would be published as a parsed finding about a real contract.
    expect(readSettlementPriceMethod('resolves according to the official source')).toBe('unknown');
  });
});

describe('readReferenceWindowSeconds', () => {
  it('normalizes the unit the text used', () => {
    expect(readReferenceWindowSeconds('averaged over the final 60 seconds')).toBe(60);
    expect(readReferenceWindowSeconds('averaged over the final 5-minute window')).toBe(300);
    expect(readReferenceWindowSeconds('averaged over 1 second')).toBe(1);
  });

  it('has no answer when the text names no window', () => {
    expect(readReferenceWindowSeconds('settles against the index')).toBeUndefined();
    expect(readReferenceWindowSeconds('averaged over the final 0 seconds')).toBeUndefined();
  });
});

describe('readRoundingDecimals', () => {
  it('reads the stated rounding and nothing else', () => {
    expect(readRoundingDecimals('rounded to the nearest 2 decimal places')).toBe(2);
    expect(readRoundingDecimals('rounded to the nearest 0 decimal place')).toBe(0);
    expect(readRoundingDecimals('rounded to the nearest dollar')).toBeUndefined();
    expect(readRoundingDecimals('rounded to the nearest 99 decimal places')).toBeUndefined();
  });
});

describe('contractSettlementIdentity', () => {
  it('publishes the parsed terms beside a stable hex digest', () => {
    const identity = contractSettlementIdentity(terms);
    expect(identity.settlementPriceMethod).toBe('simple-average');
    expect(identity.referenceWindowSeconds).toBe(60);
    expect(identity.roundingDecimals).toBe(2);
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(contractSettlementIdentity(terms).fingerprint).toBe(identity.fingerprint);
  });

  it('is unchanged by prose rewrapped around the same terms', () => {
    const rewrapped = {
      ...terms,
      rulesText: terms.rulesText.replace(/\s+/gu, '   ').replace('\n', '\n\n'),
    };
    expect(contractSettlementIdentity(rewrapped).fingerprint).toBe(
      contractSettlementIdentity(terms).fingerprint,
    );
  });

  it('changes when a term that decides settlement changes', () => {
    const baseline = contractSettlementIdentity(terms).fingerprint;
    const variants: readonly SettlementTerms[] = [
      { ...terms, referenceValue: 64_500 },
      { ...terms, referenceSource: 'Some other index, 300-second average' },
      { ...terms, closesAt: new Date('2026-10-05T19:00:00.000Z') },
      { ...terms, settlementWindowSeconds: 300 },
      { ...terms, rulesText: terms.rulesText.replace('simple average', 'TWAP') },
      { ...terms, rulesText: terms.rulesText.replace('2 decimal', '4 decimal') },
      { ...terms, contractId: 'KXBTC-26OCT0518-T64500' },
    ];
    for (const variant of variants) {
      expect(contractSettlementIdentity(variant).fingerprint).not.toBe(baseline);
    }
  });

  it('omits an unparsed window or rounding rather than defaulting them', () => {
    const vague = contractSettlementIdentity({
      ...terms,
      referenceSource: 'An index with no stated window',
      rulesText: 'Resolves Yes if the settlement price is above the strike.',
    });
    expect(vague.referenceWindowSeconds).toBeUndefined();
    expect(vague.roundingDecimals).toBeUndefined();
    expect(vague.settlementPriceMethod).toBe('unknown');
  });
});
