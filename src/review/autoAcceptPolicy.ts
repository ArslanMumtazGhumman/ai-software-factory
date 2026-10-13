import type { AutoAcceptPolicy } from '../config/factoryConfig.js';
import type { RunRecord } from '../persistence/runStore.js';
import type { Task } from '../tasks/task.js';
import { underPrefix } from './diffReview.js';

export interface AutoAcceptDecision {
  accept: boolean;
  /** Why the result must go to a human, or (when accepted) what the policy verified. */
  reasons: string[];
}

/**
 * Topics that always need a human, matched against task text and changed
 * paths. Deliberately broad: a false positive only means a human reviews.
 */
const SENSITIVE_TOPIC =
  /\b(auth\w*|login|logout|sign[-_ ]?in|password\w*|passwd|secrets?|token\w*|credential\w*|oauth|jwt|session\w*|cookie\w*|\w*crypt\w*|hash\w*|permission\w*|privilege\w*|security|sandbox\w*|payment\w*|billing|invoice\w*|deploy\w*|release\w*|publish\w*|migrat\w*|database|sql|admin\w*|sudo|firewall|cors|csrf|xss|ssl|tls|certificate\w*|keystore|api[-_ ]?keys?|env|environment|config\w*|polic\w*|budget\w*)\b/i;

function sensitiveTopic(text: string): string | undefined {
  return SENSITIVE_TOPIC.exec(text)?.[0];
}

/**
 * Decide whether a result that already passed the agent, every configured
 * check and the diff review may be accepted without a human. Every condition
 * must hold; anything ambiguous goes to a human. This never relaxes a check:
 * it only decides between "accept" and "wait for review".
 */
export function evaluateAutoAccept(policy: AutoAcceptPolicy, task: Task, run: RunRecord): AutoAcceptDecision {
  const blockers: string[] = [];
  if (!policy.enabled) return { accept: false, reasons: ['auto-accept is disabled (config.autonomy.autoAccept.enabled is false)'] };
  if (!policy.taskIds.includes(task.id)) blockers.push(`task ${task.id} is not listed in config.autonomy.autoAccept.taskIds`);

  if (task.status !== 'awaiting_review' || run.state !== 'awaiting_review' || run.outcome !== 'success' || run.review === undefined) {
    blockers.push('the result did not pass the agent, checks and diff review');
    return { accept: false, reasons: blockers };
  }
  if ((run.repairs?.length ?? 0) > 0) blockers.push(`checks initially failed and needed ${run.repairs!.length} repair attempt(s)`);
  if (!run.validation || run.validation.length === 0 || run.validation.some((v) => v.exitCode !== 0 || v.timedOut)) {
    blockers.push('not every configured check ran and passed');
  }
  if ((run.agent?.permissionDenials ?? 0) > 0) blockers.push(`the agent hit ${run.agent!.permissionDenials} permission denial(s)`);

  const { review } = run;
  if (review.findings.length > 0) {
    blockers.push(`diff review reported ${review.findings.length} finding(s): ${[...new Set(review.findings.map((f) => f.rule))].join(', ')}`);
  }
  if (review.changedFiles.length === 0) blockers.push('no files changed');
  if (review.changedFiles.length > policy.maxChangedFiles) {
    blockers.push(`${review.changedFiles.length} files changed (auto-accept limit ${policy.maxChangedFiles})`);
  }
  if (review.diffBytes > policy.maxDiffBytes) blockers.push(`diff is ${review.diffBytes} bytes (auto-accept limit ${policy.maxDiffBytes})`);
  for (const file of review.changedFiles) {
    if (file.status !== 'A' && file.status !== 'M') blockers.push(`${file.path} has change type ${file.status} (only added or modified files qualify)`);
    if (file.mode !== '100644') blockers.push(`${file.path} has file mode ${file.mode}`);
    if (!policy.paths.some((prefix) => underPrefix(file.path, prefix))) {
      blockers.push(`${file.path} is outside config.autonomy.autoAccept.paths (${policy.paths.join(', ')})`);
    }
    const topic = sensitiveTopic(file.path.replace(/[/._-]+/g, ' '));
    if (topic !== undefined) blockers.push(`${file.path} looks security-sensitive ("${topic}")`);
  }

  const topic = sensitiveTopic([task.title, task.description, ...task.acceptanceCriteria].join('\n'));
  if (topic !== undefined) blockers.push(`task text mentions a security-sensitive topic ("${topic}")`);

  if (blockers.length > 0) return { accept: false, reasons: blockers };
  return {
    accept: true,
    reasons: [
      `${review.changedFiles.length} added/modified file(s) under ${policy.paths.join(', ')}`,
      `${review.diffBytes} diff bytes`,
      `checks passed: ${run.validation!.map((v) => v.name).join(', ')}`,
      'no review findings, no repairs, task listed in autoAccept.taskIds',
    ],
  };
}
