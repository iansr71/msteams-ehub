import { MoodleValidationError } from './errors.js';

export type MoodleScalar = string | number | boolean;
export type MoodleParamValue = MoodleScalar | readonly MoodleParamValue[] | MoodleParams;
export interface MoodleParams {
  readonly [name: string]: MoodleParamValue | undefined;
}

const NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const MAX_DEPTH = 6;

function reject(message: string): MoodleValidationError {
  return new MoodleValidationError(message, { code: 'invalid_request_parameters' });
}

/**
 * Encodes parameters the way Moodle's REST server expects them:
 * `values[0]=a`, `criteria[0][key]=email`, booleans as 1/0. Parameter names are restricted
 * to Moodle's identifier alphabet so callers cannot inject extra form fields (including a
 * second `wstoken`).
 */
export function encodeMoodleParams(
  params: MoodleParams,
  target = new URLSearchParams(),
): URLSearchParams {
  for (const [name, value] of Object.entries(params)) {
    if (!NAME_PATTERN.test(name)) {
      throw reject('Parameter names must contain only letters, digits and underscores.');
    }
    appendValue(target, name, value, 0);
  }
  return target;
}

function appendValue(
  target: URLSearchParams,
  key: string,
  value: MoodleParamValue | undefined,
  depth: number,
): void {
  if (value === undefined) {
    return;
  }
  if (depth > MAX_DEPTH) {
    throw reject('Parameters are nested too deeply.');
  }
  if (typeof value === 'string') {
    target.append(key, value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw reject('Numeric parameters must be finite.');
    }
    target.append(key, String(value));
    return;
  }
  if (typeof value === 'boolean') {
    target.append(key, value ? '1' : '0');
    return;
  }
  if (isArray(value)) {
    value.forEach((item, index) => {
      appendValue(target, `${key}[${String(index)}]`, item, depth + 1);
    });
    return;
  }
  for (const [name, nested] of Object.entries(value)) {
    if (!NAME_PATTERN.test(name)) {
      throw reject('Parameter names must contain only letters, digits and underscores.');
    }
    appendValue(target, `${key}[${name}]`, nested, depth + 1);
  }
}

function isArray(value: MoodleParamValue): value is readonly MoodleParamValue[] {
  return Array.isArray(value);
}
