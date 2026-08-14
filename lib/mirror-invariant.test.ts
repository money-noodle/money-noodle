import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { assetAdmitted, excludedAssets } from './asset-exclusion';
import {
  bestEntry, bestEntryForSide, bestVenueEntry, downEntryEnabled, hasTradableEdge,
  qualifiesAsBuyEdge, qualifiesVenueBuyEdge,
} from './prediction-policy';

/**
 * SPEC §12.3: for any prediction snapshot, the entry decision is identical for live and paper.
 *
 * The guarantee is structural rather than behavioural — the rule layer takes no execution mode, so a
 * divergence cannot be expressed and therefore cannot be introduced by accident later. Asserting on
 * arity is deliberately blunt: it fails the moment someone reintroduces a `mode` argument, which is
 * exactly how paper drifted into trading XRP and ignoring the regime gate the first time.
 */
describe('mirror invariant: one policy for live and paper', () => {
  it('exposes no execution-mode parameter anywhere in the entry rule layer', () => {
    expect(qualifiesAsBuyEdge.length).toBe(1);
    expect(hasTradableEdge.length).toBe(1);
    expect(bestEntry.length).toBe(1);
    expect(bestEntryForSide.length).toBe(2);
    expect(bestVenueEntry.length).toBe(3);
    expect(qualifiesVenueBuyEdge.length).toBe(3);
    expect(downEntryEnabled.length).toBe(0);
    expect(assetAdmitted.length).toBe(1);
    expect(excludedAssets.length).toBe(0);
  });

  it('reaches one verdict per snapshot, whichever track is asking', () => {
    const prediction = (probabilityUp: number, askUp: number, askDown: number, symbol = 'BTC') => ({
      symbol, modelProbabilityUp: probabilityUp, confidence: 0.7,
      enabledTradingVenues: ['kalshi' as const],
      market: { live: false } as never,
      kalshi: { live: true, askUp, askDown } as never,
    });
    // A grid rather than one fixture: the point is that no input reaches a different answer per track,
    // and a single hand-picked case cannot show that.
    for (const probabilityUp of [0.2, 0.35, 0.45, 0.5, 0.56, 0.65, 0.8]) {
      for (const ask of [0.08, 0.3, 0.45, 0.62, 0.9]) {
        const candidate = prediction(probabilityUp, ask, Number((1 - ask).toFixed(2)));
        const verdict = {
          qualifies: qualifiesAsBuyEdge(candidate),
          side: bestEntry(candidate)?.side,
          kalshi: qualifiesVenueBuyEdge(candidate, 'kalshi'),
        };
        // Recomputing must be referentially transparent: no hidden per-track state decides this.
        expect({
          qualifies: qualifiesAsBuyEdge(candidate),
          side: bestEntry(candidate)?.side,
          kalshi: qualifiesVenueBuyEdge(candidate, 'kalshi'),
        }).toEqual(verdict);
      }
    }
  });

  it('withholds an excluded asset from both tracks at once', () => {
    // Nothing to parameterise: there is one answer, and both execution paths call this function.
    expect(assetAdmitted('XRP')).toBe(false);
    expect(assetAdmitted('BTC')).toBe(true);
  });
});
