import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PRODUCTION_PACKAGE_BLOCKED,
  defaultPaths,
  validateManifest,
  type ManifestPaths,
} from './manifestTool.js';
import { buildPackage } from './packageApp.js';
import { placeholderColorIcon, placeholderOutlineIcon } from './placeholderIcons.js';
import { decodeRgbaPng, encodePng, readPngInfo } from './png.js';

const VARIABLES = {
  TEAMS_APP_ID: '6f1c2b8e-3d4a-4e5f-9a7b-1c2d3e4f5a6b',
  TEAMS_BOT_CLIENT_ID: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  TEAMS_DEVELOPER_NAME: 'Skin Renewal',
  TEAMS_WEBSITE_URL: 'https://www.example.com',
  TEAMS_PRIVACY_URL: 'https://www.example.com/privacy',
  TEAMS_TERMS_URL: 'https://www.example.com/terms',
};

const copies: string[] = [];
afterEach(() => {
  for (const directory of copies.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A writable copy of the real manifest folder, to break one thing at a time. */
function copy(): ManifestPaths & { file: (name: string) => string } {
  const directory = mkdtempSync(join(tmpdir(), 'ehub-manifest-'));
  copies.push(directory);
  const real = defaultPaths();
  cpSync(real.manifestDir, join(directory, 'manifest'), { recursive: true });
  cpSync(real.packageJson, join(directory, 'package.json'));
  return {
    manifestDir: join(directory, 'manifest'),
    packageJson: join(directory, 'package.json'),
    file: (name) => join(directory, 'manifest', name),
  };
}

function editTemplate(
  paths: ReturnType<typeof copy>,
  edit: (manifest: Record<string, unknown>) => void,
): void {
  const path = paths.file('manifest.template.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

describe('Teams manifest', () => {
  it('builds a schema-valid, personal-only development manifest from the variables', () => {
    const result = validateManifest({ environment: 'development', env: VARIABLES });
    expect(result.errors).toEqual([]);
    const manifest = JSON.parse(result.files?.manifestJson ?? '{}') as Record<string, unknown>;
    expect(manifest).toMatchObject({
      manifestVersion: '1.24',
      version: '0.1.0',
      id: VARIABLES.TEAMS_APP_ID,
      name: { short: 'E-Hub Assistant (Dev)' },
      bots: [{ botId: VARIABLES.TEAMS_BOT_CLIENT_ID, scopes: ['personal'], supportsFiles: false }],
      validDomains: ['token.botframework.com'],
      webApplicationInfo: {
        id: VARIABLES.TEAMS_BOT_CLIENT_ID,
        resource: `api://botid-${VARIABLES.TEAMS_BOT_CLIENT_ID}`,
      },
    });
    expect(result.files?.manifestJson).not.toContain('${{');
    expect(result.warnings.join('\n')).toContain('placeholder icons');
  });

  it('blocks production until course access from enrolments exists', () => {
    const result = validateManifest({ environment: 'production', env: VARIABLES });
    expect(result.errors).toContain(`blocked: ${PRODUCTION_PACKAGE_BLOCKED}`);
  });

  it('lists missing or invalid variables by name only', () => {
    const result = validateManifest({
      environment: 'development',
      env: {
        ...VARIABLES,
        TEAMS_APP_ID: 'not-a-guid',
        TEAMS_PRIVACY_URL: 'http://insecure.example.com',
      },
    });
    expect(result.errors).toEqual([
      'variables: TEAMS_APP_ID is missing or invalid.',
      'variables: TEAMS_PRIVACY_URL is missing or invalid.',
    ]);
    expect(result.files).toBeUndefined();
  });

  it('keeps quotes in values from breaking the JSON', () => {
    const result = validateManifest({
      environment: 'development',
      env: { ...VARIABLES, TEAMS_DEVELOPER_NAME: 'Skin "R" \\ Co' },
    });
    expect(result.errors).toEqual([]);
    expect(
      (JSON.parse(result.files?.manifestJson ?? '{}') as { developer: { name: string } }).developer
        .name,
    ).toBe('Skin "R" \\ Co');
  });

  it('rejects the all-zero placeholder IDs', () => {
    const result = validateManifest({
      environment: 'development',
      env: { ...VARIABLES, TEAMS_APP_ID: '00000000-0000-0000-0000-000000000000' },
    });
    expect(result.errors.join('\n')).toContain('all-zero placeholder');
  });

  it('applies the Microsoft schema', () => {
    const paths = copy();
    editTemplate(paths, (manifest) => {
      manifest['description'] = { short: 'x'.repeat(200), full: 'ok' };
      manifest['unexpectedProperty'] = true;
    });
    const errors = validateManifest({
      environment: 'development',
      env: VARIABLES,
      paths,
    }).errors.join('\n');
    expect(errors).toContain('schema: /description/short');
    expect(errors).toContain('schema: / must NOT have additional properties');
  });

  it('refuses team or group chat scopes, other capabilities and wildcard domains', () => {
    const paths = copy();
    editTemplate(paths, (manifest) => {
      const bots = manifest['bots'] as Record<string, unknown>[];
      bots[0]!['scopes'] = ['personal', 'team'];
      manifest['composeExtensions'] = [];
      manifest['validDomains'] = ['*.example.com', 'token.botframework.com'];
    });
    const errors = validateManifest({
      environment: 'development',
      env: VARIABLES,
      paths,
    }).errors.join('\n');
    expect(errors).toContain('personal scope only');
    expect(errors).toContain('"composeExtensions" is outside');
    expect(errors).toContain('wildcards');
  });

  it('requires single sign-on wired to the bot registration', () => {
    const paths = copy();
    editTemplate(paths, (manifest) => {
      manifest['webApplicationInfo'] = {
        id: VARIABLES.TEAMS_APP_ID,
        resource: 'api://example.com/x',
      };
      manifest['validDomains'] = [];
    });
    const errors = validateManifest({ environment: 'development', env: VARIABLES, paths }).errors;
    expect(errors).toContain('policy: webApplicationInfo.id must be TEAMS_BOT_CLIENT_ID.');
    expect(errors).toContain('policy: webApplicationInfo.resource must be TEAMS_SSO_RESOURCE.');
    expect(errors).toContain(
      'policy: validDomains must include token.botframework.com for the sign-in card.',
    );
    editTemplate(paths, (manifest) => {
      Reflect.deleteProperty(manifest, 'webApplicationInfo');
    });
    expect(
      validateManifest({ environment: 'development', env: VARIABLES, paths }).errors,
    ).toContain('policy: webApplicationInfo is required for single sign-on.');
  });

  it('uses TEAMS_SSO_RESOURCE when set, and warns when it does not name the bot', () => {
    const custom = `api://ehub.example.com/botid-${VARIABLES.TEAMS_BOT_CLIENT_ID}`;
    const result = validateManifest({
      environment: 'development',
      env: { ...VARIABLES, TEAMS_SSO_RESOURCE: custom },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).not.toContain('sso:');
    expect(
      (
        JSON.parse(result.files?.manifestJson ?? '{}') as {
          webApplicationInfo: { resource: string };
        }
      ).webApplicationInfo.resource,
    ).toBe(custom);
    const other = validateManifest({
      environment: 'development',
      env: { ...VARIABLES, TEAMS_SSO_RESOURCE: 'api://something-else' },
    });
    expect(other.errors).toEqual([]);
    expect(other.warnings.join('\n')).toContain('sso: TEAMS_SSO_RESOURCE is not');
    expect(
      validateManifest({
        environment: 'development',
        env: { ...VARIABLES, TEAMS_SSO_RESOURCE: 'https://not-an-api-uri' },
      }).errors,
    ).toEqual(['variables: TEAMS_SSO_RESOURCE is missing or invalid.']);
  });

  it('refuses secrets in the manifest', () => {
    const paths = copy();
    editTemplate(paths, (manifest) => {
      manifest['developer'] = {
        name: '${{TEAMS_DEVELOPER_NAME}}',
        websiteUrl: 'https://www.example.com/?token=abcdefgh12345678',
        privacyUrl: '${{TEAMS_PRIVACY_URL}}',
        termsOfUseUrl: '${{TEAMS_TERMS_URL}}',
      };
    });
    const leaked = validateManifest({
      environment: 'development',
      env: {
        ...VARIABLES,
        MOODLE_TOKEN: 'supersecretmoodletoken0123',
        TEAMS_DEVELOPER_NAME: 'supersecretmoodletoken0123',
      },
      paths,
    }).errors.join('\n');
    expect(leaked).toContain('value of MOODLE_TOKEN');
    expect(leaked).toContain('credential-like parameter');
  });

  it('reports unknown placeholders', () => {
    const paths = copy();
    writeFileSync(
      paths.file('manifest.template.json'),
      readFileSync(paths.file('manifest.template.json'), 'utf8').replace(
        '"validDomains": ["token.botframework.com"]',
        '"validDomains": ["token.botframework.com", "${{BOT_DOMAIN}}"]',
      ),
    );
    expect(validateManifest({ environment: 'development', env: VARIABLES, paths }).errors).toEqual([
      'template: unknown placeholder BOT_DOMAIN.',
    ]);
  });

  it('checks icon sizes, transparency and outline colours', () => {
    const paths = copy();
    writeFileSync(paths.file('color.png'), placeholderOutlineIcon());
    const pixels = new Uint8Array(32 * 32 * 4).fill(255);
    pixels.set([255, 0, 0, 255], 0);
    writeFileSync(paths.file('outline.png'), encodePng({ width: 32, height: 32, pixels }));
    const errors = validateManifest({
      environment: 'development',
      env: VARIABLES,
      paths,
    }).errors.join('\n');
    expect(errors).toContain('color.png must be 192×192');
    expect(errors).toContain('only white');
    writeFileSync(paths.file('outline.png'), 'not a png');
    expect(
      validateManifest({ environment: 'development', env: VARIABLES, paths }).errors.join('\n'),
    ).toContain('outline.png is not a readable PNG');
  });

  it('stops warning about placeholders once real icons are in place', () => {
    const paths = copy();
    writeFileSync(paths.file('color.png'), placeholderColorIcon([0, 128, 0, 255]));
    const pixels = new Uint8Array(32 * 32 * 4);
    pixels.set([255, 255, 255, 128], 0);
    writeFileSync(paths.file('outline.png'), encodePng({ width: 32, height: 32, pixels }));
    const result = validateManifest({ environment: 'development', env: VARIABLES, paths });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('placeholder icons and PNG handling', () => {
  it('generates valid, deterministic icons', () => {
    expect(readPngInfo(placeholderColorIcon())).toMatchObject({
      width: 192,
      height: 192,
      colorType: 6,
    });
    const outline = decodeRgbaPng(placeholderOutlineIcon());
    expect(outline?.width).toBe(32);
    const alphas = new Set<number>();
    for (let index = 3; index < (outline?.pixels.length ?? 0); index += 4) {
      alphas.add(outline?.pixels[index] ?? -1);
    }
    expect([...alphas].sort()).toEqual([0, 255]);
    expect(placeholderColorIcon().equals(placeholderColorIcon())).toBe(true);
    expect(
      readFileSync(join(defaultPaths().manifestDir, 'color.png')).equals(placeholderColorIcon()),
    ).toBe(true);
  });

  it('round-trips pixels through every PNG filter the decoder supports', () => {
    const pixels = Uint8Array.from({ length: 4 * 4 * 4 }, (_, index) => (index * 37) % 256);
    expect(decodeRgbaPng(encodePng({ width: 4, height: 4, pixels }))?.pixels).toEqual(pixels);
  });
});

describe('app package', () => {
  it('zips exactly manifest.json and the icons, reproducibly', () => {
    const result = validateManifest({ environment: 'development', env: VARIABLES });
    if (result.files === undefined) {
      throw new Error('no files');
    }
    const first = buildPackage(result.files);
    expect(buildPackage(result.files).equals(first)).toBe(true);
    const names: string[] = [];
    let offset = 0;
    while (first.readUInt32LE(offset) === 0x04034b50) {
      const method = first.readUInt16LE(offset + 8);
      const compressed = first.readUInt32LE(offset + 18);
      const nameLength = first.readUInt16LE(offset + 26);
      const extraLength = first.readUInt16LE(offset + 28);
      const name = first.toString('utf8', offset + 30, offset + 30 + nameLength);
      names.push(name);
      const data = first.subarray(
        offset + 30 + nameLength + extraLength,
        offset + 30 + nameLength + extraLength + compressed,
      );
      if (name === 'manifest.json') {
        const text = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
        expect(JSON.parse(text)).toMatchObject({ id: VARIABLES.TEAMS_APP_ID });
      }
      offset += 30 + nameLength + extraLength + compressed;
    }
    expect(names).toEqual(['manifest.json', 'color.png', 'outline.png']);
  });
});
