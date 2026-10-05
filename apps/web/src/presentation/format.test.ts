// The formatters, including every case where a missing figure must stay missing.
//
// The dash cases are the important ones. A zero where the API published nothing is the
// single most misleading thing this site could render, so each formatter is checked
// against null and undefined as well as against the value it is for.

import { describe, expect, it } from 'vitest';

import {
  DASH,
  formatAge,
  formatCents,
  formatCompactUsd,
  formatContractPrice,
  formatCount,
  formatLifecycle,
  formatModelProbability,
  formatNumber,
  formatPercentUnits,
  formatRatio,
  formatRemaining,
  formatSignedCents,
  formatSignedPoints,
  formatSpotPrice,
  orDash,
} from './format';

describe('absent figures', () => {
  const formatters = [
    formatCents,
    formatSignedCents,
    formatSpotPrice,
    formatCompactUsd,
    formatCount,
    formatRatio,
    formatPercentUnits,
    formatModelProbability,
    formatContractPrice,
    formatSignedPoints,
    formatNumber,
    formatAge,
    formatRemaining,
  ];

  it('are a dash, never a zero', () => {
    for (const format of formatters) {
      expect(format(undefined)).toBe(DASH);
      expect(format(null)).toBe(DASH);
      expect(format(Number.NaN)).toBe(DASH);
      expect(format(Number.POSITIVE_INFINITY)).toBe(DASH);
    }
  });

  it('are distinguishable from a published zero', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatRatio(0)).toBe('0.0%');
    expect(formatCount(0)).toBe('0');
  });

  it('applies a formatter only to a value that is there', () => {
    expect(orDash(2, (value) => `${value}`)).toBe('2');
    expect(orDash(undefined, () => 'unreachable')).toBe(DASH);
    expect(orDash(null, () => 'unreachable')).toBe(DASH);
  });
});

describe('money', () => {
  it('converts the API cents to dollars', () => {
    expect(formatCents(75_000)).toBe('$750.00');
    expect(formatCents(-1_250)).toBe('-$12.50');
    expect(formatCents(12.5)).toBe('$0.13');
  });

  it('signs a profit and loss figure', () => {
    expect(formatSignedCents(580)).toBe('+$5.80');
    expect(formatSignedCents(-580)).toBe('-$5.80');
    expect(formatSignedCents(0)).toBe('$0.00');
  });

  it('follows the magnitude for a spot price', () => {
    expect(formatSpotPrice(64_100)).toBe('$64,100.00');
    expect(formatSpotPrice(2.5)).toBe('$2.500');
    expect(formatSpotPrice(0.05123456)).toBe('$0.05123');
  });

  it('is compact for liquidity and volume', () => {
    expect(formatCompactUsd(1_234_000_000)).toBe('$1.2B');
    expect(formatCompactUsd(12_000)).toBe('$12.0K');
  });
});

describe('ratios and percentages', () => {
  it('renders a fraction as a percentage', () => {
    expect(formatRatio(0.5833)).toBe('58.3%');
    expect(formatRatio(0.5833, 2)).toBe('58.33%');
  });

  it('signs a figure the API already publishes in percent units', () => {
    expect(formatPercentUnits(1.25)).toBe('+1.25%');
    expect(formatPercentUnits(-3.1)).toBe('-3.10%');
    expect(formatPercentUnits(0)).toBe('0.00%');
  });

  it('bounds a model probability at the edges of what it can support', () => {
    expect(formatModelProbability(0.5623)).toBe('56.2%');
    expect(formatModelProbability(0.0005)).toBe('<0.1%');
    expect(formatModelProbability(0.9995)).toBe('>99.9%');
  });

  it('renders a contract price in cents, with sub-cent precision', () => {
    expect(formatContractPrice(0.55)).toBe('55.0¢');
    expect(formatContractPrice(0.004)).toBe('0.40¢');
    expect(formatContractPrice(0)).toBe('0.00¢');
  });

  it('signs a probability-point difference', () => {
    expect(formatSignedPoints(0.0123)).toBe('+1.2 pp');
    expect(formatSignedPoints(-0.0123)).toBe('-1.2 pp');
    expect(formatSignedPoints(0)).toBe('+0.0 pp');
  });

  it('keeps a small number at its published precision', () => {
    expect(formatNumber(0.0000269)).toBe('0.0000269');
    expect(formatNumber(0.228, 4)).toBe('0.228');
  });
});

describe('times and counts', () => {
  it('says how old a feed value is from the age the API published', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(1.4)).toBe('just now');
    expect(formatAge(45)).toBe('45 seconds ago');
    expect(formatAge(120)).toBe('2 minutes ago');
    expect(formatAge(7_200)).toBe('2 hours ago');
    expect(formatAge(7_500)).toBe('2 hours 5 minutes ago');
    expect(formatAge(-5)).toBe('just now');
  });

  it('says how long a contract has left', () => {
    expect(formatRemaining(45)).toBe('45 seconds');
    expect(formatRemaining(450)).toBe('7 min 30 s');
    expect(formatRemaining(-1)).toBe('0 seconds');
  });

  it('groups a count', () => {
    expect(formatCount(2_160)).toBe('2,160');
  });
});

describe('formatLifecycle', () => {
  it('opens out the source value rather than renaming it', () => {
    expect(formatLifecycle('won')).toBe('won');
    expect(formatLifecycle('pending_reservation')).toBe('pending reservation');
    // The no-fill reason wins over the status, and only its first underscore is opened
    // out: the rest of the source's own value is left exactly as the source wrote it.
    expect(formatLifecycle('unfilled', 'post_only_race')).toBe('post only_race');
    // An unrecognised value is shown as itself.
    expect(formatLifecycle('something_the_source_invented')).toBe('something the_source_invented');
  });
});
