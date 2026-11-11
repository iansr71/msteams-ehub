export interface SecretFinding {
  readonly path: string;
  /** 1-based line; 0 for a finding about the file itself. */
  readonly line: number;
  readonly rule: string;
}

/** Findings for one file's text. The matched value is never included. */
export function scanText(path: string, text: string): SecretFinding[];

/** Scans tracked and untracked-but-not-ignored files under a git checkout. */
export function scanRepository(root: string): { findings: SecretFinding[]; scanned: number };
