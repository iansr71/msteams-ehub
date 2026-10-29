import type { SearchHit } from '@ehub/shared/search';

/**
 * One retrieved chunk with the metadata a citation needs. `content` is untrusted source text:
 * it is passed to later stages but never printed or logged by default.
 */
export interface RetrievedChunk {
  /** 1-based position after capping and thresholds. */
  readonly rank: number;
  readonly chunkId: string;
  readonly courseId: number;
  readonly courseName: string;
  readonly sectionId: number;
  readonly sectionName: string;
  readonly moduleId: number;
  readonly moduleName: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly resourceType: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly pageNumber: number | undefined;
  readonly pageNumberEnd: number | undefined;
  readonly slideNumber: number | undefined;
  readonly chunkNumber: number;
  readonly chunkCount: number;
  readonly sourceUrl: string | undefined;
  readonly moduleUrl: string | undefined;
  readonly modifiedAt: string | undefined;
  readonly score: number;
  readonly rerankerScore: number | undefined;
  readonly content: string;
}

export class RetrievalResultMapper {
  map(hit: SearchHit, rank: number): RetrievedChunk {
    const { document } = hit;
    return {
      rank,
      chunkId: document.id,
      courseId: document.courseId,
      courseName: document.courseName,
      sectionId: document.sectionId,
      sectionName: document.sectionName,
      moduleId: document.moduleId,
      moduleName: document.moduleName,
      resourceId: document.resourceId,
      resourceName: document.resourceName,
      resourceType: document.resourceType,
      title: document.title,
      headingPath: document.headingPath,
      pageNumber: document.pageNumber,
      pageNumberEnd: document.pageNumberEnd,
      slideNumber: document.slideNumber,
      chunkNumber: document.chunkNumber,
      chunkCount: document.chunkCount,
      sourceUrl: document.sourceUrl,
      moduleUrl: document.moduleUrl,
      modifiedAt: document.modifiedAt,
      score: hit.score,
      rerankerScore: hit.rerankerScore,
      content: document.content,
    };
  }
}
