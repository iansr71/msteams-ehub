import type { ExtractedResourceType, TextBlock, TextBlockKind } from '../../extractors/types.js';
import type { ChunkContext } from '../chunkMetadata.js';
import type { ExtractedDocument } from '../normalizeContent.js';
import type { TokenCounter } from '../tokenCounter.js';

/** One token per whitespace-separated word: makes expected chunk boundaries easy to reason about. */
export const wordCounter: TokenCounter = {
  encoding: 'words',
  count: (text) => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length),
  splitByTokens: (text, maxTokens) => {
    const words = text.trim().split(/\s+/);
    const pieces: string[] = [];
    for (let start = 0; start < words.length; start += maxTokens) {
      pieces.push(words.slice(start, start + maxTokens).join(' '));
    }
    return pieces;
  },
};

export function words(count: number, prefix = 'w'): string {
  return Array.from({ length: count }, (_value, index) => `${prefix}${String(index)}`).join(' ');
}

/**
 * `count` sentences of `wordsEach` words. Each starts with a capital and ends with a full stop:
 * Unicode sentence segmentation treats a lowercase word after a full stop as an abbreviation.
 */
export function sentences(count: number, wordsEach: number, prefix = 's'): string {
  return Array.from(
    { length: count },
    (_value, index) =>
      `Start${String(index)} ${words(wordsEach - 2, `${prefix}${String(index)}x`)} end${String(index)}.`,
  ).join(' ');
}

interface BlockSpec {
  readonly kind?: TextBlockKind;
  readonly text: string;
  readonly level?: number;
  readonly path?: readonly string[];
  readonly page?: number;
  readonly slide?: number;
}

export function block(spec: BlockSpec): TextBlock {
  return {
    kind: spec.kind ?? 'paragraph',
    text: spec.text,
    headingLevel: spec.kind === 'heading' ? (spec.level ?? 1) : undefined,
    headingPath: spec.path ?? [],
    pageNumber: spec.page,
    slideNumber: spec.slide,
  };
}

export function heading(
  text: string,
  level: number,
  path: readonly string[] = [],
  extra: Partial<BlockSpec> = {},
): TextBlock {
  return block({ kind: 'heading', text, level, path, ...extra });
}

export function document(
  blocks: readonly TextBlock[],
  resourceType: ExtractedResourceType = 'docx',
  overrides: Partial<ExtractedDocument> = {},
): ExtractedDocument {
  return {
    status: 'extracted',
    courseId: 12,
    courseName: 'Consultation Standards',
    sectionId: 101,
    sectionName: 'General',
    moduleId: 501,
    moduleName: 'Aftercare guide',
    resourceId: '501:file:/aftercare.docx',
    resourceName: 'aftercare.docx',
    resourceType,
    fileName: 'aftercare.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declaredMimeType: undefined,
    detectedContentType: resourceType === 'pdf' ? 'pdf' : resourceType === 'pptx' ? 'pptx' : 'docx',
    sourceUrl:
      'https://ehub.example.test/webservice/pluginfile.php/5501/mod_resource/content/3/aftercare.docx',
    moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=501',
    modifiedAt: '2025-06-15T15:15:00.000Z',
    byteLength: 1234,
    blocks,
    contentHash: 'a'.repeat(64),
    characterCount: blocks.reduce((sum, item) => sum + item.text.length, 0),
    warnings: [],
    extractor: { name: resourceType, version: '1.0.0' },
    ...overrides,
  };
}

export const TEST_CONTEXT: ChunkContext = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  courseCategory: '3',
  access: { allowedUserIds: ['user-1'], allowedGroupIds: ['course-12-students'] },
  indexedAt: '2026-10-28T10:00:00.000Z',
};
