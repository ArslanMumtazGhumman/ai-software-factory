import type { ExecutionConfig } from '../config/factoryConfig.js';
import type { ChangedFile, ReviewFinding } from '../persistence/runStore.js';
import { findSecretLikeContent } from '../security/redact.js';

/** Paths no agent change may ever touch, in addition to the data directory and config.execution.protectedPaths. */
export const BUILT_IN_PROTECTED_PATHS: readonly string[] = ['.git', '.github', '.claude', '.gitmodules', '.gitattributes'];

const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(npmrc|pypirc|netrc|git-credentials|htpasswd)$/i,
  /credentials/i,
  /secrets?\.(json|ya?ml|toml|ini|txt)$/i,
];

export function isSensitivePath(repoPath: string): boolean {
  const base = repoPath.split('/').pop() ?? repoPath;
  return SENSITIVE_NAME_PATTERNS.some((p) => p.test(base));
}

export function underPrefix(repoPath: string, prefix: string): boolean {
  const clean = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (clean === '' || clean === '.') return true;
  const a = process.platform === 'win32' ? repoPath.toLowerCase() : repoPath;
  const b = process.platform === 'win32' ? clean.toLowerCase() : clean;
  return a === b || a.startsWith(`${b}/`);
}

function hasGitSegment(repoPath: string): boolean {
  return repoPath.split('/').some((seg) => seg.toLowerCase() === '.git');
}

export interface DiffReviewInput {
  changedFiles: readonly ChangedFile[];
  patch: string;
  ignoredFiles: readonly string[];
  /** Repo-relative POSIX path of the factory data directory. */
  dataDirRel: string;
  policy: Pick<ExecutionConfig, 'allowedPaths' | 'protectedPaths' | 'maxChangedFiles' | 'maxDiffBytes' | 'allowDeletions'>;
}

/**
 * Inspect an agent's changes. Passing tests are not enough: any `violation`
 * makes the run fail; `warning`s are shown to the human reviewer.
 */
export function reviewChanges(input: DiffReviewInput): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const violation = (rule: string, message: string, path?: string) =>
    findings.push({ severity: 'violation', rule, message, ...(path !== undefined ? { path } : {}) });
  const warning = (rule: string, message: string, path?: string) =>
    findings.push({ severity: 'warning', rule, message, ...(path !== undefined ? { path } : {}) });

  const { changedFiles, policy } = input;
  if (changedFiles.length === 0) violation('no-changes', 'The agent made no changes.');
  if (changedFiles.length > policy.maxChangedFiles) {
    violation('too-many-files', `${changedFiles.length} files changed (limit ${policy.maxChangedFiles}).`);
  }
  const diffBytes = Buffer.byteLength(input.patch, 'utf8');
  if (diffBytes > policy.maxDiffBytes) violation('diff-too-large', `Diff is ${diffBytes} bytes (limit ${policy.maxDiffBytes}).`);

  const protectedPrefixes = [...BUILT_IN_PROTECTED_PATHS, input.dataDirRel, ...policy.protectedPaths];

  for (const file of changedFiles) {
    const paths = file.oldPath !== undefined ? [file.path, file.oldPath] : [file.path];
    for (const p of paths) {
      if (hasGitSegment(p) || protectedPrefixes.some((prefix) => underPrefix(p, prefix))) {
        violation('protected-path', `Change to protected path ${p}.`, p);
      }
      if (isSensitivePath(p)) violation('sensitive-file', `Change to a sensitive file ${p}.`, p);
      if (policy.allowedPaths.length > 0 && !policy.allowedPaths.some((prefix) => underPrefix(p, prefix))) {
        violation('out-of-scope', `${p} is outside the allowed paths (${policy.allowedPaths.join(', ')}).`, p);
      }
    }
    if (file.status === 'D' && !policy.allowDeletions) violation('deletion', `File deleted: ${file.path}.`, file.path);
    if (file.status === 'R' && !policy.allowDeletions) warning('rename', `File renamed from ${file.oldPath} to ${file.path}.`, file.path);
    if (file.mode === '120000') violation('symlink', `Symbolic link created or changed: ${file.path}.`, file.path);
    if (file.mode === '160000') violation('submodule', `Submodule (gitlink) change: ${file.path}.`, file.path);
    if (file.mode === '100755') warning('executable', `File is executable: ${file.path}.`, file.path);
    if (file.path.split('/').pop() === '.gitignore') warning('gitignore', `.gitignore changed: ${file.path}.`, file.path);
  }

  const addedLines = input.patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  for (const kind of findSecretLikeContent(addedLines)) {
    violation('secret-content', `Added content looks like a secret (${kind}).`);
  }

  for (const file of input.ignoredFiles) {
    if (isSensitivePath(file)) violation('sensitive-ignored-file', `Git-ignored sensitive file created: ${file}.`, file);
  }
  if (input.ignoredFiles.length > 0) {
    const shown = input.ignoredFiles.slice(0, 10).join(', ');
    warning('ignored-files', `${input.ignoredFiles.length} git-ignored file(s) exist in the worktree and are not part of the diff: ${shown}`);
  }
  return findings;
}
