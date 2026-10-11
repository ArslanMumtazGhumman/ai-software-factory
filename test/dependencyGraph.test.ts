import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DependencyError } from '../src/core/errors.js';
import { assertValidDependencies, findDependencyIssues } from '../src/tasks/dependencyGraph.js';
import { makeTask } from './helpers.js';

describe('dependency graph validation', () => {
  it('accepts a valid DAG', () => {
    const tasks = [
      makeTask('A'),
      makeTask('B', { dependencies: ['A'] }),
      makeTask('C', { dependencies: ['A'] }),
      makeTask('D', { dependencies: ['B', 'C'] }),
    ];
    assert.deepEqual(findDependencyIssues(tasks), []);
    assert.doesNotThrow(() => assertValidDependencies(tasks));
  });

  it('accepts dependencies declared later in the file', () => {
    assert.deepEqual(findDependencyIssues([makeTask('B', { dependencies: ['A'] }), makeTask('A')]), []);
  });

  it('reports unknown dependencies', () => {
    const issues = findDependencyIssues([makeTask('A', { dependencies: ['ghost'] })]);
    assert.deepEqual(issues, ['Task "A" depends on unknown task "ghost"']);
  });

  it('reports self-dependencies', () => {
    const issues = findDependencyIssues([makeTask('A', { dependencies: ['A'] })]);
    assert.deepEqual(issues, ['Task "A" depends on itself']);
  });

  it('reports duplicate ids and duplicate dependency entries', () => {
    const issues = findDependencyIssues([
      makeTask('A'),
      makeTask('A'),
      makeTask('B', { dependencies: ['A', 'A'] }),
    ]);
    assert.ok(issues.includes('Duplicate task id "A"'));
    assert.ok(issues.includes('Task "B" lists dependency "A" more than once'));
  });

  it('detects a two-node cycle', () => {
    const issues = findDependencyIssues([makeTask('A', { dependencies: ['B'] }), makeTask('B', { dependencies: ['A'] })]);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /Dependency cycle: A -> B -> A/);
  });

  it('detects a longer cycle reachable from an acyclic prefix', () => {
    const tasks = [
      makeTask('start'),
      makeTask('X', { dependencies: ['start', 'Z'] }),
      makeTask('Y', { dependencies: ['X'] }),
      makeTask('Z', { dependencies: ['Y'] }),
    ];
    const issues = findDependencyIssues(tasks);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /Dependency cycle: .*X.*Z.*Y|Dependency cycle: .*X.*/);
  });

  it('throws a DependencyError listing all issues', () => {
    const tasks = [makeTask('A', { dependencies: ['A', 'nope'] })];
    assert.throws(
      () => assertValidDependencies(tasks),
      (err: unknown) => err instanceof DependencyError && err.issues.length === 2 && err.code === 'DEPENDENCY_ERROR',
    );
  });

  it('handles a long dependency chain without recursion limits', () => {
    const tasks = Array.from({ length: 5000 }, (_, i) => makeTask(`T${i}`, { dependencies: i === 0 ? [] : [`T${i - 1}`] }));
    assert.deepEqual(findDependencyIssues(tasks), []);
  });
});
