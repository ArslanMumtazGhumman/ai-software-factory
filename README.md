# AI Software Factory

A local, reusable orchestrator that will eventually take an approved product idea
through planning, implementation, testing and deployment.

**This is milestone 1: the orchestrator foundation only.** It can:

- store a project specification and its tasks as JSON,
- validate the task dependency graph (unknown ids, duplicates, self-dependencies, cycles),
- select only the tasks whose dependencies are complete,
- track task status, retry counts and execution results under configurable limits,
- produce a **dry-run plan** for a Claude Code invocation (it never runs the agent),
- run named, allowlisted commands from project configuration (for example a test suite).

It does **not** run an autonomous development loop, execute coding agents, provide a
dashboard, or deploy anything.

## Requirements

- Windows 10/11
- Node.js 20 or newer (developed and tested on Node.js 24)
- npm (bundled with Node.js)

Runtime dependencies: none. Dev dependencies: `typescript`, `@types/node`.

## Setup (Windows CMD)

```cmd
cd C:\path\to\ai-software-factory
npm install
npm run build
```

## Running the tests (Windows CMD)

```cmd
npm test
```

`npm test` compiles the project and runs every test in `test\` with Node's built-in
test runner (`node --test`). There is no separate test framework.

To type-check only, without writing `dist\`:

```cmd
npm run typecheck
```

## Using the CLI (Windows CMD)

After `npm run build`, run the CLI with `node dist\src\cli.js <command>`. Every command
takes `--config <path>`; the default is `factory.config.json` in the current directory.

A complete example lives in `examples\sample-project`:

```cmd
set CFG=examples\sample-project\factory.config.json

node dist\src\cli.js validate --config %CFG%
node dist\src\cli.js status   --config %CFG%
node dist\src\cli.js next     --config %CFG%
node dist\src\cli.js plan     --config %CFG%
node dist\src\cli.js plan T1  --config %CFG%
node dist\src\cli.js run-check node-version --config %CFG%
```

| Command | What it does | Writes state? |
| --- | --- | --- |
| `validate` | Loads config, project spec and tasks, validates the dependency graph | No |
| `status` | Lists every task with its status and why it is or is not eligible | No |
| `next` | Lists eligible tasks, up to `limits.maxTasksPerRun` | No |
| `plan [taskId]` | Prints the Claude Code command and prompt that *would* run (dry run) | No |
| `record <taskId> <success\|failure> <summary...>` | Records an attempt result and updates status/retries | Yes (`tasks.json`) |
| `run-check <name>` | Runs a command defined in the config's `commands` section | No |
| `help` | Shows usage | No |

Exit codes: `0` success, `1` error (message printed as `Error [CODE]: ...`), `2` usage error.

> `record` changes the project's `tasks.json`. To experiment without changing the example,
> copy `examples\sample-project` somewhere else first, e.g.
> `xcopy /E /I examples\sample-project %TEMP%\asf-sample` and pass
> `--config %TEMP%\asf-sample\factory.config.json`.

## Project layout

```
src/
  cli.ts                     Command-line entry point
  index.ts                   Public API exports
  core/                      Typed errors and validation helpers
  config/factoryConfig.ts    Config schema, defaults, limits and validation
  security/                  Path confinement, secret redaction, safe child-process env
  project/projectSpec.ts     Project specification model
  tasks/                     Task format, dependency graph, selection, lifecycle transitions
  persistence/               Atomic JSON file I/O and the project repository
  agents/                    Coding-agent interface, prompt builder, Claude Code adapter
  testing/                   Command allowlist policy and the bounded command runner
  orchestrator/              Orchestrator that ties the modules together
test/                        Unit tests (node:test)
examples/sample-project/     Example config, spec and tasks
```

## Data files

State lives in the config's `dataDir` (default `.factory`), which must be inside `projectRoot`.

`project.json`:

```json
{
  "id": "todo-cli",
  "name": "Todo CLI",
  "description": "A small command-line todo list manager.",
  "goals": ["Add, list and complete todo items"],
  "constraints": ["No network access"]
}
```

`tasks.json`:

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "T2",
      "title": "Persist todos to a JSON file",
      "description": "Implement load and save functions.",
      "dependencies": ["T1"],
      "acceptanceCriteria": ["Saving then loading returns the same todos"],
      "status": "pending",
      "retryCount": 0,
      "results": []
    }
  ]
}
```

