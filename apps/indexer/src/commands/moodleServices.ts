import {
  createMoodleServices,
  isMoodleError,
  loadMoodleSettings,
  type MoodleClient,
  type MoodleClientSettings,
  type MoodleError,
  type NormalizedMoodleBaseUrl,
} from '@ehub/moodle-client';
import {
  ConfigValidationError,
  EXIT_FAILURE,
  EXIT_USAGE,
  type CommandContext,
  type EnvironmentSource,
  type Logger,
} from '@ehub/shared';

import { finalizeOutput, renderJson, sanitizeText } from '../moodle/diagnosticOutput.js';
import { CourseNotFoundError } from '../moodle/inspectCourse.js';
import { UsageError } from './args.js';

export interface MoodleAccess {
  readonly client: MoodleClient;
  readonly baseUrl: NormalizedMoodleBaseUrl;
  readonly settings: MoodleClientSettings;
}

/** Injection point: tests supply a fake client; production builds real HTTP services. */
export interface MoodleCommandDependencies {
  readonly env: EnvironmentSource;
  readonly createAccess?: (settings: MoodleClientSettings, logger: Logger) => MoodleAccess;
}

export function defaultCreateAccess(settings: MoodleClientSettings, logger: Logger): MoodleAccess {
  const services = createMoodleServices(settings, { logger });
  return { client: services.client, baseUrl: services.baseUrl, settings };
}

/** Loads validated settings (variable names only on failure) and builds the client. */
export function openMoodleAccess(
  dependencies: MoodleCommandDependencies,
  logger: Logger,
): MoodleAccess {
  const settings = loadMoodleSettings(dependencies.env);
  return (dependencies.createAccess ?? defaultCreateAccess)(settings, logger);
}

const HINTS: Readonly<Record<string, string>> = {
  invalid_configuration: 'Set the listed variables in .env (local) or Key Vault (Azure).',
  invalidtoken:
    'The token is wrong, was deleted, or belongs to another service. Create a new token for the E-Hub service.',
  invalidtimedtoken: 'The token has expired. Create a new token and rotate it.',
  invalidiptoken: "This machine's IP address is not in the token's IP restriction.",
  accessexception:
    'The function is not added to the external service, or the account is not an authorised user of it.',
  nopermissions: 'The service role lacks a capability required by this function.',
  requireloginerror:
    'The service account cannot access this course. Check role assignment on the course or category.',
  webservicesnotenabled: 'Enable web services and the REST protocol in Site administration.',
  servicenotavailable: 'The external service is disabled.',
  unexpected_html_response:
    'Moodle returned a web page: maintenance mode, a login page or a proxy error page.',
  http_429: 'A proxy or firewall in front of Moodle is rate limiting requests.',
  timeout: 'Moodle did not respond in time. Check connectivity or raise MOODLE_REQUEST_TIMEOUT_MS.',
  network_error: 'Could not reach Moodle. Check MOODLE_BASE_URL, DNS, firewall and TLS.',
  network_transient: 'The connection to Moodle failed repeatedly. Check connectivity and retry.',
  response_schema_mismatch:
    'Moodle returned data in an unexpected shape. Check the Moodle version; the response fields are listed in issuePaths.',
  course_not_found:
    'Check the course ID with moodle:courses, and that the service account can see the course.',
};

export interface FailureReport {
  readonly status: 'error';
  readonly error: {
    readonly category: string;
    readonly code: string;
    readonly message: string;
    readonly moodleErrorCode?: string;
    readonly httpStatus?: number;
    readonly networkCode?: string;
    readonly issuePaths?: readonly string[];
    readonly problems?: readonly string[];
  };
  readonly hint?: string;
}

function fromMoodleError(error: MoodleError): FailureReport {
  const hint = HINTS[error.moodleErrorCode ?? ''] ?? HINTS[error.code];
  return {
    status: 'error',
    error: {
      category: error.category,
      code: error.code,
      message: error.message,
      ...(error.moodleErrorCode === undefined ? {} : { moodleErrorCode: error.moodleErrorCode }),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.networkCode === undefined ? {} : { networkCode: error.networkCode }),
      ...(error.issuePaths === undefined ? {} : { issuePaths: error.issuePaths }),
    },
    ...(hint === undefined ? {} : { hint }),
  };
}

/** Converts known failures into a sanitized report; returns undefined for anything else. */
export function describeFailure(error: unknown): FailureReport | undefined {
  if (error instanceof ConfigValidationError) {
    return {
      status: 'error',
      error: {
        category: 'configuration',
        code: 'invalid_configuration',
        message: 'Moodle configuration is missing or invalid.',
        problems: error.issues.map((issue) => `${issue.variable}: ${issue.message}`),
      },
      hint: HINTS['invalid_configuration'] ?? '',
    };
  }
  if (isMoodleError(error)) {
    return fromMoodleError(error);
  }
  if (error instanceof CourseNotFoundError) {
    return {
      status: 'error',
      error: { category: 'not_found', code: error.code, message: error.message },
      hint: HINTS['course_not_found'] ?? '',
    };
  }
  return undefined;
}

export function renderFailureText(report: FailureReport, action: string): string {
  const { error } = report;
  const lines = [
    `${action} failed: ${error.category} / ${sanitizeText(error.code, 64)}`,
    `  ${sanitizeText(error.message, 300)}`,
  ];
  if (error.httpStatus !== undefined) {
    lines.push(`  HTTP status: ${String(error.httpStatus)}`);
  }
  if (error.networkCode !== undefined) {
    lines.push(`  Network code: ${sanitizeText(error.networkCode, 40)}`);
  }
  for (const problem of error.problems ?? []) {
    lines.push(`  - ${sanitizeText(problem)}`);
  }
  if (error.issuePaths !== undefined && error.issuePaths.length > 0) {
    lines.push(`  Fields: ${error.issuePaths.map((path) => sanitizeText(path, 60)).join(', ')}`);
  }
  if (report.hint !== undefined) {
    lines.push(`  Hint: ${report.hint}`);
  }
  return finalizeOutput(lines.join('\n'));
}

export interface MoodleCommandRun {
  readonly context: CommandContext;
  readonly action: string;
  readonly json: boolean;
}

/**
 * Shared error boundary for moodle:* commands: usage errors exit 2, known failures print a
 * sanitized report and exit 1, anything unexpected propagates to the CLI's generic handler.
 */
export async function withMoodleErrorHandling(
  run: MoodleCommandRun,
  body: () => Promise<number>,
): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof UsageError) {
      run.context.stdout(sanitizeText(error.message, 200));
      return EXIT_USAGE;
    }
    const report = describeFailure(error);
    if (report === undefined) {
      throw error;
    }
    run.context.logger.warn(`${run.action} failed.`, {
      category: report.error.category,
      code: report.error.code,
    });
    run.context.stdout(run.json ? renderJson(report) : renderFailureText(report, run.action));
    return EXIT_FAILURE;
  }
}
