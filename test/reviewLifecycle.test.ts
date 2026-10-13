import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTransitionError } from '../src/core/errors.js';
import { parseTaskList } from '../src/tasks/task.js';
import { acceptReview, recordResult, rejectReview, startTask, submitForReview } from '../src/tasks/taskLifecycle.js';
import { selectEligibleTasks } from '../src/tasks/taskSelector.js';
import { makeTask } from './helpers.js';

const RUN = '20260101T000000Z-0000abcd';
const times = { startedAt: 's', finishedAt: 'f' };

describe('review lifecycle', () => {
  it('start -> awaiting_review -> accept', () => {
    const started = startTask(makeTask('A'), RUN);
    assert.equal(started.status, 'in_progress');
    assert.equal(started.currentRunId, RUN);
    const waiting = submitForReview(started, { ...times, summary: 'ok', runId: RUN, evidenceDigest: 'd' });
    assert.equal(waiting.status, 'awaiting_review');
    assert.equal(waiting.results[0]!.evidenceDigest, 'd');
    const done = acceptReview(waiting, 'now');
    assert.equal(done.status, 'completed');
    assert.equal(done.currentRunId, undefined);
    assert.deepEqual(done.results[0]!.review, { decision: 'accepted', reviewedAt: 'now' });
  });

  it('reject counts as a failed attempt', () => {
    const waiting = submitForReview(startTask(makeTask('A'), RUN), { ...times, summary: 'ok', runId: RUN, evidenceDigest: 'd' });
    const rejected = rejectReview(waiting, 'no', 'now', 1);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.retryCount, 1);
    assert.equal(rejectReview({ ...waiting, retryCount: 1 }, 'no', 'now', 1).status, 'needs_attention');
  });

  it('awaiting_review blocks dependants and cannot be selected or recorded', () => {
    const waiting = submitForReview(startTask(makeTask('A'), RUN), { ...times, summary: 'ok', runId: RUN, evidenceDigest: 'd' });
    assert.deepEqual(selectEligibleTasks([waiting, makeTask('B', { dependencies: ['A'] })], { maxRetries: 2 }), []);
    assert.throws(() => recordResult(waiting, { outcome: 'success', summary: 'x', ...times }, 2), InvalidTransitionError);
    assert.throws(() => startTask(waiting), InvalidTransitionError);
  });

  it('guards against mismatched runs and double decisions', () => {
    const started = startTask(makeTask('A'), RUN);
    assert.throws(() => submitForReview(started, { ...times, summary: 'x', runId: '20260101T000000Z-ffffffff', evidenceDigest: 'd' }), InvalidTransitionError);
    assert.throws(() => acceptReview(started, 'now'), InvalidTransitionError);
    assert.throws(() => rejectReview(makeTask('A'), 'r', 'now', 1), InvalidTransitionError);
  });

  it('failure through recordResult clears the run reference', () => {
    const failed = recordResult(startTask(makeTask('A'), RUN), { outcome: 'failure', summary: 'x', runId: RUN, ...times }, 2);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.currentRunId, undefined);
    assert.equal(failed.results[0]!.runId, RUN);
  });

  it('round-trips the new optional fields and rejects malformed run ids', () => {
    const waiting = submitForReview(startTask(makeTask('A'), RUN), { ...times, summary: 'ok', runId: RUN, evidenceDigest: 'd' });
    assert.deepEqual(parseTaskList(JSON.parse(JSON.stringify([waiting]))), [waiting]);
    assert.throws(() => parseTaskList([{ ...makeTask('A'), currentRunId: '../../x' }]), /currentRunId/);
  });
});
