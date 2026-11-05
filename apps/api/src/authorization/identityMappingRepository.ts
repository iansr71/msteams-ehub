import {
  enrolmentSnapshotSchema,
  explicitMappingSchema,
  identityObservationSchema,
  invalidationSchema,
  mappingFailureSchema,
  userKeyString,
  type EnrolmentSnapshot,
  type EntraUserKey,
  type ExplicitMapping,
  type IdentityObservation,
  type Invalidation,
  type MappingFailure,
} from './records.js';

/** Audit records kept; the oldest are dropped first. */
export const MAX_FAILURE_RECORDS = 2_000;
/** Invalidations older than this cannot affect any cache entry (TTL plus grace is at most 75 min). */
export const INVALIDATION_RETENTION_MS = 2 * 60 * 60_000;

export class IdentityStateCorruptError extends Error {
  constructor(what: string) {
    super(`The identity state store is unreadable (${what}).`);
    this.name = 'IdentityStateCorruptError';
  }
}

/**
 * Persistent identity state: explicit mappings (the only records that grant anything, and only
 * after Moodle confirms the account), the audit trail of denied mappings, the claims last seen
 * per user, cache invalidations and enrolment snapshots.
 */
export interface IdentityMappingRepository {
  getMapping(key: EntraUserKey): Promise<ExplicitMapping | undefined>;
  saveMapping(mapping: ExplicitMapping): Promise<void>;
  /** True when a mapping was removed. */
  deleteMapping(key: EntraUserKey): Promise<boolean>;
  listMappings(): Promise<readonly ExplicitMapping[]>;

  recordFailure(failure: MappingFailure): Promise<void>;
  /** Newest first. */
  listFailures(options?: {
    readonly limit?: number;
    readonly key?: EntraUserKey;
  }): Promise<readonly MappingFailure[]>;

  recordObservation(observation: IdentityObservation): Promise<void>;
  getObservation(key: EntraUserKey): Promise<IdentityObservation | undefined>;
  listObservations(): Promise<readonly IdentityObservation[]>;

  addInvalidation(invalidation: Invalidation): Promise<void>;
  /** Invalidations from the last two hours, oldest first. */
  listInvalidations(): Promise<readonly Invalidation[]>;

  getSnapshot(key: EntraUserKey): Promise<EnrolmentSnapshot | undefined>;
  saveSnapshot(snapshot: EnrolmentSnapshot): Promise<void>;
  deleteSnapshot(key: EntraUserKey): Promise<void>;
}

/** The whole store as one document; small enough for a few thousand users. */
export interface IdentityStateDocument {
  mappings: ExplicitMapping[];
  failures: MappingFailure[];
  observations: IdentityObservation[];
  invalidations: Invalidation[];
  snapshots: EnrolmentSnapshot[];
}

export function emptyIdentityState(): IdentityStateDocument {
  return { mappings: [], failures: [], observations: [], invalidations: [], snapshots: [] };
}

function sameUser(left: EntraUserKey, right: EntraUserKey): boolean {
  return left.tenantId === right.tenantId && left.objectId === right.objectId;
}

/** Validates every record on the way in, so a bad caller cannot store something unreadable. */
export const validate = {
  mapping: (value: ExplicitMapping): ExplicitMapping => explicitMappingSchema.parse(value),
  failure: (value: MappingFailure): MappingFailure => mappingFailureSchema.parse(value),
  observation: (value: IdentityObservation): IdentityObservation =>
    identityObservationSchema.parse(value),
  invalidation: (value: Invalidation): Invalidation => invalidationSchema.parse(value),
  snapshot: (value: EnrolmentSnapshot): EnrolmentSnapshot => enrolmentSnapshotSchema.parse(value),
};

/**
 * The pure state transitions, shared by the in-memory and file stores so both behave
 * identically.
 */