Task fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique id: letters, digits, `.`, `_`, `-` (max 64 chars) |
| `title`, `description` | What to build. The description is treated as data, never as commands |
| `dependencies` | Ids that must be `completed` first |
| `acceptanceCriteria` | Conditions that define "done" |
| `status` | `pending`, `in_progress`, `completed`, `failed`, `needs_attention` |
| `retryCount` | Number of failed attempts so far |
| `results` | One entry per attempt: `attempt`, `outcome`, `startedAt`, `finishedAt`, `summary`, optional `error` |

**Selection rules.** A task is eligible when its status is `pending`, or `failed` with
`retryCount <= limits.maxRetries`, and every dependency is `completed`. Eligible tasks are
returned in file order, so order in `tasks.json` is the priority. A failure that pushes
`retryCount` above `maxRetries` moves the task to `needs_attention`, which only a human
can clear by editing `tasks.json`. An invalid dependency graph is an error; nothing is
selected from it.

**Writes** are atomic (written to a temp file in the same folder, then renamed), validated
before writing, and pretty-printed with a trailing newline so diffs stay clean.

## Configuration

`factory.config.json` (paths are relative to the config file):

```json
{
  "version": 1,
  "projectRoot": ".",
  "dataDir": ".factory",
  "limits": {
    "maxRetries": 2,
    "maxTasksPerRun": 1,
    "commandTimeoutMs": 60000,
    "maxOutputBytes": 65536,
    "agentTimeoutMs": 1800000
  },
  "allowedExecutables": ["node"],
  "commands": {
    "test": { "executable": "node", "args": ["--test"], "description": "Run unit tests" }
  },
  "agent": {
    "type": "claude-code",
    "executable": "claude",
    "permissionMode": "plan",
    "allowedTools": ["Read", "Glob", "Grep"]
  }
}
```

| Limit | Default | Allowed range |
| --- | --- | --- |
| `maxRetries` | 2 | 0–10 |
| `maxTasksPerRun` | 1 | 1–50 |
| `commandTimeoutMs` | 300000 | 1000–3600000 |
| `maxOutputBytes` | 65536 | 1024–10485760 |
| `agentTimeoutMs` | 1800000 | 10000–14400000 |

Unknown limit names and out-of-range values are rejected rather than ignored.

## Safety model

- **No arbitrary commands.** Only commands named in the config's `commands` section can run,
  and each command's executable must be a bare name in `allowedExecutables` (checked when
  the config loads and again at run time). There is no API that accepts a raw command string,
  so task descriptions can never become commands.
- **No shell.** Commands are spawned with `shell: false`; arguments are passed verbatim, so
  `&&`, `|`, `>` and similar have no special meaning.
- **Bounded execution.** Every command has a timeout, and captured output is size-limited.
- **No secret leakage.** Child processes get a minimal environment (PATH, SYSTEMROOT, TEMP, …);
  API keys and tokens are not passed through. Command output, recorded summaries and error
  messages pass through best-effort secret redaction.
- **Confined to one project.** `dataDir` and the agent's working directory must resolve
  inside `projectRoot`.
- **No deletion.** The factory never deletes files. The only removal is cleanup of its own
  temporary file if an atomic write fails.
- **Agent disabled.** `ClaudeCodeAdapter.execute()` always throws
  `AgentExecutionDisabledError` in this milestone. `plan` only shows what would run: the task
  prompt goes on stdin (never on the command line), with factory-owned rules the task text
  cannot override.

## Known limitations

- **Windows `.cmd` shims cannot be allowlisted.** Without a shell, Node cannot start `.cmd` or
  `.bat` files, so `npm`, `npx` or an npm-installed `claude.cmd` won't work as `executable`.
  Use a real binary, for example `node` with `["node_modules/typescript/bin/tsc"]`, or
  `node --test`. (A native `claude.exe` is fine.)
- **Single writer.** There is no file locking. Don't run two CLI processes that write the same
  `tasks.json` at the same time.
- **No stale-task recovery.** A task left in `in_progress` stays there until a result is
  recorded or the file is edited by hand.
- **Claude Code flags were checked against Claude Code 2.1.x** (`--print`, `--output-format`,
  `--permission-mode`, `--allowedTools`, `--model`). Check them again before turning on execution.
- **Redaction is pattern-based** and won't catch every possible secret format.
- **Killing on timeout** stops the direct child process. On Windows, its own child processes
  may keep running.
