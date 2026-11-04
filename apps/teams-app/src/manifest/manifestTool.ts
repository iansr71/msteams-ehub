import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  SECRET_ENV_KEYS,
  loadConfig,
  teamsManifestConfigSchema,
  type EnvironmentSource,
} from '@ehub/shared';
import AjvDraft04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { z } from 'zod';

import { placeholderColorIcon, placeholderOutlineIcon } from './placeholderIcons.js';
import { decodeRgbaPng, readPngInfo } from './png.js';

/*
 * Builds the Teams app manifest for an environment from manifest/manifest.template.json, then
 * checks it three ways: Microsoft's JSON schema for the manifest version (bundled with
 * @microsoft/app-manifest, so validation works offline), this app's policy (personal scope
 * only, no secrets, SSO not yet), and the icon files.
 */

export const MANIFEST_ENVIRONMENTS = ['development', 'production'] as const;
export type ManifestEnvironment = (typeof MANIFEST_ENVIRONMENTS)[number];

export const PRODUCTION_PACKAGE_BLOCKED =
  'Production packages are blocked until Microsoft Entra ID SSO (phase 13) is implemented: a production app must identify users before it can enforce course access.';

const environmentFileSchema = z.strictObject({
  environment: z.enum(MANIFEST_ENVIRONMENTS),
  appShortName: z.string().min(1).max(30),
  appFullName: z.string().min(1).max(100),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

export interface ManifestPaths {
  readonly manifestDir: string;
  readonly packageJson: string;
}

export function defaultPaths(): ManifestPaths {
  const root = join(dirname(new URL(import.meta.url).pathname), '..', '..');
  return { manifestDir: join(root, 'manifest'), packageJson: join(root, 'package.json') };
}

export interface ManifestFiles {
  readonly manifestJson: string;
  readonly colorIcon: Buffer;
  readonly outlineIcon: Buffer;
}

export interface ValidationResult {
  readonly environment: ManifestEnvironment;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** Present when the manifest could be built. */
  readonly files?: ManifestFiles;
}

const PLACEHOLDER = /\$\{\{([A-Z0-9_]+)\}\}/g;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

let cachedValidator: ((manifest: unknown) => string[]) | undefined;

/** Microsoft's v1.24 schema from @microsoft/app-manifest (no network access needed). */
function schemaValidator(): (manifest: unknown) => string[] {
  if (cachedValidator !== undefined) {
    return cachedValidator;
  }
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve('@microsoft/app-manifest/package.json'));
  // The published schema contains "\a" in a regex, which JavaScript rejects; Microsoft's own
  // loader applies the same substitution.
  const text = readFileSync(
    join(packageDir, 'build', 'json-schemas', 'teams', 'v1.24', 'MicrosoftTeams.schema.json'),
    'utf8',
  ).replace(/\\a/g, '\\x07');
  // CommonJS packages: under Node's ESM loader the class is the `default` export's `default`.
  const ajv = new AjvDraft04.default({ allErrors: true, strictTypes: false, strict: false });
  addFormats.default(ajv, ['uri', 'email', 'regex']);
  const validate = ajv.compile(JSON.parse(text) as object);
  cachedValidator = (manifest) =>
    validate(manifest)
      ? []
      : (validate.errors ?? []).map(
          (error) => `schema: ${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
        );
  return cachedValidator;
}

const ZERO_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

function policyErrors(
  manifest: Record<string, unknown>,
  values: Readonly<Record<string, string>>,
): string[] {
  const errors: string[] = [];
  const bots = Array.isArray(manifest['bots'])
    ? (manifest['bots'] as Record<string, unknown>[])
    : [];
  if (bots.length !== 1) {
    errors.push('policy: exactly one bot is expected.');
  }
  for (const bot of bots) {
    if (JSON.stringify(bot['scopes']) !== '["personal"]') {
      errors.push('policy: the bot must be personal scope only (no team or group chat).');
    }
    if (bot['supportsFiles'] !== false || bot['isNotificationOnly'] !== false) {
      errors.push('policy: the bot must not support files or be notification-only.');
    }
    if (bot['botId'] !== values['TEAMS_BOT_CLIENT_ID']) {
      errors.push('policy: botId must be TEAMS_BOT_CLIENT_ID.');
    }
  }
  for (const key of [
    'configurableTabs',
    'composeExtensions',
    'connectors',
    'webApplicationInfo',
    'authorization',
    'activities',
    'meetingExtensionDefinition',
  ]) {
    if (key in manifest) {
      errors.push(`policy: "${key}" is outside this phase's scope.`);
    }
  }
  const scopes = JSON.stringify(manifest).match(/"scopes":\[[^\]]*\]/g) ?? [];
  if (scopes.some((entry) => entry !== '"scopes":["personal"]')) {
    errors.push('policy: every scope must be "personal".');
  }
  const domains = Array.isArray(manifest['validDomains'])
    ? (manifest['validDomains'] as unknown[])
    : [];
  if (domains.some((domain) => typeof domain !== 'string' || domain.includes('*'))) {
    errors.push('policy: validDomains must not contain wildcards.');
  }
  for (const key of ['TEAMS_APP_ID', 'TEAMS_BOT_CLIENT_ID']) {
    if (ZERO_GUID.test(values[key] ?? '')) {
      errors.push(`policy: ${key} is the all-zero placeholder GUID.`);
    }
  }
  return errors;
}

