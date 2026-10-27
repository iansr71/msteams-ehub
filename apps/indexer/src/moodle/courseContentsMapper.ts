import {
  stripCredentialParameters,
  toMoodleFileSourceUrl,
  type MoodleCourse,
  type MoodleCourseModule,
  type MoodleCourseSection,
  type MoodleModuleContent,
  type NormalizedMoodleBaseUrl,
} from '@ehub/moodle-client';
import { z } from 'zod';

import type {
  BookChapter,
  ContentItem,
  ContentItemRole,
  CourseModule,
  CourseResource,
  CourseSection,
  CourseStructure,
  CourseSummary,
  DownloadableFile,
  IsoTimestamp,
  ModuleKind,
  SupportStatus,
  UnsupportedReason,
} from './models.js';
import { detectSupportedFileType } from './supportedFileTypes.js';

/*
 * Deterministic mapping from validated Moodle responses to the internal domain model.
 * Same input always gives the same output: no clocks, no randomness, Moodle's own ordering
 * preserved. Mapping never throws for odd module content; problems become per-module
 * warnings and "unsupported" statuses so one bad activity cannot fail a whole course.
 */

export interface MapperContext {
  readonly baseUrl: NormalizedMoodleBaseUrl;
  /** Files larger than this are reported as unsupported (`exceeds_size_limit`). */
  readonly maxFileBytes?: number;
}

const SUPPORTED: SupportStatus = { status: 'supported' };
const unsupported = (reason: UnsupportedReason): SupportStatus => ({
  status: 'unsupported',
  reason,
});

const MODULE_KIND_BY_NAME: Readonly<Record<string, ModuleKind>> = {
  resource: 'file-resource',
  folder: 'folder',
  page: 'moodle-page',
  book: 'moodle-book',
  url: 'url',
  label: 'label',
};

/** Book structure JSON is bounded before parsing; real tables of contents are a few KB. */
const MAX_BOOK_STRUCTURE_CHARS = 1_000_000;
const BOOK_CHAPTER_PATH = /^\/(\d+)\/$/;
const BOOK_HREF = /^(\d+)\/index\.html$/;

export function toIsoTimestamp(seconds: number | null | undefined): IsoTimestamp | undefined {
  if (seconds === null || seconds === undefined || seconds <= 0) {
    return undefined;
  }
  return new Date(seconds * 1000).toISOString();
}

function toVisible(flag: number | undefined): boolean | undefined {
  return flag === undefined ? undefined : flag === 1;
}

function hasText(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim() !== '';
}

