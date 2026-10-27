import { MoodleValidationError, type MoodleCourseSection } from '@ehub/moodle-client';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_BASE_URL,
  fixtureClient,
  type ContentsFixture,
} from './__fixtures__/fixtureClient.js';
import { mapCourseContents, parseBookStructure, toIsoTimestamp } from './courseContentsMapper.js';
import { inspectCourse, type CourseInspection } from './inspectCourse.js';
import type { CourseModule, CourseResource } from './models.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Contract path: fixture JSON → real client + Zod schemas → mapper. */
async function inspectFixture(contents: ContentsFixture): Promise<CourseInspection> {
  const { client, baseUrl } = fixtureClient({ contents });
  return inspectCourse(client, baseUrl, 12, { maxFileBytes: MAX_FILE_BYTES });
}

function allModules(inspection: CourseInspection): CourseModule[] {
  return inspection.structure.sections.flatMap((section) => section.modules);
}

function moduleById(inspection: CourseInspection, id: number): CourseModule {
  const found = allModules(inspection).find((module) => module.id === id);
  if (found === undefined) {
    throw new Error(`module ${String(id)} not found`);
  }
  return found;
}

function resource(inspection: CourseInspection, resourceId: string): CourseResource {
  const found = inspection.structure.resources.find(
    (candidate) => candidate.resourceId === resourceId,
  );
  if (found === undefined) {
    throw new Error(`resource ${resourceId} not found`);
  }
  return found;
}

describe('contract: course summary', () => {
  it('maps the course record and builds its Moodle URL', async () => {
    const { structure } = await inspectFixture('contents-empty-course');
    expect(structure.course).toEqual({
      id: 12,
      fullName: 'Consultation Standards',
      shortName: 'CONSULT101',
      displayName: 'Consultation Standards',
      categoryId: 3,
      idNumber: undefined,
      format: 'topics',
      visible: true,
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: undefined,
      timeModified: '2025-10-09T08:53:20.000Z',
      courseUrl: 'https://ehub.example.test/course/view.php?id=12',
    });
  });
});

describe('contract: empty course', () => {
  it('reports sections with no modules and no resources', async () => {
    const inspection = await inspectFixture('contents-empty-course');
    expect(inspection.structure.sections).toHaveLength(1);
    expect(inspection.structure.sections[0]).toMatchObject({
      name: 'General',
      sectionNumber: 0,
      modules: [],
    });
    expect(inspection.structure.resources).toEqual([]);
    expect(inspection.summary).toMatchObject({ sections: 1, modules: 0, files: 0, resources: 0 });
  });

  it('handles a course with no sections at all', () => {
    const { structure } = {
      structure: mapCourseContents(courseStub(), [], { baseUrl: FIXTURE_BASE_URL }),
    };
    expect(structure.sections).toEqual([]);
    expect(structure.resources).toEqual([]);
  });
});

describe('contract: PDF resource', () => {
  it('maps module, content item, downloadable file and resource', async () => {
    const inspection = await inspectFixture('contents-pdf-resource');
    const module = moduleById(inspection, 501);
    expect(module).toMatchObject({
      name: 'Consultation checklist',
      moduleType: 'resource',
      kind: 'file-resource',
      instanceId: 1501,
      contextId: 5501,
      url: 'https://ehub.example.test/mod/resource/view.php?id=501',
      visible: true,
      userVisible: true,
      support: { status: 'supported' },
      warnings: [],
    });
    expect(module.contentItems).toHaveLength(1);
    expect(module.contentItems[0]).toMatchObject({
      kind: 'file',
      role: 'primary',
      fileName: 'checklist.pdf',
      filePath: '/',
      mimeType: 'application/pdf',
      sizeBytes: 182044,
      timeModified: '2025-06-15T15:15:00.000Z',
      file: {
        fileName: 'checklist.pdf',
        sourceUrl:
          'https://ehub.example.test/webservice/pluginfile.php/5501/mod_resource/content/3/checklist.pdf?forcedownload=1',
        timeCreated: '2025-06-15T15:06:40.000Z',
      },
    });
    expect(resource(inspection, '501:file:/checklist.pdf')).toEqual({
      resourceId: '501:file:/checklist.pdf',
      courseId: 12,
      sectionId: 101,
      sectionName: 'General',
      moduleId: 501,
      moduleName: 'Consultation checklist',
      moduleKind: 'file-resource',
      resourceName: 'checklist.pdf',
      role: 'primary',
      fileName: 'checklist.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 182044,
      timeModified: '2025-06-15T15:15:00.000Z',
      moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=501',
      sourceUrl:
        'https://ehub.example.test/webservice/pluginfile.php/5501/mod_resource/content/3/checklist.pdf?forcedownload=1',
      hiddenFromStudents: false,
      support: { status: 'supported' },
    });
  });
});

