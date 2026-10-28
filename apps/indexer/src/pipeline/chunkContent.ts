import {
  buildContentChunk,
  type ChunkContext,
  type ChunkPlacement,
  type ContentChunk,
} from './chunkMetadata.js';
import type { ContentUnit, NormalizedDocument } from './normalizeContent.js';
import type { TokenCounter } from './tokenCounter.js';

/*
 * Structure-aware chunking (CHUNKER_VERSION in chunkMetadata.ts).
 *
 * The document is a sequence of pieces (normally one per block; oversized blocks are split
 * into sentences, then words, then token runs). Every gap between two pieces has a boundary
 * strength. Chunking then works top-down:
 *
 *   1. Structural levels — slide, document section, heading, page — always split. Slides and
 *      sections are never re-merged (except a heading left with no content); headings and pages
 *      are re-merged only when one side is tiny (< minTokens).
 *   2. Packing levels — paragraph, list item, sentence, fragment — are used only when a group is
 *      still larger than maxTokens: split there and pack greedily up to targetTokens.
 *
 * So a chunk never spans two resources (one document per call) or two slides, rarely spans PDF
 * pages, and falls back to raw token cuts only for text with no better boundary at all.
 * Overlap is added only between chunks that continue the same section, page and slide.
 */

export interface ChunkingOptions {
  readonly targetTokens: number;
  readonly maxTokens: number;
  readonly minTokens: number;
  readonly overlapTokens: number;
}

const enum Strength {
  Fragment = 1,
  Sentence = 2,
  ListItem = 3,
  Paragraph = 4,
  Page = 5,
  Heading = 6,
  Section = 7,
  Slide = 8,
}

/** Fraction of maxTokens above which a group's joined text is counted exactly. */
const EXACT_COUNT_THRESHOLD = 0.9;

const STRUCTURAL_LEVELS = [
  Strength.Slide,
  Strength.Section,
  Strength.Heading,
  Strength.Page,
] as const;
const PACKING_LEVELS = [
  Strength.Paragraph,
  Strength.ListItem,
  Strength.Sentence,
  Strength.Fragment,
] as const;

interface Piece {
  readonly text: string;
  readonly tokens: number;
  readonly unit: ContentUnit;
  /** Boundary strength between this piece and the previous one (undefined for the first). */
  boundary: Strength | undefined;
  /** How this piece joins the previous piece when both land in the same chunk. */
  readonly separator: string;
}

type Group = readonly Piece[];

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

function sentencesOf(text: string, preformatted: boolean): string[] {
  if (preformatted) {
    return text.split('\n').filter((line) => line.trim() !== '');
  }
  return [...sentenceSegmenter.segment(text)]
    .map((segment) => segment.segment.trim())
    .filter((sentence) => sentence !== '');
}

export class ChunkingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkingError';
  }
}

export function validateChunkingOptions(options: ChunkingOptions): void {
  const { targetTokens, maxTokens, minTokens, overlapTokens } = options;
  if (!(
    minTokens >= 1 &&
    minTokens < targetTokens &&
    targetTokens <= maxTokens &&
    overlapTokens >= 0 &&
    overlapTokens * 2 <= targetTokens
  )) {
    throw new ChunkingError(
      'Chunking options must satisfy 1 <= min < target <= max and overlap <= target / 2.',
    );
  }
}

export class StructuredChunker {
  readonly #options: ChunkingOptions;
  readonly #counter: TokenCounter;

  constructor(options: ChunkingOptions, counter: TokenCounter) {
    validateChunkingOptions(options);
    this.#options = options;
    this.#counter = counter;
  }

