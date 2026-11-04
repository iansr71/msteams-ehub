import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import type { ManifestFiles } from './manifestTool.js';

/*
 * A minimal ZIP writer (deflate, no directories, no ZIP64) for the three-file Teams package.
 * A fixed timestamp keeps packages byte-identical for identical inputs.
 */

// 2026-01-01 00:00:00 in MS-DOS date/time format.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

interface Entry {
  readonly name: Buffer;
  readonly crc: number;
  readonly size: number;
  readonly data: Buffer;
  readonly offset: number;
}

function header(size: number): Buffer {
  return Buffer.alloc(size);
}

export function buildZip(
  files: readonly { readonly name: string; readonly content: Buffer }[],
): Buffer {
  const parts: Buffer[] = [];
  const entries: Entry[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = deflateRawSync(file.content, { level: 9 });
    const crc = crc32(file.content);
    const local = header(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    entries.push({ name, crc, size: file.content.length, data, offset });
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  for (const entry of entries) {
    const central = header(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: regular file 644
    central.writeUInt32LE(entry.offset, 42);
    parts.push(central, entry.name);
    offset += central.length + entry.name.length;
  }
  const end = header(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/** The Teams app package: manifest.json and the two icons at the root of a zip file. */
export function buildPackage(files: ManifestFiles): Buffer {
  return buildZip([
    { name: 'manifest.json', content: Buffer.from(files.manifestJson, 'utf8') },
    { name: 'color.png', content: files.colorIcon },
    { name: 'outline.png', content: files.outlineIcon },
  ]);
}

export function writePackage(directory: string, fileName: string, bytes: Buffer): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  writeFileSync(path, bytes);
  return path;
}
