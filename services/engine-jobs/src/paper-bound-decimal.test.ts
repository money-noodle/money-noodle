import { describe, expect, it } from 'vitest';
import {
  PAPER_BOUND_DECIMAL_MAX_TEXT,
  PAPER_CONFIDENCE_MARGIN,
  comparePaperBoundDecimals,
  paperBoundDecimalFromNumber,
  paperBoundDecimalWithin,
  paperBoundMarginSatisfied,
  paperExactRegimeSourceAdmits,
  paperExactRegimeSourceWithinDomains,
  paperNumberMarginSatisfied,
} from './domain/paper-bound-decimal.js';
import { paperGateGenerationInputsAreValid } from './domain/paper-gate-write.js';
import { PAPER_HISTORICAL_REGIME_CONTRACT } from './domain/paper-regime.js';

/** Independent oracle for the sweep below. Deliberately NOT the helper's algorithm: every
 * value is padded to a fixed eight-digit scale by string surgery and compared as one
 * integer, so a defect in the helper's parsing or scale alignment cannot be reproduced
 * here and then agree with itself. */
const units = (text: string): bigint => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole! + (fraction + '00000000').slice(0, 8));
};
const oracleLegal = (pause: string, resume: string): boolean =>
  units(pause) >= units('0.9') &&
  units(pause) <= units('0.9999') &&
  units(resume) >= units('0.5') &&
  units(resume) <= units('0.98') &&
  units(resume) + units('0.01') <= units(pause);
/** Four-decimal text built from an integer count of ten-thousandths, without `toFixed`. */
const text4 = (tenThousandths: number): string =>
  `${Math.trunc(tenThousandths / 10000)}.${String(tenThousandths % 10000).padStart(4, '0')}`;

const GENERATION = {
  bundleId: PAPER_HISTORICAL_REGIME_CONTRACT,
  profileClaim: 'synthetic-profile-claim',
  enabled: true,
  minimumPolicyWindows: 12,
  evidenceHalfLifeWindows: '2.5',
  pauseConfidence: '0.99',
  resumeConfidence: '0.75',
} as const;
const valid = (patch: Record<string, unknown>): boolean =>
  paperGateGenerationInputsAreValid({ ...GENERATION, ...patch } as never);