describe('contract: hidden section', () => {
  it('records visibility and restrictions and flags resources hidden from students', async () => {
    const inspection = await inspectFixture('contents-hidden-section');
    const [, hidden, restricted] = inspection.structure.sections;
    expect(hidden).toMatchObject({
      name: 'Manager-only procedures',
      visible: false,
      hasAvailabilityRestrictions: false,
    });
    expect(restricted).toMatchObject({ visible: true, hasAvailabilityRestrictions: true });
    expect(moduleById(inspection, 503)).toMatchObject({
      visible: false,
      hasAvailabilityRestrictions: true,
    });

    expect(resource(inspection, '502:file:/cash-up.pdf').hiddenFromStudents).toBe(true);
    expect(resource(inspection, '503:file:/peel.pdf').hiddenFromStudents).toBe(true);
    expect(inspection.summary).toMatchObject({
      hiddenSections: 1,
      hiddenModules: 1,
      hiddenResources: 2,
    });
  });
});

describe('contract: Moodle Page', () => {
  it('detects the Page and its HTML body, treating images as attachments', async () => {
    const inspection = await inspectFixture('contents-page');
    const page = moduleById(inspection, 601);
    expect(page).toMatchObject({
      kind: 'moodle-page',
      support: { status: 'supported' },
      warnings: [],
    });
    expect(
      page.contentItems.map((item) => [item.fileName, item.role, item.support.status]),
    ).toEqual([
      ['index.html', 'page-body', 'supported'],
      ['alarm-panel.png', 'attachment', 'unsupported'],
    ]);
    expect(page.contentItems[0]?.file?.timeCreated).toBeUndefined();
    expect(inspection.structure.resources).toHaveLength(1);
    expect(resource(inspection, '601:page')).toMatchObject({
      resourceName: 'Opening the branch',
      role: 'page-body',
      mimeType: 'text/html',
      moduleUrl: 'https://ehub.example.test/mod/page/view.php?id=601',
      sourceUrl:
        'https://ehub.example.test/webservice/pluginfile.php/5601/mod_page/content/4/index.html?forcedownload=1',
    });
  });
});

describe('contract: Moodle Book', () => {
  it('detects chapters, titles from the table of contents and hidden chapters', async () => {
    const inspection = await inspectFixture('contents-book');
    const book = moduleById(inspection, 701);
    expect(book.kind).toBe('moodle-book');
    expect(book.warnings).toEqual([]);
    expect(book.bookChapters).toEqual([
      { chapterId: 11, title: 'Introduction', level: 0, hidden: false },
      { chapterId: 12, title: 'Skin types', level: 0, hidden: false },
      { chapterId: 13, title: 'Fitzpatrick scale', level: 1, hidden: false },
      { chapterId: 14, title: 'Draft: new protocol', level: 0, hidden: true },
    ]);
    expect(book.contentItems.map((item) => [item.role, item.bookChapterId])).toEqual([
      ['book-structure', undefined],
      ['book-chapter', 11],
      ['book-chapter', 12],
      ['attachment', 12],
      ['book-chapter', 13],
      ['book-chapter', 14],
    ]);
    expect(
      inspection.structure.resources.map((r) => [
        r.resourceId,
        r.resourceName,
        r.hiddenFromStudents,
      ]),
    ).toEqual([
      ['701:chapter:11', 'Introduction', false],
      ['701:chapter:12', 'Skin types', false],
      ['701:chapter:13', 'Fitzpatrick scale', false],
      ['701:chapter:14', 'Draft: new protocol', true],
    ]);
  });
});

describe('contract: multiple files', () => {
  it('classifies every folder file and picks the main file of a resource', async () => {
    const inspection = await inspectFixture('contents-multiple-files');
    const folderResources = inspection.structure.resources.filter((r) => r.moduleId === 801);
    expect(folderResources.map((r) => [r.resourceId, r.support])).toEqual([
      ['801:file:/botox-protocol.pdf', { status: 'supported' }],
      ['801:file:/aftercare.docx', { status: 'supported' }],
      ['801:file:/slides/induction.pptx', { status: 'supported' }],
      [
        '801:file:/slides/price-list.xlsx',
        { status: 'unsupported', reason: 'file_type_not_supported' },
      ],
      // Generic MIME type: the .txt extension decides.
      ['801:file:/notes.txt', { status: 'supported' }],
      ['801:file:/logo.png', { status: 'unsupported', reason: 'file_type_not_supported' }],
    ]);

    const web = moduleById(inspection, 802);
    expect(web.contentItems.map((item) => [item.fileName, item.role])).toEqual([
      ['styles.css', 'attachment'],
      ['guide.html', 'primary'],
      ['hero.jpg', 'attachment'],
    ]);
    expect(
      inspection.structure.resources.filter((r) => r.moduleId === 802).map((r) => r.resourceId),
    ).toEqual(['802:file:/guide.html']);
  });

  it('reports type before size, and size limits for supported types', async () => {
    const inspection = await inspectFixture('contents-multiple-files');
    expect(resource(inspection, '803:file:/training.mp4').support).toEqual({
      status: 'unsupported',
      reason: 'file_type_not_supported',
    });

    const { client, baseUrl } = fixtureClient({ contents: 'contents-multiple-files' });
    const small = await inspectCourse(client, baseUrl, 12, { maxFileBytes: 100_000 });
    expect(resource(small, '801:file:/slides/induction.pptx').support).toEqual({
      status: 'unsupported',
      reason: 'exceeds_size_limit',
    });
    expect(resource(small, '801:file:/botox-protocol.pdf').support).toEqual({
      status: 'unsupported',
      reason: 'exceeds_size_limit',
    });
  });
});

