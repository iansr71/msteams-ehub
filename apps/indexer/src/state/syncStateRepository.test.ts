import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TENANT,
  describeSyncStateRepositoryContract,
  sampleState,
} from './__fixtures__/syncStateRepositoryContract.js';
import { FileSyncStateRepository } from './fileSyncStateRepository.js';
import { InMemorySyncStateRepository } from './inMemorySyncStateRepository.js';
import {
  SyncStateConflictError,
  SyncStateCorruptError,
  type Clock,
} from './syncStateRepository.js';

function testClock(): Clock & { advance: (ms: number) => void } {
  let now = Date.parse('2026-03-01T08:00:00.000Z');
  return { now: () => new Date(now), advance: (ms) => (now += ms) };
}

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ehub-sync-state-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describeSyncStateRepositoryContract('InMemorySyncStateRepository', () => {
  const clock = testClock();
  return { repository: new InMemorySyncStateRepository({ clock }), advance: clock.advance };
});

describeSyncStateRepositoryContract('FileSyncStateRepository', () => {
  const clock = testClock();
  const directory = tempDirectory();
  return {
    repository: new FileSyncStateRepository({ directory, clock }),
    advance: clock.advance,
    reopen: () => new FileSyncStateRepository({ directory, clock }),
  };
});

describe('FileSyncStateRepository specifics', () => {
  it('lets exactly one of many concurrent creates succeed', async () => {
    const directory = tempDirectory();
    const handles = Array.from({ length: 8 }, () => new FileSyncStateRepository({ directory }));
    const results = await Promise.allSettled(
      handles.map((handle, index) =>
        handle.saveResource(sampleState({ lastJobId: `job-${String(index)}` }), null),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(SyncStateConflictError);
      }
    }
  });

  it('keeps every write when different resources of a course are saved concurrently', async () => {
    const directory = tempDirectory();
    const repository = new FileSyncStateRepository({ directory });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repository.saveResource(
          sampleState({ resourceId: `${String(index + 1)}:page`, moduleId: index + 1 }),
          null,
        ),
      ),
    );
    expect(await repository.listResources({ tenantId: TENANT })).toHaveLength(12);
  });

  it('refuses to load a damaged state file rather than starting from empty', async () => {
    const directory = tempDirectory();
    const repository = new FileSyncStateRepository({ directory });
    await repository.saveResource(sampleState(), null);
    const file = join(directory, 'resources', TENANT, '12.json');
    writeFileSync(file, '{"version":1,"resources":[{"broken":true}]}');
    await expect(repository.listResources({ tenantId: TENANT })).rejects.toBeInstanceOf(
      SyncStateCorruptError,
    );
    writeFileSync(file, 'not json');
    await expect(
      repository.getResource({ tenantId: TENANT, courseId: 12, resourceId: '601:page' }),
    ).rejects.toBeInstanceOf(SyncStateCorruptError);
  });

  it('breaks a lock left behind by a crashed process', async () => {
    const directory = tempDirectory();
    const repository = new FileSyncStateRepository({ directory });
    const folder = join(directory, 'resources', TENANT);
    mkdirSync(folder, { recursive: true });
    const lock = join(folder, '12.json.lock');
    writeFileSync(lock, '99999');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await repository.saveResource(sampleState(), null);
    expect(await repository.listResources({ tenantId: TENANT })).toHaveLength(1);
  });

  it('writes state files readable by the owner only and holds no lock afterwards', async () => {
    const directory = tempDirectory();
    const repository = new FileSyncStateRepository({ directory });
    await repository.saveResource(sampleState(), null);
    const file = join(directory, 'resources', TENANT, '12.json');
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(() => statSync(`${file}.lock`)).toThrow();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('hashes tenant IDs that are not safe directory names', async () => {
    const directory = tempDirectory();
    const repository = new FileSyncStateRepository({ directory });
    await repository.saveResource(sampleState({ tenantId: 'a:b' }), null);
    expect(await repository.listCourseIds('a:b')).toEqual([12]);
    expect(await repository.listCourseIds(TENANT)).toEqual([]);
  });
});