  /** Chunks one normalised resource. Returns no chunks for a document without units. */
  chunk(document: NormalizedDocument, context: ChunkContext): ContentChunk[] {
    const pieces = this.#toPieces(document);
    if (pieces.length === 0) {
      return [];
    }
    let groups: Group[] = [pieces];
    for (const level of STRUCTURAL_LEVELS) {
      groups = groups.flatMap((group) => this.#mergeStructural(splitAt(group, level), level));
    }
    groups = groups.flatMap((group) => this.#packIfNeeded(group, 0));

    const placements = this.#withOverlap(groups);
    return placements.map((placement, index) =>
      buildContentChunk(document, placement, index + 1, placements.length, context),
    );
  }

  /** Units become pieces; any unit larger than maxTokens is split at the best boundary it has. */
  #toPieces(document: NormalizedDocument): Piece[] {
    const pieces: Piece[] = [];
    let previous: ContentUnit | undefined;
    for (const unit of document.units) {
      const boundary =
        previous === undefined
          ? undefined
          : boundaryBetween(previous, unit, document.topHeadingLevel);
      const separator = boundary === Strength.ListItem ? '\n' : '\n\n';
      const tokens = this.#counter.count(unit.text);
      if (tokens <= this.#options.maxTokens) {
        pieces.push({ text: unit.text, tokens, unit, boundary, separator });
      } else {
        this.#splitOversized(unit).forEach((part, index) => {
          pieces.push(index === 0 ? { ...part, boundary, separator } : part);
        });
      }
      previous = unit;
    }
    return pieces;
  }

  /** Splits one oversized unit into sentence pieces, then word runs, then token runs. */
  #splitOversized(unit: ContentUnit): Piece[] {
    const { maxTokens, targetTokens } = this.#options;
    const preformatted = unit.kind === 'preformatted';
    const parts: Piece[] = [];
    for (const sentence of sentencesOf(unit.text, preformatted)) {
      const tokens = this.#counter.count(sentence);
      const sentenceSeparator = preformatted ? '\n' : ' ';
      if (tokens <= maxTokens) {
        parts.push({
          text: sentence,
          tokens,
          unit,
          boundary: Strength.Sentence,
          separator: sentenceSeparator,
        });
        continue;
      }
      // A single sentence longer than a whole chunk: cut between words, as close to target as possible.
      let run = '';
      let runTokens = 0;
      let first = true;
      const flush = (): void => {
        if (run !== '') {
          parts.push({
            text: run,
            tokens: this.#counter.count(run),
            unit,
            boundary: first ? Strength.Sentence : Strength.Fragment,
            separator: first ? sentenceSeparator : ' ',
          });
          first = false;
          run = '';
          runTokens = 0;
        }
      };
      for (const word of sentence.split(/\s+/)) {
        const wordTokens = this.#counter.count(word);
        if (wordTokens > maxTokens) {
          // No boundary at all (e.g. an enormous URL or encoded blob): raw token cuts.
          flush();
          for (const slice of this.#counter.splitByTokens(word, targetTokens)) {
            parts.push({
              text: slice,
              tokens: this.#counter.count(slice),
              unit,
              boundary: first ? Strength.Sentence : Strength.Fragment,
              separator: first ? sentenceSeparator : '',
            });
            first = false;
          }
          continue;
        }
        // Word counts are added rather than recounting the growing run (which is quadratic);
        // the run is counted exactly once when flushed.
        // BPE folds the joining space into the next word's token, so spaces add nothing here.
        if (run !== '' && runTokens + wordTokens > targetTokens) {
          flush();
        }
        run = run === '' ? word : `${run} ${word}`;
        runTokens += wordTokens;
      }
      flush();
    }
    return parts;
  }

  #mergeStructural(groups: Group[], level: Strength): Group[] {
    if (groups.length <= 1 || level === Strength.Slide) {
      return groups;
    }
    const { minTokens, maxTokens } = this.#options;
    const merged: Group[] = [];
    let current = groups[0] ?? [];
    for (const next of groups.slice(1)) {
      const fits = groupTokens(current) + groupTokens(next) + 1 <= maxTokens;
      const orphanHeading = isHeadingOnly(current);
      const tiny = groupTokens(current) < minTokens || groupTokens(next) < minTokens;
      // Sections only absorb a heading left without content; headings and pages also absorb tiny neighbours.
      const shouldMerge = fits && (orphanHeading || (level !== Strength.Section && tiny));
      if (shouldMerge) {
        current = [...current, ...next];
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
    return merged;
  }

  #packIfNeeded(group: Group, levelIndex: number): Group[] {
    const level = PACKING_LEVELS[levelIndex];
    if (this.#fits(group) || level === undefined) {
      return [group];
    }
    const parts = splitAt(group, level);
    if (parts.length === 1) {
      return this.#packIfNeeded(group, levelIndex + 1);
    }
    const { targetTokens, maxTokens, minTokens } = this.#options;
    const packed: Group[] = [];
    let current: Piece[] = [];
    for (const part of parts) {
      // A heading always travels with what follows it, even past the target; recursion splits
      // the result further if it exceeds maxTokens.
      if (
        current.length > 0 &&
        !isHeadingOnly(current) &&
        groupTokens(current) + groupTokens(part) + 1 > targetTokens
      ) {
        packed.push(current);
        current = [];
      }
      current = [...current, ...part];
    }
    // Fold a tiny tail into the previous chunk when it still fits.
    const last = packed.at(-1);
    if (
      last !== undefined &&
      groupTokens(current) < minTokens &&
      groupTokens(last) + groupTokens(current) + 1 <= maxTokens
    ) {
      packed[packed.length - 1] = [...last, ...current];
    } else {
      packed.push(current);
    }
    return packed.flatMap((part) => this.#packIfNeeded(part, levelIndex + 1));
  }

  /**
   * Piece counts plus separators are a close estimate of the joined count; the exact (and more
   * expensive) count is taken only near the limit. Every emitted chunk is counted exactly.
   */
  #fits(group: Group): boolean {
    const estimate = groupTokens(group);
    if (estimate > this.#options.maxTokens) {
      return false;
    }
    return (
      estimate <= this.#options.maxTokens * EXACT_COUNT_THRESHOLD ||
      this.#counter.count(joinPieces(group)) <= this.#options.maxTokens
    );
  }

  /**
   * Prefixes a chunk with the end of the previous one when both continue the same section,
   * heading, page and slide. Overlap is sentence-aligned where possible, never more than
   * overlapTokens or half the previous chunk, and never pushes a chunk over maxTokens.
   */
  #withOverlap(groups: readonly Group[]): ChunkPlacement[] {
    const placements: ChunkPlacement[] = [];
    groups.forEach((group, index) => {
      const body = joinPieces(group);
      const bodyTokens = this.#counter.count(body);
      const first = group[0];
      const previous = index > 0 ? groups[index - 1] : undefined;
      let overlapText = '';
      if (
        previous !== undefined &&
        first !== undefined &&
        (first.boundary ?? Strength.Slide) <= Strength.Paragraph
      ) {
        const budget = Math.min(
          this.#options.overlapTokens,
          Math.floor(this.#counter.count(joinPieces(previous)) / 2),
          this.#options.maxTokens - bodyTokens - 1,
        );
        overlapText = budget > 0 ? this.#tail(joinPieces(previous), budget) : '';
      }
      const content = overlapText === '' ? body : `${overlapText}\n\n${body}`;
      const pages = group
        .map((piece) => piece.unit.pageNumber)
        .filter((page): page is number => page !== undefined);
      placements.push({
        content,
        tokenCount: this.#counter.count(content),
        overlapTokens: overlapText === '' ? 0 : this.#counter.count(overlapText),
        headingPath: first?.unit.contextPath ?? [],
        pageNumber: pages.length === 0 ? undefined : Math.min(...pages),
        pageNumberEnd: pages.length === 0 ? undefined : Math.max(...pages),
        slideNumber: first?.unit.slideNumber,
      });
    });
    return placements;
  }

  /** Trailing whole sentences within `budget` tokens; a word-trimmed token tail if none fit. */
  #tail(text: string, budget: number): string {
    const sentences = sentencesOf(text.replace(/\n+/g, ' '), false);
    let tail = '';
    for (let index = sentences.length - 1; index >= 0; index -= 1) {
      const candidate =
        tail === '' ? (sentences[index] ?? '') : `${sentences[index] ?? ''} ${tail}`;
      if (this.#counter.count(candidate) > budget) {
        break;
      }
      tail = candidate;
    }
    if (tail !== '') {
      return tail;
    }
    const slices = this.#counter.splitByTokens(text, budget);
    const lastSlice = slices.at(-1) ?? '';
    // Drop the partial first word of a token cut.
    return lastSlice.replace(/^\S*\s+/, '').trim();
  }
}

