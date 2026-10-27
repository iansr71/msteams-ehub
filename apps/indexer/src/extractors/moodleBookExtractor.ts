import { extractHtml } from './htmlExtractor.js';
import type { ContentExtractor } from './types.js';

/**
 * One Moodle Book chapter (`mod_book/chapter/<id>/index.html`). Discovery models each chapter as
 * its own resource, so headings are rooted at [book name, chapter title]; a repeated chapter
 * title at the top of the body is dropped.
 */
export const moodleBookExtractor: ContentExtractor = {
  name: 'moodle-book',
  version: '1.0.0',
  resourceType: 'moodle-book-chapter',
  supports: ({ contentType, resource }) =>
    contentType === 'html' && resource.role === 'book-chapter',
  extract: ({ resource }, input, context) =>
    Promise.resolve(
      extractHtml(input, context, {
        basePath: [resource.moduleName, resource.resourceName],
        omitLeadingHeading: resource.resourceName,
      }),
    ),
};
