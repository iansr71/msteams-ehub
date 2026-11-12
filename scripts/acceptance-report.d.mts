/** Which live service a suite needs; `none` means it runs anywhere. */
export type SuiteRequirement = 'none' | 'moodle' | 'azure' | 'teams';

export interface AcceptanceSuite {
  readonly id: string;
  readonly name: string;
  readonly requires: SuiteRequirement;
  /** One sentence on what passing the suite establishes. */
  readonly proves: string;
  readonly files: readonly string[];
  /** For suites that need a live service: how an operator runs the check. */
  readonly command?: string;
}

/** The parts of Vitest's JSON reporter output the report reads. */
export interface VitestFileResult {
  readonly name: string;
  readonly assertionResults: readonly {
    readonly ancestorTitles: readonly string[];
    readonly status: string;
  }[];
}

export interface SuiteResult extends AcceptanceSuite {
  readonly result: 'pass' | 'fail' | 'incomplete' | 'not-run';
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** Listed files with no test results. */
  readonly missing: readonly string[];
}

/** Pure: one result per suite from the catalogue and Vitest's results. */
export function evaluateSuites(
  suites: readonly AcceptanceSuite[],
  testResults: readonly VitestFileResult[],
  rootDir: string,
): SuiteResult[];

export function renderMarkdown(report: unknown): string;
