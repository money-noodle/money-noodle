import { describe, expect, it } from 'vitest';

import * as transport from './index';

describe('platform API transport package', () => {
  it('exports the generated status and health operations', () => {
    expect(transport.getPlatformStatus).toBeTypeOf('function');
    expect(transport.getLiveness).toBeTypeOf('function');
    expect(transport.getReadiness).toBeTypeOf('function');
  });

  it('exports the generated paper read operations', () => {
    expect(transport.getPaperBudget).toBeTypeOf('function');
    expect(transport.getPaperPerformanceSummary).toBeTypeOf('function');
    expect(transport.getPaperPerformance).toBeTypeOf('function');
  });
});
