import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_REQUIRED_FEATURES,
  checkProductionReadiness,
  renderReadinessText,
  type ReadinessFinding,
} from './productionReadiness.js';

/*
 * These checks decide whether a deployment is called ready, so each rule is tested on its own.
 * The mistakes they exist to catch (a Teams app asking for an audience the API will not accept,
 * mock identity left on) all pass every per-variable check and then fail in front of staff.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const API_CLIENT = '22222222-2222-4222-8222-222222222222';
const BOT_CLIENT = '33333333-3333-4333-8333-333333333333';
const APP_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-12T00:00:00.000Z');

/** A production environment with nothing wrong with it. */
function productionEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    MOODLE_BASE_URL: 'https://ehub.example.test',
    MOODLE_TOKEN: 'moodle-token-0123456789abcdef',
    MOODLE_TOKEN_EXPIRES_ON: '2027-06-30',
    AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
    AZURE_SEARCH_INDEX_NAME: 'ehub-course-content-v1',
    AZURE_SEARCH_API_KEY: undefined,
    AZURE_OPENAI_ENDPOINT: 'https://openai.example.test',
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
    AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
    AZURE_TENANT_ID: TENANT,
    SYNC_COURSE_IDS: '12,13',
    ENTRA_ALLOWED_TENANT_IDS: TENANT,
    ENTRA_API_CLIENT_ID: API_CLIENT,
    ENTRA_API_APP_ID_URI: `api://${API_CLIENT}`,
    ENTRA_API_SCOPE: 'access_as_user',
    ENTRA_ALLOWED_CLIENT_APP_IDS: BOT_CLIENT,
    TEAMS_SSO_RESOURCE: `api://${API_CLIENT}/access_as_user`,
    TEAMS_BOT_CLIENT_ID: BOT_CLIENT,
    TEAMS_BOT_CLIENT_SECRET: 'bot-secret-value',
    TEAMS_BOT_TENANT_ID: TENANT,
    TEAMS_API_BASE_URL: 'https://api.example.test',
    TEAMS_ALLOWED_LINK_HOSTS: 'ehub.example.test',
    TEAMS_APP_ID: APP_ID,
    TEAMS_DEVELOPER_NAME: 'Skin Renewal',
    TEAMS_WEBSITE_URL: 'https://example.test',
    TEAMS_PRIVACY_URL: 'https://example.test/privacy',
    TEAMS_TERMS_URL: 'https://example.test/terms',
    APPLICATIONINSIGHTS_CONNECTION_STRING:
      'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=https://in.example.test/',
    ...overrides,
  };
}

function check(overrides: Record<string, string | undefined> = {}) {
  return checkProductionReadiness(productionEnv(overrides), { now: NOW });
}

function ids(findings: readonly ReadinessFinding[]): string[] {
  return findings.map((finding) => finding.id);
}

describe('production readiness: a complete environment', () => {
  it('passes, and reports every required feature as configured', () => {
    const report = check();
    expect(report.findings).toEqual([]);
    expect(report.status).toBe('pass');
    expect(report.configured).toEqual([...PRODUCTION_REQUIRED_FEATURES]);
  });

  it('passes on what a deployed container actually holds, with no manifest variables', () => {
    // The containers never receive the Teams manifest inputs, so the deployment scope must not
    // ask for them: otherwise `pnpm preflight` fails in the environment it is checking.
    const deployed = productionEnv({
      TEAMS_APP_ID: undefined,
      TEAMS_DEVELOPER_NAME: undefined,
      TEAMS_WEBSITE_URL: undefined,
      TEAMS_PRIVACY_URL: undefined,
      TEAMS_TERMS_URL: undefined,
      TEAMS_SSO_RESOURCE: undefined,
      TEAMS_ALLOWED_LINK_HOSTS: undefined,
    });
    const report = checkProductionReadiness(deployed, { now: NOW });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe('pass');
  });

  it('accepts the application ID URI itself as the SSO resource', () => {
    expect(check({ TEAMS_SSO_RESOURCE: `api://${API_CLIENT}` }).status).toBe('pass');
  });
});

describe('production readiness: configuration', () => {
  it('fails a required feature that is missing, naming the variable', () => {
    const report = check({ AZURE_SEARCH_ENDPOINT: undefined });
    expect(ids(report.findings)).toContain('config.azureSearch');
    expect(report.findings[0]?.variables).toContain('AZURE_SEARCH_ENDPOINT');
    expect(report.status).toBe('fail');
  });

  it('fails a missing secret, pointing at the Key Vault reference', () => {
    const report = checkProductionReadiness(
      { ...productionEnv(), TEAMS_BOT_CLIENT_SECRET: undefined },
      { now: NOW },
    );
    expect(ids(report.findings)).toContain('secret.TEAMS_BOT_CLIENT_SECRET.missing');
  });

  it('fails a secret still holding a placeholder', () => {
    const report = check({ MOODLE_TOKEN: 'changeme' });
    expect(ids(report.findings)).toContain('secret.MOODLE_TOKEN.placeholder');
  });

  it('never puts a secret value in a finding', () => {
    const report = check({ MOODLE_TOKEN: 'changeme', TEAMS_BOT_CLIENT_SECRET: 'placeholder' });
    expect(JSON.stringify(report)).not.toContain('changeme');
    expect(JSON.stringify(report)).not.toContain('moodle-token-0123456789abcdef');
  });
});

