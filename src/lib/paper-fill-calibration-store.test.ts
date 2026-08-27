import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('server-only', () => ({}));

const testRoot = mkdtempSync(path.join(tmpdir(), 'money-noodle-paper-fill-cal-'));
const storeDir = path.join(testRoot, 'store');
const storeFile = path.join(storeDir, 'paper-fill-calibration.json');
process.env.MONEY_NOODLE_PAPER_FILL_CALIBRATION_PATH = storeDir;

import {
  adoptPaperFillCalibration, getActivePaperFillCalibration, getPaperFillCalibrationStatus,
} from './paper-fill-calibration-store';
import { PAPER_NEUTRAL_EXECUTION_VERSION } from './paper-fill-calibration';

beforeEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
  delete process.env.MONEY_NOODLE_PAPER_FILL_CALIBRATION_PATH;
});

describe('paper fill calibration store', () => {
  it('defaults to the neutral horizon-bounded v7 cohort when no store exists', async () => {
    const active = await getActivePaperFillCalibration();
    expect(active).toMatchObject({
      queueClearFraction: 0,
      appliedToPaperExecution: PAPER_NEUTRAL_EXECUTION_VERSION,
      heldOutWindows: 0,
      adoptedAt: '',
    });
  });

  it('generates a fresh execution cohort and preserves complete immutable provenance per adoption', async () => {
    const first = await adoptPaperFillCalibration({
      queueClearFraction: 0.2,
      heldOutWindows: 30,
      reason: 'held-out fit',
    });
    expect(first.active).toMatchObject({
      queueClearFraction: 0.2,
      appliedToPaperExecution: 'paper-managed-execution-route-ioc-requalify3-calibrated-v8',
      heldOutWindows: 30,
      reason: 'held-out fit',
    });
    expect(first.history).toEqual([first.active]);

    const second = await adoptPaperFillCalibration({
      queueClearFraction: 0.25,
      heldOutWindows: 41,
      reason: 'later held-out fit',
    });
    expect(second.active.appliedToPaperExecution).toBe('paper-managed-execution-route-ioc-requalify3-calibrated-v9');
    expect(second.history).toHaveLength(2);
    expect(second.history[0]).toEqual(first.active);
    expect(second.history[1]).toMatchObject({
      queueClearFraction: 0.25,
      heldOutWindows: 41,
      reason: 'later held-out fit',
    });
  });

  it('gives a calibrated rollback to zero its own cohort rather than pooling it with neutral v7', async () => {
    await adoptPaperFillCalibration({ queueClearFraction: 0.2, heldOutWindows: 30, reason: 'fit' });
    const rollback = await adoptPaperFillCalibration({ queueClearFraction: 0, heldOutWindows: 25, reason: 'held-out rollback' });
    expect(rollback.active).toMatchObject({
      queueClearFraction: 0,
      appliedToPaperExecution: 'paper-managed-execution-route-ioc-requalify3-calibrated-v9',
      heldOutWindows: 25,
    });
  });

  it('projects a legacy neutral v6 file to v7 without rewriting it', async () => {
    mkdirSync(storeDir, { recursive: true });
    const legacy = {
      version: 1,
      active: {
        version: 'paper-fill-calibration-v1', queueClearFraction: 0,
        appliedToPaperExecution: 'paper-managed-execution-route-ioc-requalify3-calibrated-v6',
        heldOutWindows: 0, adoptedAt: '', reason: 'legacy neutral',
      },
      history: [], updatedAt: '2026-08-21T00:00:00.000Z',
    };
    writeFileSync(storeFile, JSON.stringify(legacy));
    expect(await getActivePaperFillCalibration()).toMatchObject({
      queueClearFraction: 0,
      appliedToPaperExecution: PAPER_NEUTRAL_EXECUTION_VERSION,
      heldOutWindows: 0,
    });
    expect(JSON.parse(readFileSync(storeFile, 'utf8'))).toEqual(legacy);
  });

  it('rejects invalid bounds and missing adoption provenance', async () => {
    await expect(adoptPaperFillCalibration({
      queueClearFraction: 0.7, heldOutWindows: 30, reason: 'bad',
    })).rejects.toThrow('queueClearFraction');
    await expect(adoptPaperFillCalibration({
      queueClearFraction: 0.2, heldOutWindows: 0, reason: 'bad',
    })).rejects.toThrow('heldOutWindows');
    await expect(adoptPaperFillCalibration({
      queueClearFraction: 0.2, heldOutWindows: 30, reason: '   ',
    })).rejects.toThrow('reason');
  });

  it('fails closed on malformed or discontinuous durable history', async () => {
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(storeFile, JSON.stringify({
      version: 1,
      active: {
        version: 'paper-fill-calibration-v1', queueClearFraction: 0.2,
        appliedToPaperExecution: 'paper-managed-execution-route-ioc-requalify3-calibrated-v9',
        heldOutWindows: 30, adoptedAt: '2026-08-21T00:00:00.000Z', reason: 'missing v8',
      },
      history: [{
        version: 'paper-fill-calibration-v1', queueClearFraction: 0.2,
        appliedToPaperExecution: 'paper-managed-execution-route-ioc-requalify3-calibrated-v9',
        heldOutWindows: 30, adoptedAt: '2026-08-21T00:00:00.000Z', reason: 'missing v8',
      }],
      updatedAt: '2026-08-21T00:00:00.000Z',
    }), { flag: 'w' });
    await expect(getPaperFillCalibrationStatus()).rejects.toThrow('discontinuous cohort history');
  });
});
