import { describe, expect, it } from 'vitest';

import {
  DIMENSION_RULES,
  METRICS,
  SPAN_ATTRIBUTE_RULES,
  cleanAttributes,
  cleanDimensions,
  isAllowedAttribute,
  isAllowedDimension,
} from './catalogue.js';

const EMAIL = 'thandi.nkosi@example.com';
const OBJECT_ID = '3f2b1c4d-9a8e-4f7b-b6c5-1d2e3f4a5b6c';
const URL_WITH_TOKEN =
  'https://ehub.example.com/webservice/pluginfile.php/12/mod_resource/content/1/a.pdf?token=abc123';
const QUESTION = 'How do I prepare a client for a chemical peel?';

describe('metric dimensions', () => {
  it('keeps declared dimensions whose values pass their rule', () => {
    expect(
      cleanDimensions('ehub.dependency.failures', {
        dependency: 'moodle',
        operation: 'core_course_get_contents',
        category: 'timeout',
      }),
    ).toEqual({
      kept: { dependency: 'moodle', operation: 'core_course_get_contents', category: 'timeout' },
      dropped: 0,
    });
  });

  it.each([
    ['email', EMAIL],
    ['Entra object ID', OBJECT_ID],
    ['URL', URL_WITH_TOKEN],
    ['question text', QUESTION],
    ['upper case', 'Timeout'],
    ['empty', ''],
    ['over 48 characters', `a${'b'.repeat(48)}`],
  ])('drops a code dimension holding %s', (_label, value) => {
    expect(cleanDimensions('ehub.dependency.failures', { category: value })).toEqual({
      kept: {},
      dropped: 1,
    });
  });

  it('drops dimensions the metric does not declare, even allowed keys', () => {
    // `reason` is a known key but not one of ehub.answers' dimensions.
    expect(
      cleanDimensions('ehub.answers', { status: 'answered', reason: 'x', userEmail: 'a' }),
    ).toEqual({ kept: { status: 'answered' }, dropped: 2 });
  });

  it('checks enumerated dimensions against their values', () => {
    expect(isAllowedDimension('dependency', 'search')).toBe(true);
    expect(isAllowedDimension('dependency', 'graph')).toBe(false);
    expect(isAllowedDimension('outcome', 'success')).toBe(true);
    expect(isAllowedDimension('outcome', 'mapped')).toBe(false);
    expect(isAllowedDimension('status_class', '4xx')).toBe(true);
    expect(isAllowedDimension('status_class', '404')).toBe(false);
    expect(isAllowedDimension('route', 'answers')).toBe(true);
    expect(isAllowedDimension('route', '/api/answers')).toBe(false);
  });

  it('ignores undefined values without counting them as dropped', () => {
    expect(cleanDimensions('ehub.answers', { status: undefined })).toEqual({
      kept: {},
      dropped: 0,
    });
  });

  it('refuses prototype keys', () => {
    expect(isAllowedDimension('constructor', 'x')).toBe(false);
    expect(isAllowedDimension('__proto__', 'x')).toBe(false);
  });

  it('declares only dimensions that have a rule', () => {
    for (const [name, definition] of Object.entries(METRICS)) {
      for (const dimension of definition.dimensions) {
        expect(Object.hasOwn(DIMENSION_RULES, dimension), `${name}.${dimension}`).toBe(true);
      }
    }
  });
});

describe('span attributes', () => {
  it('keeps identifiers, integers, codes and booleans', () => {
    expect(
      cleanAttributes({
        'ehub.correlation_id': 'c0ffee00-0000-4000-8000-000000000001',
        'ehub.course_id': 12,
        'ehub.category': 'timeout',
        'ehub.cached': true,
        'http.request.method': 'POST',
      }),
    ).toEqual({
      kept: {
        'ehub.correlation_id': 'c0ffee00-0000-4000-8000-000000000001',
        'ehub.course_id': 12,
        'ehub.category': 'timeout',
        'ehub.cached': true,
        'http.request.method': 'POST',
      },
      dropped: 0,
    });
  });

  it.each([
    ['an email as an identifier', 'ehub.correlation_id', EMAIL],
    ['a URL as a code', 'ehub.operation', URL_WITH_TOKEN],
    ['question text as a code', 'ehub.reason', QUESTION],
    ['a string as an integer', 'ehub.course_id', '12'],
    ['a negative integer', 'ehub.count.bytes', -1],
    ['a fraction', 'ehub.count.results', 1.5],
    ['a string as a boolean', 'ehub.cached', 'true'],
    ['an undeclared key', 'user.email', 'x'],
    ['an undeclared URL key', 'url.full', URL_WITH_TOKEN],
    ['a lower-case HTTP method', 'http.request.method', 'post'],
  ])('drops %s', (_label, key, value) => {
    expect(isAllowedAttribute(key, value)).toBe(false);
    expect(cleanAttributes({ [key]: value }).dropped).toBe(1);
  });

  it('never allows URL, user or message attributes', () => {
    for (const key of Object.keys(SPAN_ATTRIBUTE_RULES)) {
      expect(key).not.toMatch(/url|email|user|name|message|question|text|token|header/i);
    }
  });
});
