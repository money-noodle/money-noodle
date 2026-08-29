import { describe, expect, it } from 'vitest';

import { readPort } from './read-port.js';

describe('readPort', () => {
  it('uses the API default when PORT is absent', () => {
    expect(readPort(undefined)).toBe(3001);
  });

  it('accepts a valid TCP port', () => {
    expect(readPort('8080')).toBe(8080);
  });

  it.each(['0', '65536', '12.5', 'not-a-port'])('rejects invalid PORT value %s', (value) => {
    expect(() => readPort(value)).toThrow('PORT must be an integer from 1 through 65535.');
  });
});
