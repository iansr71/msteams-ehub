/*
 * Internal domain model for Moodle course structure. The rest of the application depends on
 * these types, never on raw Moodle web-service responses, so a Moodle version change is
 * absorbed in courseContentsMapper.ts alone.
 *
 * Hierarchy:  Course → Section → Module (activity) → ContentItem
 * A ContentItem of kind "file" carries a DownloadableFile when it can be fetched safely.
 * Indexable units are flattened into CourseResource records.
 *
 * Only metadata is modelled. Descriptions, summaries and inline content are source-document
 * text and are deliberately excluded from this phase (presence is recorded as a flag).
 */

/** Timestamps are ISO 8601 strings; Moodle's 0 / null "not set" values become undefined. */
export type IsoTimestamp = string;

export interface Visibility {
  /** Moodle `visible` flag (shown to students), when returned. */
  readonly visible: boolean | undefined;
  /** Whether the service account can see the item, when returned. */
  readonly userVisible: boolean | undefined;
}

export interface CourseSummary {
  readonly id: number;
  readonly fullName: string;
  readonly shortName: string;
  readonly displayName: string | undefined;
  readonly categoryId: number | undefined;
  readonly idNumber: string | undefined;
  readonly format: string | undefined;
  readonly visible: boolean | undefined;
  readonly startDate: IsoTimestamp | undefined;
  readonly endDate: IsoTimestamp | undefined;
  readonly timeModified: IsoTimestamp | undefined;
  /** `<base>/course/view.php?id=<id>`. */
  readonly courseUrl: string;
}

export const MODULE_KINDS = [
  'file-resource',
  'folder',
  'moodle-page',
  'moodle-book',
  'url',
  'label',
  'other',
] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export const CONTENT_ITEM_KINDS = ['file', 'url', 'content'] as const;
export type ContentItemKind = (typeof CONTENT_ITEM_KINDS)[number];

/**
 * What a content item is within its module:
 * - `primary`: the main file of a File resource;
 * - `page-body`: the HTML body of a Moodle Page;
 * - `book-chapter`: the HTML body of one Book chapter;
 * - `book-structure`: the Book's table of contents (metadata, not content);
 * - `attachment`: an embedded/secondary file (images, extra resource files);
 * - `folder-file`: a file in a Folder;
 * - `external-link`: a URL module's target.
 */
export type ContentItemRole =
  | 'primary'
  | 'page-body'
  | 'book-chapter'
  | 'book-structure'
  | 'attachment'
  | 'folder-file'
  | 'external-link';

export type UnsupportedReason =
  | 'module_type_not_supported'
  /** Embedded images, extra resource files, Book structure: covered by their parent item. */
  | 'not_indexed_separately'
  | 'no_supported_content'
  | 'file_type_not_supported'
  | 'external_file'
  | 'not_moodle_file_url'
  | 'missing_file_url'
  | 'exceeds_size_limit';

export type SupportStatus =
  | { readonly status: 'supported' }
  | { readonly status: 'unsupported'; readonly reason: UnsupportedReason };

export interface DownloadableFile {
  readonly fileName: string;
  /** Moodle file area path, always starting and ending with `/`. */
  readonly filePath: string;
  /** Moodle-declared MIME type. Untrusted: extraction detects the real type. */
  readonly mimeType: string | undefined;
  readonly sizeBytes: number | undefined;
  readonly timeCreated: IsoTimestamp | undefined;
  readonly timeModified: IsoTimestamp | undefined;
  /** Token-free pluginfile URL, validated against the configured Moodle host. */
  readonly sourceUrl: string;
}

export interface ContentItem {
  readonly kind: ContentItemKind;
  readonly role: ContentItemRole;
  readonly fileName: string;
  readonly filePath: string;
  readonly mimeType: string | undefined;
  readonly sizeBytes: number | undefined;
  readonly timeModified: IsoTimestamp | undefined;
  readonly sortOrder: number | undefined;
  /** Book chapter ID parsed from the file path, for `book-chapter` and chapter attachments. */
  readonly bookChapterId: number | undefined;
  /** Present when the item can be downloaded from Moodle. */
  readonly file: DownloadableFile | undefined;
  /** For `external-link` items: the target URL (never downloaded). */
  readonly externalUrl: string | undefined;
  readonly support: SupportStatus;
}

export interface BookChapter {
  readonly chapterId: number;
  readonly title: string;
  readonly level: number;
  readonly hidden: boolean;
}

export interface CourseModule extends Visibility {
  readonly id: number;
  readonly name: string;
  /** Raw Moodle module name, e.g. `resource`, `page`, `book`, `quiz`. */
  readonly moduleType: string;
  readonly kind: ModuleKind;
  readonly instanceId: number | undefined;
  readonly contextId: number | undefined;
  /** Moodle activity URL, e.g. `<base>/mod/page/view.php?id=<id>`. */
  readonly url: string | undefined;
  readonly hasDescription: boolean;
  readonly hasAvailabilityRestrictions: boolean;
  readonly contentItems: readonly ContentItem[];
  /** Book table of contents, when the module is a Book and the structure could be read. */
  readonly bookChapters: readonly BookChapter[] | undefined;
  readonly support: SupportStatus;
  /** Non-fatal mapping issues (codes only, no content). */
  readonly warnings: readonly string[];
}

export interface CourseSection extends Visibility {
  readonly id: number;
  /** Section number (0 = General). */
  readonly sectionNumber: number | undefined;
  readonly name: string;
  readonly hasSummary: boolean;
  readonly hasAvailabilityRestrictions: boolean;
  readonly modules: readonly CourseModule[];
}

/** One indexable unit: a Page, a Book chapter, or a single file. */
export interface CourseResource {
  /**
   * Stable within a course: `<moduleId>:page`, `<moduleId>:chapter:<chapterId>`, or
   * `<moduleId>:file:<filePath><fileName>`.
   */
  readonly resourceId: string;
  readonly courseId: number;
  readonly sectionId: number;
  readonly sectionName: string;
  readonly moduleId: number;
  readonly moduleName: string;
  readonly moduleKind: ModuleKind;
  readonly resourceName: string;
  readonly role: ContentItemRole;
  readonly fileName: string;
  readonly mimeType: string | undefined;
  readonly sizeBytes: number | undefined;
  readonly timeModified: IsoTimestamp | undefined;
  /** Moodle activity URL used for citations. */
  readonly moduleUrl: string | undefined;
  /** Token-free file URL used for download. */
  readonly sourceUrl: string | undefined;
  /** True when the section or module is hidden from students (`visible` = false). */
  readonly hiddenFromStudents: boolean;
  readonly support: SupportStatus;
}

export interface CourseStructure {
  readonly course: CourseSummary;
  readonly sections: readonly CourseSection[];
  readonly resources: readonly CourseResource[];
}
