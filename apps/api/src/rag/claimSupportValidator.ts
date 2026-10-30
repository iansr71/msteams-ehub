import type { RetrievedChunk } from '../retrieval/retrievalResultMapper.js';

/*
 * Checks that a claim's own text is consistent with the chunks it cites. These are deliberately
 * mechanical checks that catch fabricated references and numbers; they do not judge meaning.
 * A claim fails when it mentions a page, slide, link or document that none of its cited chunks
 * has, or a number that none of them contains, or shares no content word with them.
 */

export type ClaimIssue =
  | 'no_valid_citation'
  | 'fabricated_page'
  | 'fabricated_slide'
  | 'fabricated_url'
  | 'fabricated_document'
  | 'unsupported_number'
  | 'no_overlap';

export interface ClaimCheck {
  readonly supported: boolean;
  readonly issues: readonly ClaimIssue[];
}

const PAGE_REFERENCE = /\b(?:pages?|pp?\.|pg\.?)\s*(\d{1,4})(?:\s*(?:-|–|to)\s*(\d{1,4}))?/gi;
const SLIDE_REFERENCE = /\bslides?\s*(\d{1,4})(?:\s*(?:-|–|to)\s*(\d{1,4}))?/gi;
const URL_REFERENCE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const DOCUMENT_REFERENCE = /[^\s"'()[\]]+\.(?:pdf|docx?|pptx?|xlsx?|txt|html?)\b/gi;
const NUMBER = /(?<![\d.,])\d+(?:[.,]\d+)?(?![\d])/g;

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

const STOP_WORDS = new Set([
  'about',
  'above',
  'after',
  'again',
  'also',
  'always',
  'before',
  'being',
  'below',
  'between',
  'both',
  'cannot',
  'could',
  'does',
  'doing',
  'during',
  'each',
  'every',
  'from',
  'have',
  'having',
  'into',
  'just',
  'least',
  'more',
  'most',
  'must',
  'never',
  'only',
  'other',
  'over',
  'same',
  'should',
  'some',
  'such',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'very',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'within',
  'without',
  'would',
  'your',
  'yours',
  'client',
  'clients',
  'staff',
]);

function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z'-]{3,}/g)) {
    const word = match[0].replace(/'s$/, '').replace(/(?:es|s)$/, '');
    if (!STOP_WORDS.has(match[0]) && word.length >= 4) {
      words.add(word);
    }
  }
  return words;
}

function inRange(value: number, start: number | undefined, end: number | undefined): boolean {
  return start !== undefined && value >= start && value <= (end ?? start);
}

function referencedRange(match: RegExpMatchArray): [number, number] {
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  return [Math.min(start, end), Math.max(start, end)];
}

function numberPresent(value: string, haystack: string): boolean {
  const normalized = value.replace(',', '.');
  const pattern = new RegExp(`(?<![\\d.,])${normalized.replace('.', '[.,]')}(?![\\d])`);
  if (pattern.test(haystack)) {
    return true;
  }
  const integer = Number(normalized);
  const word = Number.isInteger(integer) ? NUMBER_WORDS[integer] : undefined;
  return word !== undefined && new RegExp(`\\b${word}\\b`, 'i').test(haystack);
}

/** Text with references removed, so their digits are not checked again as content numbers. */
function withoutReferences(text: string): string {
  return text
    .replace(URL_REFERENCE, ' ')
    .replace(DOCUMENT_REFERENCE, ' ')
    .replace(PAGE_REFERENCE, ' ')
    .replace(SLIDE_REFERENCE, ' ');
}

export class ClaimSupportValidator {
  check(text: string, cited: readonly RetrievedChunk[]): ClaimCheck {
    if (cited.length === 0) {
      return { supported: false, issues: ['no_valid_citation'] };
    }
    const issues = new Set<ClaimIssue>();

    for (const match of text.matchAll(PAGE_REFERENCE)) {
      const [start, end] = referencedRange(match);
      for (let page = start; page <= end; page += 1) {
        if (!cited.some((chunk) => inRange(page, chunk.pageNumber, chunk.pageNumberEnd))) {
          issues.add('fabricated_page');
        }
      }
    }
    for (const match of text.matchAll(SLIDE_REFERENCE)) {
      const [start, end] = referencedRange(match);
      for (let slide = start; slide <= end; slide += 1) {
        if (!cited.some((chunk) => chunk.slideNumber === slide)) {
          issues.add('fabricated_slide');
        }
      }
    }
    const knownUrls = new Set(
      cited.flatMap((chunk) =>
        [chunk.moduleUrl, chunk.sourceUrl].filter((url): url is string => url !== undefined),
      ),
    );
    for (const match of text.matchAll(URL_REFERENCE)) {
      // Sentence punctuation directly after a link is not part of it.
      if (!knownUrls.has(match[0].replace(/[.,;:!?]+$/, ''))) {
        issues.add('fabricated_url');
      }
    }
    const names = cited.flatMap((chunk) => [chunk.resourceName.toLowerCase()]);
    for (const match of text.matchAll(DOCUMENT_REFERENCE)) {
      const reference = match[0].toLowerCase();
      if (!names.some((name) => name.endsWith(reference) || reference.endsWith(name))) {
        issues.add('fabricated_document');
      }
    }

    const evidence = cited.map((chunk) => `${chunk.title} ${chunk.content}`).join('\n');
    const plain = withoutReferences(text);
    for (const match of plain.matchAll(NUMBER)) {
      if (!numberPresent(match[0], evidence)) {
        issues.add('unsupported_number');
      }
    }
    const claimWords = contentWords(plain);
    if (claimWords.size > 0) {
      const evidenceWords = contentWords(evidence);
      if (![...claimWords].some((word) => evidenceWords.has(word))) {
        issues.add('no_overlap');
      }
    }
    return { supported: issues.size === 0, issues: [...issues] };
  }
}
