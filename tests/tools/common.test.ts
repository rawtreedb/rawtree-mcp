import { describe, expect, it } from 'vitest';
import { asJsonRows } from '../../src/tools/common.js';

describe('asJsonRows', () => {
  it('accepts a JSON object', () => {
    expect(asJsonRows({ event: 'signup', count: 1 })).toEqual({
      event: 'signup',
      count: 1,
    });
  });

  it('accepts a non-empty array of JSON objects', () => {
    expect(asJsonRows([{ event: 'signup' }])).toEqual([{ event: 'signup' }]);
  });

  it('rejects empty arrays', () => {
    expect(() => asJsonRows([])).toThrow(
      'data must be a JSON object or a non-empty array of JSON objects.',
    );
  });

  it('rejects non-finite numbers', () => {
    expect(() => asJsonRows({ value: Number.NaN })).toThrow(
      'data must be a JSON object or a non-empty array of JSON objects.',
    );
  });
});
