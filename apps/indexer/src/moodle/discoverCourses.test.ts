import { describe, expect, it } from 'vitest';

import { fixtureClient } from './__fixtures__/fixtureClient.js';
import { discoverCourses, matchesSearch } from './discoverCourses.js';

describe('discoverCourses', () => {
  it('returns courses sorted by ID with the site front page excluded', async () => {
    const { client, baseUrl, calls } = fixtureClient();
    const result = await discoverCourses(client, baseUrl);

    expect(result.courses.map((course) => course.id)).toEqual([7, 12, 30]);
    expect(result).toMatchObject({ returnedByMoodle: 3, siteCourseExcluded: true });
    expect(calls).toEqual([{ functionName: 'core_course_get_courses', params: {} }]);
  });

  it('maps visibility, including courses where Moodle omits it', async () => {
    const { client, baseUrl } = fixtureClient();
    const { courses } = await discoverCourses(client, baseUrl);
    expect(courses.map((course) => [course.id, course.visible])).toEqual([
      [7, false],
      [12, true],
      [30, undefined],
    ]);
    expect(courses.find((course) => course.id === 30)).toMatchObject({
      fullName: 'Minimal Course',
      shortName: 'MIN',
      categoryId: undefined,
      timeModified: undefined,
    });
  });

  it('asks Moodle for specific course IDs, de-duplicated', async () => {
    const { client, baseUrl, calls } = fixtureClient();
    const result = await discoverCourses(client, baseUrl, { courseIds: [12, 7, 12] });
    expect(result.courses.map((course) => course.id)).toEqual([7, 12]);
    expect(calls[0]?.params).toEqual({ options: { ids: [12, 7] } });
  });

  it('filters by text across names and ID number, case-insensitively', async () => {
    const { client, baseUrl } = fixtureClient();
    const search = async (text: string) =>
      (await discoverCourses(client, baseUrl, { search: text })).courses.map((course) => course.id);

    expect(await search('laser')).toEqual([7]);
    expect(await search('CONSULT')).toEqual([12]);
    expect(await search('sr-ls-01')).toEqual([7]);
    expect(await search('nothing-matches')).toEqual([]);
  });

  it('combines ID and text filters', async () => {
    const { client, baseUrl } = fixtureClient();
    const result = await discoverCourses(client, baseUrl, {
      courseIds: [7, 12],
      search: 'standards',
    });
    expect(result.courses.map((course) => course.id)).toEqual([12]);
    expect(result.returnedByMoodle).toBe(2);
  });

  it('returns an empty result when Moodle returns nothing', async () => {
    const { client, baseUrl } = fixtureClient({ courses: [] });
    expect(await discoverCourses(client, baseUrl)).toEqual({
      courses: [],
      returnedByMoodle: 0,
      siteCourseExcluded: false,
    });
  });
});

describe('matchesSearch', () => {
  const course = {
    id: 1,
    fullName: 'Ｃonsultation Ｓtandards',
    shortName: 'C101',
    displayName: undefined,
    categoryId: undefined,
    idNumber: undefined,
    format: undefined,
    visible: true,
    startDate: undefined,
    endDate: undefined,
    timeModified: undefined,
    courseUrl: 'x',
  };

  it('normalises Unicode width forms and ignores blank searches', () => {
    expect(matchesSearch(course, 'consultation standards')).toBe(true);
    expect(matchesSearch(course, '   ')).toBe(true);
    expect(matchesSearch(course, 'laser')).toBe(false);
  });
});
