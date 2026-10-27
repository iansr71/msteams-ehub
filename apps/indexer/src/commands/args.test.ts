import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  UsageError,
  courseIdListSchema,
  courseIdSchema,
  parseCommandArgs,
  parseFlags,
} from './args.js';

const spec = { json: 'boolean', 'course-id': 'string', search: 'string', ids: 'string[]' } as const;

describe('parseFlags', () => {
  it('parses boolean, value and repeated flags in both forms', () => {
    expect(
      parseFlags(
        ['--json', '--course-id', '12', '--search=laser safety', '--ids', '1', '--ids=2,3'],
        spec,
      ),
    ).toEqual({
      json: true,
      'course-id': '12',
      search: 'laser safety',
      ids: ['1', '2,3'],
    });
  });

  it.each([
    [['12'], /Unexpected argument/],
    [['--unknown'], /Unknown option: --unknown/],
    [['--constructor'], /Unknown option/],
    [['--__proto__'], /Unknown option/],
    [['--course-id'], /requires a value/],
    [['--course-id', '--json'], /requires a value/],
    [['--json=true'], /does not take a value/],
    [['--course-id', '1', '--course-id', '2'], /only be given once/],
    [Array.from({ length: 65 }, () => '--json'), /Too many arguments/],
  ])('rejects %j', (args, message) => {
    expect(() => parseFlags(args, spec)).toThrow(UsageError);
    expect(() => parseFlags(args, spec)).toThrow(message);
  });

  it('accepts an empty value given with =', () => {
    expect(parseFlags(['--search='], spec)).toEqual({ search: '' });
  });
});

describe('course ID schemas', () => {
  it.each(['1', '12', '9999999999'])('accepts %s', (value) => {
    expect(courseIdSchema.parse(value)).toBe(Number(value));
  });

  it.each(['0', '-1', '1.5', '1e3', '0x10', ' 12', '12abc', '', '99999999999'])(
    'rejects %j',
    (value) => {
      expect(courseIdSchema.safeParse(value).success).toBe(false);
    },
  );

  it('flattens repeated and comma-separated lists', () => {
    expect(courseIdListSchema.parse(['1,2', ' 3 '])).toEqual([1, 2, 3]);
    expect(courseIdListSchema.safeParse(['1,,2']).success).toBe(false);
  });
});

describe('parseCommandArgs', () => {
  const schema = z.object({ json: z.boolean().optional(), 'course-id': courseIdSchema }).strict();

  it('validates parsed flags', () => {
    expect(
      parseCommandArgs(
        ['--course-id', '5', '--json'],
        { json: 'boolean', 'course-id': 'string' },
        schema,
      ),
    ).toEqual({
      json: true,
      'course-id': 5,
    });
  });

  it('turns validation failures into usage errors naming the flag', () => {
    expect(() => parseCommandArgs([], { 'course-id': 'string' }, schema)).toThrow(
      '--course-id: is required.',
    );
    expect(() => parseCommandArgs(['--course-id', 'x'], { 'course-id': 'string' }, schema)).toThrow(
      '--course-id: must be a positive whole number.',
    );
  });
});
