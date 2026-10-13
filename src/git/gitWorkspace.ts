import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import path from 'node:path';
import { GitIsolationError } from '../core/errors.js';
import { isInside } from '../security/paths.js';
import { buildSafeEnv } from '../security/redact.js';
import type { ChangedFile } from '../persistence/runStore.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd`. Injectable for tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/** Default runner: no shell, minimal environment, no prompts, bounded output. */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...buildSafeEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        shell: false,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        timeout: 120_000,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === -1 ? err.message : '')) });
      },
    );
  });

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/** State of an isolated worktree, captured after staging all changes in the worktree's own index. */
export interface WorktreeSnapshot {
  headCommit: string;
  /** Tree object of the fully staged worktree; identical content gives an identical sha. */
  treeSha: string;
  changedFiles: ChangedFile[];
  patch: string;
  /** Untracked files hidden by .gitignore (not part of the diff). */
  ignoredFiles: string[];
}

async function canonical(p: string): Promise<string> {
  let resolved = path.resolve(p);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    /* keep the resolved path */
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Git operations for supervised execution. Every mutating operation targets a
 * dedicated worktree under `<dataDir>/worktrees`; the user's working tree,
 * index and branches are only read. Repository hooks and fsmonitor are
 * disabled for every git call the factory makes.
 */
export class GitWorkspace {
  private readonly safety: string[];

  constructor(
    readonly projectRoot: string,
    readonly dataDir: string,
    private readonly git: GitRunner = defaultGitRunner,
  ) {
    // A hooks path that never exists, so no repository hook can run.
    this.safety = ['-c', `core.hooksPath=${path.join(dataDir, 'no-hooks')}`, '-c', 'core.fsmonitor=false'];
  }

  private async run(args: string[], cwd: string, what: string): Promise<string> {
    const result = await this.git([...this.safety, ...args], cwd);
    if (result.code !== 0) {
      throw new GitIsolationError(`${what} failed (git ${args.join(' ')}): ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return result.stdout;
  }

  /** Repo-relative POSIX path of the data directory. */
  get dataDirRel(): string {
    return toPosix(path.relative(this.projectRoot, this.dataDir));
  }

  /**
   * Verify the repository can be used for an isolated run and return the base
   * commit. Refuses (never repairs) when anything is unexpected.
   */
  async preflight(): Promise<{ headCommit: string }> {
    const version = await this.git(['--version'], this.projectRoot);
    if (version.code !== 0) throw new GitIsolationError('git is not available on PATH; cannot isolate execution.');

    if (!this.dataDirRel || this.dataDirRel === '.' || this.dataDirRel.startsWith('..')) {
      throw new GitIsolationError('config.dataDir must be a subdirectory of the project root for isolated execution.');
    }

    const top = await this.git(['rev-parse', '--show-toplevel'], this.projectRoot);
    if (top.code !== 0) throw new GitIsolationError(`Project root ${this.projectRoot} is not inside a git repository.`);
    if ((await canonical(top.stdout.trim())) !== (await canonical(this.projectRoot))) {
      throw new GitIsolationError(
        `Project root must be the repository top level (${top.stdout.trim()}), so the whole project is isolated in a worktree.`,
      );
    }

    const head = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], this.projectRoot);
    if (head.code !== 0) throw new GitIsolationError('Repository has no commits yet; commit a starting point first.');

    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
      const markerPath = (await this.run(['rev-parse', '--git-path', marker], this.projectRoot, 'Locating git state')).trim();
      const absolute = path.resolve(this.projectRoot, markerPath);
      if (await exists(absolute)) {
        throw new GitIsolationError(`A git operation is in progress (${marker}); finish or abort it before executing.`);
      }
    }

    const dirty = await this.uncommittedChanges();
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 20).join('\n  ');
      throw new GitIsolationError(
        `Repository has uncommitted changes. Commit or stash them yourself first; the factory never modifies them:\n  ${shown}${
          dirty.length > 20 ? `\n  ... and ${dirty.length - 20} more` : ''
        }`,
      );
    }
    return { headCommit: head.stdout.trim() };
  }

  /** Uncommitted changes in the main working tree, excluding the factory's own data directory. */
  async uncommittedChanges(): Promise<string[]> {
    const out = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], this.projectRoot, 'Checking status');
    const tokens = out.split('\0').filter((t) => t.length > 0);
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i]!;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code.includes('R') || code.includes('C')) i++; // rename/copy: next token is the source path
      if (!this.isInDataDir(file)) paths.push(`${code} ${file}`);
    }
    return paths;
  }

  isInDataDir(repoPath: string): boolean {
    const rel = this.dataDirRel;
    return repoPath === rel || repoPath.startsWith(`${rel}/`);
  }

  /** Create a new branch and worktree for one run, then verify it is isolated and clean. */
  async createWorktree(worktreePath: string, taskId: string, runId: string, baseCommit: string): Promise<WorktreeInfo> {
    const worktreesRoot = path.join(this.dataDir, 'worktrees');
    if (!isInside(worktreesRoot, worktreePath) || path.resolve(worktreePath) === path.resolve(worktreesRoot)) {
      throw new GitIsolationError(`Worktree path ${worktreePath} is outside ${worktreesRoot}`);
    }
    if (await exists(worktreePath)) throw new GitIsolationError(`Worktree path already exists: ${worktreePath}`);

    const branch = `asf/${taskId.replace(/[^A-Za-z0-9_-]/g, '-')}/${runId}`;
    await this.run(['check-ref-format', '--branch', branch], this.projectRoot, 'Validating branch name');
    const existing = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.projectRoot);
    if (existing.code === 0) throw new GitIsolationError(`Branch ${branch} already exists`);

    await this.run(['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseCommit], this.projectRoot, 'Creating worktree');

    const top = (await this.run(['rev-parse', '--show-toplevel'], worktreePath, 'Verifying worktree')).trim();
    if ((await canonical(top)) !== (await canonical(worktreePath))) {
      throw new GitIsolationError(`Worktree verification failed: ${worktreePath} resolves to repository ${top}`);
    }
    const head = (await this.run(['rev-parse', 'HEAD'], worktreePath, 'Verifying worktree')).trim();
    if (head !== baseCommit) throw new GitIsolationError(`Worktree HEAD ${head} does not match base commit ${baseCommit}`);
    const status = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktreePath, 'Verifying worktree');
    if (status.length > 0) throw new GitIsolationError('Freshly created worktree is not clean; refusing to continue.');
    return { path: worktreePath, branch };
  }

  /**
   * Stage everything in the worktree's own index and describe the result
   * relative to `baseCommit`. Only the isolated worktree is touched.
   */
  async snapshot(worktreePath: string, baseCommit: string): Promise<WorktreeSnapshot> {
    if (!(await exists(worktreePath))) throw new GitIsolationError(`Worktree ${worktreePath} no longer exists`);
    const top = (await this.run(['rev-parse', '--show-toplevel'], worktreePath, 'Locating worktree')).trim();
    if ((await canonical(top)) !== (await canonical(worktreePath))) {
      throw new GitIsolationError(`${worktreePath} is no longer a worktree root (resolves to ${top})`);
    }
    const headCommit = (await this.run(['rev-parse', 'HEAD'], worktreePath, 'Reading worktree HEAD')).trim();
    await this.run(['add', '--all'], worktreePath, 'Staging worktree changes');
    const treeSha = (await this.run(['write-tree'], worktreePath, 'Writing tree')).trim();
    const raw = await this.run(
      ['diff', '--cached', '--raw', '-z', '-M', '--no-color', '--no-ext-diff', baseCommit],
      worktreePath,
      'Listing changes',
    );
    const patch = await this.run(
      ['diff', '--cached', '--binary', '-M', '--no-color', '--no-ext-diff', '--no-textconv', baseCommit],
      worktreePath,
      'Computing diff',
    );
    // Individual files (not collapsed directories), so a sensitive file inside an ignored folder is still seen.
    const ignoredOut = await this.run(
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'],
      worktreePath,
      'Listing ignored files',
    );
    const ignoredFiles = ignoredOut.split('\0').filter((t) => t.length > 0);
    return { headCommit, treeSha, changedFiles: parseRawDiff(raw), patch, ignoredFiles };
  }

  /** Resolve `ref` to a full commit sha, or throw if it is not a commit in this repository. */
  async verifyCommit(ref: string): Promise<string> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(ref) && ref !== 'HEAD') {
      throw new GitIsolationError(`"${ref}" is not a full commit id`);
    }
    const out = await this.git([...this.safety, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], this.projectRoot);
    if (out.code !== 0) throw new GitIsolationError(`Commit ${ref} does not exist in ${this.projectRoot}`);
    return out.stdout.trim();
  }

  /** True when `ancestor` is reachable from (or equal to) `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const out = await this.git([...this.safety, 'merge-base', '--is-ancestor', ancestor, descendant], this.projectRoot);
    if (out.code === 0) return true;
    if (out.code === 1) return false;
    throw new GitIsolationError(`Cannot compare commits ${ancestor} and ${descendant}: ${out.stderr.trim() || `exit ${out.code}`}`);
  }

  /**
   * Commit exactly `treeSha` (the reviewed tree) on the run's own branch, with
   * `parent` as its only parent. Only the factory-owned branch moves; nothing is
   * merged into, or reset on, any user branch. Idempotent if already committed.
   */
  async commitReviewed(worktreePath: string, branch: string, treeSha: string, parent: string, message: string): Promise<string> {
    if (!branch.startsWith('asf/')) throw new GitIsolationError(`Refusing to commit to non-factory branch ${branch}`);
    const current = (await this.run(['symbolic-ref', '--quiet', 'HEAD'], worktreePath, 'Reading worktree branch')).trim();
    if (current !== `refs/heads/${branch}`) throw new GitIsolationError(`Worktree is on ${current}, expected refs/heads/${branch}`);
    const head = (await this.run(['rev-parse', 'HEAD'], worktreePath, 'Reading worktree HEAD')).trim();
    if (head !== parent) {
      if (await this.isCommitOf(worktreePath, head, treeSha, parent)) return head;
      throw new GitIsolationError(`Branch ${branch} moved to ${head}; it no longer matches the reviewed state`);
    }
    const identity = ['-c', 'user.name=AI Software Factory', '-c', 'user.email=factory@localhost'];
    const commit = (
      await this.run([...identity, 'commit-tree', treeSha, '-p', parent, '-m', message], worktreePath, 'Committing reviewed tree')
    ).trim();
    await this.run(['update-ref', `refs/heads/${branch}`, commit, parent], worktreePath, 'Updating run branch');
    return commit;
  }

  /** True when `commit` has exactly `treeSha` as its tree and `parent` as its only parent. */
  async isCommitOf(cwd: string, commit: string, treeSha: string, parent: string): Promise<boolean> {
    const tree = (await this.run(['rev-parse', `${commit}^{tree}`], cwd, 'Reading commit tree')).trim();
    const parents = (await this.run(['rev-list', '--parents', '-n', '1', commit], cwd, 'Reading commit parents')).trim().split(' ');
    return tree === treeSha && parents.length === 2 && parents[1] === parent;
  }
}

/** Parse `git diff --raw -z` output into changed-file entries. */
export function parseRawDiff(raw: string): ChangedFile[] {
  const tokens = raw.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i]!;
    if (!meta.startsWith(':')) continue;
    // :oldmode newmode oldsha newsha status
    const parts = meta.slice(1).split(' ');
    const newMode = parts[1] ?? '';
    const oldMode = parts[0] ?? '';
    const statusField = parts[4] ?? '';
    const status = statusField.charAt(0);
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[++i] ?? '';
      const newPath = tokens[++i] ?? '';
      files.push({ status, path: newPath, oldPath, mode: newMode });
    } else {
      const file = tokens[++i] ?? '';
      files.push({ status, path: file, mode: status === 'D' ? oldMode : newMode });
    }
  }
  return files;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }
}
