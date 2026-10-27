import { htmlToBlocks, type HtmlBlockOptions } from './htmlBlocks.js';
import { BlockCollector } from './textNormalization.js';
import { decodeText } from './textDecoding.js';
import type {
  ContentExtractor,
  ExtractionInput,
  ExtractorContext,
  ExtractorOutput,
} from './types.js';

export function extractHtml(
  input: ExtractionInput,
  context: ExtractorContext,
  options: Pick<HtmlBlockOptions, 'basePath' | 'omitLeadingHeading'> = {},
): ExtractorOutput {
  const { text, warning } = decodeText(input.bytes);
  const collector = new BlockCollector(context.limits.maxTextChars);
  htmlToBlocks(text, { collector, deadline: context.deadline, ...options });
  const warnings = [warning, collector.truncated ? 'text_truncated' : undefined].filter(
    (value): value is string => value !== undefined,
  );
  return { blocks: collector.blocks, warnings };
}

/** HTML files attached to File or Folder activities. Moodle Pages and Books have their own. */
export const htmlExtractor: ContentExtractor = {
  name: 'html',
  version: '1.0.0',
  resourceType: 'html',
  supports: ({ contentType, resource }) =>
    contentType === 'html' && resource.role !== 'page-body' && resource.role !== 'book-chapter',
  extract: (_candidate, input, context) => Promise.resolve(extractHtml(input, context)),
};
