import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../agents/claudeCodeAdapter.js';
import type { CodingAgent } from '../agents/codingAgent.js';
import { loadFactoryConfig, type FactoryConfig } from '../config/factoryConfig.js';
import { PathSafetyError, ValidationError, describeError } from '../core/errors.js';
import { AutonomousRunner } from '../orchestrator/autonomousRunner.js';
import { Supervisor } from '../orchestrator/supervisor.js';
import { AutoRunStore } from '../persistence/autoRunStore.js';
import { FileLock } from '../persistence/fileLock.js';
import { ProjectRepository } from '../persistence/projectRepository.js';
import { RunStore } from '../persistence/runStore.js';
import { isInside } from '../security/paths.js';

/** Opaque project id used in dashboard URLs; never a path. */
export const PROJECT_ID = /^[0-9a-f]{12}$/;
export const MAX_PROJECTS = 20;

/**
 * One project the dashboard may show, with the same services the CLI builds
 * for it. Every path the dashboard touches derives from this validated config.
 */
export interface DashboardProject {
  id: string;
  configFile: string;
  config: FactoryConfig;
  repository: ProjectRepository;
  lock: FileLock;
  runs: RunStore;
  store: AutoRunStore;
  supervisor: Supervisor;
  runner: AutonomousRunner;
}

export interface ProjectServiceOptions {
  /** Test seam: the coding agent (default: the Claude Code adapter, as in the CLI). */
  agent?: (config: FactoryConfig) => CodingAgent;
  now?: () => Date;
  log?: (line: string) => void;
}

export function projectIdFor(configFile: string): string {
  const key = process.platform === 'win32' ? configFile.toLowerCase() : configFile;
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

/** Build the existing orchestrator services for one loaded config, exactly as the CLI does. */
export function createProject(configFile: string, config: FactoryConfig, options: ProjectServiceOptions = {}): DashboardProject {
  const repository = new ProjectRepository(config.dataDir);
  const lock = new FileLock(config.dataDir);
  const agent =
    options.agent?.(config) ??
    new ClaudeCodeAdapter(config.agent, config.limits, config.projectRoot, { executionEnabled: config.execution.enabled });
  const log = options.log ?? (() => undefined);
  const now = options.now !== undefined ? { now: options.now } : {};
  const supervisor = new Supervisor({ config, repository, agent, lock, log, ...now });
  const runner = new AutonomousRunner({ config, repository, supervisor, lock, log, ...now });
  return {
    id: projectIdFor(configFile),
    configFile,
    config,
    repository,
    lock,
    runs: new RunStore(config.dataDir),
    store: new AutoRunStore(config.dataDir),
    supervisor,
    runner,
  };
}

/**
 * Load the projects named on the dashboard command line. Projects can only be
 * added this way: the web UI never accepts a filesystem path.
 *
 * Each config is validated by the normal config loader (which confines the
 * data directory to the project root); in addition the real (symlink-resolved)
 * data directory must still be inside the real project root, and no two
 * projects may share a config file or data directory.
 */
export async function loadProjects(configPaths: readonly string[], options: ProjectServiceOptions = {}): Promise<DashboardProject[]> {
  if (configPaths.length === 0) throw new ValidationError('The dashboard needs at least one --config <path>.');
  if (configPaths.length > MAX_PROJECTS) throw new ValidationError(`At most ${MAX_PROJECTS} projects can be shown.`);
  const projects: DashboardProject[] = [];
  const seenData = new Map<string, string>();
  for (const given of configPaths) {
    if (path.extname(given).toLowerCase() !== '.json') throw new ValidationError(`Config file must be a .json file (got ${given})`);
    let configFile: string;
    try {
      configFile = await realpath(path.resolve(given));
    } catch (err) {
      throw new ValidationError(`Cannot open config file ${path.resolve(given)}: ${describeError(err)}`);
    }
    const id = projectIdFor(configFile);
    if (projects.some((p) => p.id === id)) throw new ValidationError(`Config file ${configFile} is listed more than once.`);
    const config = await loadFactoryConfig(configFile);

    const root = await realDirectory(config.projectRoot, 'projectRoot');
    const dataDir = await realpath(config.dataDir).catch(() => config.dataDir);
    if (!isInside(root, dataDir)) {
      throw new PathSafetyError(`config.dataDir of ${configFile} resolves outside its project root ${root}`);
    }
    const key = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir;
    const other = seenData.get(key);
    if (other !== undefined) throw new ValidationError(`${configFile} and ${other} use the same data directory ${dataDir}.`);
    seenData.set(key, configFile);
    projects.push(createProject(configFile, config, options));
  }
  return projects;
}

async function realDirectory(dir: string, label: string): Promise<string> {
  try {
    const real = await realpath(dir);
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
    return real;
  } catch (err) {
    throw new ValidationError(`config.${label} ${dir} is not an accessible directory (${describeError(err)})`);
  }
}
