import { createHash } from 'node:crypto';
import type {
  ContractComparability, ContractProvenanceRecord, ContractProvenanceRef, ContractTargetComparison,
  SettlementPriceMethod, TradingVenue,
} from './types';

export const CONTRACT_PROVENANCE_VERSION = 'contract-provenance-v1';

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedClose(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, five: 5, ten: 10, fifteen: 15, thirty: 30, sixty: 60,
};

function durationSeconds(text: string): number | undefined {
  const stream = text.match(/twap[-_ ](\d+)[-_ ]?s(?:[-_ ]?streams?)?\b/i);
  if (stream) return Number(stream[1]);
  const seconds = text.match(/\b(one|five|ten|fifteen|thirty|sixty|\d+)\s*(?:-\s*)?seconds?\b/i);
  if (seconds) return NUMBER_WORDS[seconds[1].toLowerCase()] ?? Number(seconds[1]);
  if (/\blast minute\b|\bfinal minute\b/i.test(text)) return 60;
  return undefined;
}

export interface ParsedSettlementMetadata {
  settlementPriceMethod: SettlementPriceMethod;
  referenceWindowSeconds?: number;
  settlementWindowSeconds?: number;
  roundingDecimals?: number;
}

/** Deterministic rule parser. Unknown wording stays unknown rather than receiving an invented window. */
export function parseContractSettlementMetadata(rulesText: string, referenceSource?: string): ParsedSettlementMetadata {
  const text = normalizeText(`${rulesText} ${referenceSource ?? ''}`);
  const settlementPriceMethod: SettlementPriceMethod = /\btwap\b|time[- ]weighted average/i.test(text)
    ? 'time-weighted-average'
    : /simple average|average of (?:the )?(?:\w+|\d+) (?:seconds|prices)|prices are collected/i.test(text)
      ? 'simple-average'
      : /price at (?:the )?(?:beginning|end)|closing price|last price/i.test(text)
        ? 'point-in-time'
        : 'unknown';
  const windowSeconds = settlementPriceMethod === 'point-in-time' ? undefined : durationSeconds(text);
  const rounding = text.match(/rounded to the nearest\s+(\d+)\s+decimal places?/i);
  return {
    settlementPriceMethod,
    ...(windowSeconds ? { referenceWindowSeconds: windowSeconds, settlementWindowSeconds: windowSeconds } : {}),
    ...(rounding ? { roundingDecimals: Number(rounding[1]) } : {}),
  };
}

/** Reads recorded metadata first and deterministically derives missing legacy fields from immutable rules. */
export function contractSettlementMetadata(record: ContractProvenanceRecord): ParsedSettlementMetadata {
  const parsed = parseContractSettlementMetadata(record.rulesText, record.referenceSource);
  return {
    settlementPriceMethod: record.settlementPriceMethod ?? parsed.settlementPriceMethod,
    referenceWindowSeconds: record.referenceWindowSeconds ?? parsed.referenceWindowSeconds,
    settlementWindowSeconds: record.settlementWindowSeconds ?? parsed.settlementWindowSeconds,
    roundingDecimals: record.roundingDecimals ?? parsed.roundingDecimals,
  };
}

function oracleIdentity(record: ContractProvenanceRecord): string | undefined {
  const source = normalizeText(`${record.referenceSource ?? ''} ${record.rulesText}`).toLowerCase();
  if (source.includes('chainlink')) return 'chainlink';
  if (source.includes('cf benchmarks')) return 'cf-benchmarks';
  if (source.includes('kraken')) return 'kraken';
  return undefined;
}

/** Rule-level cross-venue comparison. It is descriptive and has no execution-policy consumer. */
export function compareContractTargets(
  polymarket: ContractProvenanceRecord | undefined,
  kalshi: ContractProvenanceRecord | undefined,
): ContractTargetComparison {
  if (!polymarket || !kalshi) return {
    comparability: 'not-comparable', reason: 'Both venue rule records are required.', closeAligned: false,
    settlementWindowAligned: null, referenceWindowAligned: null, oracleAligned: null, methodAligned: null,
  };
  const poly = contractSettlementMetadata(polymarket);
  const kal = contractSettlementMetadata(kalshi);
  const closeAligned = Math.abs(Date.parse(polymarket.closesAt) - Date.parse(kalshi.closesAt)) <= 5_000;
  const aligned = (left: number | undefined, right: number | undefined) => left === undefined || right === undefined ? null : left === right;
  const settlementWindowAligned = aligned(poly.settlementWindowSeconds, kal.settlementWindowSeconds);
  const referenceWindowAligned = aligned(poly.referenceWindowSeconds, kal.referenceWindowSeconds);
  const polyOracle = oracleIdentity(polymarket), kalshiOracle = oracleIdentity(kalshi);
  const oracleAligned = !polyOracle || !kalshiOracle ? null : polyOracle === kalshiOracle;
  const methodAligned = poly.settlementPriceMethod === 'unknown' || kal.settlementPriceMethod === 'unknown'
    ? null : poly.settlementPriceMethod === kal.settlementPriceMethod;
  if (!closeAligned || settlementWindowAligned === false || referenceWindowAligned === false) return {
    comparability: 'not-comparable',
    reason: !closeAligned ? 'Venue close times are not aligned.' : 'Published averaging windows differ.',
    closeAligned, settlementWindowAligned, referenceWindowAligned, oracleAligned, methodAligned,
  };
  if (oracleAligned === true && methodAligned === true && settlementWindowAligned === true && referenceWindowAligned === true) return {
    comparability: 'exact', reason: 'Close, oracle, averaging method, and reference/settlement windows match.',
    closeAligned, settlementWindowAligned, referenceWindowAligned, oracleAligned, methodAligned,
  };
  const knownWindows = settlementWindowAligned === true && referenceWindowAligned === true;
  return {
    comparability: 'approximate',
    reason: knownWindows
      ? 'Averaging windows align, but venue oracle and/or averaging method differs.'
      : 'Close times align, but one or more rule metadata fields remain unknown.',
    closeAligned, settlementWindowAligned, referenceWindowAligned, oracleAligned, methodAligned,
  };
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
  settlementPriceMethod?: SettlementPriceMethod;
  referenceWindowSeconds?: number;
  settlementWindowSeconds?: number;
  roundingDecimals?: number;
  comparability: ContractComparability;
  capturedAt?: string;
}): ContractProvenanceRecord {
  const parsed = parseContractSettlementMetadata(input.rulesText, input.referenceSource);
  const canonical = {
    venue: input.venue,
    contractId: input.contractId.trim(),
    marketUrl: input.marketUrl,
    closesAt: normalizedClose(input.closesAt),
    rulesSource: input.rulesSource,
    rulesText: normalizeText(input.rulesText),
    referenceSource: normalizeText(input.referenceSource) || undefined,
    referenceValue: Number.isFinite(input.referenceValue) ? input.referenceValue : undefined,
    settlementPriceMethod: input.settlementPriceMethod ?? parsed.settlementPriceMethod,
    referenceWindowSeconds: Number.isFinite(input.referenceWindowSeconds) ? input.referenceWindowSeconds : parsed.referenceWindowSeconds,
    settlementWindowSeconds: Number.isFinite(input.settlementWindowSeconds) ? input.settlementWindowSeconds : parsed.settlementWindowSeconds,
    roundingDecimals: Number.isFinite(input.roundingDecimals) ? input.roundingDecimals : parsed.roundingDecimals,
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