function boundaryBetween(
  previous: ContentUnit,
  current: ContentUnit,
  topHeadingLevel: number | undefined,
): Strength {
  if (previous.slideNumber !== current.slideNumber) {
    return Strength.Slide;
  }
  if (current.kind === 'heading') {
    return current.headingLevel === topHeadingLevel ? Strength.Section : Strength.Heading;
  }
  if (previous.pageNumber !== current.pageNumber) {
    return Strength.Page;
  }
  const listLike = (unit: ContentUnit): boolean =>
    unit.kind === 'list-item' || unit.kind === 'table-row';
  if (listLike(previous) && listLike(current) && previous.kind === current.kind) {
    return Strength.ListItem;
  }
  return Strength.Paragraph;
}

function splitAt(group: Group, level: Strength): Group[] {
  const groups: Piece[][] = [];
  for (const piece of group) {
    if (groups.length === 0 || (piece.boundary !== undefined && piece.boundary >= level)) {
      groups.push([piece]);
    } else {
      groups[groups.length - 1]?.push(piece);
    }
  }
  return groups;
}

/** Estimated tokens: pieces plus one per separator (exact counts are checked before emitting). */
function groupTokens(group: Group): number {
  return group.reduce((sum, piece) => sum + piece.tokens, 0) + Math.max(0, group.length - 1);
}

function isHeadingOnly(group: Group): boolean {
  return group.length > 0 && group.every((piece) => piece.unit.kind === 'heading');
}

function joinPieces(group: Group): string {
  return group
    .map((piece, index) => (index === 0 ? piece.text : `${piece.separator}${piece.text}`))
    .join('');
}
