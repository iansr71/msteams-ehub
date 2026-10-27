import {
  findMainPart,
  readRelationships,
  readXmlPart,
  type PackageContext,
} from './ooxmlPackage.js';
import { openSafeZip } from './safeZip.js';
import { BlockCollector, HeadingTracker, normalizeInlineText } from './textNormalization.js';
import type { ContentExtractor, ExtractorOutput } from './types.js';
import { parseXml } from './xml.js';

/*
 * Word documents: body paragraphs, headings (by outline level or heading style), list items and
 * table rows. Headers, footers, comments, tracked deletions, field codes and hidden (vanish)
 * text are not content and are skipped. Embedded objects and external links are never opened.
 */

interface StyleInfo {
  readonly name: string;
  readonly outlineLevel: number | undefined;
  readonly basedOn: string | undefined;
}

function isOn(value: string | undefined): boolean {
  return value === undefined || !['0', 'false', 'off'].includes(value.toLowerCase());
}

function parseStyles(xml: string, context: PackageContext): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  let current:
    | { id: string; name: string; outlineLevel: number | undefined; basedOn: string | undefined }
    | undefined;
  parseXml(
    xml,
    {
      open: (element) => {
        const value = element.attributes['w:val'];
        switch (element.name) {
          case 'w:style': {
            const id = element.attributes['w:styleId'];
            current =
              id === undefined
                ? undefined
                : { id, name: id, outlineLevel: undefined, basedOn: undefined };
            break;
          }
          case 'w:name':
            if (current !== undefined && value !== undefined) {
              current.name = value;
            }
            break;
          case 'w:basedOn':
            if (current !== undefined) {
              current.basedOn = value;
            }
            break;
          case 'w:outlineLvl':
            if (current !== undefined && value !== undefined && /^\d$/.test(value)) {
              current.outlineLevel = Number(value);
            }
            break;
        }
      },
      close: (name) => {
        if (name === 'w:style' && current !== undefined) {
          styles.set(current.id, {
            name: current.name,
            outlineLevel: current.outlineLevel,
            basedOn: current.basedOn,
          });
          current = undefined;
        }
      },
    },
    { maxDepth: context.limits.maxXmlDepth, deadline: context.deadline },
  );
  return styles;
}

/** Heading level 1-6 from paragraph outline level, then style (following basedOn), else none. */
function headingLevel(
  paragraphOutline: number | undefined,
  styleId: string | undefined,
  styles: ReadonlyMap<string, StyleInfo>,
): number | undefined {
  const fromOutline = (outline: number): number | undefined =>
    outline <= 8 ? Math.min(outline + 1, 6) : undefined;
  if (paragraphOutline !== undefined) {
    return fromOutline(paragraphOutline);
  }
  let id = styleId;
  for (let hops = 0; id !== undefined && hops < 10; hops += 1) {
    const style = styles.get(id);
    if (style === undefined) {
      break;
    }
    if (style.outlineLevel !== undefined) {
      return fromOutline(style.outlineLevel);
    }
    const match = /^heading\s*([1-9])$/i.exec(style.name);
    if (match?.[1] !== undefined) {
      return Math.min(Number(match[1]), 6);
    }
    if (/^title$/i.test(style.name)) {
      return 1;
    }
    id = style.basedOn;
  }
  return undefined;
}

function isListStyle(styleId: string | undefined, styles: ReadonlyMap<string, StyleInfo>): boolean {
  const name = styleId === undefined ? undefined : styles.get(styleId)?.name;
  return name !== undefined && /^list (bullet|number)/i.test(name);
}

interface ParagraphState {
  text: string;
  styleId: string | undefined;
  outline: number | undefined;
  numbered: boolean;
}

