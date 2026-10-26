import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface CorrelationContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

// Inbound IDs come from untrusted callers (Teams, HTTP headers). Restrict them to a short,
// log-safe alphabet so they cannot carry injected content or unbounded data into logs.
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function generateCorrelationId(): string {
  return randomUUID();
}

export function isValidCorrelationId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate);
}

/** Returns `candidate` when it is a safe correlation ID, otherwise a newly generated one. */
export function normalizeCorrelationId(candidate: unknown): string {
  return isValidCorrelationId(candidate) ? candidate : generateCorrelationId();
}

/**
 * Runs `fn` with a correlation ID bound to the current async context. An absent or unsafe
 * `correlationId` is replaced by a generated one.
 */
export function runWithCorrelationId<T>(correlationId: unknown, fn: () => T): T {
  return storage.run({ correlationId: normalizeCorrelationId(correlationId) }, fn);
}

/** Runs `fn` with a freshly generated correlation ID (background jobs, CLI commands). */
export function runWithNewCorrelationId<T>(fn: () => T): T {
  return storage.run({ correlationId: generateCorrelationId() }, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export class MissingCorrelationIdError extends Error {
  constructor() {
    super('No correlation ID is bound to the current async context.');
    this.name = 'MissingCorrelationIdError';
  }
}

export function requireCorrelationId(): string {
  const correlationId = getCorrelationId();
  if (correlationId === undefined) {
    throw new MissingCorrelationIdError();
  }
  return correlationId;
}
