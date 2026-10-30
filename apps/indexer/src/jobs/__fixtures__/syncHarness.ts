import {
  DefaultMoodleClient,
  type MoodleDownloadedFile,
  type MoodleFileDownloader,
  type MoodleTransport,
} from '@ehub/moodle-client';
import { chunkingConfigSchema, createLogger, loadConfig, type Logger } from '@ehub/shared';
import { AzureOpenAIEmbeddingProvider } from '@ehub/shared/embeddings';
import { RestSearchIndexClient, apiKeyAuthenticator } from '@ehub/shared/search';

import { FakeEmbeddingService } from '../../../../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import { FakeSearchService } from '../../../../../packages/shared/src/search/__fixtures__/fakeSearchService.js';
import { DEFAULT_EXTRACTORS, ExtractorRegistry } from '../../extractors/extractorRegistry.js';
import { testLimits } from '../../extractors/__fixtures__/helpers.js';
import { FIXTURE_BASE_URL } from '../../moodle/__fixtures__/fixtureClient.js';
import { StructuredChunker } from '../../pipeline/chunkContent.js';
import { chunkingSettingsFromConfig } from '../../pipeline/chunkingSettings.js';
import { InMemorySyncStateRepository } from '../../state/inMemorySyncStateRepository.js';
import type { SyncStateRepository } from '../../state/syncStateRepository.js';
import { buildPipelineVersions, chunkerVersionLabel } from '../fingerprints.js';
import type { SyncServices, SyncSettings } from '../syncContext.js';

export const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';
export const INDEX = 'ehub-course-content-v1';
const SEARCH_KEY = 'sync-test-search-key-0123456789abcdef';
const OPENAI_KEY = 'sync-test-openai-key-0123456789abcdef';
const HOST = 'https://ehub.example.test';

type Raw = Record<string, unknown>;

interface ModuleSpec {
  readonly raw: Raw;
  readonly sectionId: number;
}

interface CourseSpec {
  readonly raw: Raw;
  readonly sections: { id: number; name: string; visible: number }[];
  readonly modules: Map<number, ModuleSpec>;
}

export interface PageOptions {
  readonly name?: string;
  readonly html: string;
  readonly timeModified?: number | null;
  readonly revision?: number;
  readonly visible?: boolean;
  readonly sectionId?: number;
}

export interface FileOptions {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly timeModified?: number;
  readonly revision?: number;
  readonly visible?: boolean;
}

/**
 * A small Moodle site: courses, sections and Page / File activities, served through the real
 * DefaultMoodleClient (so responses pass the production schemas) and a fake downloader.
 */
export class FakeMoodleSite {
  readonly courses = new Map<number, CourseSpec>();
  readonly files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly downloadErrors = new Map<string, Error>();
  readonly contentErrors = new Map<number, Error>();
  readonly downloads: string[] = [];
  /** When set, downloads wait for it (for concurrency tests). */
  downloadGate: Promise<void> | undefined;
  readonly client: DefaultMoodleClient;
  readonly downloader: MoodleFileDownloader;

  constructor() {
    const transport: MoodleTransport = {
      call: (functionName, params) => {
        if (functionName === 'core_course_get_courses') {
          const options = params['options'];
          const ids =
            typeof options === 'object' && !Array.isArray(options)
              ? (options as Raw)['ids']
              : undefined;
          const all = [...this.courses.values()].map((course) => course.raw);
          return Promise.resolve(
            Array.isArray(ids) ? all.filter((course) => ids.includes(course['id'])) : all,
          );
        }
        if (functionName === 'core_course_get_contents') {
          const courseId = Number(params['courseid']);
          const error = this.contentErrors.get(courseId);
          if (error !== undefined) {
            return Promise.reject(error);
          }
          return Promise.resolve(this.#contents(courseId));
        }
        return Promise.reject(new Error(`No fake for ${functionName}`));
      },
    };
    this.client = new DefaultMoodleClient(transport);
    this.downloader = {
      download: async (fileUrl): Promise<MoodleDownloadedFile> => {
        const path = new URL(fileUrl).pathname;
        this.downloads.push(path);
        if (this.downloadGate !== undefined) {
          await this.downloadGate;
        }
        const error = this.downloadErrors.get(path);
        if (error !== undefined) {
          throw error;
        }
        const file = this.files.get(path);
        if (file === undefined) {
          throw new Error(`No fake file at ${path}`);
        }
        return {
          sourceUrl: fileUrl,
          finalUrl: fileUrl,
          redirectCount: 0,
          contentType: file.contentType,
          lastModified: undefined,
          byteLength: file.bytes.byteLength,
          bytes: file.bytes,
        };
      },
    };
  }

  addCourse(id: number, options: { name?: string; visible?: boolean } = {}): void {
    this.courses.set(id, {
      raw: {
        id,
        shortname: `C${String(id)}`,
        fullname: options.name ?? `Course ${String(id)}`,
        categoryid: 3,
        format: 'topics',
        visible: options.visible === false ? 0 : 1,
      },
      sections: [{ id: id * 10, name: 'General', visible: 1 }],
      modules: new Map(),
    });
  }

  setCourseVisible(id: number, visible: boolean): void {
    const course = this.#course(id);
    course.raw['visible'] = visible ? 1 : 0;
  }

  #course(id: number): CourseSpec {
    const course = this.courses.get(id);
    if (course === undefined) {
      throw new Error(`No course ${String(id)}`);
    }
    return course;
  }

