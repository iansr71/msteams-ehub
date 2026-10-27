import { readFileSync } from 'node:fs';

import {
  DefaultMoodleClient,
  normalizeMoodleBaseUrl,
  type MoodleFunctionName,
  type MoodleParams,
  type MoodleTransport,
  type NormalizedMoodleBaseUrl,
} from '@ehub/moodle-client';

/*
 * Contract-test harness: raw fixture JSON is served through a MoodleTransport into the real
 * DefaultMoodleClient, so every fixture is validated by the production Zod schemas before it
 * reaches the mapper — exactly the path live Moodle data takes.
 */

export const FIXTURE_BASE_URL: NormalizedMoodleBaseUrl = normalizeMoodleBaseUrl(
  'https://ehub.example.test',
  { allowHttp: false },
);

export type ContentsFixture =
  | 'contents-empty-course'
  | 'contents-pdf-resource'
  | 'contents-hidden-section'
  | 'contents-page'
  | 'contents-book'
  | 'contents-multiple-files'
  | 'contents-unsupported-modules'
  | 'contents-missing-optional'
  | 'contents-malformed';

export function loadFixture(name: ContentsFixture | 'courses' | 'site-info'): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));
}

function requestedIds(params: MoodleParams): number[] | undefined {
  const options = params['options'];
  if (typeof options !== 'object' || Array.isArray(options)) {
    return undefined;
  }
  const ids = (options as MoodleParams)['ids'];
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : undefined;
}

export interface FixtureClientOptions {
  /** A named fixture file for core_course_get_contents. */
  readonly contents?: ContentsFixture;
  /** A raw value for core_course_get_contents, used as-is (including null). */
  readonly rawContents?: unknown;
  readonly courses?: unknown;
  readonly siteInfo?: unknown;
}

export interface FixtureClient {
  readonly client: DefaultMoodleClient;
  readonly calls: { functionName: MoodleFunctionName; params: MoodleParams }[];
  readonly baseUrl: NormalizedMoodleBaseUrl;
}

export function fixtureClient(options: FixtureClientOptions = {}): FixtureClient {
  const calls: { functionName: MoodleFunctionName; params: MoodleParams }[] = [];
  const transport: MoodleTransport = {
    call: (functionName, params) => {
      calls.push({ functionName, params });
      switch (functionName) {
        case 'core_course_get_courses': {
          const courses = (options.courses ?? loadFixture('courses')) as { id: number }[];
          const ids = requestedIds(params);
          return Promise.resolve(
            ids === undefined ? courses : courses.filter((c) => ids.includes(c.id)),
          );
        }
        case 'core_course_get_contents':
          return Promise.resolve(
            'rawContents' in options
              ? options.rawContents
              : loadFixture(options.contents ?? 'contents-empty-course'),
          );
        case 'core_webservice_get_site_info':
          return Promise.resolve(options.siteInfo ?? loadFixture('site-info'));
        default:
          return Promise.reject(new Error(`Fixture transport has no response for ${functionName}`));
      }
    },
  };
  return { client: new DefaultMoodleClient(transport), calls, baseUrl: FIXTURE_BASE_URL };
}
