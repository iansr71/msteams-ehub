import yauzl, { type Entry, type ZipFile } from 'yauzl';

import type { Deadline } from './deadline.js';
import { ExtractionFailure } from './errors.js';
import type { ExtractionLimits } from './types.js';

/*
 * Bounded, read-only ZIP access for OOXML documents. Entries are listed from the central
 * directory, validated, and read on demand with streaming byte counts. Nothing is ever
 * written to disk, and nested archives are never opened.
 */

export interface SafeZip {
  readonly entryNames: ReadonlySet<string>;
  has(name: string): boolean;
  /** Reads one entry fully, enforcing per-entry, total and compression-ratio limits. */
  read(name: string): Promise<Uint8Array>;
  close(): void;
}

const MAX_NAME_LENGTH = 1024;

/** OOXML part names are relative POSIX-style paths; anything else is refused. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return false;
  }
  if (name.includes('\0') || name.includes('\\')) {
    return false;
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return false;
  }
  const segments = name.split('/');
  return segments.every(
    (segment, index) =>
      segment !== '..' && segment !== '.' && (segment !== '' || index === segments.length - 1),
  );
}

function unsafeEntry(): ExtractionFailure {
  return new ExtractionFailure('unsafe_archive_entry', 'Archive contains an unsafe entry name.');
}

function limitExceeded(message: string): ExtractionFailure {
  return new ExtractionFailure('archive_limit_exceeded', message);
}

function corrupt(): ExtractionFailure {
  return new ExtractionFailure('corrupt', 'Archive structure is invalid.');
}

/** yauzl reports name problems as plain errors; classify them without exposing the text. */
function fromYauzlError(error: unknown): ExtractionFailure {
  if (error instanceof ExtractionFailure) {
    return error;
  }
  const message = error instanceof Error ? error.message : '';
  if (/relative path|absolute path|invalid characters|fileName/i.test(message)) {
    return unsafeEntry();
  }
  if (/encrypt/i.test(message)) {
    return new ExtractionFailure('encrypted', 'Archive entries are encrypted.');
  }
  return corrupt();
}

function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        decodeStrings: true,
        // Otherwise yauzl rewrites backslashes to slashes before our own name check sees them.
        strictFileNames: true,
      },
      (error, zipFile) => {
        if (error !== null) {
          reject(fromYauzlError(error));
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function listEntries(
  zip: ZipFile,
  limits: ExtractionLimits,
  deadline: Deadline,
): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    const fail = (error: unknown): void => {
      zip.removeAllListeners();
      reject(fromYauzlError(error));
    };
    zip.on('entry', (entry: Entry) => {
      try {
        deadline.check();
        if (entries.size >= limits.maxArchiveEntries) {
          throw limitExceeded('Archive has too many entries.');
        }
        if (!isSafeEntryName(entry.fileName) || entries.has(entry.fileName)) {
          throw unsafeEntry();
        }
        entries.set(entry.fileName, entry);
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.on('end', () => {
      zip.removeAllListeners('entry');
      resolve(entries);
    });
    zip.on('error', fail);
    zip.readEntry();
  });
}

export async function openSafeZip(
  bytes: Uint8Array,
  limits: ExtractionLimits,
  deadline: Deadline,
): Promise<SafeZip> {
  const zip = await openZip(bytes);
  let entries: Map<string, Entry>;
  try {
    entries = await listEntries(zip, limits, deadline);
  } catch (error) {
    zip.close();
    throw error;
  }

  let totalRead = 0;
  const names: ReadonlySet<string> = new Set(entries.keys());

  const read = (name: string): Promise<Uint8Array> => {
    const entry = entries.get(name);
    if (entry === undefined) {
      return Promise.reject(corrupt());
    }
    deadline.check();
    if (entry.isEncrypted()) {
      return Promise.reject(new ExtractionFailure('encrypted', 'Archive entries are encrypted.'));
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      return Promise.reject(limitExceeded('Archive entry is too large.'));
    }
    if (totalRead + entry.uncompressedSize > limits.maxUncompressedBytes) {
      return Promise.reject(limitExceeded('Archive expands beyond the decompression limit.'));
    }
    const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
    if (entry.uncompressedSize > 1024 * 1024 && ratio > limits.maxCompressionRatio) {
      return Promise.reject(limitExceeded('Archive entry compression ratio is suspicious.'));
    }

    return new Promise((resolve, reject) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error !== null) {
          reject(fromYauzlError(error));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          // validateEntrySizes also rejects a size mismatch, but only at the end of the stream.
          if (size > entry.uncompressedSize || size > limits.maxEntryBytes) {
            stream.destroy(limitExceeded('Archive entry expands beyond its declared size.'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', (streamError) => {
          reject(fromYauzlError(streamError));
        });
        stream.on('end', () => {
          totalRead += size;
          resolve(new Uint8Array(Buffer.concat(chunks)));
        });
      });
    });
  };

  return {
    entryNames: names,
    has: (name) => names.has(name),
    read,
    close: () => {
      zip.close();
    },
  };
}
