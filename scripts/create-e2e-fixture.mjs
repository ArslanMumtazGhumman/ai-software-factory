#!/usr/bin/env node
// Creates a disposable git repository for the supervised-execution end-to-end test.
//
//   node scripts\create-e2e-fixture.mjs <empty-or-new-directory>
//
// The fixture contains a stubbed greet() with a deterministic node:test test,
// a factory config with execution and autonomy enabled, and three tasks
// (T2 depends on T1; T3 depends on T1 and T2).
// It refuses to touch a directory that already exists and is not empty.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/create-e2e-fixture.mjs <new-directory>');
  process.exit(2);
}
const dir = path.resolve(target);
try {
  if ((await readdir(dir)).length > 0) {
    console.error(`Refusing to use ${dir}: directory exists and is not empty.`);
    process.exit(1);
  }
} catch {
  /* does not exist yet */
}

const files = {
  'package.json': '{\n  "name": "e2e-fixture",\n  "private": true,\n  "type": "module"\n}\n',
  '.gitignore': '.factory/\nnode_modules/\n',
  'src/greet.js': "export function greet(name) {\n  throw new Error('not implemented');\n}\n",
  'test/greet.test.js': [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from '../src/greet.js';",
    '',
    "test('greet returns a friendly greeting', () => {",
    "  assert.equal(greet('Ada'), 'Hello, Ada!');",
    "  assert.equal(greet('Grace'), 'Hello, Grace!');",
    '});',
    '',
  ].join('\n'),
  'factory.config.json': `${JSON.stringify(
    {
      version: 1,
      projectRoot: '.',
      dataDir: '.factory',
      limits: {
        maxRetries: 1,
        maxTasksPerRun: 5,
        commandTimeoutMs: 60000,
        agentTimeoutMs: 600000,
        maxOutputBytes: 65536,
        agentMaxOutputBytes: 1048576,
      },
      allowedExecutables: ['node'],
      commands: { test: { executable: 'node', args: ['--test'], description: 'Run all node:test tests' } },
      agent: {
        type: 'claude-code',
        executable: 'claude',
        permissionMode: 'dontAsk',
        tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
        maxBudgetUsd: 1,
      },
      execution: { enabled: true, validationCommands: ['test'], allowedPaths: ['src', 'test'], maxChangedFiles: 10, maxRepairAttempts: 1 },
      // T1 and T2 may be accepted automatically when every low-risk condition holds; T3 always waits for a person.
      autonomy: {
        enabled: true,
        maxRunDurationMs: 3600000,
        maxTaskDurationMs: 900000,
        maxCostUsd: 3,
        autoAccept: { enabled: true, taskIds: ['T1', 'T2'], paths: ['src', 'test'], maxChangedFiles: 4, maxDiffBytes: 20000 },
      },
    },
    null,
    2,
  )}\n`,
  '.factory/project.json': `${JSON.stringify(
    {
      id: 'e2e-fixture',
      name: 'E2E Fixture',
      description: 'A tiny ES module library used to test supervised execution.',
      goals: ['Small, well-tested functions'],
      constraints: ['Plain JavaScript ES modules', 'No dependencies'],
    },
    null,
    2,
  )}\n`,
  '.factory/tasks.json': `${JSON.stringify(
    {
      schemaVersion: 1,
      tasks: [
        {
          id: 'T1',
          title: 'Implement greet',
          description: 'Implement greet(name) in src/greet.js so it returns "Hello, <name>!". Do not change the tests.',
          dependencies: [],
          acceptanceCriteria: ["greet('Ada') returns 'Hello, Ada!'", 'test/greet.test.js passes unchanged'],
          status: 'pending',
          retryCount: 0,
          results: [],
        },
        {
          id: 'T2',
          title: 'Add farewell',
          description:
            'Add src/farewell.js exporting farewell(name) that returns "Goodbye, <name>!", and add test/farewell.test.js using node:test that checks it.',
          dependencies: ['T1'],
          acceptanceCriteria: ["farewell('Ada') returns 'Goodbye, Ada!'", 'A node:test test covers farewell'],
          status: 'pending',
          retryCount: 0,
          results: [],
        },
        {
          id: 'T3',
          title: 'Combine greetings',
          description:
            'Add src/both.js exporting both(name) that returns greet(name) and farewell(name) joined by a single space, importing both functions from their modules. Add test/both.test.js using node:test.',
          dependencies: ['T1', 'T2'],
          acceptanceCriteria: ["both('Ada') returns 'Hello, Ada! Goodbye, Ada!'", 'A node:test test covers both'],
          status: 'pending',
          retryCount: 0,
          results: [],
        },
      ],
    },
    null,
    2,
  )}\n`,
};

for (const [rel, content] of Object.entries(files)) {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=AI Software Factory fixture', '-c', 'user.email=fixture@localhost', ...args], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
git('init', '-q');
git('add', '.');
git('commit', '-q', '-m', 'E2E fixture: stubbed greet with failing test');
console.log(`Fixture created at ${dir} (commit ${git('rev-parse', '--short', 'HEAD').trim()}).`);
console.log(`Next: node dist\\src\\cli.js status --config "${path.join(dir, 'factory.config.json')}"`);