describe('exact decimal bounds for the persisted regime profile', () => {
  it('compares by value over the writer grammar, keeping every accepted spelling', () => {
    expect(PAPER_BOUND_DECIMAL_MAX_TEXT).toBe(24);
    expect(PAPER_CONFIDENCE_MARGIN).toBe('0.01');
    expect(comparePaperBoundDecimals('2.50', '2.5')).toBe(0);
    expect(comparePaperBoundDecimals('08', '8.000')).toBe(0);
    expect(comparePaperBoundDecimals('0.970', '0.97')).toBe(0);
    expect(comparePaperBoundDecimals('0.9', '0.9001')).toBe(-1);
    expect(comparePaperBoundDecimals('500', '499.9999')).toBe(1);
    // Anything outside the writer's own text grammar is not a decimal here at all.
    for (const bad of ['', ' 0.9', '0.9 ', '+0.9', '-0.9', '9e-1', '.9', '0.', 0.9, null])
      expect(comparePaperBoundDecimals(bad, '0.9')).toBeUndefined();
    expect(comparePaperBoundDecimals('2.' + '0'.repeat(23), '2')).toBeUndefined();
    expect(paperBoundDecimalWithin('0.9999', '0.9', '0.9999')).toBe(true);
    expect(paperBoundDecimalWithin('0.99990000000000000001', '0.9', '0.9999')).toBe(false);
    expect(paperBoundDecimalWithin('x', '0.9', '0.9999')).toBe(false);
  });

  it('decides the margin on digits, where binary64 disagrees with the column', () => {
    for (const [pause, resume] of [
      ['0.94', '0.93'],
      ['0.9007', '0.8907'],
      ['0.938', '0.928'],
      ['0.9400', '0.93'],
      ['0.94', '0.9300'],
    ] as const) {
      expect(paperBoundMarginSatisfied(resume, pause)).toBe(true);
      // The same rule in doubles; these are the pairs it got wrong.
      if (pause === '0.94' || pause === '0.9007')
        expect(Number(resume) <= Number(pause) - 0.01).toBe(false);
    }
    for (const [pause, resume] of [
      ['0.94', '0.9301'],
      ['0.9400', '0.9301'],
      ['0.9', '0.8901'],
    ] as const)
      expect(paperBoundMarginSatisfied(resume, pause)).toBe(false);
    expect(paperBoundMarginSatisfied('0.93', 'x')).toBe(false);
  });

  it('spells an existing number exactly and decides the number margin on that spelling', () => {
    expect(paperBoundDecimalFromNumber(0.94)).toBe('0.94');
    expect(paperBoundDecimalFromNumber(2.5)).toBe('2.5');
    expect(paperBoundDecimalFromNumber(Number('0.99990000000000000001'))).toBe('0.9999');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.94', 5e-324])
      expect(paperBoundDecimalFromNumber(bad)).toBeUndefined();
    expect(paperNumberMarginSatisfied(0.93, 0.94)).toBe(true);
    expect(paperNumberMarginSatisfied(0.8907, 0.9007)).toBe(true);
    expect(paperNumberMarginSatisfied(0.9301, 0.94)).toBe(false);
    expect(paperNumberMarginSatisfied(0.93, Number.NaN)).toBe(false);
  });

  it('admits an exact source only when it is real and projects onto those very numbers', () => {
    const source = {
      evidenceHalfLifeWindows: '2.50',
      pauseConfidence: '0.93999999999999989',
      resumeConfidence: '0.92999999999999989',
    };
    const numeric = {
      evidenceHalfLifeWindows: 2.5,
      pauseConfidence: Number(source.pauseConfidence),
      resumeConfidence: Number(source.resumeConfidence),
    };
    // SQL-legal: the difference is exactly a hundredth on the recorded digits, while the
    // projections differ by a hundredth minus one ulp.
    expect(paperExactRegimeSourceWithinDomains(source)).toBe(true);
    expect(paperExactRegimeSourceAdmits(source, numeric)).toBe(true);
    expect(numeric.resumeConfidence <= numeric.pauseConfidence - 0.01).toBe(false);
    expect(paperNumberMarginSatisfied(numeric.resumeConfidence, numeric.pauseConfidence)).toBe(
      false,
    );
    // A source that does not project onto these numbers is not a source.
    expect(paperExactRegimeSourceAdmits(source, { ...numeric, pauseConfidence: 0.94 })).toBe(false);
    expect(paperExactRegimeSourceAdmits(source, { ...numeric, evidenceHalfLifeWindows: 2.6 })).toBe(
      false,
    );
    expect(paperExactRegimeSourceAdmits(source, { ...numeric, resumeConfidence: 0.93 })).toBe(
      false,
    );
    // Malformed, out-of-domain or margin-violating text is not a source either.
    for (const patch of [
      { pauseConfidence: '0.9e0' },
      { pauseConfidence: '+0.94' },
      { pauseConfidence: ' 0.94' },
      { pauseConfidence: '0.99990000000000000001' },
      { resumeConfidence: '0.98000000000000000001' },
      { resumeConfidence: '0.9299999999999999' },
      { evidenceHalfLifeWindows: '1.9999' },
      { evidenceHalfLifeWindows: `2.${'0'.repeat(23)}` },
    ])
      expect(paperExactRegimeSourceWithinDomains({ ...source, ...patch })).toBe(false);
    for (const bad of [undefined, null, 'text', 42, [], { pauseConfidence: '0.94' }])
      expect(paperExactRegimeSourceWithinDomains(bad)).toBe(false);
  });

  it('matches an independent oracle on 16- to 20-digit pairs on both sides of the margin', () => {
    // pause = 0.94 - 11 units at the given scale, which at scale 17 is exactly the
    // reviewed counterexample; resume = pause - 0.01 exactly, and one unit above it.
    const text = (coefficient: bigint, scale: number) =>
      `0.${coefficient.toString().padStart(scale, '0')}`;
    const checked: string[] = [];
    for (let scale = 16; scale <= 20; scale += 1) {
      const unit = 10n ** BigInt(scale - 2);
      const pauseCoefficient = 94n * unit - 11n;
      const legal = pauseCoefficient - unit;
      const pause = text(pauseCoefficient, scale);
      for (const [resumeCoefficient, expected] of [
        [legal, true],
        [legal + 1n, false],
      ] as const) {
        const resume = text(resumeCoefficient, scale);
        // Independent oracle: pad both to a common scale by string surgery and compare
        // one integer, never the helper's own alignment.
        const pad = (value: string) => {
          const [, fraction = ''] = value.split('.');
          return BigInt((fraction + '0'.repeat(24)).slice(0, 24));
        };
        expect(pad(resume) + pad('0.01') <= pad(pause)).toBe(expected);
        expect(paperBoundMarginSatisfied(resume, pause)).toBe(expected);
        expect(
          paperExactRegimeSourceWithinDomains({
            evidenceHalfLifeWindows: '2.50',
            pauseConfidence: pause,
            resumeConfidence: resume,
          }),
        ).toBe(expected);
        checked.push(`${pause}/${resume}=${expected}`);
      }
    }
    expect(checked).toHaveLength(10);
    expect(checked).toContain('0.93999999999999989/0.92999999999999989=true');
    expect(checked).toContain('0.93999999999999989/0.92999999999999990=false');
  });

  it('agrees with an independent integer oracle across a 3000-pair boundary sweep', () => {
    let cases = 0;
    let legal = 0;
    const disagreements: string[] = [];
    const doubleOnly: string[] = [];
    for (let pauseUnits = 9000; pauseUnits <= 9999; pauseUnits += 1)
      for (const offset of [-1, 0, 1]) {
        const pause = text4(pauseUnits);
        const resume = text4(pauseUnits - 100 + offset);
        const expected = oracleLegal(pause, resume);
        const actual = valid({ pauseConfidence: pause, resumeConfidence: resume });
        cases += 1;
        if (expected) legal += 1;
        if (actual !== expected) disagreements.push(`${pause}/${resume}`);
        // Where the old binary64 rule and the column disagree, on in-bounds pairs.
        if (expected && !(Number(resume) <= Number(pause) - 0.01))
          doubleOnly.push(`${pause}/${resume}`);
      }
    expect(cases).toBe(3000);
    expect(disagreements).toEqual([]);
    expect(legal).toBeGreaterThan(0);
    // The repair is not cosmetic: these legal pairs were refused before it.
    expect(doubleOnly.length).toBeGreaterThan(0);
    expect(doubleOnly).toContain('0.9400/0.9300');
    // Trailing zeros never change a verdict.
    for (let pauseUnits = 9000; pauseUnits <= 9199; pauseUnits += 1) {
      const pause = text4(pauseUnits);
      const resume = text4(pauseUnits - 100);
      expect(valid({ pauseConfidence: `${pause}0`, resumeConfidence: resume })).toBe(
        valid({ pauseConfidence: pause, resumeConfidence: resume }),
      );
    }
  });
});
