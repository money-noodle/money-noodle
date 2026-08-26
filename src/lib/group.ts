/**
 * Grouping helpers for the reporting and storage paths.
 *
 * These exist because of a specific, measured mistake. The natural way to bucket rows in this codebase
 * was `map.set(key, [...(map.get(key) ?? []), item])`, which reads cleanly and copies the entire bucket
 * on every single row. Grouping n rows into a handful of buckets therefore costs O(n²) element copies,
 * and the allocation churn costs more than the copying does.
 *
 * On the real forecast history that made `summarizePerformance` a 9.6-second synchronous block, 43.8%
 * of it inside the garbage collector. Because the event loop was held, unrelated feeds all recorded the
 * same elapsed time and it looked like four upstream hosts stalling in lockstep. Replacing the copies
 * with in-place appends took the same call to roughly 0.7 seconds with byte-identical output.
 *
 * Coarse buckets are the dangerous case, not the exotic one: a two-label split over ~27k rows is far
 * worse than a per-window split into thousands of small groups. Prefer these helpers wherever the bucket
 * count is small or unbounded-by-input. See docs/forecast-storage-design.md §1.1.
 */

/** Appends to a bucket in place. Insertion order matches the copying form exactly. */
export function pushInto<T>(groups: Map<string, T[]>, key: string, item: T): void {
  const existing = groups.get(key);
  if (existing) existing.push(item);
  else groups.set(key, [item]);
}

/** Buckets items by a key function, skipping any item whose key is null or undefined. */
export function groupBy<T>(items: Iterable<T>, key: (item: T) => string | null | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = key(item);
    if (label === null || label === undefined) continue;
    pushInto(groups, label, item);
  }
  return groups;
}
