import { describe, expect, it } from 'vitest';
import { fundingOpenedLabel, fundingScopeLine, fundingScopeTitle } from './funding-label';

const opened = '2026-08-15T08:15:43.046Z';
const openedMs = Date.parse(opened);
const firstOrder = '2026-08-08T21:12:37.137Z';

describe('fundingOpenedLabel', () => {
  it('says nothing when the record carries no opening timestamp', () => {
    // Paper's original bankroll has never been re-funded and holds no `startedAt`. Inventing one would
    // date every figure beside it wrongly, so the caller — not this function — says what absence means.
    expect(fundingOpenedLabel(undefined)).toBeUndefined();
  });

  it('says nothing for a malformed timestamp rather than rendering Invalid Date', () => {
    for (const bad of ['', 'not-a-date', '2026-13-45T99:99:99Z']) expect(fundingOpenedLabel(bad)).toBeUndefined();
  });

  it('reports the elapsed span across every boundary', () => {
    const cases: Array<[number, string]> = [
      [0, 'just now'],
      [59_000, 'just now'],
      [60_000, '1m ago'],
      [59 * 60_000, '59m ago'],
      [60 * 60_000, '1h ago'],
      [47 * 60 * 60_000, '47h ago'],
      [48 * 60 * 60_000, '2d ago'],
      [10 * 24 * 60 * 60_000, '10d ago'],
    ];
    for (const [age, expected] of cases) {
      expect(fundingOpenedLabel(opened, openedMs + age)).toMatch(new RegExp(`^Funded .+ · ${expected}$`));
    }
  });

  it('drops the elapsed span when the funding is stamped ahead of the clock', () => {
    // Clock skew must not produce "-1d ago"; the instant is still worth showing.
    const label = fundingOpenedLabel(opened, openedMs - 60_000);
    expect(label).toMatch(/^Funded /);
    expect(label).not.toContain('ago');
  });
});

describe('fundingScopeLine', () => {
  const now = openedMs + 2 * 24 * 60 * 60_000;

  it('dates a funding that was opened deliberately, and never mentions a first trade beside it', () => {
    // Live's epoch. The opening moment is recorded, so the first order it bought adds nothing.
    const line = fundingScopeLine({ pnlScope: 'budget-epoch', epochStartedAt: opened, fundingFirstOrderAt: firstOrder }, now);
    expect(line).toMatch(/^Funded .+ · 2d ago$/);
    expect(line).not.toContain('first trade');
  });

  it('anchors a bankroll with no funding timestamp to its first trade, labelled as one', () => {
    // Paper's original bankroll: 1,086 orders, no `startedAt`, no reset. The line must not imply the
    // bankroll was funded when it happened to place its first order.
    const line = fundingScopeLine({ pnlScope: 'lifetime', fundingFirstOrderAt: firstOrder, bankrollResets: 0 }, now);
    expect(line).toMatch(/^Whole bankroll life · first trade .+ · no reset recorded$/);
    expect(line).not.toContain('Funded');
  });

  it('reports the reset that rebased the figures once one has happened', () => {
    const line = fundingScopeLine({ pnlScope: 'lifetime', epochStartedAt: opened, fundingFirstOrderAt: firstOrder, bankrollResets: 2 }, now);
    expect(line).toMatch(/^Funded .+ · 2d ago · reset 2×$/);
  });

  it('omits the reset clause for a track that carries no reset counter', () => {
    // Live's budget is re-funded through the control, not reset; claiming "no reset recorded" there
    // would describe a counter that does not apply to it.
    expect(fundingScopeLine({ pnlScope: 'budget-epoch', epochStartedAt: opened }, now)).not.toContain('reset');
  });

  it('still names the span when the record holds neither timestamp', () => {
    expect(fundingScopeLine({ pnlScope: 'budget-epoch' }, now)).toBe('Current budget only');
    expect(fundingScopeLine({}, now)).toBe('Whole bankroll life');
    expect(fundingScopeLine({ bankrollResets: 0 }, now)).toBe('Whole bankroll life · no reset recorded');
  });
});

describe('fundingScopeTitle', () => {
  it('carries the exact stored instant so the short line never has to be precise', () => {
    expect(fundingScopeTitle({ epochStartedAt: opened })).toContain(opened);
  });

  it('says outright that a first-trade anchor is not a funding timestamp', () => {
    const title = fundingScopeTitle({ fundingFirstOrderAt: firstOrder });
    expect(title).toContain('no funding timestamp');
    expect(title).toContain(firstOrder);
  });

  it('prefers the funding timestamp over the first trade when both exist', () => {
    expect(fundingScopeTitle({ epochStartedAt: opened, fundingFirstOrderAt: firstOrder })).toContain('This funding opened');
  });

  it('has nothing to say when neither timestamp is recorded', () => {
    expect(fundingScopeTitle({})).toBeUndefined();
    expect(fundingScopeTitle({ epochStartedAt: 'not-a-date' })).toBeUndefined();
  });
});
