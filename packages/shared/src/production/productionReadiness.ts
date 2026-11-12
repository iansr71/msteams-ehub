import { cleanEnvironment, type EnvironmentSource } from '../config/load.js';
import { CONFIG_FEATURES, applicationConfigSchema, type ConfigFeature } from '../config/schema.js';

/*
 * Static production readiness: everything that can be decided from configuration alone, before
 * any service is contacted. The live checks (Moodle, search, model, state store) are in the
 * api's `preflight` command, which runs these first.
 *
 * Three kinds of finding, because they fail for different reasons:
 *
 * - `configuration`: a feature the production services need is missing or invalid.
 * - `consistency`: each value is individually valid, but two of them disagree — a Teams app
 *   pointing at an audience the API does not accept, say. These are the mistakes that pass every
 *   per-variable check and then fail at sign-in, in front of staff.
 * - `pilotControl`: a setting that must hold for the controlled rollout (docs/pilot-controls in
 *   docs/production-deployment.md), such as mock identity being off.
 *
 * Nothing here reads a secret's value beyond asking whether it is present and not a placeholder,
 * and no finding ever carries a value: findings name variables.
 */

export type FindingKind = 'configuration' | 'consistency' | 'pilotControl';
export type FindingSeverity = 'fail' | 'warn';

export interface ReadinessFinding {
  readonly kind: FindingKind;
  readonly severity: FindingSeverity;
  /** Stable identifier, for the deployment checklist and the release report. */
  readonly id: string;
  /** The variables involved, by name only. */
  readonly variables: readonly string[];
  /** What is wrong and what to do, naming no values. */
  readonly message: string;
}

export interface ProductionReadinessReport {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly findings: readonly ReadinessFinding[];
  /** Features that parsed cleanly, for the evidence trail. */
  readonly configured: readonly ConfigFeature[];
}

/**
 * Which deployment the checks are about. `deployment` is the whole rollout, as the preflight and
 * the deployment checklist see it. `apiService` is what the running answer API itself must get
 * right: it does not need the Teams manifest inputs (a packaging step) or the course selection
 * (the indexer's), so demanding them would stop a correct API from starting.
 */
export type ReadinessScope = 'deployment' | 'apiService' | 'release';

export const READINESS_SCOPES: readonly ReadinessScope[] = ['deployment', 'apiService', 'release'];

/** Features every production deployment of the assistant needs. */
export const PRODUCTION_REQUIRED_FEATURES: readonly ConfigFeature[] = [
  'runtime',
  'moodle',
  'azureSearch',
  'azureOpenAI',
  'retrieval',
  'embeddings',
  'chat',
  'sync',
  'apiServer',
  'entraAuth',
  'authorization',
  'teams',
  'observability',
];
// `teamsManifest` is deliberately not here. Those variables are packaging inputs: the deployed
// containers never receive them (infrastructure/bicep/main.bicep), so requiring them would make
// `pnpm preflight` fail inside the very environment it is meant to check. They are checked where
// they exist, by the `release` scope and by `pnpm teams:validate`.

/**
 * Values that look like configuration but are the examples from .env.example, or obvious
 * stand-ins. A deployment that reached production with one of these has an unset secret
 * reference, which would otherwise show up as a puzzling authentication failure.
 */
const PLACEHOLDERS: readonly string[] = [
  'changeme',
  'change-me',
  'placeholder',
  'replace-me',
  'example',
  'your-token-here',
  'todo',
  'xxx',
  '00000000-0000-0000-0000-000000000000',
];

/** Secrets Key Vault supplies to the deployed services (docs/configuration-reference.md). */
/** How long before a recorded Moodle token expiry the preflight starts warning. */
export const TOKEN_EXPIRY_WARNING_DAYS = 30;

export const PRODUCTION_SECRET_VARIABLES: readonly string[] = [
  'MOODLE_TOKEN',
  'TEAMS_BOT_CLIENT_SECRET',
];

/** Features and secrets the answer API itself needs; the rest belong to other components. */
export const API_SERVICE_FEATURES: readonly ConfigFeature[] = [
  'runtime',
  'moodle',
  'azureSearch',
  'azureOpenAI',
  'retrieval',
  'embeddings',
  'chat',
  'apiServer',
  'entraAuth',
  'authorization',
];

/** Settings a release can be checked against without holding any secret. */
export const RELEASE_FEATURES: readonly ConfigFeature[] = ['runtime', 'teamsManifest'];

