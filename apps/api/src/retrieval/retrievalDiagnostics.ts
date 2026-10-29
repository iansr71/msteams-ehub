import { redactString, sanitizeText } from '@ehub/shared';

import type { RetrievedChunk } from './retrievalResultMapper.js';
import type { RetrievalResult } from './retrievalService.js';

/*
 * Operator-facing output. Chunk content is source material and is never included unless the
 * caller explicitly asks for excerpts; excerpts are short, single-line and sanitised.
 */

export const EXCERPT_MAX_CHARS = 160;

export interface DiagnosticOptions {
  /** Include a short sanitised excerpt of each chunk. Off by default. */
  readonly excerpts: boolean;
}

export interface ChunkDiagnostic {
  readonly rank: number;
  readonly chunkId: string;
  readonly courseId: number;
  readonly courseName: string;
  readonly sectionName: string;
  readonly moduleId: number;
  readonly moduleName: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly resourceType: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly pageNumber?: number;
  readonly pageNumberEnd?: number;
  readonly slideNumber?: number;
  readonly chunkNumber: number;
  readonly sourceUrl?: string;
  readonly moduleUrl?: string;
  readonly score: number;
  readonly rerankerScore?: number;
  readonly excerpt?: string;
}

/** A short, single-line, control-free, secret-redacted excerpt of untrusted text. */
export function sanitizeExcerpt(content: string, maxChars = EXCERPT_MAX_CHARS): string {
  return sanitizeText(redactString(content), maxChars);
}

const metadataText = (value: string, max = 200): string => sanitizeText(value, max);

export function describeChunk(chunk: RetrievedChunk, options: DiagnosticOptions): ChunkDiagnostic {
  return {
    rank: chunk.rank,
    chunkId: chunk.chunkId,
    courseId: chunk.courseId,
    courseName: metadataText(chunk.courseName),
    sectionName: metadataText(chunk.sectionName),
    moduleId: chunk.moduleId,
    moduleName: metadataText(chunk.moduleName),
    resourceId: metadataText(chunk.resourceId, 300),
    resourceName: metadataText(chunk.resourceName),
    resourceType: chunk.resourceType,
    title: metadataText(chunk.title),
    headingPath: chunk.headingPath.map((heading) => metadataText(heading)),
    ...(chunk.pageNumber === undefined ? {} : { pageNumber: chunk.pageNumber }),
    ...(chunk.pageNumberEnd === undefined ? {} : { pageNumberEnd: chunk.pageNumberEnd }),
    ...(chunk.slideNumber === undefined ? {} : { slideNumber: chunk.slideNumber }),
    chunkNumber: chunk.chunkNumber,
    ...(chunk.sourceUrl === undefined ? {} : { sourceUrl: metadataText(chunk.sourceUrl, 500) }),
    ...(chunk.moduleUrl === undefined ? {} : { moduleUrl: metadataText(chunk.moduleUrl, 500) }),
    score: chunk.score,
    ...(chunk.rerankerScore === undefined ? {} : { rerankerScore: chunk.rerankerScore }),
    ...(options.excerpts ? { excerpt: sanitizeExcerpt(chunk.content) } : {}),
  };
}

export interface RetrievalDiagnosticReport {
  readonly mode: RetrievalResult['mode'];
  readonly queryEmbeddingModel?: string;
  readonly semanticApplied: boolean;
  readonly topK: number;
  readonly candidates: number;
  readonly droppedBelowThreshold: number;
  readonly droppedByResourceCap: number;
  readonly durationMs: number;
  readonly results: readonly ChunkDiagnostic[];
}

export class RetrievalDiagnostics {
  readonly #options: DiagnosticOptions;

  constructor(options: DiagnosticOptions = { excerpts: false }) {
    this.#options = options;
  }

  report(result: RetrievalResult): RetrievalDiagnosticReport {
    return {
      mode: result.mode,
      ...(result.queryEmbeddingModel === undefined
        ? {}
        : { queryEmbeddingModel: result.queryEmbeddingModel }),
      semanticApplied: result.semanticApplied,
      topK: result.topK,
      candidates: result.candidates,
      droppedBelowThreshold: result.droppedBelowThreshold,
      droppedByResourceCap: result.droppedByResourceCap,
      durationMs: result.durationMs,
      results: result.chunks.map((chunk) => describeChunk(chunk, this.#options)),
    };
  }

  renderJson(result: RetrievalResult): string {
    return redactString(JSON.stringify(this.report(result), null, 2));
  }

  renderText(result: RetrievalResult): string {
    const report = this.report(result);
    const lines = [
      `Retrieval: ${report.mode}${report.queryEmbeddingModel === undefined ? '' : ` (query embedded with ${report.queryEmbeddingModel})`}${report.semanticApplied ? ' + semantic ranking' : ''}, ${String(report.results.length)} of top ${String(report.topK)} (${String(report.candidates)} candidates, ${String(report.droppedBelowThreshold)} below threshold, ${String(report.droppedByResourceCap)} over the per-resource cap), ${String(report.durationMs)} ms`,
    ];
    if (report.results.length === 0) {
      lines.push('No results.');
    }
    for (const chunk of report.results) {
      const location = [
        chunk.pageNumber === undefined
          ? undefined
          : `page ${String(chunk.pageNumber)}${chunk.pageNumberEnd === undefined ? '' : `-${String(chunk.pageNumberEnd)}`}`,
        chunk.slideNumber === undefined ? undefined : `slide ${String(chunk.slideNumber)}`,
        `chunk ${String(chunk.chunkNumber)}`,
      ]
        .filter((part) => part !== undefined)
        .join(', ');
      lines.push(
        `${String(chunk.rank).padStart(2)}. score ${chunk.score.toFixed(4)}${chunk.rerankerScore === undefined ? '' : ` | reranker ${chunk.rerankerScore.toFixed(2)}`}`,
        `    course ${String(chunk.courseId)} ${chunk.courseName} > ${chunk.sectionName}`,
        `    resource ${chunk.resourceId} (${chunk.resourceType}) ${chunk.resourceName} | ${location}`,
        `    title ${chunk.title}`,
        `    source ${chunk.moduleUrl ?? chunk.sourceUrl ?? '-'}`,
      );
      if (chunk.excerpt !== undefined) {
        lines.push(`    excerpt (untrusted source text): ${chunk.excerpt}`);
      }
    }
    return redactString(lines.join('\n'));
  }
}
