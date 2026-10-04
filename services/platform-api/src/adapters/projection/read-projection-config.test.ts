import { describe, expect, it } from 'vitest';

import { DEFAULT_PROJECTION_TABLES } from '../../domain/paper-projection.js';
import {
  PROJECTION_URL_ENV,
  expectedTableList,
  readProjectionConfig,
} from './read-projection-config.js';

describe('readProjectionConfig', () => {
  it('defaults to the projection the v1 worker writes, in the public schema', () => {
    const config = readProjectionConfig({});

    expect(config.schema).toBe('public');
    expect(config.tables).toEqual(DEFAULT_PROJECTION_TABLES);
    expect(config.connectionString).toBeUndefined();
  });

  it('treats an absent or blank connection string as no projection configured', () => {
    // A Secret Manager reference that has no version yet can arrive as empty.
    // Handing that to a driver produces a confusing failure much later.
    for (const value of [undefined, '', '   ']) {
      const config = readProjectionConfig(
        value === undefined ? {} : { [PROJECTION_URL_ENV]: value },
      );
      expect(config.connectionString).toBeUndefined();
    }
  });

  it('carries a configured connection string through without inspecting it', () => {
    // Obviously synthetic: this value is not a credential and reaches no driver.
    const synthetic = 'postgresql://example/example';
    const config = readProjectionConfig({ [PROJECTION_URL_ENV]: synthetic });

    expect(config.connectionString).toBe(synthetic);
  });

  it('accepts configured table names so a writer-side rename needs no release', () => {
    const config = readProjectionConfig({
      PLATFORM_API_PROJECTION_SCHEMA: 'projection_v2',
      PLATFORM_API_PROJECTION_TABLE_BUDGET: 'paper_budget',
      PLATFORM_API_PROJECTION_TABLE_EXECUTIONS: 'paper_executions',
    });

    expect(config.schema).toBe('projection_v2');
    expect(config.tables.budget).toBe('paper_budget');
    expect(config.tables.executions).toBe('paper_executions');
    expect(config.tables.performance).toBe(DEFAULT_PROJECTION_TABLES.performance);
  });

  it.each([
    'Budget',
    'budget; drop table t',
    'budget"',
    'budget-name',
    '1budget',
    'public.budget',
    'budget ',
  ])('refuses %o as a table name rather than building SQL from it', (value) => {
    expect(() =>
      readProjectionConfig({ PLATFORM_API_PROJECTION_TABLE_BUDGET: value }),
    ).toThrowError(/must be a lower-case unquoted SQL identifier/u);
  });

  it('names the variable but never its value when refusing one', () => {
    // The rejected value may be whatever someone pasted into the wrong variable.
    // A connection-string-shaped value with no userinfo: the point is that the
    // refusal does not echo it, not that it is realistic.
    const secretish = 'postgresql://db.example.invalid/example';
    try {
      readProjectionConfig({ PLATFORM_API_PROJECTION_TABLE_BUDGET: secretish });
      expect.unreachable('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('PLATFORM_API_PROJECTION_TABLE_BUDGET');
      expect(message).not.toContain(secretish);
      expect(message).not.toContain('db.example.invalid');
      expect(message).not.toContain('postgresql');
    }
  });

  it('lists exactly the four projection tables for the privilege rule', () => {
    const config = readProjectionConfig({});
    const expected = expectedTableList(config.tables);

    expect([...expected].sort()).toEqual(
      [
        DEFAULT_PROJECTION_TABLES.budget,
        DEFAULT_PROJECTION_TABLES.executions,
        DEFAULT_PROJECTION_TABLES.longShot,
        DEFAULT_PROJECTION_TABLES.performance,
      ].sort(),
    );
  });
});
