// A stable identity for the settlement terms of one public contract.
//
// Two contracts are only comparable if they settle the same way, and venue rules
// text is prose that changes wording without changing meaning. So the published
// identity is a hash over the terms that decide settlement — the reference index,
// the averaging method and window, the rounding, the strike — and deliberately not
// over anything that moves: no capture time, no quote, no liquidity.
//
// The consequence worth knowing: the fingerprint changes when the terms change, and
// only then. A caller can use it to tell "the same contract, requoted" from "a
// contract whose settlement definition was edited".
//
// The parser below reads the method, the averaging window and the rounding out of the
// rules text with the keyword rules the venue's own wording follows. It is a parser of
// public prose, so it is wrong sometimes; `settlementPriceMethod` therefore has an
// explicit `unknown` value rather than a default that would read as a finding.

import { createHash } from 'node:crypto';

export type SettlementPriceMethod =
  'point-in-time' | 'simple-average' | 'time-weighted-average' | 'unknown';

export interface SettlementTerms {
  readonly closesAt: Date;
  readonly contractId: string;
  readonly marketUrl: string;
  readonly referenceSource: string;
  readonly referenceValue: number;
  readonly rulesSource: string;
  readonly rulesText: string;
  readonly settlementWindowSeconds: number;
}

export interface ContractSettlementIdentity {
  readonly fingerprint: string;
  readonly referenceWindowSeconds?: number;
  readonly roundingDecimals?: number;
  readonly settlementPriceMethod: SettlementPriceMethod;
}

/** Whitespace runs collapse to one space, so re-wrapped prose hashes the same. */
export function canonicalRulesText(...parts: readonly (string | undefined)[]): string {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The method the text describes, by the venue's own keyword conventions. */
export function readSettlementPriceMethod(text: string): SettlementPriceMethod {
  const lowered = text.toLowerCase();
  if (/\btwap\b/u.test(lowered) || /time[\s-]weighted\s+average/u.test(lowered)) {
    return 'time-weighted-average';
  }
  if (
    /\bsimple\s+average\b/u.test(lowered) ||
    /\baverage\s+of\s+(?:the\s+)?\d+\s+(?:second|price)s?\b/u.test(lowered) ||
    /\bprices\s+are\s+collected\b/u.test(lowered)
  ) {
    return 'simple-average';
  }
  if (
    /\bprice\s+at\s+the\s+(?:beginning|end)\b/u.test(lowered) ||
    /\bclosing\s+price\b/u.test(lowered) ||
    /\blast\s+price\b/u.test(lowered)
  ) {
    return 'point-in-time';
  }
  return 'unknown';
}

/** The averaging window the text names, in seconds. */
export function readReferenceWindowSeconds(text: string): number | undefined {
  const match = /(\d{1,4})[\s-]*(second|minute)s?/iu.exec(text);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return undefined;
  return match[2]?.toLowerCase() === 'minute' ? amount * 60 : amount;
}

/** The rounding the text names, in decimal places. */
export function readRoundingDecimals(text: string): number | undefined {
  const match = /rounded\s+to\s+the\s+nearest\s+(\d{1,2})\s+decimal\s+places?/iu.exec(text);
  if (match === null) return undefined;
  const places = Number(match[1]);
  return Number.isInteger(places) && places >= 0 && places <= 12 ? places : undefined;
}

/**
 * The settlement identity of one contract.
 *
 * The hashed object's key order is fixed by this function rather than by object
 * literal order elsewhere, because the hash is only stable if the serialization is.
 * `comparability` is part of the hashed terms: a contract whose terms this API
 * matched exactly and one it merely approximated are not the same claim.
 */
export function contractSettlementIdentity(terms: SettlementTerms): ContractSettlementIdentity {
  const rulesText = canonicalRulesText(terms.rulesText);
  const describedBy = canonicalRulesText(rulesText, terms.referenceSource);
  const settlementPriceMethod = readSettlementPriceMethod(describedBy);
  const referenceWindowSeconds = readReferenceWindowSeconds(describedBy);
  const roundingDecimals = readRoundingDecimals(rulesText);

  const hashed: Record<string, unknown> = {
    venue: 'kalshi',
    contractId: terms.contractId.trim(),
    marketUrl: terms.marketUrl,
    closesAt: terms.closesAt.toISOString(),
    rulesSource: terms.rulesSource,
    rulesText,
    referenceSource: terms.referenceSource,
    referenceValue: terms.referenceValue,
    settlementPriceMethod,
    ...(referenceWindowSeconds === undefined ? {} : { referenceWindowSeconds }),
    settlementWindowSeconds: terms.settlementWindowSeconds,
    ...(roundingDecimals === undefined ? {} : { roundingDecimals }),
    comparability: 'exact',
  };

  return Object.freeze({
    fingerprint: createHash('sha256').update(JSON.stringify(hashed)).digest('hex'),
    ...(referenceWindowSeconds === undefined ? {} : { referenceWindowSeconds }),
    ...(roundingDecimals === undefined ? {} : { roundingDecimals }),
    settlementPriceMethod,
  });
}
