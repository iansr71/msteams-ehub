import { BlockCollector } from './textNormalization.js';
import { decodeText } from './textDecoding.js';
import type { ContentExtractor, ExtractorOutput } from './types.js';

/** Plain text: paragraphs are separated by blank lines; hard-wrapped lines are joined. */
export const plainTextExtractor: ContentExtractor = {
  name: 'plain-text',
  version: '1.0.0',
  resourceType: 'plain-text',
  supports: ({ contentType }) => contentType === 'plain-text',
  extract: (_candidate, input, context): Promise<ExtractorOutput> => {
    const { text, warning } = decodeText(input.bytes);
    const collector = new BlockCollector(context.limits.maxTextChars);
    const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
    for (const [index, paragraph] of paragraphs.entries()) {
      if (index % 500 === 0) {
        context.deadline.check();
      }
      if (!collector.add({ kind: 'paragraph', text: paragraph })) {
        break;
      }
    }
    const warnings = [warning, collector.truncated ? 'text_truncated' : undefined].filter(
      (value): value is string => value !== undefined,
    );
    return Promise.resolve({ blocks: collector.blocks, warnings });
  },
};
