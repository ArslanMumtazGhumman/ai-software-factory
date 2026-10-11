import { DependencyError } from '../core/errors.js';
import type { Task } from './task.js';

/**
 * Return every structural problem in the dependency graph: duplicate ids,
 * self-dependencies, unknown dependency ids and cycles. Empty means valid.
 */
export function findDependencyIssues(tasks: readonly Task[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) issues.push(`Duplicate task id "${task.id}"`);
    ids.add(task.id);
  }
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const dep of task.dependencies) {
      if (seen.has(dep)) issues.push(`Task "${task.id}" lists dependency "${dep}" more than once`);
      seen.add(dep);
      if (dep === task.id) issues.push(`Task "${task.id}" depends on itself`);
      else if (!ids.has(dep)) issues.push(`Task "${task.id}" depends on unknown task "${dep}"`);
    }
  }
  issues.push(...findCycles(tasks));
  return issues;
}

/** Throw a DependencyError if the graph is invalid. */
export function assertValidDependencies(tasks: readonly Task[]): void {
  const issues = findDependencyIssues(tasks);
  if (issues.length > 0) throw new DependencyError(issues);
}

/** Detect cycles (excluding self-loops, reported separately) via iterative DFS. */
function findCycles(tasks: readonly Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();
  const issues: string[] = [];

  for (const root of tasks) {
    if (state.has(root.id)) continue;
    // Stack frames: [taskId, index of next dependency to visit]
    const stack: [string, number][] = [[root.id, 0]];
    const pathIds: string[] = [root.id];
    state.set(root.id, 'visiting');

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const [id, index] = frame;
      const deps = (byId.get(id)?.dependencies ?? []).filter((d) => d !== id && byId.has(d));
      if (index >= deps.length) {
        state.set(id, 'done');
        stack.pop();
        pathIds.pop();
        continue;
      }
      frame[1] = index + 1;
      const dep = deps[index]!;
      const depState = state.get(dep);
      if (depState === 'visiting') {
        const cycle = [...pathIds.slice(pathIds.indexOf(dep)), dep];
        const key = [...new Set(cycle)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          issues.push(`Dependency cycle: ${cycle.join(' -> ')}`);
        }
      } else if (depState === undefined) {
        state.set(dep, 'visiting');
        stack.push([dep, 0]);
        pathIds.push(dep);
      }
    }
  }
  return issues;
}
