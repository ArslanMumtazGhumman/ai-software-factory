import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentExecutionHooks, AgentInvocationPlan, AgentRunResult, AgentTaskRequest, CodingAgent } from '../src/agents/codingAgent.js';
import { parseFactoryConfig, type FactoryConfig } from '../src/config/factoryConfig.js';
import { ProjectRepository } from '../src/persistence/projectRepository.js';
import type { Task } from '../src/tasks/task.js';
import { makeTask, makeTempDir, sampleProject } from './helpers.js';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export const STUB = "export function greet(name) {\n  throw new Error('not implemented');\n}\n";
export const GOOD = 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n';
export const BAD = 'export function greet(name) {\n  return `Bye, ${name}`;\n}\n';
const TEST_FILE = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { greet } from '../src/greet.js';",
  "test('greets', () => assert.equal(greet('Ada'), 'Hello, Ada!'));",
  '',
].join('\n');

/** A pid that is guaranteed not to be running (a process that already exited). */
export function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid!;
}

export interface Fixture {
  dir: string;
  cleanup: () => Promise<void>;
  config: FactoryConfig;
  repository: ProjectRepository;
  head: string;
  /** The raw config object (projectRoot ".", relative to dir). */
  rawConfig: Record<string, unknown>;
}

/**
 * Disposable git repository with a stubbed greet() and a deterministic test.
 * Task T1 implements greet; T2 depends on T1.
 */
export async function makeFixture(
  overrides: {
    config?: Record<string, unknown>;
    tasks?: Task[];
    execution?: Record<string, unknown>;
    autonomy?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  } = {},
): Promise<Fixture> {
  const { dir, cleanup } = await makeTempDir();
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'test'));
  await writeFile(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  await writeFile(path.join(dir, 'src', 'greet.js'), STUB);
  await writeFile(path.join(dir, 'test', 'greet.test.js'), TEST_FILE);
  await writeFile(path.join(dir, '.gitignore'), 'build/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  const head = git(dir, 'rev-parse', 'HEAD').trim();

  const rawConfig: Record<string, unknown> = {
    version: 1,
    projectRoot: '.',
    limits: { maxRetries: 1, commandTimeoutMs: 60_000, agentTimeoutMs: 60_000, ...(overrides.limits ?? {}) },
    allowedExecutables: ['node'],
    commands: { test: { executable: 'node', args: ['--test', 'test/greet.test.js'] } },
    agent: { permissionMode: 'dontAsk', tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'] },
    execution: { enabled: true, validationCommands: ['test'], ...(overrides.execution ?? {}) },
    ...(overrides.autonomy !== undefined ? { autonomy: overrides.autonomy } : {}),
    ...(overrides.config ?? {}),
  };
  const config = parseFactoryConfig(rawConfig, dir);
  const repository = new ProjectRepository(config.dataDir);
  await repository.saveProject(sampleProject);
  await repository.saveTasks(
    overrides.tasks ?? [
      makeTask('T1', { title: 'Implement greet', description: 'Make greet return "Hello, <name>!"' }),
      makeTask('T2', { dependencies: ['T1'] }),
    ],
  );
  return { dir, cleanup, config, repository, head, rawConfig };
}

export type AgentBehavior = (cwd: string, hooks: AgentExecutionHooks, request?: AgentTaskRequest) => Promise<AgentRunResult>;

/** Test double that edits files directly instead of running Claude Code. */
export class FakeAgent implements CodingAgent {
  readonly name = 'fake-agent';
  calls: string[] = [];
  /** Every request planned, in order (includes repair context when present). */
  requests: AgentTaskRequest[] = [];
  /** Timeout of each executed plan, in order. */
  timeouts: number[] = [];

  constructor(private readonly behavior: AgentBehavior) {}

  plan(request: AgentTaskRequest): AgentInvocationPlan {
    this.requests.push(request);
    return { agent: this.name, executable: 'none', args: [], stdin: request.task.description, cwd: request.workingDirectory, timeoutMs: 60_000 };
  }

  async execute(plan: AgentInvocationPlan, hooks: AgentExecutionHooks = {}): Promise<AgentRunResult> {
    this.calls.push(plan.cwd);
    this.timeouts.push(plan.timeoutMs);
    return this.behavior(plan.cwd, hooks, this.requests[this.requests.length - 1]!);
  }
}

export const ok = (summary = 'done'): AgentRunResult => ({ outcome: 'success', summary });

export function writesFile(rel: string, content: string, result: AgentRunResult = ok()): AgentBehavior {
  return async (cwd) => {
    await mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
    await writeFile(path.join(cwd, rel), content);
    return result;
  };
}

// ----------------------------------------------------------- dependency chain
// T1 implements greet; T2 adds farewell (imports greet); T3 combines both.
// A later task's checks only pass if the earlier tasks' accepted work is in its base.

export const FAREWELL = "import { greet } from './greet.js';\nexport function farewell(name) {\n  return greet(name).replace('Hello', 'Goodbye');\n}\n";
export const FAREWELL_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { farewell } from '../src/farewell.js';",
  "test('farewell', () => assert.equal(farewell('Ada'), 'Goodbye, Ada!'));",
  '',
].join('\n');
export const BOTH = "import { greet } from './greet.js';\nimport { farewell } from './farewell.js';\nexport const both = (name) => greet(name) + ' ' + farewell(name);\n";
export const BOTH_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { both } from '../src/both.js';",
  "test('both', () => assert.equal(both('Ada'), 'Hello, Ada! Goodbye, Ada!'));",
  '',
].join('\n');

export const CHAIN_WORK: Record<string, Record<string, string>> = {
  T1: { 'src/greet.js': GOOD },
  T2: { 'src/farewell.js': FAREWELL, 'test/farewell.test.js': FAREWELL_TEST },
  T3: { 'src/both.js': BOTH, 'test/both.test.js': BOTH_TEST },
};

export function chainTasks(): Task[] {
  return [
    makeTask('T1', { title: 'Implement greet', description: 'Make greet return "Hello, <name>!"', acceptanceCriteria: ['greet test passes'] }),
    makeTask('T2', { title: 'Add farewell', description: 'Add farewell built on greet', dependencies: ['T1'], acceptanceCriteria: ['farewell test passes'] }),
    makeTask('T3', { title: 'Combine greetings', description: 'Add both() using greet and farewell', dependencies: ['T2'], acceptanceCriteria: ['both test passes'] }),
  ];
}

/** Writes the chain files for whichever task is requested. */
export async function writeChainWork(cwd: string, taskId: string): Promise<void> {
  for (const [rel, content] of Object.entries(CHAIN_WORK[taskId] ?? {})) {
    await mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
    await writeFile(path.join(cwd, rel), content);
  }
}

export const chainAgent: AgentBehavior = async (cwd, _hooks, request) => {
  const taskId = request?.task.id ?? '';
  await writeChainWork(cwd, taskId);
  return ok(`implemented ${taskId}`);
};

export const AUTONOMY_ON = {
  enabled: true,
  autoAccept: { enabled: true, taskIds: ['T1', 'T2', 'T3'], paths: ['src', 'test'] },
};

/** Fixture for autonomous runs: three chained tasks, all tests as the check, autonomy on. */
export function makeChainFixture(overrides: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  return makeFixture({
    tasks: chainTasks(),
    autonomy: AUTONOMY_ON,
    ...overrides,
    limits: { maxTasksPerRun: 10, ...(overrides.limits ?? {}) },
    config: { commands: { test: { executable: 'node', args: ['--test'] } }, ...(overrides.config ?? {}) },
  });
}