describe('contract: unsupported modules', () => {
  it('reports unsupported types without failing the inspection', async () => {
    const inspection = await inspectFixture('contents-unsupported-modules');
    const byId = (id: number) => moduleById(inspection, id);

    for (const id of [901, 902, 903, 904, 907]) {
      expect(byId(id).support).toEqual({
        status: 'unsupported',
        reason: 'module_type_not_supported',
      });
    }
    expect(byId(903)).toMatchObject({ kind: 'url' });
    expect(byId(903).contentItems[0]).toMatchObject({
      kind: 'url',
      role: 'external-link',
      filePath: '/',
      externalUrl: 'https://supplier.example.test/portal?ref=ehub',
      file: undefined,
    });
    expect(byId(904)).toMatchObject({ kind: 'label', hasDescription: true });
    expect(byId(907)).toMatchObject({ kind: 'other', moduleType: 'customcert' });

    expect(resource(inspection, '905:file:/policy.pdf').support).toEqual({
      status: 'unsupported',
      reason: 'external_file',
    });
    expect(resource(inspection, '906:file:/mirror.pdf')).toMatchObject({
      support: { status: 'unsupported', reason: 'not_moodle_file_url' },
      sourceUrl: undefined,
    });

    expect(inspection.summary).toMatchObject({
      modules: 7,
      supportedModules: 0,
      unsupportedModules: 7,
      unsupportedReasons: {
        external_file: 1,
        module_type_not_supported: 5,
        not_moodle_file_url: 1,
      },
    });
  });
});

describe('contract: missing optional metadata', () => {
  it('maps minimal responses with warnings instead of failing', async () => {
    const inspection = await inspectFixture('contents-missing-optional');
    const [section] = inspection.structure.sections;
    expect(section).toMatchObject({
      id: 301,
      name: '',
      sectionNumber: undefined,
      visible: undefined,
      userVisible: undefined,
      hasSummary: false,
    });

    expect(moduleById(inspection, 1001)).toMatchObject({
      kind: 'moodle-page',
      url: undefined,
      visible: undefined,
      instanceId: undefined,
      contentItems: [],
      support: { status: 'unsupported', reason: 'no_supported_content' },
      warnings: ['page_body_missing'],
    });
    expect(moduleById(inspection, 1002).contentItems[0]).toMatchObject({
      fileName: 'untitled',
      filePath: '/',
      mimeType: undefined,
      sizeBytes: undefined,
      timeModified: undefined,
      file: undefined,
      support: { status: 'unsupported', reason: 'missing_file_url' },
    });
    expect(moduleById(inspection, 1003).warnings).toEqual(['book_structure_missing']);
    expect(resource(inspection, '1002:file:/untitled').hiddenFromStudents).toBe(false);
  });
});

describe('contract: malformed response', () => {
  it('rejects the whole response with field paths and no values', async () => {
    const { client, baseUrl } = fixtureClient({ contents: 'contents-malformed' });
    const error: unknown = await inspectCourse(client, baseUrl, 12).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MoodleValidationError);
    expect(error).toMatchObject({
      code: 'response_schema_mismatch',
      functionName: 'core_course_get_contents',
      issuePaths: ['0.id', '0.modules.0.modname'],
    });
    expect(JSON.stringify(error)).not.toContain('Consultation checklist');
  });

  it.each([null, {}, 'oops', [{ id: 1 }]])('rejects %j as course contents', async (rawContents) => {
    const { client, baseUrl } = fixtureClient({ rawContents });
    await expect(inspectCourse(client, baseUrl, 12)).rejects.toBeInstanceOf(MoodleValidationError);
  });
});

