import { extractHtml } from './htmlExtractor.js';
import type { ContentExtractor } from './types.js';

/**
 * A Moodle Page body (`mod_page/content/<revision>/index.html`). The Page name becomes the root
 * of every heading path, and a repeated title at the top of the body is dropped.
 */
export const moodlePageExtractor: ContentExtractor = {
  name: 'moodle-page',
  version: '1.0.0',
  resourceType: 'moodle-page',
  supports: ({ contentType, resource }) => contentType === 'html' && resource.role === 'page-body',
  extract: ({ resource }, input, context) =>
    Promise.resolve(
      extractHtml(input, context, {
        basePath: [resource.moduleName],
        omitLeadingHeading: resource.moduleName,
      }),
    ),
};
