// The tolerant readers, against the values a stored record might plausibly hold
// and the values it must not be allowed to pass off as data.
//
// Provider-free by construction: every input is a literal.

import { describe, expect, it } from 'vitest';

import {
  field,
  readArray,
  readArrayOrEmpty,
  readBoolean,
  readConstant,
  readCount,
  readExactNumber,
  readInteger,
  readNullableNumber,
  readNumber,
  readObject,
  readOptional,
  readOptionalNullableNumber,
  readSourceTime,
  readString,
  RecordShapeError,
} from './read-record.js';

/** The failure a read rejected with. Refuses to let a resolved read pass as one. */
function refusal(read: () => unknown): RecordShapeError {
  try {
    read();
  } catch (error) {
    if (error instanceof RecordShapeError) return error;
    throw error;
  }
  throw new Error('expected a refusal, got a value');
}

describe('field', () => {
  it('tells an absent key from one holding undefined', () => {
    expect(field({ present: 1 }, 'present')).toBe(1);
    expect(field({}, 'absent')).toBeUndefined();
    expect(field({ explicit: undefined }, 'explicit')).toBeUndefined();
  });
});

describe('primitive readers', () => {
  it('accepts a finite number and refuses anything else', () => {
    expect(readNumber(1.5, 'x')).toBe(1.5);
    expect(readNumber(-0.25, 'x')).toBe(-0.25);
    for (const value of ['1', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(refusal(() => readNumber(value, 'x')).path).toBe('x');
    }
  });

  it('accepts a documented null as the answer it is', () => {
    expect(readNullableNumber(null, 'x')).toBeNull();
    expect(readNullableNumber(0, 'x')).toBe(0);
    // Absent is not the same as null here: a missing documented field is a failure.
    expect(refusal(() => readNullableNumber(undefined, 'x')).path).toBe('x');
  });

  it('separates whole numbers, counts and strings from their near misses', () => {
    expect(readInteger(-3, 'x')).toBe(-3);
    expect(refusal(() => readInteger(1.5, 'x')).message).toContain('a whole number');
    expect(readCount(0, 'x')).toBe(0);
    expect(refusal(() => readCount(-1, 'x')).message).toContain('a count of zero or more');
    expect(readString('value', 'x')).toBe('value');
    expect(refusal(() => readString('', 'x')).path).toBe('x');
  });

  it('refuses a boolean-looking string, because the source stores real booleans here', () => {
    expect(readBoolean(false, 'x')).toBe(false);
    expect(refusal(() => readBoolean('false', 'x')).path).toBe('x');
  });

  it('refuses a constant that is not the expected one', () => {
    expect(readConstant('paper', 'mode', 'paper')).toBe('paper');
    const error = refusal(() => readConstant('live', 'mode', 'paper'));
    expect(error.path).toBe('mode');
    expect(error.message).toContain('exactly "paper"');
    // The expectation is named; what was actually there is not repeated.
    expect(error.message).not.toContain('live');
  });

  it('refuses an array or null where an object is documented', () => {
    expect(readObject({ a: 1 }, 'x').a).toBe(1);
    for (const value of [null, [], 'object', 7]) {
      expect(refusal(() => readObject(value, 'x')).message).toContain('an object');
    }
  });
});

describe('readSourceTime', () => {
  it('normalizes every form the source might record to ISO-8601 UTC', () => {
    expect(readSourceTime('2026-10-05T06:00:00.000Z', 'x')).toBe('2026-10-05T06:00:00.000Z');
    // A database text cast of a timestamp: a real instant, not ISO-8601. This is the
    // legacy fallback the source's own summary path can produce.
    expect(readSourceTime('2026-10-05 06:00:00+00', 'x')).toBe('2026-10-05T06:00:00.000Z');
    expect(readSourceTime(new Date('2026-10-05T06:00:00Z'), 'x')).toBe('2026-10-05T06:00:00.000Z');
  });

  it('refuses a value that is not a time', () => {
    for (const value of ['not a time', '', 1_760_000_000, null, new Date(Number.NaN)]) {
      expect(refusal(() => readSourceTime(value, 'issuedAt')).path).toBe('issuedAt');
    }
  });
});

describe('readArray', () => {
  it('names the element and the field inside it when one entry is wrong', () => {
    const error = refusal(() =>
      readArray([{ n: 1 }, { n: 'two' }], 'rows', (value, path) =>
        readNumber(field(readObject(value, path), 'n'), `${path}.n`),
      ),
    );

    expect(error.path).toBe('rows[1].n');
    expect(error.message).not.toContain('two');
  });

  it('refuses a missing array, while the explicitly tolerant reader reads it as empty', () => {
    expect(refusal(() => readArray(undefined, 'rows', readNumber)).message).toContain('an array');
    expect(readArrayOrEmpty(undefined, 'rows', readNumber)).toEqual([]);
    expect(readArrayOrEmpty(null, 'rows', readNumber)).toEqual([]);
    expect(readArrayOrEmpty([1, 2], 'rows', readNumber)).toEqual([1, 2]);
  });
});

describe('optional readers', () => {
  it('treats absent and null alike where the source uses both for "nothing"', () => {
    expect(readOptional(undefined, 'x', readNumber)).toBeUndefined();
    expect(readOptional(null, 'x', readNumber)).toBeUndefined();
    expect(readOptional(2, 'x', readNumber)).toBe(2);
  });

  it('keeps absent and null apart where the source means different things by them', () => {
    expect(readOptionalNullableNumber(undefined, 'x')).toBeUndefined();
    expect(readOptionalNullableNumber(null, 'x')).toBeNull();
    expect(readOptionalNullableNumber(0.5, 'x')).toBe(0.5);
  });
});

describe('readExactNumber', () => {
  it('carries an integer amount the representation can hold exactly', () => {
    expect(readExactNumber(100_000n, 'startingCents')).toBe(100_000);
    expect(readExactNumber(-42n, 'realizedPnlCents')).toBe(-42);
    expect(readExactNumber(0n, 'availableCents')).toBe(0);
  });

  it('refuses an integer beyond exact representation rather than rounding it', () => {
    // A balance this large is impossible in practice. Refusing is still the right
    // answer: a rounded balance is a wrong balance, quietly.
    const error = refusal(() => readExactNumber(9_007_199_254_740_993n, 'availableCents'));
    expect(error.path).toBe('availableCents');
    expect(error.message).toContain('exactly');
  });

  it('carries a decimal the representation can hold exactly, in any stored spelling', () => {
    expect(readExactNumber('-12.3456789', 'realizedPnlCents')).toBe(-12.3456789);
    expect(readExactNumber('615', 'stakeCents')).toBe(615);
    expect(readExactNumber('0.6150', 'askPrice')).toBe(0.615);
    expect(readExactNumber('  1.5  ', 'quantity')).toBe(1.5);
    expect(readExactNumber('007', 'quantity')).toBe(7);
    expect(readExactNumber('-0', 'feeCents')).toBe(-0);
    expect(readExactNumber('0.00', 'feeCents')).toBe(0);
  });

  it('refuses a decimal carrying more precision than the representation can hold', () => {
    expect(refusal(() => readExactNumber('0.10000000000000000000001', 'quantity')).path).toBe(
      'quantity',
    );
    expect(refusal(() => readExactNumber('9007199254740993', 'stakeCents')).message).toContain(
      'exactly',
    );
  });

  it('refuses text that is not a decimal at all', () => {
    for (const value of ['1e21', '1,5', 'NaN', '', '0x10', '1.']) {
      expect(refusal(() => readExactNumber(value, 'stakeCents')).path).toBe('stakeCents');
    }
  });
});
