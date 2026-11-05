/** Why authorisation could not be confirmed. The request is refused (fail closed). */
export type AuthorizationUnavailableReason =
  'moodle_unavailable' | 'identity_store_unavailable' | 'invalid_moodle_response';

/**
 * Moodle or the identity store could not be reached or gave an unusable answer, so the user's
 * access cannot be confirmed. Never carries the underlying error, which could include request
 * details; only its type is kept for logs.
 */
export class AuthorizationUnavailableError extends Error {
  readonly reason: AuthorizationUnavailableReason;
  readonly causeType: string;

  constructor(reason: AuthorizationUnavailableReason, cause?: unknown) {
    super('Course authorisation could not be confirmed.');
    this.name = 'AuthorizationUnavailableError';
    this.reason = reason;
    this.causeType =
      cause === undefined ? 'none' : cause instanceof Error ? cause.name : typeof cause;
  }
}

/** The signed-in user could not be mapped to exactly one active Moodle account. */
export class IdentityNotMappedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super('The signed-in user is not linked to an E-Hub account.');
    this.name = 'IdentityNotMappedError';
    this.reason = reason;
  }
}
