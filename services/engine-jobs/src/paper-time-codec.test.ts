import { describe, expect, it } from 'vitest';
import {
  decodePaperDbMicroseconds,
  paperSourceIsoToDbMicroseconds,
  comparePaperDbTimes,
  paperDbTimeToSourceIso,
  paperSourceAtOrBeforeDbCutoff,
} from './domain/paper-time-codec.js';
describe('unwired paper source milliseconds versus database microseconds', () => {
  it('keeps microsecond ordering and rejects precision loss at the source boundary', () => {
    expect(comparePaperDbTimes('1001', '1002')).toBe(-1);
    expect(comparePaperDbTimes('1002', '1001')).toBe(1);
    expect(comparePaperDbTimes('1001', '1001')).toBe(0);
    expect(paperDbTimeToSourceIso('1001')).toBeUndefined();
    expect(paperDbTimeToSourceIso('1000')).toBe('1970-01-01T00:00:00.001Z');
    expect(paperSourceAtOrBeforeDbCutoff('1970-01-01T00:00:00.001Z', '1001')).toBe(true);
    expect(paperSourceAtOrBeforeDbCutoff('1970-01-01T00:00:00.001Z', '999')).toBe(false);
  });
  it('preserves negative epoch, zero and exact aligned source round trips', () => {
    expect(decodePaperDbMicroseconds('-1')).toBe(-1n);
    expect(paperDbTimeToSourceIso('-1')).toBeUndefined();
    expect(paperDbTimeToSourceIso('-1000')).toBe('1969-12-31T23:59:59.999Z');
    expect(paperSourceIsoToDbMicroseconds('1970-01-01T00:00:00.000Z')).toBe(0n);
    expect(paperSourceIsoToDbMicroseconds('1969-12-31T23:59:59.999Z')).toBe(-1000n);
    const source = '2026-10-12T03:00:00.000Z';
    const encoded = paperSourceIsoToDbMicroseconds(source);
    expect(encoded).not.toBeUndefined();
    expect(paperDbTimeToSourceIso(encoded!.toString())).toBe(source);
  });
  it('refuses noncanonical transport, infinity, coercion and unsupported range', () => {
    for (const bad of [
      null,
      undefined,
      1001,
      1001n,
      new Date(0),
      '',
      ' 1',
      '1 ',
      '+1',
      '-0',
      '01',
      '-01',
      '1.0',
      '1e3',
      'NaN',
      'Infinity',
      '-Infinity',
      '8640000000000000001',
      '-8640000000000000001',
      '9'.repeat(21),
    ]) {
      expect(decodePaperDbMicroseconds(bad)).toBeUndefined();
      expect(comparePaperDbTimes(bad, '0')).toBeUndefined();
      expect(paperDbTimeToSourceIso(bad)).toBeUndefined();
    }
    for (const bad of [
      null,
      new Date(0),
      0,
      '1970-01-01T00:00:00Z',
      '1970-01-01T00:00:00.000+00:00',
      '1970-01-01T00:00:00.000001Z',
      '2026-02-30T00:00:00.000Z',
      'infinity',
      'not-a-date',
    ]) {
      expect(paperSourceIsoToDbMicroseconds(bad)).toBeUndefined();
      expect(paperSourceAtOrBeforeDbCutoff(bad, '0')).toBeUndefined();
    }
  });
  it('retains both explicit JS Date endpoints without rounding database input', () => {
    for (const text of ['8640000000000000000', '-8640000000000000000']) {
      const source = paperDbTimeToSourceIso(text);
      expect(source).not.toBeUndefined();
      expect(paperSourceIsoToDbMicroseconds(source)).toBe(BigInt(text));
    }
  });
});
