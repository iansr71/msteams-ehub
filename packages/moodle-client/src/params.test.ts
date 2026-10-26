import { describe, expect, it } from 'vitest';

import { MoodleValidationError } from './errors.js';
import { encodeMoodleParams } from './params.js';

function entries(params: Parameters<typeof encodeMoodleParams>[0]): [string, string][] {
  return [...encodeMoodleParams(params)];
}

describe('encodeMoodleParams', () => {
  it('encodes scalars, booleans as 1/0, and skips undefined', () => {
    expect(
      entries({ courseid: 5, field: 'email', flag: true, off: false, missing: undefined }),
    ).toEqual([
      ['courseid', '5'],
      ['field', 'email'],
      ['flag', '1'],
      ['off', '0'],
    ]);
  });

  it('encodes arrays and nested objects in Moodle bracket notation', () => {
    expect(
      entries({
        values: ['a@example.test', 'b@example.test'],
        options: [
          { name: 'onlyactive', value: true },
          { name: 'limitnumber', value: 50 },
        ],
        filter: { ids: [1, 2] },
      }),
    ).toEqual([
      ['values[0]', 'a@example.test'],
      ['values[1]', 'b@example.test'],
      ['options[0][name]', 'onlyactive'],
      ['options[0][value]', '1'],
      ['options[1][name]', 'limitnumber'],
      ['options[1][value]', '50'],
      ['filter[ids][0]', '1'],
      ['filter[ids][1]', '2'],
    ]);
  });

  it('keeps values containing form syntax as data', () => {
    const encoded = encodeMoodleParams({ values: ['x&wstoken=evil'] }).toString();
    expect(new URLSearchParams(encoded).getAll('wstoken')).toEqual([]);
  });

  it.each([
    [{ 'bad name': 1 }],
    [{ 'x[0]': 1 }],
    [{ 'a&b': 1 }],
    [{ nested: { 'k=v': 1 } }],
    [{ n: Number.NaN }],
    [{ n: Number.POSITIVE_INFINITY }],
  ])('rejects unsafe input %j', (params) => {
    expect(() => encodeMoodleParams(params)).toThrow(MoodleValidationError);
  });

  it('limits nesting depth', () => {
    expect(() => encodeMoodleParams({ a: [[[[[[[[1]]]]]]]] })).toThrow(/nested too deeply/);
  });
});