  /** Path of a page body or file, as downloaded. */
  static pagePath(moduleId: number, revision = 1): string {
    return `/webservice/pluginfile.php/${String(5000 + moduleId)}/mod_page/content/${String(revision)}/index.html`;
  }

  static filePath(moduleId: number, fileName: string, revision = 1): string {
    return `/webservice/pluginfile.php/${String(5000 + moduleId)}/mod_resource/content/${String(revision)}/${encodeURIComponent(fileName)}`;
  }

  setPage(courseId: number, moduleId: number, options: PageOptions): void {
    const course = this.#course(courseId);
    const revision = options.revision ?? 1;
    const path = FakeMoodleSite.pagePath(moduleId, revision);
    this.files.set(path, {
      bytes: new TextEncoder().encode(options.html),
      contentType: 'text/html',
    });
    course.modules.set(moduleId, {
      sectionId: options.sectionId ?? courseId * 10,
      raw: {
        id: moduleId,
        name: options.name ?? `Page ${String(moduleId)}`,
        modname: 'page',
        instance: moduleId + 1000,
        contextid: moduleId + 5000,
        url: `${HOST}/mod/page/view.php?id=${String(moduleId)}`,
        visible: options.visible === false ? 0 : 1,
        uservisible: true,
        contents: [
          {
            type: 'file',
            filename: 'index.html',
            filepath: '/',
            filesize: 0,
            fileurl: `${HOST}${path}?forcedownload=1`,
            timemodified: options.timeModified === undefined ? 1_770_000_000 : options.timeModified,
            sortorder: 1,
          },
        ],
      },
    });
  }

  setFile(courseId: number, moduleId: number, options: FileOptions): void {
    const course = this.#course(courseId);
    const path = FakeMoodleSite.filePath(moduleId, options.fileName, options.revision ?? 1);
    this.files.set(path, { bytes: options.bytes, contentType: options.mimeType });
    course.modules.set(moduleId, {
      sectionId: courseId * 10,
      raw: {
        id: moduleId,
        name: options.fileName,
        modname: 'resource',
        instance: moduleId + 1000,
        contextid: moduleId + 5000,
        url: `${HOST}/mod/resource/view.php?id=${String(moduleId)}`,
        visible: options.visible === false ? 0 : 1,
        uservisible: true,
        contents: [
          {
            type: 'file',
            filename: options.fileName,
            filepath: '/',
            filesize: options.bytes.byteLength,
            fileurl: `${HOST}${path}?forcedownload=1`,
            mimetype: options.mimeType,
            timemodified: options.timeModified ?? 1_770_000_000,
            sortorder: 1,
          },
        ],
      },
    });
  }

  removeModule(courseId: number, moduleId: number): void {
    this.#course(courseId).modules.delete(moduleId);
  }

  removeCourse(courseId: number): void {
    this.courses.delete(courseId);
  }

  /** Empties every section of a course, as a glitching Moodle might. */
  clearCourse(courseId: number): void {
    this.#course(courseId).modules.clear();
  }

  #contents(courseId: number): unknown[] {
    const course = this.courses.get(courseId);
    if (course === undefined) {
      return [];
    }
    return course.sections.map((section) => ({
      id: section.id,
      name: section.name,
      section: 0,
      visible: section.visible,
      uservisible: true,
      modules: [...course.modules.values()]
        .filter((module) => module.sectionId === section.id)
        .map((module) => module.raw),
    }));
  }
}

export function pageHtml(title: string, paragraphs: readonly string[]): string {
  return `<h2>${title}</h2>${paragraphs.map((text) => `<p>${text}</p>`).join('')}`;
}