describe('mapper properties', () => {
  it('is deterministic: identical input gives identical output', async () => {
    const first = await inspectFixture('contents-book');
    const second = await inspectFixture('contents-book');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('keeps every source URL token-free', () => {
    const sections: MoodleCourseSection[] = [
      {
        id: 1,
        name: 'S',
        modules: [
          {
            id: 9,
            name: 'Tokened',
            modname: 'resource',
            url: 'https://ehub.example.test/mod/resource/view.php?id=9&token=leaked1234567890',
            contents: [
              {
                type: 'file',
                filename: 'a.pdf',
                filepath: '/',
                mimetype: 'application/pdf',
                fileurl:
                  'https://ehub.example.test/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf?token=leaked1234567890&wstoken=x',
              },
            ],
          },
        ],
      },
    ];
    const structure = mapCourseContents(courseStub(), sections, { baseUrl: FIXTURE_BASE_URL });
    expect(JSON.stringify(structure)).not.toContain('leaked1234567890');
    expect(structure.resources[0]?.sourceUrl).toBe(
      'https://ehub.example.test/webservice/pluginfile.php/1/mod_resource/content/1/a.pdf',
    );
  });

  it('drops module URLs that point off the Moodle site, with a warning', () => {
    const structure = mapCourseContents(
      courseStub(),
      [
        {
          id: 1,
          name: 'S',
          modules: [{ id: 2, name: 'M', modname: 'quiz', url: 'https://evil.example.test/x' }],
        },
      ],
      { baseUrl: FIXTURE_BASE_URL },
    );
    const module = structure.sections[0]?.modules[0];
    expect(module?.url).toBeUndefined();
    expect(module?.warnings).toEqual(['module_url_not_on_site']);
  });

  it('skips a duplicate resource ID with a warning', () => {
    const file = {
      type: 'file',
      filename: 'a.pdf',
      filepath: '/',
      mimetype: 'application/pdf',
      fileurl: 'https://ehub.example.test/webservice/pluginfile.php/1/mod_folder/content/0/a.pdf',
    };
    const structure = mapCourseContents(
      courseStub(),
      [
        {
          id: 1,
          name: 'S',
          modules: [{ id: 3, name: 'F', modname: 'folder', contents: [file, file] }],
        },
      ],
      { baseUrl: FIXTURE_BASE_URL },
    );
    expect(structure.resources).toHaveLength(1);
    expect(structure.sections[0]?.modules[0]?.warnings).toEqual(['duplicate_resource_id']);
  });
});

describe('parseBookStructure', () => {
  it('returns undefined for unreadable structures instead of throwing', () => {
    expect(parseBookStructure(undefined)).toBeUndefined();
    expect(parseBookStructure('not json')).toBeUndefined();
    expect(parseBookStructure('{"title":"x"}')).toBeUndefined();
    expect(parseBookStructure('x'.repeat(1_000_001))).toBeUndefined();
  });

  it('ignores entries without a chapter href and inherits hidden from parents', () => {
    const chapters = parseBookStructure(
      JSON.stringify([
        { title: 'Odd', href: 'javascript:alert(1)', level: 0 },
        {
          title: 'Parent',
          href: '5/index.html',
          level: 0,
          hidden: 1,
          subitems: [{ title: 'Child', href: '6/index.html', level: 1, hidden: '0' }],
        },
      ]),
    );
    expect(chapters).toEqual([
      { chapterId: 5, title: 'Parent', level: 0, hidden: true },
      { chapterId: 6, title: 'Child', level: 1, hidden: true },
    ]);
  });

  it('marks a structure that cannot be read as a module warning', () => {
    const structure = mapCourseContents(
      courseStub(),
      [
        {
          id: 1,
          name: 'S',
          modules: [
            {
              id: 4,
              name: 'B',
              modname: 'book',
              contents: [{ type: 'content', filename: 'structure', content: '{broken' }],
            },
          ],
        },
      ],
      { baseUrl: FIXTURE_BASE_URL },
    );
    expect(structure.sections[0]?.modules[0]?.warnings).toEqual(['book_structure_unreadable']);
  });
});

describe('toIsoTimestamp', () => {
  it('converts Unix seconds and treats 0/null as not set', () => {
    expect(toIsoTimestamp(1750000000)).toBe('2025-06-15T15:06:40.000Z');
    expect(toIsoTimestamp(0)).toBeUndefined();
    expect(toIsoTimestamp(null)).toBeUndefined();
    expect(toIsoTimestamp(undefined)).toBeUndefined();
  });
});

function courseStub() {
  return {
    id: 12,
    fullName: 'Stub',
    shortName: 'STUB',
    displayName: undefined,
    categoryId: undefined,
    idNumber: undefined,
    format: undefined,
    visible: true,
    startDate: undefined,
    endDate: undefined,
    timeModified: undefined,
    courseUrl: 'https://ehub.example.test/course/view.php?id=12',
  };
}
