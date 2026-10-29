import {
  RestSearchIndexClient,
  apiKeyAuthenticator,
  type SearchDocument,
} from '@ehub/shared/search';

import {
  TEST_DIMENSIONS,
  makeSearchDocument,
} from '../../../../../packages/shared/src/search/__fixtures__/documents.js';
import { FakeSearchService } from '../../../../../packages/shared/src/search/__fixtures__/fakeSearchService.js';

export const TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const API_KEY = 'fake-search-admin-key-0123456789abcdef';
export const INDEX = 'ehub-course-content-v1';
/** Text that must never appear in output unless excerpts are requested. */
export const SECRET_SENTENCE = 'Reapply broad-spectrum sunscreen every two hours after a peel';

function chunk(seed: string, overrides: Partial<SearchDocument>): SearchDocument {
  return makeSearchDocument({ seed, tenantId: TENANT_ID, ...overrides });
}

/**
 * Course 12 (Consultation Skills) and course 13 (Laser Safety). Course 13's laser chunk
 * matches laser questions better than anything in course 12, so any leak would surface.
 */
export function corpus(): SearchDocument[] {
  const aftercare = (n: number, content: string) =>
    chunk(`c12-aftercare-${String(n)}`, {
      courseId: 12,
      moduleId: 701,
      resourceId: '701:chapter:11',
      resourceName: 'Aftercare',
      title: 'Sun protection',
      chunkNumber: n,
      chunkCount: 5,
      content,
    });
  return [
    aftercare(1, `${SECRET_SENTENCE}. Sunscreen protects peeled skin.`),
    aftercare(2, 'Sunscreen after a peel: use SPF 50 and avoid direct sun.'),
    aftercare(3, 'Peel aftercare includes sunscreen, moisturiser and no exfoliation.'),
    aftercare(4, 'More sunscreen peel guidance for clients.'),
    aftercare(5, 'Final sunscreen peel reminders.'),
    chunk('c12-consult', {
      courseId: 12,
      moduleId: 702,
      resourceId: '702:file:/Consultation checklist.pdf',
      resourceName: 'Consultation checklist.pdf',
      resourceType: 'pdf',
      fileName: 'Consultation checklist.pdf',
      title: 'Before a peel',
      pageNumber: 2,
      content: 'Before a peel, ask about sunscreen use and recent sun exposure.',
    }),
    chunk('c12-laser-mention', {
      courseId: 12,
      moduleId: 703,
      resourceId: '703:page',
      resourceName: 'Treatment overview',
      resourceType: 'moodle-page',
      title: 'Treatments offered',
      content: 'Laser treatments are offered at selected branches.',
    }),
    chunk('c13-laser', {
      courseId: 13,
      courseName: 'Laser Safety',
      moduleId: 801,
      resourceId: '801:chapter:3',
      resourceName: 'Eye protection',
      title: 'Eye protection',
      content: 'Laser treatments require eye protection goggles rated for the laser wavelength.',
    }),
    chunk('c12-inactive', {
      courseId: 12,
      moduleId: 704,
      resourceId: '704:page',
      resourceName: 'Old aftercare',
      resourceType: 'moodle-page',
      isActive: false,
      content: 'Withdrawn sunscreen peel laser eye protection guidance.',
    }),
    chunk('other-tenant', {
      tenantId: '00000000-0000-4000-8000-000000000099',
      courseId: 12,
      moduleId: 705,
      resourceId: '705:page',
      content: 'Other tenant sunscreen peel laser eye protection.',
    }),
  ];
}

export async function seededSearch(
  options: { semanticEnabled?: boolean } = {},
): Promise<{ service: FakeSearchService; client: RestSearchIndexClient }> {
  const service = new FakeSearchService({ apiKey: API_KEY });
  const client = new RestSearchIndexClient({
    endpoint: 'https://search.example.test',
    indexName: INDEX,
    vectorDimensions: TEST_DIMENSIONS,
    semanticEnabled: options.semanticEnabled ?? true,
    authenticator: apiKeyAuthenticator(API_KEY),
    fetch: service.fetch,
    sleep: () => Promise.resolve(),
  });
  await client.createOrUpdateIndex();
  service.seed(INDEX, corpus());
  return { service, client };
}

export { TEST_DIMENSIONS };
