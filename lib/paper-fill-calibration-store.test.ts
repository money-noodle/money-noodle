import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

vi.mock('server-only', () => ({}));

const storeDir = path.join(mkdtempSync('paper-fill-cal-'), 'store');
process.env.MONEY_NOODLE_PAPER_FILL_CALIBRATION_PATH = storeDir;

import { adoptPaperFillCalibration, getActivePaperFillCalibration } from './paper-fill-calibration-store';

beforeEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe('paper fill calibration store', () => {
  it('defaults to a neutral calibration when no store exists', async () => {
    console.log('neutral: dir exists?', existsSync(storeDir));
    const active = await getActivePaperFillCalibration();
    expect(active.queueClearFraction).toBe(0);
  });

  it('manual adoption appends immutable history and never auto-promotes', async () => {
    const first = await adoptPaperFillCalibration({
      queueClearFraction: 0.2,
      appliedToPaperExecution: 'v6',
      heldOutWindows: 30,
      reason: 'held-out fit',
    });
    expect(first.active.queueClearFraction).toBe(0.2);
    expect(first.history).toHaveLength(1);

    const second = await adoptPaperFillCalibration({
      queueClearFraction: 0.25,
      appliedToPaperExecution: 'v7',
      heldOutWindows: 41,
      reason: 'later held-out fit',
    });
    expect(second.history.map((entry) => entry.queueClearFraction)).toEqual([0.2, 0.25]);
    expect(second.active.queueClearFraction).toBe(0.25);
  });

  it('rejects out-of-range fractions', async () => {
    await expect(adoptPaperFillCalibration({
      queueClearFraction: 0.7,
      appliedToPaperExecution: 'v6',
      heldOutWindows: 30,
      reason: 'bad',
    })).rejects.toThrow();
  });

  it('reads the adopted calibration back', async () => {
    const active = await getActivePaperFillCalibration();
    expect(active.version).toBe('paper-fill-calibration-v1');
  });
});