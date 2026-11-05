import { classifyByCategory, getTelemetry, type DependencyName, type Logger } from '@ehub/shared';

/*
 * Liveness and readiness. Liveness says the process can serve HTTP at all and never depends on
 * anything outside it, so a Moodle or Azure outage never gets the API restarted. Readiness says
 * whether a request could succeed now: it fails when a required dependency is down, so a load
 * balancer stops sending traffic until it recovers.
 */

export type DependencyStatus = 'up' | 'down' | 'not_configured';

export interface DependencyCheck {
  readonly name: DependencyName;
  /** A required dependency that is down makes the service not ready. */
  readonly required: boolean;
  /** Resolves when the dependency answers correctly; rejects (or throws) otherwise. */
  readonly probe: ((signal: AbortSignal) => Promise<void>) | undefined;
}

export interface DependencyReport {
  readonly name: DependencyName;
  readonly required: boolean;
  readonly status: DependencyStatus;
  readonly latencyMs: number | null;
  /** Sanitised failure category; never an error message or URL. */
  readonly category: string | null;
  readonly checkedAt: string;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly checkedAt: string;
  readonly dependencies: readonly DependencyReport[];
}

export interface ReadinessOptions {
  readonly checks: readonly DependencyCheck[];
  /** Results are reused this long, so frequent probes do not load the dependencies. */
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
  readonly logger: Logger;
  readonly now?: () => Date;
}

const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export class DependencyTimeoutError extends Error {
  readonly category = 'timeout';

  constructor() {
    super('The dependency did not answer in time.');
    this.name = 'DependencyTimeoutError';
  }
}

export class ReadinessService {
  readonly #options: ReadinessOptions;
  readonly #cache = new Map<
    DependencyName,
    { readonly report: DependencyReport; readonly at: number }
  >();
  readonly #running = new Map<DependencyName, Promise<DependencyReport>>();
  readonly #now: () => Date;
  readonly #logger: Logger;

  constructor(options: ReadinessOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger.child({ component: 'readiness' });
  }

  async #check(check: DependencyCheck, fresh: boolean): Promise<DependencyReport> {
    const cached = this.#cache.get(check.name);
    const now = this.#now();
    if (
      !fresh &&
      cached !== undefined &&
      now.getTime() - cached.at < (this.#options.cacheMs ?? DEFAULT_CACHE_MS)
    ) {
      return cached.report;
    }
    const running = this.#running.get(check.name);
    if (running !== undefined) {
      return await running;
    }
    const task = this.#run(check).finally(() => {
      this.#running.delete(check.name);
    });
    this.#running.set(check.name, task);
    const report = await task;
    this.#cache.set(check.name, { report, at: this.#now().getTime() });
    return report;
  }

  async #run(check: DependencyCheck): Promise<DependencyReport> {
    const checkedAt = this.#now().toISOString();
    if (check.probe === undefined) {
      return {
        name: check.name,
        required: check.required,
        status: 'not_configured',
        latencyMs: null,
        category: null,
        checkedAt,
      };
    }
    const probe = check.probe;
    const started = performance.now();
    return await getTelemetry().span(
      'health.check',
      async (span) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            probe(controller.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new DependencyTimeoutError());
              }, this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            }),
          ]);
          return {
            name: check.name,
            required: check.required,
            status: 'up' as const,
            latencyMs: Math.round(performance.now() - started),
            category: null,
            checkedAt,
          };
        } catch (error) {
          const { category } = classifyByCategory(error);
          span.fail(category);
          this.#logger.warn('Dependency check failed.', { dependency: check.name, category });
          return {
            name: check.name,
            required: check.required,
            status: 'down' as const,
            latencyMs: Math.round(performance.now() - started),
            category,
            checkedAt,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      { attributes: { 'ehub.dependency': check.name } },
    );
  }

  /** Every dependency's status; `fresh` bypasses the cache (the diagnostic command). */
  async report(options: { readonly fresh?: boolean } = {}): Promise<ReadinessReport> {
    const dependencies = await Promise.all(
      this.#options.checks.map((check) => this.#check(check, options.fresh === true)),
    );
    const ready = dependencies.every(
      (dependency) => !dependency.required || dependency.status === 'up',
    );
    return {
      status: ready ? 'ready' : 'not_ready',
      checkedAt: this.#now().toISOString(),
      dependencies,
    };
  }
}

/** A probe that fails unless `healthy` resolves to true; for health methods returning reports. */
export function expectHealthy(
  healthy: (signal: AbortSignal) => Promise<boolean>,
  category: string,
) {
  return async (signal: AbortSignal): Promise<void> => {
    if (!(await healthy(signal))) {
      throw Object.assign(new Error('Dependency reported unhealthy.'), { category });
    }
  };
}
