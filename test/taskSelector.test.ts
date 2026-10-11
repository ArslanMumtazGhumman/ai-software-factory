import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DependencyError } from '../src/core/errors.js';
import { explainTasks, selectEligibleTasks, selectNextTask } from '../src/tasks/taskSelector.js';
import { makeTask } from './helpers.js';

const opts = { maxRetries: 2 };
const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

describe('task selection', () => {
  it('selects tasks with no dependencies', () => {
    const tasks = [makeTask('A'), makeTask('B')];
    assert.deepEqual(ids(selectEligibleTasks(tasks, opts)), ['A', 'B']);
  });

  it('excludes tasks whose dependencies are not completed', () => {
    const tasks = [makeTask('A'), makeTask('B', { dependencies: ['A'] })];
    assert.deepEqual(ids(selectEligibleTasks(tasks, opts)), ['A']);
  });

  it('includes a task once all dependencies are completed', () => {
    const tasks = [
      makeTask('A', { status: 'completed' }),
      makeTask('B', { status: 'completed' }),
      makeTask('C', { dependencies: ['A', 'B'] }),
    ];
    assert.deepEqual(ids(selectEligibleTasks(tasks, opts)), ['C']);
  });

  it('requires every dependency, not just some', () => {
    const tasks = [
      makeTask('A', { status: 'completed' }),
      makeTask('B'),
      makeTask('C', { dependencies: ['A', 'B'] }),
    ];
    assert.deepEqual(ids(selectEligibleTasks(tasks, opts)), ['B']);
  });

  it('treats in_progress, failed and needs_attention dependencies as incomplete', () => {
    for (const status of ['in_progress', 'failed', 'needs_attention'] as const) {
      const tasks = [makeTask('A', { status, retryCount: 5 }), makeTask('B', { dependencies: ['A'] })];
      assert.deepEqual(ids(selectEligibleTasks(tasks, opts)), [], `dependency status ${status}`);
    }
  });

  it('never selects completed, in_progress or needs_attention tasks', () => {
    const tasks = [
      makeTask('A', { status: 'completed' }),
      makeTask('B', { status: 'in_progress' }),
      makeTask('C', { status: 'needs_attention', retryCount: 3 }),
    ];
    assert.deepEqual(selectEligibleTasks(tasks, opts), []);
  });

  it('selects failed tasks only while retries remain', () => {
    const tasks = [
      makeTask('A', { status: 'failed', retryCount: 1 }),
      makeTask('B', { status: 'failed', retryCount: 2 }),
      makeTask('C', { status: 'failed', retryCount: 3 }),
    ];
    assert.deepEqual(ids(selectEligibleTasks(tasks, opts)), ['A', 'B']);
    assert.deepEqual(ids(selectEligibleTasks(tasks, { maxRetries: 0 })), []);
  });

  it('preserves file order and honours the limit', () => {
    const tasks = [makeTask('Z'), makeTask('A'), makeTask('M')];
    assert.deepEqual(ids(selectEligibleTasks(tasks, { ...opts, limit: 2 })), ['Z', 'A']);
    assert.equal(selectNextTask(tasks, opts)?.id, 'Z');
  });

  it('returns undefined / empty when nothing is eligible', () => {
    assert.equal(selectNextTask([], opts), undefined);
    assert.deepEqual(selectEligibleTasks([makeTask('A', { status: 'completed' })], opts), []);
  });

  it('refuses to select from an invalid graph', () => {
    const tasks = [makeTask('A', { dependencies: ['missing'] }), makeTask('B')];
    assert.throws(() => selectEligibleTasks(tasks, opts), DependencyError);
  });

  it('explains why each task is or is not eligible', () => {
    const tasks = [makeTask('A'), makeTask('B', { dependencies: ['A'] }), makeTask('C', { status: 'completed' })];
    const report = explainTasks(tasks, 2);
    assert.equal(report[0]!.eligibility.eligible, true);
    assert.match(report[1]!.eligibility.reason, /waiting on dependencies: A/);
    assert.match(report[2]!.eligibility.reason, /already completed/);
  });
});
