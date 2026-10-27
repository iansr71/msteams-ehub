import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';

import { EXTRACTION_DEFAULTS } from '@ehub/shared';

import type { ContentItemRole } from '../../moodle/models.js';
import { Deadline } from '../deadline.js';
import type {
  ExtractionInput,
  ExtractionLimits,
  ExtractionResource,
  ExtractorContext,
} from '../types.js';

export function loadBinary(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url)));
}

export function testLimits(overrides: Partial<ExtractionLimits> = {}): ExtractionLimits {
  return {
    maxInputBytes: EXTRACTION_DEFAULTS.maxInputBytes,
    maxTextChars: EXTRACTION_DEFAULTS.maxTextChars,
    timeoutMs: 30_000,
    maxArchiveEntries: EXTRACTION_DEFAULTS.maxArchiveEntries,
    maxUncompressedBytes: EXTRACTION_DEFAULTS.maxUncompressedBytes,
    maxEntryBytes: 100 * 1024 * 1024,
    maxCompressionRatio: 200,
    maxXmlDepth: 256,
    ...overrides,
  };
}

export function testContext(overrides: Partial<ExtractionLimits> = {}): ExtractorContext {
  const limits = testLimits(overrides);
  return { limits, deadline: new Deadline(limits.timeoutMs), signal: new AbortController().signal };
}

export function testResource(
  role: ContentItemRole = 'primary',
  overrides: Partial<ExtractionResource> = {},
): ExtractionResource {
  return {
    resourceId: '501:file:/document',
    courseId: 12,
    courseName: 'Consultation Standards',
    sectionId: 101,
    sectionName: 'General',
    moduleId: 501,
    moduleName: 'Consultation checklist',
    resourceName: 'document',
    fileName: 'document',
    mimeType: undefined,
    sourceUrl:
      'https://ehub.example.test/webservice/pluginfile.php/5501/mod_resource/content/3/document',
    moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=501',
    timeModified: '2025-06-15T15:15:00.000Z',
    role,
    ...overrides,
  };
}

export function input(bytes: Uint8Array | string, declaredContentType?: string): ExtractionInput {
  return {
    bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
    declaredContentType,
    lastModified: undefined,
  };
}

export interface RawZipEntry {
  readonly name: string;
  readonly data: Uint8Array | string;
  /** Store uncompressed instead of deflating. */
  readonly store?: boolean;
  /** Override the uncompressed size written to the headers (to simulate lying archives). */
  readonly declaredSize?: number;
  /** Set the "encrypted" general-purpose flag. */
  readonly encryptedFlag?: boolean;
}

/**
 * Builds a ZIP byte-for-byte. Unlike archiving libraries, this writes whatever names and sizes
 * it is given, which is needed to test traversal, lying headers and decompression bombs.
 */
export function buildZip(entries: readonly RawZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(
      typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data,
    );
    const compressed = entry.store === true ? raw : deflateRawSync(raw);
    const method = entry.store === true ? 0 : 8;
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.declaredSize ?? raw.length;
    const checksum = crc32(raw);
    const flags = (entry.encryptedFlag === true ? 0x1 : 0) | 0x800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const WORD_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

export const ROOT_RELS_DOCX = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** A minimal Word package around a hand-written body. */
export function minimalDocx(
  bodyXml: string,
  extra: readonly RawZipEntry[] = [],
  contentTypes = CONTENT_TYPES_DOCX,
): Uint8Array {
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: ROOT_RELS_DOCX },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${WORD_NS}><w:body>${bodyXml}</w:body></w:document>`,
    },
    ...extra,
  ]);
}

const PRESENTATION_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

export interface MinimalSlide {
  readonly title?: string;
  readonly body?: readonly string[];
  readonly hidden?: boolean;
  readonly tableRows?: readonly (readonly string[])[];
  readonly notes?: string;
}

function shape(text: readonly string[], placeholderType?: string): string {
  const ph =
    placeholderType === undefined ? '<p:ph idx="1"/>' : `<p:ph type="${placeholderType}"/>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody>${text
    .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`;
}

/**
 * A minimal PowerPoint package. `fileOrder` lets the slide part names differ from the
 * presentation order, to prove order comes from p:sldIdLst.
 */
export function minimalPptx(
  slides: readonly MinimalSlide[],
  fileOrder?: readonly number[],
): Uint8Array {
  const order = fileOrder ?? slides.map((_slide, index) => index + 1);
  const entries: RawZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${PRESENTATION_NS}><p:sldIdLst>${slides
        .map(
          (_slide, index) =>
            `<p:sldId id="${String(256 + index)}" r:id="rId${String(index + 10)}"/>`,
        )
        .join('')}</p:sldIdLst></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
        .map(
          (_slide, index) =>
            `<Relationship Id="rId${String(index + 10)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${String(order[index] ?? index + 1)}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/tracker" TargetMode="External"/></Relationships>`,
    },
  ];
  slides.forEach((slide, index) => {
    const fileNumber = order[index] ?? index + 1;
    const table =
      slide.tableRows === undefined
        ? ''
        : `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${slide.tableRows
            .map(
              (row) =>
                `<a:tr>${row.map((cell) => `<a:tc><a:txBody><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`).join('')}</a:tr>`,
            )
            .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    entries.push({
      name: `ppt/slides/slide${String(fileNumber)}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8"?><p:sld ${PRESENTATION_NS}${slide.hidden === true ? ' show="0"' : ''}><p:cSld><p:spTree>${
        slide.body === undefined ? '' : shape(slide.body)
      }${slide.title === undefined ? '' : shape([slide.title], 'title')}${table}</p:spTree></p:cSld></p:sld>`,
    });
    if (slide.notes !== undefined) {
      entries.push(
        {
          name: `ppt/slides/_rels/slide${String(fileNumber)}.xml.rels`,
          data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${String(fileNumber)}.xml"/></Relationships>`,
        },
        {
          name: `ppt/notesSlides/notesSlide${String(fileNumber)}.xml`,
          data: `<?xml version="1.0" encoding="UTF-8"?><p:notes ${PRESENTATION_NS}><p:cSld><p:spTree>${shape(['1'], 'sldNum')}${shape([slide.notes], 'body')}</p:spTree></p:cSld></p:notes>`,
        },
      );
    }
  });
  return buildZip(entries);
}