/** No credential may end up in a package that anyone in the tenant can download. */
function secretErrors(manifestJson: string, env: EnvironmentSource): string[] {
  const errors: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.length >= 8 && manifestJson.includes(value)) {
      errors.push(`secrets: the manifest contains the value of ${key}.`);
    }
  }
  if (/"[^"]*(?:secret|password|apikey|api[-_]key|token)[^"]*"\s*:/i.test(manifestJson)) {
    errors.push('secrets: the manifest has a credential-like property name.');
  }
  if (/(?:wstoken|token|sig|key)=[^"&]{8,}/i.test(manifestJson)) {
    errors.push('secrets: the manifest contains a URL with a credential-like parameter.');
  }
  return errors;
}

function iconErrors(color: Buffer, outline: Buffer): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const info = readPngInfo(color);
    if (info.width !== 192 || info.height !== 192) {
      errors.push(
        `icons: color.png must be 192×192 pixels (is ${String(info.width)}×${String(info.height)}).`,
      );
    }
  } catch {
    errors.push('icons: color.png is not a PNG file.');
  }
  try {
    const info = readPngInfo(outline);
    if (info.width !== 32 || info.height !== 32) {
      errors.push(
        `icons: outline.png must be 32×32 pixels (is ${String(info.width)}×${String(info.height)}).`,
      );
    }
    if (!info.hasAlphaChannel) {
      errors.push('icons: outline.png must have a transparent background (an alpha channel).');
    }
    const image = decodeRgbaPng(outline);
    if (image === undefined) {
      warnings.push(
        'icons: outline.png colours could not be checked (only 8-bit RGBA is read); check it is white on transparent.',
      );
    } else {
      for (let index = 0; index < image.pixels.length; index += 4) {
        const [r, g, b, a] = [
          image.pixels[index],
          image.pixels[index + 1],
          image.pixels[index + 2],
          image.pixels[index + 3],
        ];
        if (a !== 0 && (r !== 255 || g !== 255 || b !== 255)) {
          errors.push(
            'icons: outline.png must contain only white (any opacity) and transparent pixels.',
          );
          break;
        }
      }
    }
  } catch {
    errors.push('icons: outline.png is not a readable PNG file.');
  }
  return { errors, warnings };
}

export interface BuildOptions {
  readonly environment: ManifestEnvironment;
  readonly env: EnvironmentSource;
  readonly paths?: ManifestPaths;
}

