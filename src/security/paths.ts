import path from 'node:path';
import { PathSafetyError } from '../core/errors.js';

/** True when `candidate` is `root` itself or a descendant of it. */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `target` against `root` and guarantee the result stays inside `root`.
 * Used to keep every read, write and working directory confined to the
 * configured project, so the factory never touches unrelated projects.
 */
export function resolveInside(root: string, target: string, label: string): string {
  const resolved = path.resolve(root, target);
  if (!isInside(root, resolved)) {
    throw new PathSafetyError(`${label} must stay inside ${path.resolve(root)} (got ${resolved})`);
  }
  return resolved;
}
