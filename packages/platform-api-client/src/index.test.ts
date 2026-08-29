import { describe, expect, it } from 'vitest';

import * as transport from './index';

describe('platform API transport package', () => {
  it('contains no status operation before the vertical slice', () => {
    expect(Object.keys(transport)).not.toContain('getPlatformStatus');
  });
});
