import type { ExecutionMode } from './types';

/**
 * Assets withheld from live entry on their own evidence.
 *
 * XRP is the only asset whose clustered per-window return clears two standard errors negative, and it
 * does so independently on both tracks: live −44.3% ±21.4 over 41 windows, paper −34.3% ±13.1 over 80.
 * Seven assets were tested, so roughly 0.4 false positives are expected by chance — one asset failing in
 * two separate samples is a good deal stronger than one failing in a ranking.
 *
 * Nothing else qualifies. BTC and BNB looked strong in the maker shadow, but neither clears two standard
 * errors on either track, and excluding or favouring an asset on a ranking alone is how a five-day sample
 * becomes a permanent rule.
 *
 * Live-only by default: paper keeps trading XRP so the evidence continues to accumulate, in the same
 * spirit as the DOWN experiment. Real money stops; measurement does not.
 */
export const DEFAULT_LIVE_EXCLUDED_ASSETS = ['XRP'];

function configured(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
}

export function excludedAssets(mode: ExecutionMode): string[] {
  return mode === 'live'
    ? configured('MONEY_NOODLE_LIVE_EXCLUDED_ASSETS', DEFAULT_LIVE_EXCLUDED_ASSETS)
    : configured('MONEY_NOODLE_PAPER_EXCLUDED_ASSETS', []);
}

/** Defaults to the stricter track when a mode is not stated, so a forgotten argument cannot loosen this. */
export function assetAdmitted(symbol: string, mode: ExecutionMode = 'live'): boolean {
  return !excludedAssets(mode).includes(symbol.toUpperCase());
}