/** Pilot controls that bypass authentication, so the API refuses to start with any of them on. */
const AUTH_BYPASS_FLAGS: readonly string[] = [
  'API_DEV_MOCK_IDENTITY',
  'TEAMS_DEV_MOCK_IDENTITY',
  'TEAMS_DEV_ALLOW_UNAUTHENTICATED',
];

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') {
    return true;
  }
  return PLACEHOLDERS.some((placeholder) => normalized === placeholder);
}

function read(env: EnvironmentSource, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function isTrue(value: string | undefined): boolean {
  return value !== undefined && ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

function listOf(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== '');
}

function hostOf(value: string | undefined): string | undefined {
  if (value === undefined || !URL.canParse(value)) {
    return undefined;
  }
  return new URL(value).host.toLowerCase();
}

function configurationFindings(
  env: EnvironmentSource,
  features: readonly ConfigFeature[],
): {
  readonly findings: ReadinessFinding[];
  readonly configured: ConfigFeature[];
} {
  const clean = cleanEnvironment(env);
  const findings: ReadinessFinding[] = [];
  const configured: ConfigFeature[] = [];
  for (const feature of features) {
    const parsed = CONFIG_FEATURES[feature].safeParse(clean);
    if (parsed.success) {
      configured.push(feature);
      continue;
    }
    const variables = [
      ...new Set(
        parsed.error.issues.map((issue) =>
          issue.path.length === 0 ? '(feature)' : String(issue.path[0]),
        ),
      ),
    ].sort();
    findings.push({
      kind: 'configuration',
      severity: 'fail',
      id: `config.${feature}`,
      variables,
      message: `${feature}: configuration is missing or invalid. Production needs this feature.`,
    });
  }
  return { findings, configured };
}

function secretFindings(env: EnvironmentSource, names: readonly string[]): ReadinessFinding[] {
  return names.flatMap((name) => {
    const value = env[name];
    if (value === undefined) {
      return [
        {
          kind: 'configuration' as const,
          severity: 'fail' as const,
          id: `secret.${name}.missing`,
          variables: [name],
          message: `${name} is not set. In Azure it comes from Key Vault through the container app's secret reference, so an empty value means the reference or the managed identity's access to the vault is wrong (docs/production-deployment.md).`,
        },
      ];
    }
    return isPlaceholder(value)
      ? [
          {
            kind: 'configuration' as const,
            severity: 'fail' as const,
            id: `secret.${name}.placeholder`,
            variables: [name],
            message: `${name} still holds a placeholder value. Set the real secret in Key Vault and redeploy.`,
          },
        ]
      : [];
  });
}

function consistencyFindings(env: EnvironmentSource): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  const add = (
    id: string,
    variables: readonly string[],
    message: string,
    severity: FindingSeverity = 'fail',
  ): void => {
    findings.push({ kind: 'consistency', severity, id, variables, message });
  };

  const appIdUri = read(env, 'ENTRA_API_APP_ID_URI');
  const ssoResource = read(env, 'TEAMS_SSO_RESOURCE');
  const apiScope = read(env, 'ENTRA_API_SCOPE');
  // The bot asks Entra for a token for TEAMS_SSO_RESOURCE; the API accepts tokens whose audience
  // is ENTRA_API_APP_ID_URI (or its client ID). If they disagree, every sign-in fails with an
  // audience error that looks like a Teams problem.
  if (appIdUri !== undefined && ssoResource !== undefined) {
    const expected = apiScope === undefined ? appIdUri : `${appIdUri}/${apiScope}`;
    if (ssoResource !== appIdUri && ssoResource !== expected) {
      add(
        'entra.ssoResource',
        ['TEAMS_SSO_RESOURCE', 'ENTRA_API_APP_ID_URI', 'ENTRA_API_SCOPE'],
        "The resource the bot requests a token for is neither the API's application ID URI nor that URI with ENTRA_API_SCOPE appended, so the API will reject every token as the wrong audience.",
      );
    }
  }

  const botClientId = read(env, 'TEAMS_BOT_CLIENT_ID')?.toLowerCase();
  const allowedClients = listOf(read(env, 'ENTRA_ALLOWED_CLIENT_APP_IDS'));
  if (
    botClientId !== undefined &&
    allowedClients.length > 0 &&
    !allowedClients.includes(botClientId)
  ) {
    add(
      'entra.allowedClient',
      ['ENTRA_ALLOWED_CLIENT_APP_IDS', 'TEAMS_BOT_CLIENT_ID'],
      "The bot's client ID is not in the API's list of allowed client applications, so the API will refuse tokens issued to the bot.",
    );
  }

  const botTenant = read(env, 'TEAMS_BOT_TENANT_ID')?.toLowerCase();
  const allowedTenants = listOf(read(env, 'ENTRA_ALLOWED_TENANT_IDS'));
  if (botTenant !== undefined && allowedTenants.length > 0 && !allowedTenants.includes(botTenant)) {
    add(
      'entra.allowedTenant',
      ['ENTRA_ALLOWED_TENANT_IDS', 'TEAMS_BOT_TENANT_ID'],
      "The bot's tenant is not in the API's allowed tenant list, so tokens from the staff tenant will be refused.",
    );
  }

  const apiClientId = read(env, 'ENTRA_API_CLIENT_ID')?.toLowerCase();
  if (apiClientId !== undefined && botClientId !== undefined && apiClientId === botClientId) {
    add(
      'entra.separateRegistrations',
      ['ENTRA_API_CLIENT_ID', 'TEAMS_BOT_CLIENT_ID'],
      'The API and the bot are registered as the same application. The bot must be its own registration so the API can tell callers apart (docs/entra-sso.md).',
    );
  }

  const apiBase = read(env, 'TEAMS_API_BASE_URL');
  if (apiBase !== undefined && URL.canParse(apiBase) && new URL(apiBase).protocol !== 'https:') {
    add(
      'teams.apiBaseUrl',
      ['TEAMS_API_BASE_URL'],
      'The bot reaches the answer API over plain HTTP. Use https in production.',
    );
  }

  const moodleHost = hostOf(read(env, 'MOODLE_BASE_URL'));
  const linkHosts = listOf(read(env, 'TEAMS_ALLOWED_LINK_HOSTS'));
  if (moodleHost !== undefined && linkHosts.length > 0 && !linkHosts.includes(moodleHost)) {
    // Citation links are rendered only for allowed hosts, so a mismatch silently strips every
    // "Open in E-Hub" button and makes answers unverifiable.
    add(
      'teams.linkHosts',
      ['TEAMS_ALLOWED_LINK_HOSTS', 'MOODLE_BASE_URL'],
      'The Moodle host is not in the Teams allowed link hosts, so citation links will not be shown.',
    );
  }

  const manifestApp = read(env, 'TEAMS_APP_ID')?.toLowerCase();
  if (manifestApp !== undefined && botClientId !== undefined && manifestApp === botClientId) {
    add(
      'teams.appId',
      ['TEAMS_APP_ID', 'TEAMS_BOT_CLIENT_ID'],
      'The Teams app ID and the bot client ID are the same value. They are different identifiers; reusing one makes the uploaded package point at the wrong application.',
      'warn',
    );
  }

  const adminSpa = read(env, 'ADMIN_SPA_CLIENT_ID')?.toLowerCase();
  if (isTrue(read(env, 'ADMIN_UI_ENABLED')) && adminSpa === undefined) {
    add(
      'admin.spaClientId',
      ['ADMIN_UI_ENABLED', 'ADMIN_SPA_CLIENT_ID'],
      'The administration area is enabled but has no SPA client ID, so nobody can sign in to it.',
    );
  }

  return findings;
}

