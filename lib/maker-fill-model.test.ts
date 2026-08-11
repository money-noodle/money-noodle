import { describe, expect, it } from 'vitest';
import { estimateMakerTouch, quoteVolatilityPerSecond } from './maker-fill-model';

const history = [0.50, 0.49, 0.51, 0.48, 0.50].map((ask, index) => ({ time: index * 10_000, ask }));

describe('observation-only maker first-passage model', () => {
  it('estimates quote volatility from time-normalized ask changes', () => {
    const result = quoteVolatilityPerSecond(history)!;
    expect(result.samples).toBe(4);
    expect(result.volatility).toBeGreaterThan(0);
  });

  it('assigns a higher touch probability to a nearer passive bid', () => {
    const near = estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.49, quoteHistory: history })!;
    const far = estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.4, quoteHistory: history })!;
    expect(near.probability).toBeGreaterThan(far.probability);
    expect(near.model).toBe('quote-first-passage-v1');
    expect(near.horizonSeconds).toBe(12);
  });

  it('fails closed with flat, thin, or crossing quote data', () => {
    expect(estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.49, quoteHistory: history.slice(0, 3) })).toBeNull();
    expect(estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.5, quoteHistory: history })).toBeNull();
    expect(estimateMakerTouch({ currentAsk: 0.5, passiveBid: 0.49, quoteHistory: history.map((point) => ({ ...point, ask: 0.5 })) })).toBeNull();
  });
});
