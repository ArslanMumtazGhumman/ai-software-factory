import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { PathSafetyError, ValidationError } from '../core/errors.js';
import { defaultGitRunner, type GitRunner } from '../git/gitWorkspace.js';
import { isInside } from '../security/paths.js';

/** What the factory learned about an existing codebase, read-only. */
export interface CodebaseSummary {
  path: string;
  isGitRepo: boolean;
  branch: string | null;
  head: string | null;
  /** Uncommitted or untracked changes (the runner refuses to start until they are committed or stashed). */
  uncommittedChanges: number;
  topLevel: string[];
  fileCounts: Record<string, number>;
  packageJson: { name: string | null; scripts: string[]; dependencies: string[] } | null;
  /** The project already has factory state; initializing it again would overwrite it. */
  hasFactoryState: boolean;
  problems: string[];
}

const SKIP = new Set(['.git', 'node_modules', '.factory', 'dist', 'build', 'out', '.next', 'coverage', 'target', 'bin', 'obj', '.gradle', 'Pods']);
const MAX_FILES = 5000;

/**
 * Resolve an existing codebase path and make sure it is inside one of the
 * workspace's allowed roots (after resolving links). Returns the real path.
 */
export async function resolveExistingCodebase(given: string, allowedRoots: readonly string[]): Promise<string> {
  if (!path.isAbsolute(given)) throw new ValidationError('The existing codebase path must be absolute (e.g. C:\\code\\my-app).');
  if (allowedRoots.length === 0) {
    throw new PathSafetyError('Extending existing codebases is not enabled: add the parent folder to "existingProjectRoots" in the workspace file.');
  }
  let real: string;
  try {
    real = await realpath(given);
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ValidationError(`The existing codebase ${given} is not an accessible folder.`);
  }
  for (const root of allowedRoots) {
    const realRoot = await realpath(root).catch(() => path.resolve(root));
    if (isInside(realRoot, real) && path.relative(realRoot, real) !== '') return real;
  }
  throw new PathSafetyError(`${given} is not inside an allowed folder (${allowedRoots.join(', ')}).`);
}

/** Inspect structure and git state without changing anything. */
export async function inspectCodebase(dir: string, git: GitRunner = defaultGitRunner): Promise<CodebaseSummary> {
  const problems: string[] = [];
  const safe = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false'];
  const top = await git([...safe, 'rev-parse', '--show-toplevel'], dir);
  const isGitRepo = top.code === 0 && path.resolve(top.stdout.trim()).toLowerCase() === path.resolve(dir).toLowerCase();
  let branch: string | null = null;
  let head: string | null = null;
  let uncommittedChanges = 0;
  if (!isGitRepo) {
    problems.push(top.code === 0 ? 'the folder is inside a git repository but is not its top level' : 'the folder is not a git repository (run "git init" and commit first)');
  } else {
    const h = await git([...safe, 'rev-parse', '--verify', 'HEAD'], dir);
    if (h.code === 0) head = h.stdout.trim();
    else problems.push('the repository has no commits yet');
    const b = await git([...safe, 'symbolic-ref', '--short', '-q', 'HEAD'], dir);
    branch = b.code === 0 ? b.stdout.trim() : null;
    const s = await git([...safe, 'status', '--porcelain=v1', '--untracked-files=all'], dir);
    uncommittedChanges = s.stdout.split('\n').filter((l) => l.trim() !== '' && !/^.. \.factory\//.test(l)).length;
  }

  const fileCounts: Record<string, number> = {};
  let seen = 0;
  const walk = async (d: string, depth: number) => {
    if (depth > 6 || seen >= MAX_FILES) return;
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (seen >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) await walk(path.join(d, entry.name), depth + 1);
      } else if (entry.isFile()) {
        seen += 1;
        const ext = path.extname(entry.name).toLowerCase() || '(none)';
        fileCounts[ext] = (fileCounts[ext] ?? 0) + 1;
      }
    }
  };
  await walk(dir, 0);
  const topLevel = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.name !== '.git')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .slice(0, 100);

  let packageJson: CodebaseSummary['packageJson'] = null;
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    const keys = (v: unknown) => (typeof v === 'object' && v !== null ? Object.keys(v).slice(0, 80) : []);
    packageJson = { name: typeof pkg.name === 'string' ? pkg.name : null, scripts: keys(pkg.scripts), dependencies: [...keys(pkg.dependencies), ...keys(pkg.devDependencies)] };
  } catch {
    /* no package.json */
  }
  const hasFactoryState = await stat(path.join(dir, '.factory', 'project.json')).then(() => true, () => false);
  return { path: dir, isGitRepo, branch, head, uncommittedChanges, topLevel, fileCounts, packageJson, hasFactoryState, problems };
}