function pilotFindings(
  env: EnvironmentSource,
  now: Date,
  scope: ReadinessScope,
): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  const add = (
    id: string,
    variables: readonly string[],
    message: string,
    severity: FindingSeverity = 'fail',
  ): void => {
    findings.push({ kind: 'pilotControl', severity, id, variables, message });
  };

  for (const name of AUTH_BYPASS_FLAGS) {
    if (isTrue(read(env, name))) {
      add(
        `pilot.${name}`,
        [name],
        `${name} is on. It bypasses Entra sign-in and must be off outside development.`,
      );
    }
  }

  if (scope !== 'deployment') {
    // The remaining controls are about the rollout, not about one process or one build: the API
    // can serve correctly, and a package can be correct, while the indexer's course selection,
    // the telemetry wiring or the token's recorded expiry are still being set up. `pnpm
    // preflight` checks those where the deployed values are.
    return findings;
  }

  const allCourses = isTrue(read(env, 'SYNC_ALL_COURSES'));
  const courseIds = listOf(read(env, 'SYNC_COURSE_IDS'));
  if (allCourses) {
    add(
      'pilot.courseSelection',
      ['SYNC_ALL_COURSES', 'SYNC_COURSE_IDS'],
      'Every Moodle course would be indexed. The pilot indexes an approved list only: set SYNC_COURSE_IDS and leave SYNC_ALL_COURSES off.',
    );
  } else if (courseIds.length === 0) {
    add(
      'pilot.courseSelection.empty',
      ['SYNC_COURSE_IDS'],
      'No courses are selected, so there would be nothing to answer from.',
    );
  }

  const expiresOn = read(env, 'MOODLE_TOKEN_EXPIRES_ON');
  if (expiresOn === undefined) {
    add(
      'pilot.tokenExpiry',
      ['MOODLE_TOKEN_EXPIRES_ON'],
      'The Moodle token has no recorded expiry date, so nobody will be warned before it stops working (docs/token-rotation.md).',
      'warn',
    );
  } else {
    const expiry = Date.parse(`${expiresOn}T00:00:00Z`);
    const days = Number.isNaN(expiry)
      ? undefined
      : Math.floor((expiry - now.getTime()) / 86_400_000);
    if (days === undefined) {
      add(
        'pilot.tokenExpiry.invalid',
        ['MOODLE_TOKEN_EXPIRES_ON'],
        'The recorded Moodle token expiry is not a date as YYYY-MM-DD.',
      );
    } else if (days < 0) {
      add(
        'pilot.tokenExpiry.expired',
        ['MOODLE_TOKEN_EXPIRES_ON'],
        'The Moodle token expired on the recorded date. Rotate it before deploying (docs/token-rotation.md).',
      );
    } else if (days <= TOKEN_EXPIRY_WARNING_DAYS) {
      add(
        'pilot.tokenExpiry.soon',
        ['MOODLE_TOKEN_EXPIRES_ON'],
        `The Moodle token expires in ${String(days)} day(s). Rotate it before it stops working (docs/token-rotation.md).`,
        'warn',
      );
    }
  }

  if (read(env, 'APPLICATIONINSIGHTS_CONNECTION_STRING') === undefined) {
    add(
      'pilot.telemetry',
      ['APPLICATIONINSIGHTS_CONNECTION_STRING'],
      'No Application Insights connection string, so there would be no traces or alerts during the pilot.',
    );
  }

  if (isTrue(read(env, 'ADMIN_UI_ENABLED')) && listOf(read(env, 'API_DEV_MOCK_ROLES')).length > 0) {
    add(
      'pilot.mockRoles',
      ['API_DEV_MOCK_ROLES'],
      'Administration roles are being supplied by configuration rather than by the token. Remove API_DEV_MOCK_ROLES.',
    );
  }

  return findings;
}

