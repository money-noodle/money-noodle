/**
 * Assets withheld from entry on their own evidence.
 *
 * XRP is the only asset whose historical executed clustered per-window return clears two standard errors
 * negative independently on both tracks: live −45.7% ±21.5 over 41 windows, paper −35.1% ±13.0 over 81.
 * Seven assets were tested, so roughly 0.4 false positives are expected by chance — one asset failing in
 * two separate samples is a good deal stronger than one failing in a ranking. The 2026-08-20 review
 * reproduced those legacy–v14 results but found null, less-than-one-day v21 ask evidence (+1.0% ±12.5 over
 * 59 windows), with no current-policy XRP execution. The exclusion remains conservative extrapolation,
 * not a claim that current XRP harm or value has been established; see reports/xrp-exclusion-review-2026-08-20.md.
 *
 * Nothing else qualifies. BTC and BNB looked strong in the maker shadow, but neither clears two standard
 * errors on either track, and excluding or favouring an asset on a ranking alone is how a five-day sample
 * becomes a permanent rule.
 *
 * One list for both tracks. This was live-only while paper carried it as an experiment; paper is now the
 * mirror, so an asset the desk will not buy with real money is not one it pretends to buy in the shadow
 * either. Continuing to measure a withheld asset belongs in the evaluation lane. See SPEC §12.
 */
export const DEFAULT_EXCLUDED_ASSETS = ['XRP'];

export function excludedAssets(): string[] {
  const raw = process.env.MONEY_NOODLE_EXCLUDED_ASSETS;
  if (raw === undefined) return DEFAULT_EXCLUDED_ASSETS;
  return raw.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
}

export function assetAdmitted(symbol: string): boolean {
  return !excludedAssets().includes(symbol.toUpperCase());
}
