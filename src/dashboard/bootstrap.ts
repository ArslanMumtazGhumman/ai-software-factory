import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { describeError } from '../core/errors.js';
import type { GitRunner } from '../git/gitWorkspace.js';
import { createPlanner, type ProductPlanner } from '../planning/planner.js';
import { PlanningService } from '../planning/planningService.js';
import { loadWorkspaceConfig } from '../planning/workspace.js';
import { CliRunLauncher, type RunLauncher } from './launcher.js';
import { loadProjects, type ProjectServiceOptions } from './projects.js';
import { DashboardService } from './service.js';

export interface DashboardSetup {
  /** Config files given on the command line. */
  configPaths: readonly string[];
  /** factory.workspace.json: enables idea-to-project planning and loads the projects it created. */
  workspaceFile?: string;
  launcher?: RunLauncher;
  /** Test seams. */
  planner?: ProductPlanner;
  projectOptions?: ProjectServiceOptions;
  agentAvailable?: (executable: string) => Promise<boolean>;
  git?: GitRunner;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Build the dashboard service: projects from --config plus the projects a
 * workspace's planner created (its registry), and the planning workflow, which
 * adds each newly created project to the running dashboard.
 */
export async function createDashboard(setup: DashboardSetup): Promise<{ service: DashboardService; planning?: PlanningService; warnings: string[] }> {
  const log = setup.log ?? (() => undefined);
  const warnings: string[] = [];
  const workspace = setup.workspaceFile !== undefined ? await loadWorkspaceConfig(setup.workspaceFile) : undefined;

  const key = async (p: string) => {
    const real = await realpath(path.resolve(p)).catch(() => path.resolve(p));
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  const explicit = setup.configPaths.length > 0 ? setup.configPaths : workspace === undefined ? ['factory.config.json'] : [];
  const projects = explicit.length > 0 ? await loadProjects(explicit, setup.projectOptions) : [];
  const seen = new Set(await Promise.all(explicit.map(key)));

  let planning: PlanningService | undefined;
  let service: DashboardService | undefined;
  if (workspace !== undefined) {
    planning = new PlanningService(workspace, {
      planner: setup.planner ?? createPlanner(workspace.planner),
      ...(setup.git !== undefined ? { git: setup.git } : {}),
      ...(setup.now !== undefined ? { now: setup.now } : {}),
      log,
      onProjectReady: async (configFile) => {
        const [project] = await loadProjects([configFile], setup.projectOptions);
        service?.addProject(project!);
        log(`Project ready: ${project!.config.projectRoot}`);
      },
    });
    for (const entry of await planning.store.registry()) {
      const k = await key(entry.configFile);
      if (seen.has(k)) continue;
      seen.add(k);
      try {
        projects.push(...(await loadProjects([entry.configFile], setup.projectOptions)));
      } catch (err) {
        warnings.push(`Skipped registered project ${entry.configFile}: ${describeError(err)}`);
      }
    }
  }

  service = new DashboardService(projects, {
    launcher: setup.launcher ?? new CliRunLauncher(),
    ...(planning !== undefined ? { planning } : {}),
    ...(setup.agentAvailable !== undefined ? { agentAvailable: setup.agentAvailable } : {}),
    ...(setup.now !== undefined ? { now: setup.now } : {}),
  });
  return { service, ...(planning !== undefined ? { planning } : {}), warnings };
}
