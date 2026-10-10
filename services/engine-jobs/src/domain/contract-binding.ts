import { createHash } from 'node:crypto';
import { validatedContract, type Contract, type Venue } from './forecast.js';
export const recordObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const normalized = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
/** Canonical fields/order match historical contract-provenance-v1. Capture time,
 * quote values and duplicated reference fields never define registry identity. */
export function canonicalRecord(
  value: unknown,
  registryId: string,
  venue: Venue,
  close: string,
  slug: string,
): Contract | null {
  const raw = recordObject(value);
  if (!raw || raw.version !== 'contract-provenance-v1' || raw.registryId !== registryId)
    return null;
  const valid = validatedContract(raw, venue, close, slug);
  if (!valid) return null;
  if (
    typeof raw.marketUrl !== 'string' ||
    typeof raw.rulesSource !== 'string' ||
    typeof raw.rulesText !== 'string' ||
    raw.rulesText.length > 16000 ||
    !['unknown', 'point-in-time', 'simple-average', 'time-weighted-average'].includes(
      String(raw.settlementPriceMethod),
    ) ||
    !['exact', 'approximate', 'not-comparable'].includes(String(raw.comparability))
  )
    return null;
  const optionalNumber = (key: string) =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;
  for (const key of [
    'referenceValue',
    'referenceWindowSeconds',
    'settlementWindowSeconds',
    'roundingDecimals',
  ])
    if (raw[key] !== undefined && optionalNumber(key) === undefined) return null;
  const canonical = {
    venue,
    contractId: valid.contractId.trim(),
    marketUrl: raw.marketUrl,
    closesAt: new Date(Date.parse(valid.closesAt)).toISOString(),
    rulesSource: raw.rulesSource,
    rulesText: normalized(raw.rulesText),
    referenceSource: normalized(raw.referenceSource) || undefined,
    referenceValue: optionalNumber('referenceValue'),
    settlementPriceMethod: raw.settlementPriceMethod,
    referenceWindowSeconds: optionalNumber('referenceWindowSeconds'),
    settlementWindowSeconds: optionalNumber('settlementWindowSeconds'),
    roundingDecimals: optionalNumber('roundingDecimals'),
    comparability: raw.comparability,
  };
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  if (
    raw.rulesFingerprint !== hash ||
    registryId !== venue + ':' + canonical.contractId + ':' + hash
  )
    return null;
  return validatedContract({ ...raw, closesAt: canonical.closesAt }, venue, close, slug);
}
export function boundReference(
  value: unknown,
  registry: ReadonlyMap<string, unknown>,
  venue: Venue,
  close: string,
  slug: string,
): Contract | null {
  const raw = recordObject(value);
  if (!raw) return null;
  if (raw.registryId === undefined) return validatedContract(raw, venue, close, slug);
  if (typeof raw.registryId !== 'string' || raw.registryId.length > 400) return null;
  const canonical = canonicalRecord(
    registry.get(raw.registryId),
    raw.registryId,
    venue,
    close,
    slug,
  );
  if (!canonical) return null;
  for (const key of [
    'venue',
    'contractId',
    'marketUrl',
    'rulesSource',
    'rulesText',
    'referenceSource',
    'referenceValue',
    'settlementPriceMethod',
    'referenceWindowSeconds',
    'settlementWindowSeconds',
    'roundingDecimals',
    'comparability',
    'rulesFingerprint',
  ])
    if (raw[key] !== undefined && raw[key] !== canonical[key as keyof Contract]) return null;
  if (
    raw.closesAt !== undefined &&
    (typeof raw.closesAt !== 'string' ||
      Date.parse(raw.closesAt) !== Date.parse(canonical.closesAt))
  )
    return null;
  return canonical;
}
