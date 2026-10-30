import type { CourseResource, CourseSummary } from '../../moodle/models.js';
import type { IndexedFingerprint, ResourceState } from '../../state/syncState.js';
import {
  buildPipelineVersions,
  sourceFingerprint,
  type PipelineVersions,
} from '../fingerprints.js';

export const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';

export const COURSE: Pick<CourseSummary, 'fullName' | 'categoryId'> = {
  fullName: 'Consultation Standards',
  categoryId: 3,
};

export function makeResource(overrides: Partial<CourseResource> = {}): CourseResource {
  return {
    resourceId: '702:file:/Aftercare.pdf',
    courseId: 12,
    sectionId: 101,
    sectionName: 'Aftercare',
    moduleId: 702,
    moduleName: 'Aftercare guide',
    moduleKind: 'file-resource',
    resourceName: 'Aftercare.pdf',
    role: 'primary',
    fileName: 'Aftercare.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 5000,
    timeModified: '2026-02-01T10:00:00.000Z',
    moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=702',
    sourceUrl:
      'https://ehub.example.test/webservice/pluginfile.php/5702/mod_resource/content/1/Aftercare.pdf',
    hiddenFromStudents: false,
    support: { status: 'supported' },
    ...overrides,
  };
}

export const VERSIONS: PipelineVersions = buildPipelineVersions({
  extractors: [
    { name: 'pdf', version: '1.0.0' },
    { name: 'html', version: '1.0.0' },
  ],
  chunker: 'structure-aware@1.0.0#abc',
  embeddingModel: 'text-embedding-3-small',
  embeddingVersion: '1',
  embeddingDimensions: 8,
});

export const FILE_HASH = '1'.repeat(64);
export const CONTENT_HASH = '2'.repeat(64);

export function indexedFingerprint(
  resource: CourseResource = makeResource(),
  overrides: Partial<IndexedFingerprint> = {},
): IndexedFingerprint {
  return {
    ...sourceFingerprint(resource, COURSE),
    fileHash: FILE_HASH,
    contentHash: CONTENT_HASH,
    extractorVersion: 'pdf@1.0.0',
    chunkerVersion: VERSIONS.chunker,
    embeddingModel: VERSIONS.embeddingModel,
    embeddingVersion: VERSIONS.embeddingVersion,
    embeddingDimensions: VERSIONS.embeddingDimensions,
    chunkCount: 3,
    indexedAt: '2026-02-01T11:00:00.000Z',
    ...overrides,
  };
}

export function indexedState(
  resource: CourseResource = makeResource(),
  overrides: Partial<ResourceState> = {},
): ResourceState {
  return {
    tenantId: TENANT_ID,
    courseId: resource.courseId,
    resourceId: resource.resourceId,
    moduleId: resource.moduleId,
    status: 'indexed',
    observed: sourceFingerprint(resource, COURSE),
    lastFileHash: FILE_HASH,
    lastContentHash: CONTENT_HASH,
    indexed: indexedFingerprint(resource),
    retryCount: 0,
    lastJobId: 'job-0',
    lastJobType: 'incremental',
    lastAttemptAt: '2026-02-01T11:00:00.000Z',
    lastSuccessfulIndexAt: '2026-02-01T11:00:00.000Z',
    updatedAt: '2026-02-01T11:00:00.000Z',
    ...overrides,
  };
}
