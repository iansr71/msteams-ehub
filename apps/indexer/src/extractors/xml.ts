import { SaxesParser } from 'saxes';

import type { Deadline } from './deadline.js';
import { ExtractionFailure } from './errors.js';

export interface XmlElement {
  /** Qualified name as written, e.g. `w:p`. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface XmlHandlers {
  open?(element: XmlElement, depth: number): void;
  close?(name: string, depth: number): void;
  text?(text: string): void;
}

export interface XmlOptions {
  readonly maxDepth: number;
  readonly deadline: Deadline;
}

/** Decodes an OOXML part: UTF-8 by default, UTF-16 when a byte-order mark says so. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

const DEADLINE_CHECK_INTERVAL = 2_000;

/**
 * Streams XML events from an OOXML part. Saxes never fetches external resources and only knows
 * the five predefined entities; DOCTYPE declarations are rejected outright (OOXML never uses
 * them), which rules out entity-expansion attacks.
 */
export function parseXml(text: string, handlers: XmlHandlers, options: XmlOptions): void {
  const parser = new SaxesParser();
  let depth = 0;
  let events = 0;
  let failure: ExtractionFailure | undefined;

  const tick = (): void => {
    events += 1;
    if (events % DEADLINE_CHECK_INTERVAL === 0) {
      options.deadline.check();
    }
  };

  parser.on('doctype', () => {
    throw new ExtractionFailure('corrupt', 'XML part contains a DOCTYPE declaration.');
  });
  parser.on('opentag', (tag) => {
    tick();
    depth += 1;
    if (depth > options.maxDepth) {
      throw new ExtractionFailure('corrupt', 'XML part is nested too deeply.');
    }
    // Without namespace processing saxes reports attribute values as plain strings.
    const attributes: Record<string, string> = { ...tag.attributes };
    handlers.open?.({ name: tag.name, attributes }, depth);
  });
  parser.on('closetag', (tag) => {
    tick();
    handlers.close?.(tag.name, depth);
    depth -= 1;
  });
  parser.on('text', (value) => {
    tick();
    handlers.text?.(value);
  });
  parser.on('cdata', (value) => {
    handlers.text?.(value);
  });
  parser.on('error', () => {
    failure ??= new ExtractionFailure('corrupt', 'XML part is not well formed.');
  });

  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof ExtractionFailure) {
      throw error;
    }
    throw new ExtractionFailure('corrupt', 'XML part is not well formed.');
  }
  if (failure !== undefined) {
    throw failure;
  }
}
