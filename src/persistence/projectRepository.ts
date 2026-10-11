import path from 'node:path';
import { ValidationError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { parseProjectSpec, type ProjectSpec } from '../project/projectSpec.js';
import { assertValidDependencies } from '../tasks/dependencyGraph.js';
import { parseTaskList, type Task } from '../tasks/task.js';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile.js';

export const TASKS_SCHEMA_VERSION = 1;
export const PROJECT_FILE = 'project.json';
export const TASKS_FILE = 'tasks.json';

/** On-disk shape of tasks.json. The version allows future migrations. */
export interface TasksDocument {
  schemaVersion: typeof TASKS_SCHEMA_VERSION;
  tasks: Task[];
}

function parseTasksDocument(raw: unknown): Task[] {
  if (!isRecord(raw)) throw new ValidationError('tasks file must be a JSON object');
  if (raw.schemaVersion !== TASKS_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported tasks schemaVersion ${String(raw.schemaVersion)} (expected ${TASKS_SCHEMA_VERSION})`);
  }
  const tasks = parseTaskList(raw.tasks);
  assertValidDependencies(tasks);
  return tasks;
}

/**
 * JSON-backed storage for one project's spec and tasks, rooted at the
 * configured data directory. Every load validates; every save validates
 * before writing, so invalid state is never persisted.
 */
export class ProjectRepository {
  readonly projectFile: string;
  readonly tasksFile: string;

  constructor(readonly dataDir: string) {
    this.projectFile = path.join(dataDir, PROJECT_FILE);
    this.tasksFile = path.join(dataDir, TASKS_FILE);
  }

  loadProject(): Promise<ProjectSpec> {
    return readJsonFile(this.projectFile, parseProjectSpec);
  }

  async saveProject(spec: ProjectSpec): Promise<void> {
    await writeJsonFileAtomic(this.projectFile, parseProjectSpec(spec));
  }

  loadTasks(): Promise<Task[]> {
    return readJsonFile(this.tasksFile, parseTasksDocument);
  }

  async saveTasks(tasks: readonly Task[]): Promise<void> {
    const validated = parseTaskList(tasks);
    assertValidDependencies(validated);
    const doc: TasksDocument = { schemaVersion: TASKS_SCHEMA_VERSION, tasks: validated };
    await writeJsonFileAtomic(this.tasksFile, doc);
  }
}
