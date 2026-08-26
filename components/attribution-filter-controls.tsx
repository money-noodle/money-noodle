'use client';

import { Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  EMPTY_ORDER_ATTRIBUTION_FILTERS, type OrderAttributionFacets,
  type OrderAttributionFilterKey, type OrderAttributionFilters,
} from '@/lib/order-attribution';

const DIMENSIONS: Array<{ key: OrderAttributionFilterKey; label: string }> = [
  { key: 'modes', label: 'Track' },
  { key: 'providerIds', label: 'Provider' },
  { key: 'providerVariantIds', label: 'Variant' },
  { key: 'marketIds', label: 'Market' },
  { key: 'forecastModelVersions', label: 'Forecast' },
  { key: 'buyPolicyVersions', label: 'Buy policy' },
  { key: 'executionPolicyVersions', label: 'Execution' },
];

export function AttributionFilterControls({ filters, facets, onChange, compact = false }: {
  filters: OrderAttributionFilters;
  facets: OrderAttributionFacets;
  onChange: (filters: OrderAttributionFilters) => void;
  compact?: boolean;
}) {
  const activeCount = Object.values(filters).reduce((sum, values) => sum + values.length, 0);
  const toggle = (key: OrderAttributionFilterKey, value: string) => {
    const current = filters[key];
    onChange({ ...filters, [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  };
  return <div className="rounded-lg border bg-background/35 p-2.5">
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 flex items-center gap-1 text-[8px] font-medium uppercase tracking-wider text-muted-foreground"><Filter className="size-3"/>Attribution scope</span>
      {DIMENSIONS.map(({ key, label }) => {
        const selected = filters[key];
        const options = facets[key];
        if (!options.length) return null;
        return <details key={key} className="relative">
          <summary className="cursor-pointer list-none rounded-md border bg-background px-2 py-1 font-mono text-[8px] marker:content-none">
            {label}{selected.length ? ` · ${selected.length}` : ' · all'}
          </summary>
          <div className="absolute left-0 top-7 z-50 max-h-56 w-72 overflow-y-auto rounded-md border bg-popover p-1.5 shadow-xl">
            {options.map((option) => <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-[9px] hover:bg-secondary/60">
              <input type="checkbox" className="mt-0.5" checked={selected.includes(option.value)} onChange={() => toggle(key, option.value)}/>
              <span className="min-w-0 flex-1 break-all font-mono">{option.value}</span>
              <span className="shrink-0 text-muted-foreground">{option.count}</span>
            </label>)}
          </div>
        </details>;
      })}
      {activeCount > 0 && <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[8px]" onClick={() => onChange({ ...EMPTY_ORDER_ATTRIBUTION_FILTERS })}><X className="size-3"/>Clear {activeCount}</Button>}
    </div>
    {!compact && <p className="mt-1.5 text-[8px] leading-relaxed text-muted-foreground">Selections within one field are OR; fields combine with AND. “unattributed” is historical missing identity, never the current version. Live and paper totals remain separate.</p>}
  </div>;
}
