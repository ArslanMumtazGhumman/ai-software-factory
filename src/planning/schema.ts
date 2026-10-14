/**
 * Minimal structural validators for planner output and idea input. Each check
 * returns the cleaned value (unknown keys are dropped) or undefined, and
 * appends human-readable issues with the JSON path of the problem.
 */
export type Check<T> = (value: unknown, path: string, issues: string[]) => T | undefined;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function str(options: { min?: number; max?: number; pattern?: RegExp; label?: string } = {}): Check<string> {
  const { min = 1, max = 4000, pattern } = options;
  return (v, path, issues) => {
    if (typeof v !== 'string') {
      issues.push(`${path} must be a string`);
      return undefined;
    }
    const s = v.trim();
    if (s.length < min) issues.push(min === 1 ? `${path} must not be empty` : `${path} must have at least ${min} characters`);
    else if (s.length > max) issues.push(`${path} must have at most ${max} characters`);
    else if (pattern !== undefined && !pattern.test(s)) issues.push(`${path} ${options.label ?? `must match ${pattern}`} (got "${s.slice(0, 60)}")`);
    else return s;
    return undefined;
  };
}

export function bool(): Check<boolean> {
  return (v, path, issues) => {
    if (typeof v !== 'boolean') {
      issues.push(`${path} must be true or false`);
      return undefined;
    }
    return v;
  };
}

export function int(min: number, max: number): Check<number> {
  return (v, path, issues) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      issues.push(`${path} must be a whole number from ${min} to ${max}`);
      return undefined;
    }
    return v;
  };
}

export function oneOf<T extends string>(values: readonly T[]): Check<T> {
  return (v, path, issues) => {
    if (typeof v !== 'string' || !values.includes(v as T)) {
      issues.push(`${path} must be one of ${values.join(', ')}`);
      return undefined;
    }
    return v as T;
  };
}

export function arr<T>(item: Check<T>, options: { min?: number; max?: number } = {}): Check<T[]> {
  const { min = 0, max = 200 } = options;
  return (v, path, issues) => {
    if (!Array.isArray(v)) {
      issues.push(`${path} must be a list`);
      return undefined;
    }
    if (v.length < min) issues.push(`${path} must have at least ${min} item(s)`);
    if (v.length > max) issues.push(`${path} must have at most ${max} items`);
    const out: T[] = [];
    v.slice(0, max).forEach((x, i) => {
      const r = item(x, `${path}[${i}]`, issues);
      if (r !== undefined) out.push(r);
    });
    return out;
  };
}

/** An optional value; `fallback` is used when it is missing (undefined or null). */
export function opt<T>(check: Check<T>, fallback?: T): Check<T> {
  return (v, path, issues) => (v === undefined || v === null ? fallback : check(v, path, issues));
}

type Shape = Record<string, Check<unknown>>;
type Out<S extends Shape> = { [K in keyof S]: S[K] extends Check<infer T> ? T : never };

export function obj<S extends Shape>(shape: S): Check<Out<S>> {
  return (v, path, issues) => {
    if (!isObject(v)) {
      issues.push(`${path} must be an object`);
      return undefined;
    }
    const before = issues.length;
    const out: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(shape)) {
      const r = check(v[key], `${path}.${key}`, issues);
      if (r !== undefined) out[key] = r;
    }
    return issues.length > before ? undefined : (out as Out<S>);
  };
}

/** Run a check and return the value with all issues (value is undefined when any issue was found). */
export function validate<T>(check: Check<T>, value: unknown, path: string): { value?: T; issues: string[] } {
  const issues: string[] = [];
  const result = check(value, path, issues);
  return issues.length > 0 || result === undefined ? { issues: issues.length > 0 ? issues : [`${path} is invalid`] } : { value: result, issues };
}
