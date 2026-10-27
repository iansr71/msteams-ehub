import { describe, expect, it } from 'vitest';

import { buildZip, testLimits } from './__fixtures__/helpers.js';
import { Deadline } from './deadline.js';
import { ExtractionFailure } from './errors.js';
import { isSafeEntryName, openSafeZip } from './safeZip.js';

const deadline = (): Deadline => new Deadline(30_000);

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractionFailure);
    return (error as ExtractionFailure).reason;
  }
  throw new Error('expected failure');
}

describe('isSafeEntryName', () => {
  it.each(['word/document.xml', '[Content_Types].xml', '_rels/.rels', 'ppt/media/', 'a/b/c.xml'])(
    'accepts %s',
    (name) => {
      expect(isSafeEntryName(name)).toBe(true);
    },
  );

  it.each([
    '../evil.xml',
    'word/../../evil.xml',
    '/etc/passwd',
    'C:/Windows/evil.dll',
    'c:evil',
    'word\\..\\evil.xml',
    'word/\0.xml',
    'word//document.xml',
    './word/document.xml',
    '',
    'x'.repeat(1025),
  ])('rejects %j', (name) => {
    expect(isSafeEntryName(name)).toBe(false);
  });
});

describe('openSafeZip', () => {
  it('lists and reads entries', async () => {
    const zip = await openSafeZip(
      buildZip([
        { name: 'a.xml', data: '<a/>' },
        { name: 'dir/b.txt', data: 'hello', store: true },
      ]),
      testLimits(),
      deadline(),
    );
    expect([...zip.entryNames]).toEqual(['a.xml', 'dir/b.txt']);
    expect(new TextDecoder().decode(await zip.read('dir/b.txt'))).toBe('hello');
    zip.close();
  });

  it.each(['../evil.xml', '/abs.xml', 'C:/x.xml', 'a\\b.xml'])(
    'refuses an archive containing the path %j',
    async (name) => {
      expect(
        await failureOf(openSafeZip(buildZip([{ name, data: 'x' }]), testLimits(), deadline())),
      ).toBe('unsafe_archive_entry');
    },
  );

  it('refuses duplicate entry names', async () => {
    const archive = buildZip([
      { name: 'a.xml', data: '1' },
      { name: 'a.xml', data: '2' },
    ]);
    expect(await failureOf(openSafeZip(archive, testLimits(), deadline()))).toBe(
      'unsafe_archive_entry',
    );
  });

  it('limits the number of entries', async () => {
    const archive = buildZip(
      Array.from({ length: 11 }, (_v, i) => ({ name: `f${String(i)}.xml`, data: 'x' })),
    );
    expect(
      await failureOf(openSafeZip(archive, testLimits({ maxArchiveEntries: 10 }), deadline())),
    ).toBe('archive_limit_exceeded');
  });

  it('refuses an entry declared larger than the per-entry limit before inflating it', async () => {
    const zip = await openSafeZip(
      buildZip([{ name: 'big.xml', data: 'x'.repeat(5000) }]),
      testLimits({ maxEntryBytes: 1000 }),
      deadline(),
    );
    expect(await failureOf(zip.read('big.xml'))).toBe('archive_limit_exceeded');
  });

  it('stops at the total decompression budget across entries', async () => {
    const zip = await openSafeZip(
      buildZip([
        { name: 'a.xml', data: 'a'.repeat(3000) },
        { name: 'b.xml', data: 'b'.repeat(3000) },
      ]),
      testLimits({ maxUncompressedBytes: 5000 }),
      deadline(),
    );
    await zip.read('a.xml');
    expect(await failureOf(zip.read('b.xml'))).toBe('archive_limit_exceeded');
  });

  it('refuses a decompression bomb by compression ratio', async () => {
    // 8 MB of zeros deflates to a few KB: ratio far above 200:1.
    const bomb = buildZip([{ name: 'bomb.xml', data: new Uint8Array(8 * 1024 * 1024) }]);
    const zip = await openSafeZip(bomb, testLimits(), deadline());
    expect(await failureOf(zip.read('bomb.xml'))).toBe('archive_limit_exceeded');
  });

  it('catches an entry that inflates beyond its declared size', async () => {
    const lying = buildZip([{ name: 'lie.xml', data: 'x'.repeat(50_000), declaredSize: 100 }]);
    const zip = await openSafeZip(lying, testLimits(), deadline());
    const reason = await failureOf(zip.read('lie.xml'));
    expect(['archive_limit_exceeded', 'corrupt']).toContain(reason);
  });

  it('reports encrypted entries', async () => {
    const zip = await openSafeZip(
      buildZip([{ name: 'secret.xml', data: 'x', encryptedFlag: true }]),
      testLimits(),
      deadline(),
    );
    expect(await failureOf(zip.read('secret.xml'))).toBe('encrypted');
  });

  it('reports a truncated archive as corrupt', async () => {
    const archive = buildZip([{ name: 'a.xml', data: 'hello' }]);
    expect(
      await failureOf(openSafeZip(archive.slice(0, archive.length - 10), testLimits(), deadline())),
    ).toBe('corrupt');
  });

  it('respects the deadline while listing', async () => {
    const expired = new Deadline(0);
    expect(
      await failureOf(openSafeZip(buildZip([{ name: 'a.xml', data: 'x' }]), testLimits(), expired)),
    ).toBe('timeout');
  });
});
