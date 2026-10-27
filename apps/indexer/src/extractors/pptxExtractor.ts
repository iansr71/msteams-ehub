import {
  findMainPart,
  readRelationships,
  readXmlPart,
  type PackageContext,
} from './ooxmlPackage.js';
import { openSafeZip } from './safeZip.js';
import { BlockCollector, normalizeInlineText } from './textNormalization.js';
import type { ContentExtractor, ExtractorOutput } from './types.js';
import { parseXml } from './xml.js';

/*
 * PowerPoint: slides in presentation order (p:sldIdLst), each with its slide number, title as a
 * level-1 heading, body text, tables and speaker notes. Hidden slides are skipped. Media,
 * embedded objects, OLE packages and external links are never opened.
 */

const TITLE_PLACEHOLDERS: ReadonlySet<string> = new Set(['title', 'ctrTitle']);
/** Notes-page placeholders that are page furniture, not notes text. */
const NOTES_FURNITURE: ReadonlySet<string> = new Set(['sldImg', 'sldNum', 'hdr', 'ftr', 'dt']);

interface SlideText {
  hidden: boolean;
  title: string;
  paragraphs: string[];
  rows: string[];
}

function parseSlide(xml: string, pkg: PackageContext, kind: 'slide' | 'notes'): SlideText {
  const slide: SlideText = { hidden: false, title: '', paragraphs: [], rows: [] };
  let placeholder: string | undefined;
  let shapeDepth = 0;
  let paragraph: string | undefined;
  let inText = false;
  let rowCells: string[] | undefined;
  let cell: string | undefined;

  parseXml(
    xml,
    {
      open: (element) => {
        switch (element.name) {
          case 'p:sld':
            slide.hidden = element.attributes['show'] === '0';
            break;
          case 'p:sp':
            shapeDepth += 1;
            placeholder = undefined;
            break;
          case 'p:ph':
            placeholder = element.attributes['type'] ?? 'body';
            break;
          case 'a:tr':
            rowCells = [];
            break;
          case 'a:tc':
            cell = '';
            break;
          case 'a:p':
            paragraph = '';
            break;
          case 'a:t':
            inText = true;
            break;
          case 'a:br':
            if (paragraph !== undefined) {
              paragraph += ' ';
            }
            break;
        }
      },
      close: (name) => {
        switch (name) {
          case 'a:t':
            inText = false;
            break;
          case 'a:p': {
            const text = normalizeInlineText(paragraph ?? '');
            paragraph = undefined;
            if (text === '') {
              break;
            }
            if (cell !== undefined) {
              cell = `${cell} ${text}`;
            } else if (
              kind === 'notes' &&
              placeholder !== undefined &&
              NOTES_FURNITURE.has(placeholder)
            ) {
              // Slide number, header or footer on the notes page.
            } else if (
              kind === 'slide' &&
              placeholder !== undefined &&
              TITLE_PLACEHOLDERS.has(placeholder)
            ) {
              slide.title = slide.title === '' ? text : `${slide.title} ${text}`;
            } else {
              slide.paragraphs.push(text);
            }
            break;
          }
          case 'a:tc':
            if (cell !== undefined && rowCells !== undefined) {
              const text = normalizeInlineText(cell);
              if (text !== '') {
                rowCells.push(text);
              }
            }
            cell = undefined;
            break;
          case 'a:tr':
            if (rowCells !== undefined && rowCells.length > 0) {
              slide.rows.push(rowCells.join(' | '));
            }
            rowCells = undefined;
            break;
          case 'p:sp':
            shapeDepth -= 1;
            if (shapeDepth === 0) {
              placeholder = undefined;
            }
            break;
        }
      },
      text: (text) => {
        if (inText && paragraph !== undefined) {
          paragraph += text;
        }
      },
    },
    { maxDepth: pkg.limits.maxXmlDepth, deadline: pkg.deadline },
  );
  return slide;
}

function slideOrder(xml: string, pkg: PackageContext): string[] {
  const ids: string[] = [];
  parseXml(
    xml,
    {
      open: (element) => {
        if (element.name === 'p:sldId') {
          const id = element.attributes['r:id'];
          if (id !== undefined) {
            ids.push(id);
          }
        }
      },
    },
    { maxDepth: pkg.limits.maxXmlDepth, deadline: pkg.deadline },
  );
  return ids;
}

export const pptxExtractor: ContentExtractor = {
  name: 'pptx',
  version: '1.0.0',
  resourceType: 'pptx',
  supports: ({ contentType }) => contentType === 'pptx',
  extract: async (_candidate, input, context): Promise<ExtractorOutput> => {
    const zip = await openSafeZip(input.bytes, context.limits, context.deadline);
    try {
      const pkg: PackageContext = { zip, limits: context.limits, deadline: context.deadline };
      const presentation = await findMainPart(pkg, 'ppt/presentation.xml');
      const relationships = await readRelationships(pkg, presentation);
      const targets = new Map(
        relationships
          .filter((rel) => rel.type.endsWith('/slide'))
          .map((rel) => [rel.id, rel.target]),
      );
      const order = slideOrder(await readXmlPart(pkg, presentation), pkg);

      const collector = new BlockCollector(context.limits.maxTextChars);
      let hiddenSlides = 0;
      let emptySlides = 0;
      let missingSlides = 0;

      for (const [index, relationshipId] of order.entries()) {
        context.deadline.check();
        const slideNumber = index + 1;
        const part = targets.get(relationshipId);
        if (part === undefined || !zip.has(part)) {
          missingSlides += 1;
          continue;
        }
        const slide = parseSlide(await readXmlPart(pkg, part), pkg, 'slide');
        if (slide.hidden) {
          hiddenSlides += 1;
          continue;
        }

        const notesPart = (await readRelationships(pkg, part)).find((rel) =>
          rel.type.endsWith('/notesSlide'),
        )?.target;
        const notes =
          notesPart !== undefined && zip.has(notesPart)
            ? parseSlide(await readXmlPart(pkg, notesPart), pkg, 'notes').paragraphs
            : [];

        const path = slide.title === '' ? [] : [slide.title];
        if (slide.title === '' && slide.paragraphs.length === 0 && slide.rows.length === 0) {
          emptySlides += 1;
        }
        if (slide.title !== '') {
          collector.add({
            kind: 'heading',
            text: slide.title,
            headingLevel: 1,
            headingPath: [],
            slideNumber,
          });
        }
        for (const text of slide.paragraphs) {
          collector.add({ kind: 'paragraph', text, headingPath: path, slideNumber });
        }
        for (const row of slide.rows) {
          collector.add({ kind: 'table-row', text: row, headingPath: path, slideNumber });
        }
        if (notes.length > 0) {
          collector.add({
            kind: 'speaker-notes',
            text: notes.join(' '),
            headingPath: path,
            slideNumber,
          });
        }
        if (collector.truncated) {
          break;
        }
      }

      const warnings: string[] = [];
      if (hiddenSlides > 0) {
        warnings.push('hidden_slides_skipped');
      }
      if (emptySlides > 0) {
        warnings.push('slides_without_text');
      }
      if (missingSlides > 0) {
        warnings.push('slide_parts_missing');
      }
      if (collector.truncated) {
        warnings.push('text_truncated');
      }
      return { blocks: collector.blocks, warnings };
    } finally {
      zip.close();
    }
  },
};
