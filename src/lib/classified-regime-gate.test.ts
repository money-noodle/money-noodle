import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { classifiedRegimeRequired } from './paper-execution';

/**
 * Applied to both tracks. It can only remove trades, never add exposure, which is what makes shipping it
 * on an in-sample counterfactual acceptable: the downside is missed opportunity rather than new risk.
 * Both tracks also record the label on each order so the cohorts stay measurable afterwards.
 */
const requireClassified = classifiedRegimeRequired;
const eligible = (regime: string | undefined) => requireClassified()
  ? Boolean(regime && regime !== 'insufficient')
  : true;

afterEach(() => { delete process.env.MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME; });

describe('classified-regime requirement', () => {
  it('is on by default, since the cohort it excludes is the weakest observed', () => {
    expect(requireClassified()).toBe(true);
  });

  it('admits a characterised path and refuses an uncharacterised one', () => {
    expect(eligible('trending')).toBe(true);
    expect(eligible('mean-reverting')).toBe(true);
    expect(eligible('mixed')).toBe(true);
    expect(eligible('insufficient')).toBe(false);
  });

  it('refuses a window with no recorded path at all rather than assuming it is fine', () => {
    expect(eligible(undefined)).toBe(false);
  });

  it('can be disabled without a code change, so the experiment is reversible', () => {
    process.env.MONEY_NOODLE_REQUIRE_CLASSIFIED_REGIME = 'false';
    expect(eligible('insufficient')).toBe(true);
    expect(eligible(undefined)).toBe(true);
  });
});
