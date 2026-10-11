/**
 * Minimal, dependency-free validation helpers. Each helper records a readable
 * issue (with a JSON-ish path) instead of throwing, so a single validation pass
 * can report every problem at once.
 */
export type Issues = string[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
  opts: { optional?: boolean; allowEmpty?: boolean; maxLength?: number } = {},
): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    if (!opts.optional) issues.push(`${path}.${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push(`${path}.${key} must be a string`);
    return undefined;
  }
  if (!opts.allowEmpty && value.trim().length === 0) {
    issues.push(`${path}.${key} must not be empty`);
    return undefined;
  }
  if (opts.maxLength !== undefined && value.length > opts.maxLength) {
    issues.push(`${path}.${key} must be at most ${opts.maxLength} characters`);
    return undefined;
  }
  return value;
}

export function readStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
  opts: { optional?: boolean } = {},
): string[] | undefined {
  const value = obj[key];
  if (value === undefined) {
    if (!opts.optional) issues.push(`${path}.${key} is required`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    issues.push(`${path}.${key} must be an array of strings`);
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      issues.push(`${path}.${key}[${i}] must be a non-empty string`);
    } else {
      out.push(item);
    }
  });
  return out;
}

export function readInteger(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: Issues,
  bounds: { min: number; max: number; optional?: boolean },
): number | undefined {
  const value = obj[key];
  if (value === undefined) {
    if (!bounds.optional) issues.push(`${path}.${key} is required`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push(`${path}.${key} must be an integer`);
    return undefined;
  }
  if (value < bounds.min || value > bounds.max) {
    issues.push(`${path}.${key} must be between ${bounds.min} and ${bounds.max}`);
    return undefined;
  }
  return value;
}