export const docxExtractor: ContentExtractor = {
  name: 'docx',
  version: '1.0.0',
  resourceType: 'docx',
  supports: ({ contentType }) => contentType === 'docx',
  extract: async (_candidate, input, context): Promise<ExtractorOutput> => {
    const zip = await openSafeZip(input.bytes, context.limits, context.deadline);
    try {
      const pkg: PackageContext = { zip, limits: context.limits, deadline: context.deadline };
      const mainPart = await findMainPart(pkg, 'word/document.xml');
      const relationships = await readRelationships(pkg, mainPart);
      const stylesPart = relationships.find((rel) => rel.type.endsWith('/styles'))?.target;
      const styles =
        stylesPart !== undefined && zip.has(stylesPart)
          ? parseStyles(await readXmlPart(pkg, stylesPart), pkg)
          : new Map<string, StyleInfo>();

      const collector = new BlockCollector(context.limits.maxTextChars);
      const headings = new HeadingTracker();
      const paragraphs: ParagraphState[] = [];
      const rows: string[][] = [];
      const cells: string[] = [];
      let inText = false;
      let runHidden = false;
      let inRunProperties = false;
      // Held in an object: TypeScript cannot see the parser callbacks mutate a plain local.
      const seen = { hiddenText: false };

      const appendText = (text: string): void => {
        const paragraph = paragraphs.at(-1);
        if (paragraph !== undefined) {
          paragraph.text += text;
        }
      };

      parseXml(
        await readXmlPart(pkg, mainPart),
        {
          open: (element) => {
            const value = element.attributes['w:val'];
            switch (element.name) {
              case 'w:p':
                paragraphs.push({
                  text: '',
                  styleId: undefined,
                  outline: undefined,
                  numbered: false,
                });
                break;
              case 'w:pStyle': {
                const current = paragraphs.at(-1);
                if (current !== undefined) {
                  current.styleId = value;
                }
                break;
              }
              case 'w:outlineLvl': {
                const current = paragraphs.at(-1);
                if (current !== undefined && value !== undefined && /^\d$/.test(value)) {
                  current.outline = Number(value);
                }
                break;
              }
              case 'w:numPr': {
                const current = paragraphs.at(-1);
                if (current !== undefined) {
                  current.numbered = true;
                }
                break;
              }
              case 'w:r':
                runHidden = false;
                break;
              case 'w:rPr':
                inRunProperties = true;
                break;
              case 'w:vanish':
                if (inRunProperties && isOn(value)) {
                  runHidden = true;
                }
                break;
              case 'w:t':
                inText = true;
                break;
              case 'w:tab':
              case 'w:br':
              case 'w:cr':
                if (!runHidden) {
                  appendText(' ');
                }
                break;
              case 'w:noBreakHyphen':
                if (!runHidden) {
                  appendText('-');
                }
                break;
              case 'w:tr':
                rows.push([]);
                break;
              case 'w:tc':
                cells.push('');
                break;
            }
          },
          close: (name) => {
            switch (name) {
              case 'w:t':
                inText = false;
                break;
              case 'w:rPr':
                inRunProperties = false;
                break;
              case 'w:p': {
                const paragraph = paragraphs.pop();
                if (paragraph === undefined) {
                  break;
                }
                if (cells.length > 0) {
                  // Inside a table cell: paragraphs become part of the cell text.
                  cells[cells.length - 1] = `${cells.at(-1) ?? ''} ${paragraph.text}`;
                  break;
                }
                if (paragraphs.length > 0) {
                  // Text box paragraph nested in another paragraph: emit separately.
                  collector.add({
                    kind: 'paragraph',
                    text: paragraph.text,
                    headingPath: headings.path,
                  });
                  break;
                }
                const level = headingLevel(paragraph.outline, paragraph.styleId, styles);
                if (level !== undefined && normalizeInlineText(paragraph.text) !== '') {
                  const path = headings.enter(level, paragraph.text);
                  collector.add({
                    kind: 'heading',
                    text: paragraph.text,
                    headingLevel: level,
                    headingPath: path,
                  });
                } else {
                  collector.add({
                    kind:
                      paragraph.numbered || isListStyle(paragraph.styleId, styles)
                        ? 'list-item'
                        : 'paragraph',
                    text: paragraph.text,
                    headingPath: headings.path,
                  });
                }
                break;
              }
              case 'w:tc': {
                const cell = normalizeInlineText(cells.pop() ?? '');
                rows.at(-1)?.push(cell);
                break;
              }
              case 'w:tr': {
                const row = (rows.pop() ?? []).filter((cell) => cell !== '');
                if (row.length > 0) {
                  if (cells.length > 0) {
                    // Nested table: fold the row into the enclosing cell.
                    cells[cells.length - 1] = `${cells.at(-1) ?? ''} ${row.join(' | ')}`;
                  } else {
                    collector.add({
                      kind: 'table-row',
                      text: row.join(' | '),
                      headingPath: headings.path,
                    });
                  }
                }
                break;
              }
            }
          },
          text: (text) => {
            if (!inText) {
              return;
            }
            if (runHidden) {
              seen.hiddenText = true;
              return;
            }
            appendText(text);
          },
        },
        { maxDepth: context.limits.maxXmlDepth, deadline: context.deadline },
      );

      const warnings: string[] = [];
      if (seen.hiddenText) {
        warnings.push('hidden_text_skipped');
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
