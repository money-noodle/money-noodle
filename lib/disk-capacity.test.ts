import { describe, expect, it } from 'vitest';
import { assessDiskCapacity, MINIMUM_FREE_DISK_FRACTION } from './disk-capacity';

describe('disk capacity reserve', () => {
  it('requires ten percent of total capacity using available worker blocks', () => {
    expect(MINIMUM_FREE_DISK_FRACTION).toBe(0.10);
    expect(assessDiskCapacity(1_000, 100)).toMatchObject({
      ok: true, minimumAvailableBytes: 100, deficitBytes: 0, availableFraction: 0.1,
    });
    expect(assessDiskCapacity(1_000, 99)).toMatchObject({
      ok: false, minimumAvailableBytes: 100, deficitBytes: 1, availableFraction: 0.099,
    });
  });

  it('rounds the reserve upward so a fractional byte cannot weaken the threshold', () => {
    expect(assessDiskCapacity(1_001, 100)).toMatchObject({ ok: false, minimumAvailableBytes: 101, deficitBytes: 1 });
    expect(assessDiskCapacity(1_001, 101)).toMatchObject({ ok: true, minimumAvailableBytes: 101, deficitBytes: 0 });
  });

  it('rejects malformed filesystem measurements', () => {
    expect(() => assessDiskCapacity(0, 0)).toThrow('positive safe integer');
    expect(() => assessDiskCapacity(1_000, -1)).toThrow('within the filesystem total');
    expect(() => assessDiskCapacity(1_000, 1_001)).toThrow('within the filesystem total');
  });
});