/** Builds and validates the manifest; never throws for content problems (they are listed). */
export function validateManifest(options: BuildOptions): ValidationResult {
  const paths = options.paths ?? defaultPaths();
  const errors: string[] = [];
  const warnings: string[] = [];
  const { environment } = options;

  if (environment === 'production') {
    errors.push(`blocked: ${PRODUCTION_PACKAGE_BLOCKED}`);
  }

  const environmentFile = environmentFileSchema.safeParse(
    readJson(join(paths.manifestDir, 'environments', `${environment}.json`)),
  );
  if (!environmentFile.success) {
    return {
      environment,
      errors: [...errors, `environment: manifest/environments/${environment}.json is invalid.`],
      warnings,
    };
  }
  if (environmentFile.data.environment !== environment) {
    errors.push(
      `environment: manifest/environments/${environment}.json names a different environment.`,
    );
  }

  const variables = teamsManifestConfigSchema.safeParse(options.env);
  if (!variables.success) {
    const names = [...new Set(variables.error.issues.map((issue) => String(issue.path[0])))];
    return {
      environment,
      errors: [...errors, ...names.map((name) => `variables: ${name} is missing or invalid.`)],
      warnings,
    };
  }
  // Re-validated through the shared loader so values are cleaned exactly as at runtime.
  const config = loadConfig(teamsManifestConfigSchema, options.env);
  const version = z
    .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) })
    .parse(readJson(paths.packageJson)).version;
  const values: Record<string, string> = {
    APP_VERSION: version,
    TEAMS_APP_ID: config.TEAMS_APP_ID,
    TEAMS_BOT_CLIENT_ID: config.TEAMS_BOT_CLIENT_ID,
    TEAMS_DEVELOPER_NAME: config.TEAMS_DEVELOPER_NAME,
    TEAMS_WEBSITE_URL: config.TEAMS_WEBSITE_URL,
    TEAMS_PRIVACY_URL: config.TEAMS_PRIVACY_URL,
    TEAMS_TERMS_URL: config.TEAMS_TERMS_URL,
    APP_SHORT_NAME: environmentFile.data.appShortName,
    APP_FULL_NAME: environmentFile.data.appFullName,
    ACCENT_COLOR: environmentFile.data.accentColor,
  };

  const template = readFileSync(join(paths.manifestDir, 'manifest.template.json'), 'utf8');
  const unknown = [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1] ?? '')
    .filter((name) => !(name in values));
  if (unknown.length > 0) {
    return {
      environment,
      errors: [
        ...errors,
        ...[...new Set(unknown)].map((name) => `template: unknown placeholder ${name}.`),
      ],
      warnings,
    };
  }
  // Values are inserted as JSON string content, so quotes or backslashes cannot break out.
  const manifestJson = template.replace(PLACEHOLDER, (_match, name: string) =>
    JSON.stringify(values[name] ?? '').slice(1, -1),
  );
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  } catch {
    return {
      environment,
      errors: [...errors, 'template: the manifest is not valid JSON after substitution.'],
      warnings,
    };
  }

  errors.push(
    ...schemaValidator()(manifest),
    ...policyErrors(manifest, values),
    ...secretErrors(manifestJson, options.env),
  );

  const colorIcon = readFileSync(join(paths.manifestDir, 'color.png'));
  const outlineIcon = readFileSync(join(paths.manifestDir, 'outline.png'));
  const icons = iconErrors(colorIcon, outlineIcon);
  errors.push(...icons.errors);
  warnings.push(...icons.warnings);
  if (colorIcon.equals(placeholderColorIcon()) || outlineIcon.equals(placeholderOutlineIcon())) {
    warnings.push(
      'icons: the placeholder icons are still in use; replace them before a wider rollout (docs/teams-app.md).',
    );
  }

  return {
    environment,
    errors,
    warnings,
    files: { manifestJson: `${JSON.stringify(manifest, null, 2)}\n`, colorIcon, outlineIcon },
  };
}
