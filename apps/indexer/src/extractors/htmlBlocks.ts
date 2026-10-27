import type { ChildNode, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';
import { parseDocument } from 'htmlparser2';

import type { Deadline } from './deadline.js';
import { HeadingTracker, normalizeInlineText, type BlockCollector } from './textNormalization.js';

/*
 * Converts HTML into text blocks. The HTML is parsed into an inert tree (htmlparser2): nothing
 * is rendered, no script runs, and no URL (images, iframes, stylesheets, links) is fetched.
 * Elements that never carry document content are dropped with their whole subtree.
 */

const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'source',
  'track',
  'img',
  'picture',
  'map',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'nav',
  'dialog',
  'link',
  'meta',
  'base',
]);

const DROPPED_ROLES: ReadonlySet<string> = new Set([
  'navigation',
  'banner',
  'search',
  'menu',
  'menubar',
]);
const NAVIGATION_CLASS = /(?:^|[\s_-])(?:breadcrumbs?|skip-?links?|sr-only|navbar)(?:$|[\s_-])/i;

const HEADING = /^h([1-6])$/;
const LIST_CONTAINERS: ReadonlySet<string> = new Set(['ul', 'ol', 'menu', 'dl']);
const TABLE_SECTIONS: ReadonlySet<string> = new Set(['thead', 'tbody', 'tfoot']);
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  'br',
]);

function isDropped(element: Element): boolean {
  if (DROPPED_ELEMENTS.has(element.name)) {
    return true;
  }
  const attributes = element.attribs;
  if ('hidden' in attributes || attributes['aria-hidden'] === 'true') {
    return true;
  }
  if (DROPPED_ROLES.has((attributes['role'] ?? '').toLowerCase())) {
    return true;
  }
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attributes['style'] ?? '')) {
    return true;
  }
  return (
    NAVIGATION_CLASS.test(attributes['class'] ?? '') ||
    NAVIGATION_CLASS.test(attributes['id'] ?? '')
  );
}

/** Text of an element's inline content; nested lists and dropped elements are excluded. */
function inlineText(nodes: readonly ChildNode[], skipNestedLists: boolean): string {
  let text = '';
  for (const node of nodes) {
    if (isText(node)) {
      text += node.data;
    } else if (isTag(node)) {
      if (isDropped(node) || (skipNestedLists && LIST_CONTAINERS.has(node.name))) {
        continue;
      }
      if (node.name === 'br') {
        text += ' ';
        continue;
      }
      const inner = inlineText(node.children, skipNestedLists);
      text += INLINE_ELEMENTS.has(node.name) ? inner : ` ${inner} `;
    }
  }
  return text;
}

function rawText(nodes: readonly ChildNode[]): string {
  let text = '';
  for (const node of nodes) {
    if (isText(node)) {
      text += node.data;
    } else if (isTag(node) && !isDropped(node)) {
      text += node.name === 'br' ? '\n' : rawText(node.children);
    }
  }
  return text;
}

export interface HtmlBlockOptions {
  readonly collector: BlockCollector;
  readonly deadline: Deadline;
  /** Heading path above the document, e.g. [book name, chapter title]. */
  readonly basePath?: readonly string[];
  /**
   * A leading heading equal to this title is skipped: Moodle repeats the Page or chapter
   * title inside the body, and it is already in `basePath`.
   */
  readonly omitLeadingHeading?: string;
}

export interface HtmlBlockResult {
  readonly documentTitle: string | undefined;
}

export function htmlToBlocks(html: string, options: HtmlBlockOptions): HtmlBlockResult {
  const document = parseDocument(html, {
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
  });
  const headings = new HeadingTracker(options.basePath ?? []);
  const collector = options.collector;
  let buffer = '';
  let visited = 0;
  let sawContent = false;
  const omit =
    options.omitLeadingHeading === undefined
      ? undefined
      : normalizeInlineText(options.omitLeadingHeading);

  const flush = (): void => {
    if (buffer.trim() !== '') {
      collector.add({ kind: 'paragraph', text: buffer, headingPath: headings.path });
      sawContent = true;
    }
    buffer = '';
  };

  const walk = (nodes: readonly ChildNode[]): void => {
    for (const node of nodes) {
      if (collector.truncated) {
        return;
      }
      visited += 1;
      if (visited % 500 === 0) {
        options.deadline.check();
      }
      if (isText(node)) {
        buffer += node.data;
        continue;
      }
      if (!isTag(node) || isDropped(node)) {
        continue;
      }
      const name = node.name;
      const heading = HEADING.exec(name);
      if (heading?.[1] !== undefined) {
        flush();
        const title = inlineText(node.children, false);
        if (!sawContent && omit !== undefined && normalizeInlineText(title) === omit) {
          sawContent = true;
          continue;
        }
        const level = Number(heading[1]);
        const path = headings.enter(level, title);
        collector.add({ kind: 'heading', text: title, headingLevel: level, headingPath: path });
        sawContent = true;
      } else if (name === 'li' || name === 'dt' || name === 'dd') {
        flush();
        collector.add({
          kind: 'list-item',
          text: inlineText(node.children, true),
          headingPath: headings.path,
        });
        sawContent = true;
        walk(node.children.filter((child) => isTag(child) && LIST_CONTAINERS.has(child.name)));
      } else if (name === 'tr') {
        flush();
        const cells = node.children
          .filter(
            (child): child is Element =>
              isTag(child) && (child.name === 'td' || child.name === 'th'),
          )
          .map((cell) => normalizeInlineText(inlineText(cell.children, false)))
          .filter((cell) => cell !== '');
        if (cells.length > 0) {
          collector.add({ kind: 'table-row', text: cells.join(' | '), headingPath: headings.path });
          sawContent = true;
        }
      } else if (name === 'pre') {
        flush();
        collector.add({
          kind: 'preformatted',
          text: rawText(node.children),
          headingPath: headings.path,
        });
        sawContent = true;
      } else if (name === 'table' || TABLE_SECTIONS.has(name) || LIST_CONTAINERS.has(name)) {
        flush();
        walk(node.children);
      } else if (INLINE_ELEMENTS.has(name)) {
        if (name === 'br') {
          buffer += ' ';
        } else {
          walk(node.children);
        }
      } else {
        // Any other element (p, div, section, blockquote, figcaption, td outside tr…) is a block.
        flush();
        walk(node.children);
        flush();
      }
    }
  };

  const titleElement = findFirst(document.children, 'title');
  walk(document.children);
  flush();
  return {
    documentTitle:
      titleElement === undefined
        ? undefined
        : normalizeInlineText(rawText(titleElement.children)) || undefined,
  };
}

function findFirst(nodes: readonly ChildNode[], name: string): Element | undefined {
  for (const node of nodes) {
    if (isTag(node)) {
      if (node.name === name) {
        return node;
      }
      const found = findFirst(node.children, name);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}