function normalizeFilePath(path: string | undefined): string {
  if (path === undefined || path === '') {
    return '/';
  }
  const withLeading = path.startsWith('/') ? path : `/${path}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export function mapCourse(course: MoodleCourse, baseUrl: NormalizedMoodleBaseUrl): CourseSummary {
  return {
    id: course.id,
    fullName: course.fullname.trim(),
    shortName: course.shortname.trim(),
    displayName: course.displayname?.trim(),
    categoryId: course.categoryid,
    idNumber: hasText(course.idnumber) ? course.idnumber?.trim() : undefined,
    format: course.format,
    visible: toVisible(course.visible),
    startDate: toIsoTimestamp(course.startdate),
    endDate: toIsoTimestamp(course.enddate),
    timeModified: toIsoTimestamp(course.timemodified),
    courseUrl: `${baseUrl.href}/course/view.php?id=${String(course.id)}`,
  };
}

/** Moodle's front page is returned as a course with format "site"; it is not course content. */
export function isSiteCourse(course: MoodleCourse | CourseSummary): boolean {
  return course.format === 'site';
}

function moduleUrlOnSite(
  raw: string | undefined,
  baseUrl: NormalizedMoodleBaseUrl,
  warnings: string[],
): string | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.host.toLowerCase() !== baseUrl.host || parsed.protocol !== baseUrl.protocol) {
      warnings.push('module_url_not_on_site');
      return undefined;
    }
    return stripCredentialParameters(parsed).href;
  } catch {
    warnings.push('module_url_invalid');
    return undefined;
  }
}

interface FileResolution {
  readonly file: DownloadableFile | undefined;
  /** Why the file cannot be fetched, if it cannot. */
  readonly blocker: UnsupportedReason | undefined;
}

function exceedsSizeLimit(item: MoodleModuleContent, context: MapperContext): boolean {
  return (
    context.maxFileBytes !== undefined &&
    item.filesize !== undefined &&
    item.filesize > context.maxFileBytes
  );
}

function resolveDownloadableFile(
  item: MoodleModuleContent,
  filePath: string,
  context: MapperContext,
): FileResolution {
  if (item.isexternalfile === true) {
    return { file: undefined, blocker: 'external_file' };
  }
  if (item.fileurl === undefined || item.fileurl === '') {
    return { file: undefined, blocker: 'missing_file_url' };
  }
  let sourceUrl: URL;
  try {
    sourceUrl = toMoodleFileSourceUrl(context.baseUrl, item.fileurl);
  } catch {
    return { file: undefined, blocker: 'not_moodle_file_url' };
  }
  const file: DownloadableFile = {
    fileName: item.filename,
    filePath,
    mimeType: item.mimetype,
    sizeBytes: item.filesize,
    timeCreated: toIsoTimestamp(item.timecreated),
    timeModified: toIsoTimestamp(item.timemodified),
    sourceUrl: sourceUrl.href,
  };
  return { file, blocker: undefined };
}

function externalLink(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? stripCredentialParameters(parsed).href
      : undefined;
  } catch {
    return undefined;
  }
}

const bookStructureEntry: z.ZodType<BookStructureEntry> = z.lazy(() =>
  z.object({
    title: z.string(),
    href: z.string(),
    level: z.coerce.number().int().min(0).max(10).catch(0),
    hidden: z.union([z.string(), z.number(), z.boolean()]).optional(),
    subitems: z.array(bookStructureEntry).optional(),
  }),
);

interface BookStructureEntry {
  title: string;
  href: string;
  level: number;
  hidden?: string | number | boolean | undefined;
  subitems?: BookStructureEntry[] | undefined;
}

function isTruthyFlag(value: string | number | boolean | undefined): boolean {
  return value === true || value === 1 || value === '1';
}

/** Parses the Book table of contents. Untrusted JSON-in-a-string; failure is a warning. */
export function parseBookStructure(content: string | undefined): BookChapter[] | undefined {
  if (content === undefined || content.length > MAX_BOOK_STRUCTURE_CHARS) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = z.array(bookStructureEntry).safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const chapters: BookChapter[] = [];
  const visit = (entries: readonly BookStructureEntry[], parentHidden: boolean): void => {
    for (const entry of entries) {
      const match = BOOK_HREF.exec(entry.href);
      const hidden = parentHidden || isTruthyFlag(entry.hidden);
      if (match?.[1] !== undefined) {
        chapters.push({
          chapterId: Number(match[1]),
          title: entry.title.trim(),
          level: entry.level,
          hidden,
        });
      }
      visit(entry.subitems ?? [], hidden);
    }
  };
  visit(parsed.data, false);
  return chapters;
}

function roleFor(
  kind: ModuleKind,
  item: MoodleModuleContent,
  filePath: string,
  isPrimary: boolean,
): ContentItemRole {
  if (item.type === 'url') {
    return 'external-link';
  }
  switch (kind) {
    case 'file-resource':
      return isPrimary ? 'primary' : 'attachment';
    case 'folder':
      return 'folder-file';
    case 'moodle-page':
      return item.filename === 'index.html' && filePath === '/' ? 'page-body' : 'attachment';
    case 'moodle-book':
      if (item.type === 'content' && item.filename === 'structure') {
        return 'book-structure';
      }
      return item.filename === 'index.html' && BOOK_CHAPTER_PATH.test(filePath)
        ? 'book-chapter'
        : 'attachment';
    case 'url':
    case 'label':
    case 'other':
      return 'attachment';
  }
}

function itemSupport(
  kind: ModuleKind,
  role: ContentItemRole,
  item: MoodleModuleContent,
  resolution: FileResolution,
  context: MapperContext,
): SupportStatus {
  if (kind === 'url' || kind === 'label' || kind === 'other') {
    return unsupported('module_type_not_supported');
  }
  if (role === 'attachment' || role === 'book-structure' || role === 'external-link') {
    return unsupported('not_indexed_separately');
  }
  if (resolution.blocker !== undefined) {
    return unsupported(resolution.blocker);
  }
  // Page bodies and Book chapters are Moodle-rendered HTML with no declared MIME type.
  const knownHtml = role === 'page-body' || role === 'book-chapter';
  if (!knownHtml && detectSupportedFileType(item.filename, item.mimetype) === undefined) {
    return unsupported('file_type_not_supported');
  }
  return exceedsSizeLimit(item, context) ? unsupported('exceeds_size_limit') : SUPPORTED;
}

function primaryIndex(contents: readonly MoodleModuleContent[]): number {
  const bySortOrder = contents.findIndex((item) => item.type === 'file' && item.sortorder === 1);
  return bySortOrder >= 0 ? bySortOrder : contents.findIndex((item) => item.type === 'file');
}

interface MappedModule {
  readonly module: CourseModule;
  readonly resources: CourseResource[];
}

function mapModule(
  raw: MoodleCourseModule,
  section: CourseSection,
  courseId: number,
  context: MapperContext,
): MappedModule {
  const warnings: string[] = [];
  const kind: ModuleKind = MODULE_KIND_BY_NAME[raw.modname] ?? 'other';
  const contents = raw.contents ?? [];
  const primary = kind === 'file-resource' ? primaryIndex(contents) : -1;
  const moduleUrl = moduleUrlOnSite(raw.url, context.baseUrl, warnings);
  const moduleHidden = raw.visible === 0;

  let bookChapters: BookChapter[] | undefined;
  if (kind === 'moodle-book') {
    const structure = contents.find(
      (item) => item.type === 'content' && item.filename === 'structure',
    );
    bookChapters = parseBookStructure(structure?.content);
    if (bookChapters === undefined) {
      warnings.push(
        structure === undefined ? 'book_structure_missing' : 'book_structure_unreadable',
      );
    }
  }
  const chapterById = new Map((bookChapters ?? []).map((chapter) => [chapter.chapterId, chapter]));

  const contentItems: ContentItem[] = contents.map((item, index) => {
    const filePath = normalizeFilePath(item.filepath);
    const role = roleFor(kind, item, filePath, index === primary);
    const resolution: FileResolution =
      item.type === 'file'
        ? resolveDownloadableFile(item, filePath, context)
        : { file: undefined, blocker: undefined };
    const chapterMatch = kind === 'moodle-book' ? BOOK_CHAPTER_PATH.exec(filePath) : null;
    return {
      kind: item.type === 'url' ? 'url' : item.type === 'content' ? 'content' : 'file',
      role,
      fileName: item.filename,
      filePath,
      mimeType: item.mimetype,
      sizeBytes: item.filesize,
      timeModified: toIsoTimestamp(item.timemodified),
      sortOrder: item.sortorder ?? undefined,
      bookChapterId: chapterMatch?.[1] === undefined ? undefined : Number(chapterMatch[1]),
      file: resolution.file,
      externalUrl: item.type === 'url' ? externalLink(item.fileurl) : undefined,
      support: itemSupport(kind, role, item, resolution, context),
    };
  });

  const resources: CourseResource[] = [];
  const seenResourceIds = new Set<string>();
  const indexable = contentItems.filter(
    (item) =>
      item.role === 'primary' ||
      item.role === 'page-body' ||
      item.role === 'book-chapter' ||
      item.role === 'folder-file',
  );
  for (const item of indexable) {
    const chapter =
      item.bookChapterId === undefined ? undefined : chapterById.get(item.bookChapterId);
    const resourceId =
      item.role === 'page-body'
        ? `${String(raw.id)}:page`
        : item.role === 'book-chapter'
          ? `${String(raw.id)}:chapter:${String(item.bookChapterId)}`
          : `${String(raw.id)}:file:${item.filePath}${item.fileName}`;
    if (seenResourceIds.has(resourceId)) {
      warnings.push('duplicate_resource_id');
      continue;
    }
    seenResourceIds.add(resourceId);
    const resourceName =
      item.role === 'page-body'
        ? raw.name
        : item.role === 'book-chapter'
          ? (chapter?.title ?? `Chapter ${String(item.bookChapterId)}`)
          : item.fileName;
    resources.push({
      resourceId,
      courseId,
      sectionId: section.id,
      sectionName: section.name,
      moduleId: raw.id,
      moduleName: raw.name,
      moduleKind: kind,
      resourceName,
      role: item.role,
      fileName: item.fileName,
      mimeType:
        item.role === 'page-body' || item.role === 'book-chapter' ? 'text/html' : item.mimeType,
      sizeBytes: item.sizeBytes,
      timeModified: item.timeModified,
      moduleUrl,
      sourceUrl: item.file?.sourceUrl,
      hiddenFromStudents: section.visible === false || moduleHidden || chapter?.hidden === true,
      support: item.support,
    });
  }

  if (kind === 'moodle-page' && !contentItems.some((item) => item.role === 'page-body')) {
    warnings.push('page_body_missing');
  }

  let support: SupportStatus;
  if (kind === 'url' || kind === 'label' || kind === 'other') {
    support = unsupported('module_type_not_supported');
  } else if (resources.some((resource) => resource.support.status === 'supported')) {
    support = SUPPORTED;
  } else {
    const first = resources[0]?.support;
    support = first?.status === 'unsupported' ? first : unsupported('no_supported_content');
  }

  return {
    module: {
      id: raw.id,
      name: raw.name,
      moduleType: raw.modname,
      kind,
      instanceId: raw.instance,
      contextId: raw.contextid,
      url: moduleUrl,
      visible: toVisible(raw.visible),
      userVisible: raw.uservisible,
      hasDescription: hasText(raw.description),
      hasAvailabilityRestrictions: hasText(raw.availabilityinfo),
      contentItems,
      bookChapters,
      support,
      warnings,
    },
    resources,
  };
}

export function mapCourseContents(
  course: CourseSummary,
  sections: readonly MoodleCourseSection[],
  context: MapperContext,
): CourseStructure {
  const mappedSections: CourseSection[] = [];
  const resources: CourseResource[] = [];

  for (const rawSection of sections) {
    const sectionShell: CourseSection = {
      id: rawSection.id,
      sectionNumber: rawSection.section,
      name: rawSection.name.trim(),
      visible: toVisible(rawSection.visible),
      userVisible: rawSection.uservisible,
      hasSummary: hasText(rawSection.summary),
      hasAvailabilityRestrictions: hasText(rawSection.availabilityinfo),
      modules: [],
    };
    const modules: CourseModule[] = [];
    for (const rawModule of rawSection.modules) {
      const mapped = mapModule(rawModule, sectionShell, course.id, context);
      modules.push(mapped.module);
      resources.push(...mapped.resources);
    }
    mappedSections.push({ ...sectionShell, modules });
  }

  return { course, sections: mappedSections, resources };
}
