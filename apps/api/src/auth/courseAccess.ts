import type { AuthenticatedCaller } from '../http/authentication.js';

/**
 * Which Moodle courses a caller may ask about. Phase 14 implements this from Moodle
 * enrolments; until then real users get no courses (fail closed) unless a development-only
 * course list is configured.
 */
export interface CourseAccessResolver {
  readonly mode: string;
  resolve(caller: AuthenticatedCaller): Promise<readonly number[]>;
}

export class InterimCourseAccess implements CourseAccessResolver {
  readonly mode: string;
  readonly #mockCourseIds: readonly number[];
  readonly #entraCourseIds: readonly number[];

  constructor(options: {
    readonly nodeEnv: string;
    readonly mockCourseIds: readonly number[];
    /** DEVELOPMENT ONLY: every signed-in user gets these. Ignored outside development. */
    readonly devEntraCourseIds: readonly number[];
  }) {
    const development = options.nodeEnv === 'development';
    this.#mockCourseIds = development ? [...options.mockCourseIds] : [];
    this.#entraCourseIds = development ? [...options.devEntraCourseIds] : [];
    this.mode = this.#entraCourseIds.length > 0 ? 'dev-static' : 'none';
  }

  resolve(caller: AuthenticatedCaller): Promise<readonly number[]> {
    return Promise.resolve(caller.mock ? this.#mockCourseIds : this.#entraCourseIds);
  }
}
