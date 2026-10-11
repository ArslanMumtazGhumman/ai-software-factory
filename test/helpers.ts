import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFactoryConfig, type FactoryConfig } from '../src/config/factoryConfig.js';
import type { ProjectSpec } from '../src/project/projectSpec.js';
import type { Task } from '../src/tasks/task.js';

export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Description of ${id}`,
    dependencies: [],
    acceptanceCriteria: [`${id} works`],
    status: 'pending',
    retryCount: 0,
    results: [],
    ...overrides,
  };
}

export const sampleProject: ProjectSpec = {
  id: 'sample',
  name: 'Sample',
  description: 'A sample project',
  goals: ['Be useful'],
  constraints: ['No network'],
};

export function makeConfig(projectRoot: string, raw: Record<string, unknown> = {}): FactoryConfig {
  return parseFactoryConfig({ version: 1, projectRoot, ...raw }, projectRoot);
}

/** Create an isolated temp directory under the OS temp folder; returns a cleanup fn for the test's own dir. */
export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'asf-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