describe('production readiness: consistency', () => {
  it('fails when the bot asks for an audience the API will not accept', () => {
    const report = check({ TEAMS_SSO_RESOURCE: 'api://something-else/access_as_user' });
    expect(ids(report.findings)).toContain('entra.ssoResource');
  });

  it('fails when the bot is not an allowed client application', () => {
    const report = check({ ENTRA_ALLOWED_CLIENT_APP_IDS: API_CLIENT });
    expect(ids(report.findings)).toContain('entra.allowedClient');
  });

  it('fails when the bot tenant is not an allowed tenant', () => {
    const report = check({ TEAMS_BOT_TENANT_ID: '66666666-6666-4666-8666-666666666666' });
    expect(ids(report.findings)).toContain('entra.allowedTenant');
  });

  it('fails when the API and the bot share one app registration', () => {
    const report = check({
      TEAMS_BOT_CLIENT_ID: API_CLIENT,
      ENTRA_ALLOWED_CLIENT_APP_IDS: API_CLIENT,
      TEAMS_APP_ID: APP_ID,
    });
    expect(ids(report.findings)).toContain('entra.separateRegistrations');
  });

  it('fails a plain-HTTP answer API', () => {
    const report = check({ TEAMS_API_BASE_URL: 'http://api.example.test' });
    expect(ids(report.findings)).toContain('teams.apiBaseUrl');
  });

  it('fails when the Moodle host is not an allowed link host, so citations would lose links', () => {
    const report = check({ TEAMS_ALLOWED_LINK_HOSTS: 'elsewhere.example.test' });
    expect(ids(report.findings)).toContain('teams.linkHosts');
  });

  it('warns when the Teams app ID and the bot client ID are the same value', () => {
    const report = check({ TEAMS_APP_ID: BOT_CLIENT });
    const finding = report.findings.find((entry) => entry.id === 'teams.appId');
    expect(finding?.severity).toBe('warn');
    expect(report.status).toBe('warn');
  });

  it('fails an administration area nobody can sign in to', () => {
    const report = check({ ADMIN_UI_ENABLED: 'true' });
    expect(ids(report.findings)).toContain('admin.spaClientId');
  });
});

describe('production readiness: pilot controls', () => {
  it.each([
    ['API_DEV_MOCK_IDENTITY', 'pilot.API_DEV_MOCK_IDENTITY'],
    ['TEAMS_DEV_MOCK_IDENTITY', 'pilot.TEAMS_DEV_MOCK_IDENTITY'],
    ['TEAMS_DEV_ALLOW_UNAUTHENTICATED', 'pilot.TEAMS_DEV_ALLOW_UNAUTHENTICATED'],
  ])('fails when %s is on', (variable, id) => {
    expect(ids(check({ [variable]: 'true' }).findings)).toContain(id);
  });

  it('fails when every course would be indexed instead of the approved list', () => {
    expect(ids(check({ SYNC_ALL_COURSES: 'true' }).findings)).toContain('pilot.courseSelection');
  });

  it('fails when no course is selected at all', () => {
    expect(ids(check({ SYNC_COURSE_IDS: undefined }).findings)).toContain(
      'pilot.courseSelection.empty',
    );
  });

  it('fails without Application Insights, so the pilot would be unobservable', () => {
    expect(ids(check({ APPLICATIONINSIGHTS_CONNECTION_STRING: undefined }).findings)).toContain(
      'pilot.telemetry',
    );
  });

  it('fails when administration roles come from configuration rather than the token', () => {
    const report = check({
      ADMIN_UI_ENABLED: 'true',
      ADMIN_SPA_CLIENT_ID: '77777777-7777-4777-8777-777777777777',
      API_DEV_MOCK_ROLES: 'admin',
    });
    expect(ids(report.findings)).toContain('pilot.mockRoles');
  });
});

describe('production readiness: Moodle token expiry', () => {
  it('warns as the recorded expiry approaches', () => {
    const report = check({ MOODLE_TOKEN_EXPIRES_ON: '2026-11-20' });
    const finding = report.findings.find((entry) => entry.id === 'pilot.tokenExpiry.soon');
    expect(finding?.severity).toBe('warn');
    expect(finding?.message).toContain('8 day(s)');
  });

  it('fails once the token has expired', () => {
    expect(ids(check({ MOODLE_TOKEN_EXPIRES_ON: '2026-11-11' }).findings)).toContain(
      'pilot.tokenExpiry.expired',
    );
  });

  it('warns when no expiry was recorded at all', () => {
    const report = check({ MOODLE_TOKEN_EXPIRES_ON: undefined });
    expect(ids(report.findings)).toContain('pilot.tokenExpiry');
    expect(report.status).toBe('warn');
  });

  it('does not warn while the expiry is far off', () => {
    expect(ids(check({ MOODLE_TOKEN_EXPIRES_ON: '2027-01-01' }).findings)).toEqual([]);
  });
});

describe('production readiness: rendering', () => {
  it('says PASS with a count when there is nothing to report', () => {
    expect(renderReadinessText(check())).toContain('PASS');
  });

  it('lists each finding with its kind, variables and advice', () => {
    const text = renderReadinessText(check({ API_DEV_MOCK_IDENTITY: 'true' }));
    expect(text).toContain('FAIL');
    expect(text).toContain('pilot.API_DEV_MOCK_IDENTITY');
    expect(text).toContain('API_DEV_MOCK_IDENTITY');
  });
});