export interface Harness {
  readonly site: FakeMoodleSite;
  readonly search: FakeSearchService;
  readonly embeddings: FakeEmbeddingService;
  readonly state: SyncStateRepository;
  readonly logs: string[];
  readonly clock: { now: () => Date; advance: (ms: number) => void };
  services(overrides?: {
    settings?: Partial<SyncSettings>;
    chunkTargetTokens?: number;
    embeddingVersion?: string;
    extractorVersionBump?: string;
    state?: SyncStateRepository;
  }): Promise<SyncServices>;
  /** Index documents, by key. */
  documents(): Map<string, Record<string, unknown>>;
  /** Resource IDs with chunks in the index, sorted. */
  indexedResources(): string[];
}

export async function createHarness(): Promise<Harness> {
  const site = new FakeMoodleSite();
  const search = new FakeSearchService({ apiKey: SEARCH_KEY });
  const embeddings = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: 8 });
  let now = Date.parse('2026-03-02T06:00:00.000Z');
  const clock = { now: () => new Date(now), advance: (ms: number) => (now += ms) };
  const state = new InMemorySyncStateRepository({ clock });
  const logs: string[] = [];
  const logger: Logger = createLogger({
    service: 'sync-test',
    level: 'trace',
    sink: { write: (line) => logs.push(line) },
  });
  const searchClient = new RestSearchIndexClient({
    endpoint: 'https://search.example.test',
    indexName: INDEX,
    vectorDimensions: 8,
    semanticEnabled: true,
    authenticator: apiKeyAuthenticator(SEARCH_KEY),
    fetch: search.fetch,
    logger,
    sleep: () => Promise.resolve(),
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
  });
  await searchClient.createOrUpdateIndex();

  const harness: Harness = {
    site,
    search,
    embeddings,
    state,
    logs,
    clock,
    services: (overrides = {}) => {
      const config = loadConfig(chunkingConfigSchema, {
        ...(overrides.chunkTargetTokens === undefined
          ? {}
          : {
              CHUNK_TARGET_TOKENS: String(overrides.chunkTargetTokens),
              CHUNK_MIN_TOKENS: String(Math.min(100, overrides.chunkTargetTokens - 1)),
              CHUNK_OVERLAP_TOKENS: String(Math.floor(overrides.chunkTargetTokens / 4)),
            }),
      });
      const chunking = chunkingSettingsFromConfig(config);
      const extractors = new ExtractorRegistry({
        limits: testLimits(),
        logger,
        extractors: DEFAULT_EXTRACTORS.map((extractor) =>
          extractor.name === overrides.extractorVersionBump
            ? { ...extractor, version: '9.9.9' }
            : extractor,
        ),
      });
      const embedder = new AzureOpenAIEmbeddingProvider({
        endpoint: 'https://openai.example.test',
        deployment: 'embed',
        modelIdentifier: 'text-embedding-3-small',
        embeddingVersion: overrides.embeddingVersion ?? '1',
        dimensions: 8,
        sendDimensions: false,
        authenticator: apiKeyAuthenticator(OPENAI_KEY),
        batchSize: 16,
        maxBatchTokens: 100_000,
        maxInputTokens: 8191,
        maxConcurrency: 1,
        requestsPerMinute: 60_000,
        requestTimeoutMs: 5_000,
        retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
        fetch: embeddings.fetch,
        clock: () => clock.now(),
      });
      const settings: SyncSettings = {
        tenantId: TENANT_ID,
        courseIds: [12],
        allCourses: false,
        includeHidden: false,
        maxAttempts: 3,
        retryBaseDelayMs: 600_000,
        retryMaxDelayMs: 3_600_000,
        leaseTtlMs: 600_000,
        maxDeleteFraction: 0.5,
        maxDeleteMinimum: 2,
        maxDownloadBytes: 10 * 1024 * 1024,
        ...overrides.settings,
      };
      return Promise.resolve({
        moodle: { client: site.client, baseUrl: FIXTURE_BASE_URL, downloader: site.downloader },
        extractors,
        chunker: new StructuredChunker(chunking.options, chunking.counter),
        embedder,
        search: searchClient,
        state: overrides.state ?? state,
        versions: buildPipelineVersions({
          extractors: extractors.extractorVersions(),
          chunker: chunkerVersionLabel(chunking.options, chunking.counter.encoding),
          embeddingModel: embedder.getModelIdentifier(),
          embeddingVersion: embedder.getEmbeddingVersion(),
          embeddingDimensions: embedder.getDimensions(),
        }),
        settings,
        clock,
        logger,
      });
    },
    documents: () => search.documents.get(INDEX) ?? new Map(),
    indexedResources: () =>
      [
        ...new Set(
          [...(search.documents.get(INDEX)?.values() ?? [])].map((document) =>
            String(document['resourceId']),
          ),
        ),
      ].sort(),
  };
  return harness;
}
