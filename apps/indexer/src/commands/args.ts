import { z } from 'zod';

export type FlagKind = 'boolean' | 'string' | 'string[]';
export type FlagSpec = Readonly<Record<string, FlagKind>>;

/** A command-line mistake; reported with usage text and exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const FLAG_NAME = /^[a-z][a-z0-9-]*$/;
const MAX_ARGUMENTS = 64;

/**
 * Parses `--flag`, `--flag value` and `--flag=value` forms against `spec`. Positional arguments
 * and unknown flags are rejected so a typo never silently widens what a command does.
 */
export function parseFlags(
  args: readonly string[],
  spec: FlagSpec,
): Record<string, string | boolean | string[]> {
  if (args.length > MAX_ARGUMENTS) {
    throw new UsageError('Too many arguments.');
  }
  const result: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      throw new UsageError(`Unexpected argument: ${arg.slice(0, 40)}`);
    }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const kind = FLAG_NAME.test(name) && Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) {
      throw new UsageError(`Unknown option: --${name.slice(0, 40)}`);
    }
    if (kind === 'boolean') {
      if (equals !== -1) {
        throw new UsageError(`--${name} does not take a value.`);
      }
      result[name] = true;
      continue;
    }
    let value: string | undefined;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`--${name} requires a value.`);
    }
    if (kind === 'string') {
      if (result[name] !== undefined) {
        throw new UsageError(`--${name} can only be given once.`);
      }
      result[name] = value;
    } else {
      const existing = result[name];
      result[name] = [...(Array.isArray(existing) ? existing : []), value];
    }
  }
  return result;
}

/** Parses flags and validates them with `schema`, turning Zod failures into usage errors. */
export function parseCommandArgs<Schema extends z.ZodType>(
  args: readonly string[],
  spec: FlagSpec,
  schema: Schema,
): z.output<Schema> {
  const parsed = schema.safeParse(parseFlags(args, spec));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const flag = issue?.path[0];
    const message =
      issue?.code === 'invalid_type' && issue.input === undefined
        ? 'is required.'
        : (issue?.message ?? 'invalid value.');
    throw new UsageError(
      flag === undefined ? 'Invalid arguments.' : `--${String(flag)}: ${message}`,
    );
  }
  return parsed.data;
}

export const courseIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,9}$/, { message: 'must be a positive whole number.' })
  .transform(Number)
  .refine(Number.isSafeInteger, { message: 'is too large.' });

/** Accepts repeated flags and comma-separated lists: `--course-id 1,2 --course-id 3`. */
export const courseIdListSchema = z
  .array(z.string())
  .transform((values) => values.flatMap((value) => value.split(',')).map((value) => value.trim()))
  .pipe(z.array(courseIdSchema).min(1).max(500, { message: 'at most 500 course IDs.' }));