export const identityStateRules = {
  saveMapping(state: IdentityStateDocument, mapping: ExplicitMapping): void {
    state.mappings = [...state.mappings.filter((entry) => !sameUser(entry, mapping)), mapping];
  },
  deleteMapping(state: IdentityStateDocument, key: EntraUserKey): boolean {
    const before = state.mappings.length;
    state.mappings = state.mappings.filter((entry) => !sameUser(entry, key));
    return state.mappings.length !== before;
  },
  recordFailure(state: IdentityStateDocument, failure: MappingFailure): void {
    state.failures = [...state.failures, failure].slice(-MAX_FAILURE_RECORDS);
  },
  listFailures(
    state: IdentityStateDocument,
    options: { readonly limit?: number; readonly key?: EntraUserKey },
  ): MappingFailure[] {
    const matching = state.failures.filter(
      (entry) => options.key === undefined || sameUser(entry, options.key),
    );
    return matching.reverse().slice(0, options.limit ?? 100);
  },
  recordObservation(state: IdentityStateDocument, observation: IdentityObservation): void {
    state.observations = [
      ...state.observations.filter((entry) => !sameUser(entry, observation)),
      observation,
    ];
  },
  addInvalidation(state: IdentityStateDocument, invalidation: Invalidation, now: Date): void {
    identityStateRules.pruneInvalidations(state, now);
    state.invalidations = [...state.invalidations, invalidation];
  },
  pruneInvalidations(state: IdentityStateDocument, now: Date): void {
    const cutoff = now.getTime() - INVALIDATION_RETENTION_MS;
    state.invalidations = state.invalidations.filter((entry) => Date.parse(entry.at) >= cutoff);
  },
  saveSnapshot(state: IdentityStateDocument, snapshot: EnrolmentSnapshot): void {
    state.snapshots = [...state.snapshots.filter((entry) => !sameUser(entry, snapshot)), snapshot];
  },
  deleteSnapshot(state: IdentityStateDocument, key: EntraUserKey): void {
    state.snapshots = state.snapshots.filter((entry) => !sameUser(entry, key));
  },
  find<T extends EntraUserKey>(entries: readonly T[], key: EntraUserKey): T | undefined {
    return entries.find((entry) => sameUser(entry, key));
  },
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** For tests and single-process development. */
export class InMemoryIdentityMappingRepository implements IdentityMappingRepository {
  readonly #state = emptyIdentityState();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  getMapping(key: EntraUserKey): Promise<ExplicitMapping | undefined> {
    return Promise.resolve(copy(identityStateRules.find(this.#state.mappings, key)));
  }

  saveMapping(mapping: ExplicitMapping): Promise<void> {
    identityStateRules.saveMapping(this.#state, validate.mapping(mapping));
    return Promise.resolve();
  }

  deleteMapping(key: EntraUserKey): Promise<boolean> {
    return Promise.resolve(identityStateRules.deleteMapping(this.#state, key));
  }

  listMappings(): Promise<readonly ExplicitMapping[]> {
    return Promise.resolve(copy(this.#state.mappings));
  }

  recordFailure(failure: MappingFailure): Promise<void> {
    identityStateRules.recordFailure(this.#state, validate.failure(failure));
    return Promise.resolve();
  }

  listFailures(
    options: { readonly limit?: number; readonly key?: EntraUserKey } = {},
  ): Promise<readonly MappingFailure[]> {
    return Promise.resolve(copy(identityStateRules.listFailures(this.#state, options)));
  }

  recordObservation(observation: IdentityObservation): Promise<void> {
    identityStateRules.recordObservation(this.#state, validate.observation(observation));
    return Promise.resolve();
  }

  getObservation(key: EntraUserKey): Promise<IdentityObservation | undefined> {
    return Promise.resolve(copy(identityStateRules.find(this.#state.observations, key)));
  }

  listObservations(): Promise<readonly IdentityObservation[]> {
    return Promise.resolve(copy(this.#state.observations));
  }

  addInvalidation(invalidation: Invalidation): Promise<void> {
    identityStateRules.addInvalidation(
      this.#state,
      validate.invalidation(invalidation),
      this.#now(),
    );
    return Promise.resolve();
  }

  listInvalidations(): Promise<readonly Invalidation[]> {
    identityStateRules.pruneInvalidations(this.#state, this.#now());
    return Promise.resolve(copy(this.#state.invalidations));
  }

  getSnapshot(key: EntraUserKey): Promise<EnrolmentSnapshot | undefined> {
    return Promise.resolve(copy(identityStateRules.find(this.#state.snapshots, key)));
  }

  saveSnapshot(snapshot: EnrolmentSnapshot): Promise<void> {
    identityStateRules.saveSnapshot(this.#state, validate.snapshot(snapshot));
    return Promise.resolve();
  }

  deleteSnapshot(key: EntraUserKey): Promise<void> {
    identityStateRules.deleteSnapshot(this.#state, key);
    return Promise.resolve();
  }
}

export { userKeyString };
