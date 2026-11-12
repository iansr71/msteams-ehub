export type StepResult = 'pass' | 'fail' | 'blocked' | 'skipped';

export interface ReleaseStep {
  readonly id: string;
  readonly name: string;
  readonly result: StepResult;
  /** Why a step was blocked or skipped. */
  readonly reason?: string;
  readonly durationMs: number;
  /** Redacted tail of a failing step's output; empty otherwise. */
  readonly output: string;
}

export interface ReleaseSummary {
  /** True only when every step passed: a blocked step holds the release. */
  readonly ready: boolean;
  readonly verdict:
    'ready' | 'ready-with-skipped-steps' | 'not-ready-failed' | 'not-ready-incomplete';
  readonly failed: readonly string[];
  readonly blocked: readonly string[];
  readonly skipped: readonly string[];
}

/** Pure: the release verdict from the step results. */
export function summarizeSteps(steps: readonly ReleaseStep[]): ReleaseSummary;

/** Collapses anything that looks like a credential before it reaches a report. */
export function redactOutput(text: string): string;

export function renderMarkdown(report: unknown): string;
