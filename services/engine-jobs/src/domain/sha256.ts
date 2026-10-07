import { createHash } from 'node:crypto';

export const SHA256_HEX = /^[a-f0-9]{64}$/;

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Stable JSON for hashing a set of rows: keys sorted at every depth, one row per
 * line, so the same logical rows hash the same whatever order a reader produced
 * them in.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function rowSetDigest(rows: readonly unknown[]): string {
  return sha256Hex(rows.map(canonicalJson).join('\n'));
}
