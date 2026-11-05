import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  IdentityStateCorruptError,
  emptyIdentityState,
  identityStateRules,
  validate,
  type IdentityMappingRepository,
  type IdentityStateDocument,
} from './identityMappingRepository.js';
import {
  enrolmentSnapshotSchema,
  explicitMappingSchema,
  identityObservationSchema,
  invalidationSchema,
  mappingFailureSchema,
  type EnrolmentSnapshot,
  type EntraUserKey,
  type ExplicitMapping,
  type IdentityObservation,
  type Invalidation,
  type MappingFailure,
} from './records.js';

/*
 * Local store: one JSON file under IDENTITY_STATE_DIR. Writes hold a lock file (created with
 * O_EXCL) and replace the file by rename, so the API and the admin commands can share it on one
 * machine. Not for several machines: see docs/authorization.md.
 */

const FORMAT_VERSION = 1 as const;
const FILE_NAME = 'identity-state.json';
const LOCK_NAME = 'identity-state.lock';
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 25;
const STALE_LOCK_MS = 60_000;

const documentSchema = z.object({
  version: z.literal(FORMAT_VERSION),
  mappings: z.array(explicitMappingSchema),
  failures: z.array(mappingFailureSchema),
  observations: z.array(identityObservationSchema),
  invalidations: z.array(invalidationSchema),
  snapshots: z.array(enrolmentSnapshotSchema),
});

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class FileIdentityMappingRepository implements IdentityMappingRepository {
  readonly #directory: string;
  readonly #now: () => Date;

  constructor(options: { readonly directory: string; readonly now?: () => Date }) {
    this.#directory = options.directory;
    this.#now = options.now ?? (() => new Date());
  }

  get #file(): string {
    return join(this.#directory, FILE_NAME);
  }

  async #read(): Promise<IdentityStateDocument> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        return emptyIdentityState();
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new IdentityStateCorruptError('not JSON');
    }
    const parsed = documentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new IdentityStateCorruptError('unexpected content');
    }
    const { mappings, failures, observations, invalidations, snapshots } = parsed.data;
    return { mappings, failures, observations, invalidations, snapshots };
  }

  async #lock(): Promise<() => Promise<void>> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = join(this.#directory, LOCK_NAME);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
        return async () => {
          await rm(path, { force: true });
        };
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) {
          throw error;
        }
      }
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(path, { force: true });
          continue;
        }
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) {
          throw error;
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the identity state lock.');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  async #update<T>(change: (state: IdentityStateDocument) => T): Promise<T> {
    const release = await this.#lock();
    try {
      const state = await this.#read();
      const result = change(state);
      const temporary = join(this.#directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify({ version: FORMAT_VERSION, ...state })}\n`, {
        mode: 0o600,
      });
      await rename(temporary, this.#file);
      return result;
    } finally {
      await release();
    }
  }

  async getMapping(key: EntraUserKey): Promise<ExplicitMapping | undefined> {
    return identityStateRules.find((await this.#read()).mappings, key);
  }

  async saveMapping(mapping: ExplicitMapping): Promise<void> {
    const valid = validate.mapping(mapping);
    await this.#update((state) => {
      identityStateRules.saveMapping(state, valid);
    });
  }

  async deleteMapping(key: EntraUserKey): Promise<boolean> {
    return await this.#update((state) => identityStateRules.deleteMapping(state, key));
  }

  async listMappings(): Promise<readonly ExplicitMapping[]> {
    return (await this.#read()).mappings;
  }

  async recordFailure(failure: MappingFailure): Promise<void> {
    const valid = validate.failure(failure);
    await this.#update((state) => {
      identityStateRules.recordFailure(state, valid);
    });
  }

  async listFailures(
    options: { readonly limit?: number; readonly key?: EntraUserKey } = {},
  ): Promise<readonly MappingFailure[]> {
    return identityStateRules.listFailures(await this.#read(), options);
  }

  async recordObservation(observation: IdentityObservation): Promise<void> {
    const valid = validate.observation(observation);
    await this.#update((state) => {
      identityStateRules.recordObservation(state, valid);
    });
  }

  async getObservation(key: EntraUserKey): Promise<IdentityObservation | undefined> {
    return identityStateRules.find((await this.#read()).observations, key);
  }

  async listObservations(): Promise<readonly IdentityObservation[]> {
    return (await this.#read()).observations;
  }

  async addInvalidation(invalidation: Invalidation): Promise<void> {
    const valid = validate.invalidation(invalidation);
    await this.#update((state) => {
      identityStateRules.addInvalidation(state, valid, this.#now());
    });
  }

  async listInvalidations(): Promise<readonly Invalidation[]> {
    const state = await this.#read();
    identityStateRules.pruneInvalidations(state, this.#now());
    return state.invalidations;
  }

  async getSnapshot(key: EntraUserKey): Promise<EnrolmentSnapshot | undefined> {
    return identityStateRules.find((await this.#read()).snapshots, key);
  }

  async saveSnapshot(snapshot: EnrolmentSnapshot): Promise<void> {
    const valid = validate.snapshot(snapshot);
    await this.#update((state) => {
      identityStateRules.saveSnapshot(state, valid);
    });
  }

  async deleteSnapshot(key: EntraUserKey): Promise<void> {
    await this.#update((state) => {
      identityStateRules.deleteSnapshot(state, key);
    });
  }
}
