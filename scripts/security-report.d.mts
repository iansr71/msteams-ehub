export interface ControlTestReference {
  readonly file: string;
  /** Only tests under this describe block count; all tests in the file when omitted. */
  readonly suite?: string;
}

export interface SecurityControl {
  readonly id: string;
  readonly area: string;
  readonly control: string;
  readonly attack?: string;
  readonly tests: readonly ControlTestReference[];
}

/** The parts of Vitest's JSON reporter output the report reads. */
export interface VitestFileResult {
  readonly name: string;
  readonly assertionResults: readonly {
    readonly ancestorTitles: readonly string[];
    readonly status: string;
  }[];
}

export interface ControlResult extends SecurityControl {
  readonly result: 'pass' | 'fail' | 'incomplete';
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** Referenced files or suites with no test results. */
  readonly missing: readonly string[];
}

/** Pure: one result per control from the catalogue and Vitest's results. */
export function evaluateControls(
  controls: readonly SecurityControl[],
  testResults: readonly VitestFileResult[],
  rootDir: string,
): ControlResult[];

export function renderMarkdown(report: unknown): string;
