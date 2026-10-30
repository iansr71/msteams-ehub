import type { RetrievedChunk } from '../retrieval/retrievalResultMapper.js';
import type { PromptSource } from './promptBuilder.js';

/** Who is asking and which links may be shown; all from trusted code, never from the model. */
export interface CitationScope {
  readonly tenantId: string;
  /** The courses this request may draw on (the selected courses, or all authorised ones). */
  readonly courseIds: ReadonlySet<number>;
  /** Hosts (lower case, optional port) allowed in citation links; empty means no links. */
  readonly allowedHosts: ReadonlySet<string>;
}

export type CitationRejection = 'unknown_source' | 'unauthorized_course';

export interface ValidatedClaimCitations {
  /** Distinct chunks the claim may cite, in the order the model cited them. */
  readonly chunks: readonly RetrievedChunk[];
  readonly rejected: readonly { readonly sourceId: string; readonly reason: CitationRejection }[];
}

/**
 * Maps the model's source IDs to chunks retrieved for this request. An ID that was not provided
 * is rejected; so is a chunk outside the request's courses, which can only appear through a
 * fault upstream and must never be cited or excerpted.
 */
export function validateClaimCitations(
  sourceIds: readonly string[],
  sources: readonly PromptSource[],
  scope: CitationScope,
): ValidatedClaimCitations {
  const bySourceId = new Map(sources.map((source) => [source.sourceId, source.chunk]));
  const chunks: RetrievedChunk[] = [];
  const seen = new Set<string>();
  const rejected: { sourceId: string; reason: CitationRejection }[] = [];
  for (const sourceId of sourceIds) {
    const chunk = bySourceId.get(sourceId);
    if (chunk === undefined) {
      rejected.push({ sourceId, reason: 'unknown_source' });
      continue;
    }
    if (!scope.courseIds.has(chunk.courseId)) {
      rejected.push({ sourceId, reason: 'unauthorized_course' });
      continue;
    }
    if (!seen.has(chunk.chunkId)) {
      seen.add(chunk.chunkId);
      chunks.push(chunk);
    }
  }
  return { chunks, rejected };
}

/**
 * The link to show for a chunk: the Moodle activity page if available (it enforces Moodle
 * access), otherwise the file URL, and only if it is https, carries no credentials or token, and
 * its host is approved. Otherwise no link is shown.
 */
export function approvedSourceUrl(
  chunk: Pick<RetrievedChunk, 'moduleUrl' | 'sourceUrl'>,
  allowedHosts: ReadonlySet<string>,
): string | undefined {
  for (const candidate of [chunk.moduleUrl, chunk.sourceUrl]) {
    if (candidate === undefined) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const host = url.host.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      ![...url.searchParams.keys()].some((key) => /token|key|secret|sig/i.test(key)) &&
      (allowedHosts.has(host) || allowedHosts.has(hostname))
    ) {
      return url.toString();
    }
  }
  return undefined;
}

/** Parses CITATION_ALLOWED_HOSTS, or falls back to the Moodle base URL's host. */
export function resolveAllowedHosts(
  configured: readonly string[] | undefined,
  moodleBaseUrl: string | undefined,
): ReadonlySet<string> {
  if (configured !== undefined && configured.length > 0) {
    return new Set(configured.map((host) => host.toLowerCase()));
  }
  if (moodleBaseUrl !== undefined && moodleBaseUrl.trim() !== '') {
    try {
      return new Set([new URL(moodleBaseUrl).host.toLowerCase()]);
    } catch {
      return new Set();
    }
  }
  return new Set();
}
