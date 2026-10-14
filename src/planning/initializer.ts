import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FactoryError, GitIsolationError, PathSafetyError } from '../core/errors.js';
import { defaultGitRunner, type GitRunner } from '../git/gitWorkspace.js';
import { ProjectRepository } from '../persistence/projectRepository.js';
import { resolveInside } from '../security/paths.js';
import { inspectCodebase } from './codebase.js';
import { DOCUMENT_NAMES, factoryConfigFor, projectSpec, renderDocuments, tasksDocument, type DocumentName } from './documents.js';
import type { ProductPlan } from './model.js';
import { PlanStore, type PlanRecord } from './planStore.js';
import type { WorkspaceConfig } from './workspace.js';

/** The destination already holds something this plan did not create. */
export class DestinationConflictError extends FactoryError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export interface InitializedProject {
  root: string;
  configFile: string;
  initialCommit: string | null;
  actions: string[];
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const IDENTITY = ['-c', 'user.name=AI Software Factory', '-c', 'user.email=factory@localhost'];
const SAFE_GIT = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false'];

/**
 * Choose where a new project goes: `<projectsDir>/<slug>`, with a numeric
 * suffix when that folder is taken by something else. Chosen once per plan.
 */
export async function chooseDestination(workspace: WorkspaceConfig, slug: string, planId: string, taken: readonly string[]): Promise<{ slug: string; destination: string }> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? slug : `${slug}-${n}`.slice(0, 64);
    const destination = resolveInside(workspace.projectsDir, candidate, 'project destination');
    const takenByRegistry = taken.some((t) => path.resolve(t).toLowerCase() === destination.toLowerCase());
    if (takenByRegistry) continue;
    if (!(await exists(destination))) return { slug: candidate, destination };
    const origin = await PlanStore.readOrigin(path.join(destination, '.factory'));
    if (origin?.planId === planId) return { slug: candidate, destination };
  }
  throw new DestinationConflictError(`No free project folder name for "${slug}" in ${workspace.projectsDir}.`);
}

/** Write a file we generate; never replace a file with different content that we did not write in this plan. */
async function writeOwned(file: string, content: string, owned: boolean, actions: string[]): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => undefined);
  if (current === content) return;
  if (current !== undefined && !owned) throw new DestinationConflictError(`${file} already exists with different content; it was not created by this plan.`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  actions.push(`wrote ${file}`);
}

async function saveBacklog(repository: ProjectRepository, plan: ProductPlan, record: PlanRecord, docsDir: string, slug: string, actions: string[]): Promise<void> {
  const tasks = tasksDocument(plan, docsDir).tasks;
  const existing = await repository.loadTasks().catch(() => undefined);
  if (existing !== undefined) {
    const started = existing.filter((t) => t.status !== 'pending' || t.results.length > 0);
    if (started.length > 0) {
      actions.push(`kept the existing backlog (${started.length} task(s) already started)`);
      return;
    }
  }
  await repository.saveProject(projectSpec(plan, slug, record.idea, docsDir));
  await repository.saveTasks(tasks);
  actions.push(`imported ${tasks.length} task(s) into the task engine`);
}

/**
 * Create (or safely resume creating) the project for an approved, validated
 * plan. Every step checks what is already there, so an interrupted
 * initialization can simply be run again: it never creates a second project
 * and never overwrites files it did not create.
 *
 * New project: `<projectsDir>/<slug>` with docs/, factory.config.json, a
 * .gitignore, the factory's project.json/tasks.json in .factory/, a new git
 * repository and one initial commit of the generated files (the factory needs
 * a commit to build isolated worktrees on).
 *
 * Existing codebase: nothing in the user's files or git history changes. The
 * documents, config and backlog go into its .factory/ folder, which the factory
 * already excludes from its clean-repository check.
 */