/**
 * Static production checks. `env` is the deployed environment; nothing is contacted. The caller
 * decides what to do with warnings, but any `fail` finding means the deployment is not ready.
 */
export function checkProductionReadiness(
  env: EnvironmentSource,
  options: { readonly now?: Date; readonly scope?: ReadinessScope } = {},
): ProductionReadinessReport {
  const scope = options.scope ?? 'deployment';
  const features =
    scope === 'apiService'
      ? API_SERVICE_FEATURES
      : scope === 'release'
        ? RELEASE_FEATURES
        : PRODUCTION_REQUIRED_FEATURES;
  const secrets =
    scope === 'apiService'
      ? ['MOODLE_TOKEN']
      : scope === 'release'
        ? []
        : PRODUCTION_SECRET_VARIABLES;
  const { findings: configuration, configured } = configurationFindings(env, features);
  const findings = [
    ...configuration,
    ...secretFindings(env, secrets),
    ...consistencyFindings(env),
    ...pilotFindings(env, options.now ?? new Date(), scope),
  ];
  const status = findings.some((finding) => finding.severity === 'fail')
    ? 'fail'
    : findings.length > 0
      ? 'warn'
      : 'pass';
  return { status, findings, configured };
}

/** Every variable the full application schema knows, for the configuration reference. */
export function applicationVariableNames(): readonly string[] {
  return Object.keys(applicationConfigSchema.shape).sort();
}

export function renderReadinessText(report: ProductionReadinessReport): string {
  if (report.findings.length === 0) {
    return `Production configuration: PASS. ${String(report.configured.length)} features configured, no findings.`;
  }
  const lines = report.findings.map(
    (finding) =>
      `${finding.severity === 'fail' ? '✗' : '!'} ${finding.kind} ${finding.id}\n    ${finding.variables.join(', ')}\n    ${finding.message}`,
  );
  const failures = report.findings.filter((finding) => finding.severity === 'fail').length;
  return [
    `Production configuration: ${report.status.toUpperCase()}. ${String(failures)} failure(s), ${String(report.findings.length - failures)} warning(s).`,
    '',
    ...lines,
  ].join('\n');
}
