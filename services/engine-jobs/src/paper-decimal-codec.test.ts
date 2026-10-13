import { describe, expect, it } from 'vitest';
import {
  decodePaperExactDecimal,
  comparePaperExactDecimals,
  encodePaperSourceBinary64,
  decodePaperSourceBinary64,
} from './domain/paper-decimal-codec.js';
describe('unwired exact SQL decimal versus source binary64 transport', () => {
  it('uses literal exact decimal coefficients and orders values that Number merges', () => {
    expect(decodePaperExactDecimal('0.10000000000000000001')).toEqual({
      coefficient: 10000000000000000001n,
      scale: 20,
    });
    expect(comparePaperExactDecimals('0.10000000000000000001', '0.1')).toBe(1);
    expect(comparePaperExactDecimals('-0.10000000000000000001', '-0.1')).toBe(-1);
    expect(comparePaperExactDecimals('2.5', '2.5')).toBe(0);
    expect(decodePaperSourceBinary64('0.10000000000000000001')).toBeUndefined();
    expect(decodePaperSourceBinary64('0.10000000000000001')).toBeUndefined();
  });
  it('preserves source dust, fractional raw costs and noninteger settings without rounding', () => {
    const vectors: [number, string][] = [
      [0, '0'],
      [0.1, '0.1'],
      [0.1 + 0.2, '0.30000000000000004'],
      [7.000000000000001, '7.000000000000001'],
      [6.25, '6.25'],
      [2.5, '2.5'],
      [-0.99, '-0.99'],
      [1e-7, '0.0000001'],
      [-1e-7, '-0.0000001'],
      [2e12, '2000000000000'],
      [-2e12, '-2000000000000'],
    ];
    for (const [source, text] of vectors) {
      expect(encodePaperSourceBinary64(source)).toBe(text);
      expect(Object.is(decodePaperSourceBinary64(text), source)).toBe(true);
    }
    expect(encodePaperSourceBinary64(6.25)).not.toBe('7');
  });
  it('retains subnormal source values in the explicit finite decimal domain', () => {
    const text = '0.' + '0'.repeat(323) + '5';
    expect(encodePaperSourceBinary64(Number.MIN_VALUE)).toBe(text);
    expect(decodePaperExactDecimal(text)).toEqual({ coefficient: 5n, scale: 324 });
    expect(decodePaperSourceBinary64(text)).toBe(Number.MIN_VALUE);
    expect(encodePaperSourceBinary64(-Number.MIN_VALUE)).toBe('-' + text);
    expect(decodePaperSourceBinary64('0.' + '0'.repeat(323) + '1')).toBeUndefined();
  });
  it('rejects malformed, coercible, noncanonical, nonfinite and out-of-domain transport', () => {
    for (const bad of [
      null,
      undefined,
      0,
      1n,
      {},
      [],
      Object(1),
      '',
      ' 1',
      '1 ',
      '1\n',
      '1\r',
      '1x1',
      '1/1',
      '+1',
      '01',
      '-01',
      '-0',
      '-0.0',
      '1.0',
      '0.10',
      '.1',
      '1.',
      '1e-7',
      'NaN',
      'Infinity',
      '-Infinity',
      '2000000000000.0000000000000001',
      '-2000000000000.1',
      '9'.repeat(14),
      '0.' + '0'.repeat(324) + '1',
    ]) {
      expect(decodePaperExactDecimal(bad)).toBeUndefined();
      expect(decodePaperSourceBinary64(bad)).toBeUndefined();
      expect(comparePaperExactDecimals(bad, '0')).toBeUndefined();
    }
    for (const bad of [null, '1', 1n, {}, NaN, Infinity, -Infinity, -0, 2000000000000.001])
      expect(encodePaperSourceBinary64(bad)).toBeUndefined();
    expect(decodePaperExactDecimal('-0.1')).toEqual({ coefficient: -1n, scale: 1 });
  });
});
