import { z } from 'zod';

/** Tenant, user and group identifiers: never free text, never containing a comma. */
export const SEARCH_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
const identifier = z.string().regex(SEARCH_IDENTIFIER_PATTERN);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
// Edm.DateTimeOffset needs an explicit offset; Date#toISOString always produces one.
const dateTimeOffset = z.iso.datetime({ offset: true });
const positiveInt32 = z.number().int().positive().max(2_147_483_647);

/** One chunk as stored in Azure AI Search. Mirrors the fields in buildIndexDefinition. */
export const searchDocumentSchema = z
  .strictObject({
    id: sha256Hex,
    tenantId: identifier,
    courseId: positiveInt32,
    courseName: z.string(),
    courseCategory: z.string().optional(),
    sectionId: z.number().int().nonnegative().max(2_147_483_647),
    sectionName: z.string(),
    moduleId: positiveInt32,
    moduleName: z.string(),
    moduleUrl: z.string().optional(),
    /** Moodle-derived, e.g. `701:chapter:11` or `702:file:/sub/Aftercare 2.pdf`; may be any text. */
    resourceId: z.string().min(1).max(1100),
    resourceName: z.string(),
    resourceType: z.string().min(1),
    fileName: z.string(),
    mimeType: z.string().optional(),
    title: z.string(),
    headingPath: z.array(z.string()),
    content: z.string().min(1),
    contentVector: z.array(z.number()).min(1),
    sourceUrl: z.string().optional(),
    pageNumber: positiveInt32.optional(),
    pageNumberEnd: positiveInt32.optional(),
    slideNumber: positiveInt32.optional(),
    chunkNumber: positiveInt32,
    chunkCount: positiveInt32,
    tokenCount: positiveInt32,
    contentHash: sha256Hex,
    sourceContentHash: sha256Hex,
    modifiedAt: dateTimeOffset.optional(),
    indexedAt: dateTimeOffset,
    extractorVersion: z.string().min(1),
    chunkerVersion: z.string().min(1),
    embeddingModel: z.string().min(1).max(64),
    embeddingVersion: z.string().min(1).max(32),
    embeddingDimensions: positiveInt32,
    embeddedAt: dateTimeOffset,
    allowedUserIds: z.array(identifier),
    allowedGroupIds: z.array(identifier),
    isActive: z.boolean(),
  })
  .refine((document) => document.embeddingDimensions === document.contentVector.length, {
    path: ['embeddingDimensions'],
    message: 'Must equal the vector length.',
  });
export type SearchDocument = z.output<typeof searchDocumentSchema>;

const optionalFromNull = <T extends z.ZodType>(schema: T) =>
  schema
    .nullish()
    .transform((value) => value ?? undefined)
    .optional();

/**
 * A document as returned by a query: the retrievable fields only (no vector, no access lists).
 * Unset optional fields come back as null.
 */
export const retrievedDocumentSchema = z.object({
  id: sha256Hex,
  tenantId: z.string(),
  courseId: z.number().int(),
  courseName: z.string(),
  courseCategory: optionalFromNull(z.string()),
  sectionId: z.number().int(),
  sectionName: z.string(),
  moduleId: z.number().int(),
  moduleName: z.string(),
  moduleUrl: optionalFromNull(z.string()),
  resourceId: z.string(),
  resourceName: z.string(),
  resourceType: z.string(),
  fileName: z.string(),
  mimeType: optionalFromNull(z.string()),
  title: z.string(),
  headingPath: z.array(z.string()),
  content: z.string(),
  sourceUrl: optionalFromNull(z.string()),
  pageNumber: optionalFromNull(z.number().int()),
  pageNumberEnd: optionalFromNull(z.number().int()),
  slideNumber: optionalFromNull(z.number().int()),
  chunkNumber: z.number().int(),
  chunkCount: z.number().int(),
  tokenCount: z.number().int(),
  contentHash: z.string(),
  sourceContentHash: z.string(),
  modifiedAt: optionalFromNull(z.string()),
  indexedAt: z.string(),
  extractorVersion: z.string(),
  chunkerVersion: z.string(),
  // Absent on chunks indexed with schema version 1.
  embeddingModel: optionalFromNull(z.string()),
  embeddingVersion: optionalFromNull(z.string()),
  embeddingDimensions: optionalFromNull(z.number().int()),
  embeddedAt: optionalFromNull(z.string()),
  isActive: z.boolean(),
});
export type RetrievedDocument = z.output<typeof retrievedDocumentSchema>;
