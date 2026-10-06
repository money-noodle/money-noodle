import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTROL_EPOCH,
  DEFAULT_ENGINE_SCHEMA,
  ENGINE_READER_URL_ENV,
  ENGINE_RECORDER_URL_ENV,
  readEngineStoreConfig,
} from './read-engine-store-config.js';

describe('reading engine store configuration', () => {
  it('keeps the two connections separate, so one can be present without the other', () => {
    // The two roles are the point of ADR-0013 §2, and they arrive as two
    // independent Secret Manager references.
    const readOnly = readEngineStoreConfig({ [ENGINE_READER_URL_ENV]: 'postgres://r' });
    expect(readOnly.readerConnectionString).toBe('postgres://r');
    expect(readOnly.recorderConnectionString).toBeUndefined();

    const recordOnly = readEngineStoreConfig({ [ENGINE_RECORDER_URL_ENV]: 'postgres://w' });
    expect(recordOnly.readerConnectionString).toBeUndefined();
    expect(recordOnly.recorderConnectionString).toBe('postgres://w');
  });

  it('treats an absent or empty reference as unconfigured', () => {
    const config = readEngineStoreConfig({
      [ENGINE_READER_URL_ENV]: '',
      [ENGINE_RECORDER_URL_ENV]: '   ',
    });
    expect(config.readerConnectionString).toBeUndefined();
    expect(config.recorderConnectionString).toBeUndefined();
  });

  it('defaults the schema and the epoch', () => {
    const config = readEngineStoreConfig({});
    expect(config.schema).toBe(DEFAULT_ENGINE_SCHEMA);
    expect(config.epoch).toBe(DEFAULT_CONTROL_EPOCH);
  });

  it('accepts a renamed schema and refuses one that could carry SQL', () => {
    expect(readEngineStoreConfig({ PLATFORM_API_ENGINE_SCHEMA: 'engine_v2' }).schema).toBe(
      'engine_v2',
    );
    expect(() =>
      readEngineStoreConfig({ PLATFORM_API_ENGINE_SCHEMA: 'engine"; drop schema engine --' }),
    ).toThrow('PLATFORM_API_ENGINE_SCHEMA');
  });

  it('refuses an epoch that is not a positive integer', () => {
    expect(readEngineStoreConfig({ PLATFORM_API_ENGINE_CONTROL_EPOCH: '4' }).epoch).toBe(4);
    for (const bad of ['0', '-1', 'two', '1.5']) {
      expect(() => readEngineStoreConfig({ PLATFORM_API_ENGINE_CONTROL_EPOCH: bad })).toThrow(
        'PLATFORM_API_ENGINE_CONTROL_EPOCH',
      );
    }
  });
});