export async function initializeProject(
  workspace: WorkspaceConfig,
  record: PlanRecord,
  plan: ProductPlan,
  at: string,
  git: GitRunner = defaultGitRunner,
): Promise<InitializedProject> {
  const actions: string[] = [];
  if (record.destination === undefined || record.slug === undefined) throw new PathSafetyError('The plan has no project destination.');
  const root = record.destination;
  const existing = record.existing !== undefined;

  if (!existing) {
    resolveInside(workspace.projectsDir, root, 'project destination');
  } else if (path.resolve(root).toLowerCase() !== path.resolve(record.existing!.path).toLowerCase()) {
    throw new PathSafetyError('The destination of an existing-codebase plan must be the codebase itself.');
  }

  const dataDir = path.join(root, '.factory');
  const origin = await PlanStore.readOrigin(dataDir);
  if (origin !== undefined && origin.planId !== record.planId) {
    throw new DestinationConflictError(`${root} was created by another plan (${origin.planId}).`);
  }
  const ours = origin !== undefined;

  if (existing) {
    const summary = await inspectCodebase(root, git);
    if (!ours && summary.hasFactoryState) throw new DestinationConflictError(`${root} already has factory state (.factory/project.json); it is not overwritten.`);
    if (!summary.isGitRepo || summary.head === null) {
      throw new GitIsolationError(`${root} must be a git repository with at least one commit before the factory can work on it (${summary.problems.join('; ')}).`);
    }
  } else if (!ours && (await exists(root))) {
    const entries = await readdir(root).catch(() => [] as string[]);
    if (entries.length > 0) throw new DestinationConflictError(`${root} already exists and is not empty; it was not created by this plan.`);
  }

  // 1. Claim the folder first, so a retry recognises it as ours.
  if (!ours) {
    await PlanStore.writeOrigin(dataDir, record.planId, at);
    actions.push(`claimed ${root}`);
  }

  // 2. Documents and config.
  const docsDir = existing ? '.factory/docs' : 'docs';
  const docs = renderDocuments(plan, record.idea, record.proposal, record.decision?.at ?? record.createdAt, docsDir);
  const head = existing ? record.existing!.head : await currentHead(root, git);
  // Files of a new project may be (re)written until the initial commit exists.
  const ownedFiles = !existing && head === null;
  for (const name of DOCUMENT_NAMES as readonly DocumentName[]) {
    await writeOwned(path.join(root, ...docsDir.split('/'), name), docs[name], existing || ownedFiles, actions);
  }
  const configDir = existing ? dataDir : root;
  const config = factoryConfigFor(plan, workspace, existing ? { projectRoot: '..', dataDir: '.factory', configDir } : { projectRoot: '.', dataDir: '.factory', configDir });
  const configFile = path.join(configDir, 'factory.config.json');
  await writeOwned(configFile, `${JSON.stringify(config, null, 2)}\n`, existing || ownedFiles, actions);
  if (!existing) {
    await writeOwned(path.join(root, '.gitignore'), '# Factory state and installed dependencies are never committed.\n.factory/\nnode_modules/\n.env\n.env.*\n', ownedFiles, actions);
    await writeOwned(
      path.join(root, 'README.md'),
      `# ${plan.product.name}\n\n${plan.product.valueProposition}\n\nPlanned by the AI Software Factory. The specification is in docs/ and the backlog in docs/TASKS.json.\n`,
      ownedFiles,
      actions,
    );
  }

  // 3. Register the backlog with the existing task engine.
  await saveBacklog(new ProjectRepository(dataDir), plan, record, docsDir, record.slug, actions);

  // 4. Git: a new repository with one commit of the generated files. Existing repositories are never touched.
  let initialCommit: string | null = head;
  if (!existing) {
    if (!(await exists(path.join(root, '.git')))) {
      await gitOk(git, ['init', '-q'], root, 'git init');
      actions.push('initialized a git repository');
    }
    if (head === null) {
      await gitOk(git, [...SAFE_GIT, 'add', '--', 'docs', 'factory.config.json', '.gitignore', 'README.md'], root, 'git add');
      await gitOk(git, [...SAFE_GIT, ...IDENTITY, 'commit', '-q', '-m', `Plan ${plan.product.name}\n\nGenerated by the AI Software Factory planner (plan ${record.planId}).`], root, 'git commit');
      initialCommit = await currentHead(root, git);
      actions.push(`created the initial commit ${initialCommit}`);
    }
    const status = await git([...SAFE_GIT, 'status', '--porcelain=v1', '--untracked-files=all'], root);
    const dirty = status.stdout.split('\n').filter((l) => l.trim() !== '');
    if (dirty.length > 0) throw new GitIsolationError(`The new repository has uncommitted changes after initialization: ${dirty.slice(0, 5).join(', ')}`);
  }
  return { root, configFile, initialCommit, actions };
}

async function currentHead(root: string, git: GitRunner): Promise<string | null> {
  if (!(await exists(path.join(root, '.git')))) return null;
  const r = await git([...SAFE_GIT, 'rev-parse', '--verify', '-q', 'HEAD'], root);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function gitOk(git: GitRunner, args: string[], cwd: string, label: string): Promise<void> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new GitIsolationError(`${label} failed: ${r.stderr.trim().slice(0, 500)}`);
}
