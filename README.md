# AI Software Factory

A local, reusable orchestrator that will eventually take an approved product idea
through planning, implementation, testing and deployment.

**Current state: milestone 3, bounded autonomous runs.** The factory can:

- store a project specification and its tasks as JSON,
- validate the task dependency graph (unknown ids, duplicates, self-dependencies, cycles),
- select only the tasks whose dependencies are complete,
- track task status, retry counts and execution results under configurable limits,
- produce a dry-run plan for a Claude Code invocation,
- **execute one explicitly chosen task** through Claude Code in an isolated git worktree, run
  the configured validation commands, review the diff, record the evidence, and stop for a
  human to accept or reject the result (milestone 2),
- **repair** a task whose checks failed, with a bounded number of attempts (optional),
- **run the backlog autonomously, one task at a time**: select the next eligible task, execute
  it, verify it, and continue only when the task is completed under the configured review
  policy. The run stops with a recorded reason and the next action when a person is needed, a
  limit is reached, or nothing is left. It can be paused, resumed, stopped and recovered.
- run named, allowlisted commands from project configuration.

It does **not** merge into your branches, push, publish or deploy anything, coordinate multiple
agents, or provide a dashboard.

## Requirements

- Windows 10/11
- Node.js 20 or newer (developed and tested on Node.js 24)
- npm (bundled with Node.js)
- Git 2.28 or newer on `PATH` (for execution)
- Claude Code CLI on `PATH`, signed in (for execution). Developed against Claude Code
  2.1.296; the native installer's `claude.exe` works. An npm-installed `claude.cmd` does **not**
  work (see Known limitations).

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
npm run typecheck
```

`npm test` compiles the project and runs every test in `test\` with Node's built-in test runner.
The tests create temporary git repositories under `%TEMP%` and use a fake coding agent; they
never start the real Claude Code. Some tests start a second Node.js process (a runner that is
paused or killed) and the real CLI, to test cross-process locking, pause and crash recovery.

## Commands (Windows CMD)

Run the CLI with `node dist\src\cli.js <command> --config <path>`. The default config is
`factory.config.json` in the current directory.

| Command | What it does | Writes state? |
| --- | --- | --- |
| `validate` | Loads config, project spec and tasks, validates the dependency graph, shows execution/autonomy settings | No |
| `status` | Every task's status and eligibility, plus who holds the lock | No |
| `next` | Eligible tasks, up to `limits.maxTasksPerRun` | No |
| `plan [taskId]` | Shows the Claude Code command and prompt that would run (dry run) | No |
| `execute <taskId>` | Supervised execution of exactly one eligible task (see below) | Yes |
| `review <taskId> [--no-diff]` | Latest run: agent result, repairs, validation output, findings, changed files, diff | No |
| `accept <taskId>` | Accepts a reviewed result after checking nothing changed, and commits it on the run's factory branch | Yes |
| `reject <taskId> <reason...>` | Rejects a reviewed result; the work is kept for inspection | Yes |
| `recover` | Releases a dead process's lock, fails interrupted executions, pauses interrupted autonomous runs | Yes |
| `auto start [--max-tasks N] [--retry-failed]` | Starts an autonomous run (see below) | Yes |
| `auto resume [--retry-failed]` | Continues a paused autonomous run | Yes |
| `auto pause` | Asks the running runner to pause after the current task | Control file only |
| `auto stop` | Asks the runner to stop after the current task; ends a paused run | Yes |
| `auto status` | Current (or last) run: state, current task, last completed task, counts, reason and next step | No |
| `auto history` | All autonomous runs, one line each | No |
| `auto show [autoRunId]` | Executions (agent exit, checks, repairs, branch, commit) and the event log | No |
| `auto failures [autoRunId]` | Failure details: agent result, failing check output, repairs, findings, worktree | No |
| `record <taskId> <success\|failure> <summary...>` | Records a manual attempt (not for supervised runs) | Yes |
| `run-check <name>` | Runs a command from the config's `commands` section in the project root | No |
| `help` | Usage | No |

Exit codes: `0` success, `1` error or failed execution (printed as `Error [CODE]: ...`), `2` usage error.
For `execute`, exit code `0` means "passed and waiting for review", `1` means the failure was recorded.
For `auto start`/`auto resume`, `0` means the run ended normally (everything completed, waiting for
review, paused or stopped on request, or a run limit reached); `1` means a task failed, needs
attention, is blocked, or a safety gate or error stopped the run.

### One supervised execution

```cmd
set CFG=C:\path\to\project\factory.config.json
node dist\src\cli.js next --config %CFG%
node dist\src\cli.js execute T1 --config %CFG%
node dist\src\cli.js review T1 --config %CFG%
node dist\src\cli.js accept T1 --config %CFG%
rem   or: node dist\src\cli.js reject T1 "reason for rejecting" --config %CFG%
```

`execute T1` does the following, in order, and stops at the first refusal:

1. Checks that execution is enabled, that the agent configuration is safe (see Safety model)
   and that every validation command is configured and allowlisted.
2. Takes the cross-process lock `<dataDir>\factory.lock`. If another factory process holds it,
   it refuses.
3. Loads and validates the project spec, the tasks and the dependency graph. Unknown, invalid,
   completed, in-progress, awaiting-review, needs-attention and dependency-blocked tasks are
   refused.
4. Git preflight. The project root must be the repository's top level. HEAD must be a commit,
   no merge/rebase/cherry-pick/bisect may be in progress, and there must be **no uncommitted
   or untracked changes** outside the data directory. The factory never stashes, resets or
   overwrites your changes; it refuses and lists them.
5. Chooses the base commit: HEAD, moved forward to include the **accepted work of every
   dependency** (see "How accepted work is stacked"). If a dependency's accepted commit has
   diverged from the base, it refuses.
6. Creates a new branch `asf/<task>/<runId>` and worktree `<dataDir>\worktrees\<runId>` at the
   base commit, then verifies the worktree is clean and on that commit.
7. Marks the task `in_progress` with the run id.
8. Runs Claude Code inside the worktree (never in your working tree).
9. Stages everything **in the worktree's own index** and records the tree hash, changed files
   and diff relative to the base commit.
10. If the agent succeeded, runs each `execution.validationCommands` entry in the worktree and
    records exit code, timeout status, duration and (redacted, bounded) output.
11. Reviews the diff (see Diff review).
12. If checks failed, the diff review found no violation, and `execution.maxRepairAttempts > 0`,
    runs the bounded repair loop (see "Bounded repair").
13. Success means the agent succeeded, every validation command exited 0, and the review found
    no violations. On success the task becomes `awaiting_review`. Otherwise it becomes `failed`
    (or `needs_attention` once retries are exhausted). The worktree is always kept.
14. Releases the lock.

Evidence is written to `<dataDir>\runs\<runId>\run.json` and `diff.patch`.

### Task lifecycle

```
pending ──execute──> in_progress ──passed──> awaiting_review ──accept (human or policy)──> completed
   ^                     │                         │
   │                     └──failed/timeout──┐      └──reject──┐
   └──(eligible again: failed with retries left)<─┴───────────┘
                         retries exhausted ──> needs_attention (a person must intervene)
```

Only `completed` satisfies a dependency, so dependants stay blocked while a task awaits review.
A rejection counts as a failed attempt (`retryCount + 1`). "Execution succeeded" (agent exit 0),
"awaiting review" (agent, checks and diff review all passed), and "completed" (accepted) are
separate states; the factory never marks a task completed because the agent exited successfully.

### Accepting and rejecting

`accept` re-verifies, under the lock, that:

- `run.json` still matches the evidence digest stored in `tasks.json`,
- `diff.patch` still matches its recorded SHA-256,
- the worktree is still at the factory-managed path, its HEAD has not moved, and the staged
  tree hash equals the reviewed one. Any edit made after review (an added, changed or deleted
  file) is detected.

If anything differs, acceptance fails with `TAMPER_DETECTED` and the task stays `awaiting_review`.
Reject it, or investigate.

Then it commits **exactly the reviewed tree** on the run's own branch `asf/<task>/<runId>`
(author "AI Software Factory", message `[asf] <task>: <title>`, with `Accepted-by: human` or
`policy`). Only that factory-owned branch moves. **Nothing is merged into your branch**, and
nothing is pushed. To integrate accepted work yourself:

```cmd
cd C:\path\to\project
git log --oneline --graph --all
git merge --ff-only asf/T3/<runId>
```

Because accepted tasks are stacked (next section), merging the branch of the last accepted task
brings in all the earlier ones.

`reject` records the reason and keeps the worktree and branch. Nothing is deleted. Clean up old
worktrees yourself when you no longer need them (`git worktree remove <path>`,
`git branch -D <branch>`).

### How accepted work is stacked

A dependant must be built on the code of the tasks it depends on. When a task is accepted, its
reviewed tree is committed on its factory branch (parent: the commit it was built on). When a
later task is executed, the factory starts from HEAD (or, in an autonomous run, from the run's
current tip) and moves forward to each dependency's accepted commit when that commit is a
descendant. If a dependency's accepted commit and the base have diverged, the execution is
refused with `GIT_ISOLATION_ERROR` and nothing changes; merge the branches yourself and retry.

Tasks completed manually (`record`) or accepted before commits were recorded have no factory
commit. The factory then assumes their changes are already in your branch and logs a note.

### Bounded repair

When `execution.maxRepairAttempts` is greater than 0 and a task's checks fail:

1. The factory captures the failing checks' output (redacted, at most 6000 characters per check).
2. It invokes the agent again in the same worktree with the original task, its acceptance
   criteria, the same rules, and the failing output, labelled as untrusted data. The agent still
   has only file tools.
3. It reruns every validation command and the diff review.
4. It stops when the checks pass or after `maxRepairAttempts` repairs (0–3), whichever comes
   first, and never starts a repair when less than 10 seconds of the task's time budget is left.

Only failed checks with a clean diff review are repaired. Agent failures, timeouts, checks whose
process tree could not be stopped, and any diff-review violation (protected path, secret,
out-of-scope change, …) are **never** repaired. A failure after the last repair is recorded as a
failure (`Validation failed: ... (after N repair attempt(s))`); every repair's agent result and
the checks that triggered it are kept in `run.json` under `repairs`, and the worktree is kept.
A repaired result is never auto-accepted; a person reviews it.

## Autonomous runs

An autonomous run processes the backlog **one task at a time** using the same selector and the
same supervised execution as `execute`. There is no hard-coded list of phases: the dependency
graph and task order in `tasks.json` decide what comes next.

```cmd
set CFG=C:\path\to\project\factory.config.json
node dist\src\cli.js validate --config %CFG%
node dist\src\cli.js auto start --config %CFG%
rem In another window, at any time:
node dist\src\cli.js auto status --config %CFG%
node dist\src\cli.js auto pause --config %CFG%
rem After a pause or a review stop:
node dist\src\cli.js auto resume --config %CFG%
node dist\src\cli.js auto show --config %CFG%
node dist\src\cli.js auto failures --config %CFG%
node dist\src\cli.js auto stop --config %CFG%
```

Each iteration of `auto start` / `auto resume`:

1. Verifies it still holds the lock and checks for a pause/stop request.
2. Checks the run's limits: task executions, active time, and cost.
3. Reloads `tasks.json` from disk (never stale in-memory state) and picks up human decisions
   made while paused.
4. Stops if every task is completed, if any task is `awaiting_review` or unexpectedly
   `in_progress`, or if no task is eligible.
5. Selects the first eligible task with the existing selector. Tasks that failed before are
   **not** selected unless you pass `--retry-failed` (still bounded by `limits.maxRetries`).
6. Runs `execute` for that task on the run's tip, with a deadline of
   `min(maxTaskDurationMs, remaining run time)`. The agent timeout is shortened to fit.
7. If the result passed, evaluates the auto-accept policy. If allowed, accepts it (same
   integrity checks and commit as a human `accept`), moves the tip to that commit, and continues.
   Otherwise it stops for human review.
8. If the task failed, it stops and reports the failure.

### Why a run stops, and what to do

`auto status` and the end of `auto start`/`auto resume` print the reason and the next step.

| Reason | State | Meaning | Next step |
| --- | --- | --- | --- |
| `all-complete` | completed | Every task is completed | Review and merge the factory branches yourself |
| `awaiting-review` | paused | A task passed everything but needs a person | `review <id>`, then `accept <id>` or `reject <id> <reason>`, then `auto resume` |
| `task-failed` | paused | A task failed (agent, checks after repairs, or diff review), or only failed tasks remain | `review <id>` / `auto failures`; `auto resume --retry-failed` to retry |
| `needs-attention` | paused | Retries exhausted (or nothing eligible because of such a task) | Fix the code or task yourself, then `auto resume` or `auto stop` |
| `blocked` | paused | Nothing eligible for another reason | Resolve the listed reasons, then `auto resume` |
| `pause-requested` | paused | `auto pause` or Ctrl+C | `auto resume` |
| `safety-gate` | paused | Isolation, lock, policy, configuration or integrity could not be established (e.g. dirty repository, tamper detected) | Fix the reported condition, then `auto resume` |
| `interrupted` | paused | The runner process died (set by `recover` or `auto resume`) | `auto show`, then `auto resume` |
| `error` | paused | Unexpected error | `auto failures`, fix, `recover`, `auto resume` |
| `task-limit`, `duration-limit`, `cost-limit` | stopped | A run budget is used up | Review the work; `auto start` begins a new run with a new budget |
| `stop-requested` | stopped | `auto stop` | `auto start` when ready |

`paused` runs can be resumed; `stopped` and `completed` runs cannot. Only one run can be active
(running or paused) at a time: `auto start` refuses while another run is paused. Resume it or
stop it first.

### Limits

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `limits.maxTasksPerRun` | 1 | 1–50 | Task executions per autonomous run (repairs don't count). `--max-tasks N` can lower it for one run. |
| `limits.maxRetries` | 2 | 0–10 | Failed attempts allowed per task before `needs_attention` |
| `execution.maxRepairAttempts` | 0 | 0–3 | Repairs within one execution |
| `autonomy.maxRunDurationMs` | 7200000 (2 h) | 60000–86400000 | Active (not paused) time per run. A new task starts only with at least 30 s left. |
| `autonomy.maxTaskDurationMs` | 2700000 (45 min) | 10000–14400000 | Per task, including repairs. Bounds every agent timeout. |
| `autonomy.maxCostUsd` | none | 0.01–500 | Total measured agent cost per run. Requires `agent.maxBudgetUsd`, so the most a run can overshoot is one invocation's budget. If an invocation does not report its cost, the run stops because the cap can no longer be enforced. |
| `limits.agentTimeoutMs` | 1800000 | 10000–14400000 | Hard timeout for each agent invocation |

Budgets are fixed when the run starts and are not reset by `auto resume`. A run that reaches a
budget is `stopped`; start a new run for a new budget.

### Review policy and auto-accept

By default **every** result waits for a person: `autonomy.autoAccept.enabled` is `false`, so an
autonomous run stops after each task for review, and continues after you accept it and run
`auto resume`. That still removes the manual prompting, task selection and copying between
tools. To let low-risk work continue without you, list exactly which tasks may be accepted and
where their changes may be:

```json
"autonomy": {
  "enabled": true,
  "autoAccept": {
    "enabled": true,
    "taskIds": ["T1", "T2"],
    "paths": ["src", "test"],
    "maxChangedFiles": 5,
    "maxDiffBytes": 20000
  }
}
```

A result is auto-accepted only if **all** of these hold. Otherwise it waits for a person, and
the reasons are recorded and shown:

- auto-accept is enabled and the task id is listed (no wildcards);
- the agent succeeded, every configured check ran and passed, and the diff review found **no
  findings at all**, including warnings (renames, executable files, `.gitignore` changes,
  ignored files);
- no repair was needed (checks that failed once always go to a person);
- the agent hit no permission denials;
- only added or modified regular files (mode 100644), all under `autoAccept.paths`, within
  `maxChangedFiles` and `maxDiffBytes`;
- neither the task text nor any changed path mentions a security-sensitive topic (auth, login,
  passwords, secrets, tokens, credentials, keys, crypto, permissions, security, payments,
  deployment/release/publishing, migrations, databases, admin, configuration, policies,
  budgets, environment, …). The list is deliberately broad; a false positive only means a
  person reviews.

Auto-accept runs the same tamper checks as a human `accept` and records
`review.by: "policy"` with the reasons in `tasks.json` and the run record. Auto-accept never
relaxes a check: it only chooses between "accept now" and "wait for a person".

### Pause, resume, stop

- `auto pause` writes a request to `<dataDir>\autoruns\<id>\control.json` (it does not need the
  lock, which the runner holds). The runner honours it **between tasks**, never in the middle of
  one. Ctrl+C in the runner's window does the same; a second Ctrl+C aborts immediately (then run
  `recover`). On Windows, Ctrl+C also reaches the Claude Code process, which then fails the
  current task. Prefer `auto pause` from another window.
- `auto stop` asks a running runner to stop after the current task; on a paused run it ends the
  run immediately. Tasks, worktrees and branches are not changed.
- `auto resume` takes the lock, reloads everything from disk, reconciles unfinished work (as
  `recover` does), and continues with the same run id, budgets and history.

### Crash recovery

If the runner process dies (crash, power loss, `taskkill /F`):

- `auto status` shows the run as `RUNNING` with `NOT RUNNING (run "factory recover")`.
- Other commands are refused with `LOCK_HELD ... no longer running. Run "recover"`.
- `recover` archives the stale lock, marks the interrupted execution `interrupted` and its task
  `failed` (worktree kept), and marks the autonomous run `paused` with reason `interrupted`.
  If the agent process or the original runner is still alive, it changes nothing and says so.
- `auto resume` does **not** rerun the interrupted task, because its result is uncertain. Inspect
  it (`auto show`, `review <id>`), then use `auto resume --retry-failed` to allow a retry.

Only one runner can work on a project at a time: the runner holds the task-store lock for the
whole time it is working, so a second `auto start`, `auto resume`, `execute`, `accept`, `reject`,
`record` or `recover` is refused with `LOCK_HELD`.

### Run history

Each autonomous run is recorded in `<dataDir>\autoruns\<autoRunId>\autorun.json`:

- ids: run id, project id; state; created, updated and finished times; the runner's pid while
  it runs;
- limits, initial commit and current tip; active time; measured cost;
- segments (each start/resume until its pause/stop, with the reason);
- current task and last completed task;
- one entry per task execution: task id, run id, times, result (`auto-accepted`,
  `awaiting-review`, `accepted`, `rejected`, `failed`, `needs-attention`, `interrupted`, `error`),
  agent exit code and timeout, each check's exit code, number of repairs, cost, branch,
  worktree, base and accepted commit, failure reason, and auto-accept reasons;
- the stop reason, message and next action; task counts at the end;
- an event log (at most 500 entries; older ones are dropped and counted).

Full evidence for each execution (agent output tail, check output, repairs, findings, hashes)
stays in `runs\<runId>\run.json`. Everything is redacted before it is written, and no
environment variables are stored. The formats are plain JSON with `schemaVersion: 1`, intended to
be read by a later dashboard.

## Recovery procedures

| Situation | What you see | What to do |
| --- | --- | --- |
| Another factory command is running | `LOCK_HELD ... locked by a running factory process` | Wait for it to finish, or `auto pause` it. |
| A factory process crashed or was killed | `LOCK_HELD ... no longer running. Run "recover"` | `node dist\src\cli.js recover --config %CFG%` |
| A task is stuck `in_progress` | `status` shows `in_progress` and no live lock owner | `recover` |
| An autonomous run shows `NOT RUNNING` | `auto status` | `recover`, then `auto resume` |
| `recover` says the agent process is still alive | `agent process <pid> is still alive` | `taskkill /PID <pid> /T /F`, then run `recover` again |
| `recover` says the lock is owned by another host | `owned by host ...` | Confirm that machine's process has stopped, then move `factory.lock` away manually |
| Lock file is unreadable | `lock file is unreadable` | Confirm no factory process is running, then move `factory.lock` away manually |
| `auto start` refuses because a run is paused | `... is paused. Resume it ...` | `auto resume` or `auto stop` |
| An execution refuses a diverged base | `GIT_ISOLATION_ERROR ... diverged` | Merge the factory branches into your branch yourself, then retry |

How `recover` tells a running execution from an interrupted one:

- A lock held by a **live** process on this machine means the execution is genuinely running.
  `recover` refuses and changes nothing.
- A lock held by a **dead** process on this machine is archived (moved, not deleted) to
  `<dataDir>\stale-locks\`.
- Then, holding the lock, every `in_progress` task with a run is checked. If its agent process
  or originating factory process is still alive, the task is left alone. Otherwise the run is
  marked `interrupted` and the task `failed`, and the worktree is kept. Autonomous runs still
  marked `running` are marked `paused` (`interrupted`).

Unexpected errors during `execute` (for example a git failure after the agent ran) are caught.
The run and task are recorded as failed before the lock is released, so only a hard crash
(power loss, `taskkill /F` of the factory) leaves a task `in_progress`. `recover` handles that.

## End-to-end procedure (real Claude Code)

This runs Claude Code for real, which costs a small amount of API usage (each invocation is
capped at $1 and the whole run at $3 by the fixture config). It never touches the factory's own
repository. The fixture has three chained tasks: T1 (implement `greet`), T2 (add `farewell`,
depends on T1) and T3 (combine both, depends on T1 and T2). T1 and T2 may be auto-accepted;
T3 always waits for a person.

```cmd
npm run build
set FIX=%TEMP%\asf-e2e
node scripts\create-e2e-fixture.mjs %FIX%
set CFG=%FIX%\factory.config.json
node dist\src\cli.js validate --config %CFG%
node dist\src\cli.js status --config %CFG%

rem Window 1: start the autonomous run
node dist\src\cli.js auto start --config %CFG%

rem Window 2, while T1 is running:
node dist\src\cli.js auto status --config %CFG%
node dist\src\cli.js execute T2 --config %CFG%
rem   ^ must be refused with LOCK_HELD
node dist\src\cli.js auto pause --config %CFG%
rem   ^ window 1 pauses after T1 is auto-accepted

rem Continue: T2 is auto-accepted on top of T1, T3 stops for review
node dist\src\cli.js auto resume --config %CFG%
node dist\src\cli.js review T3 --config %CFG%
node dist\src\cli.js accept T3 --config %CFG%
node dist\src\cli.js auto resume --config %CFG%
rem   ^ completed: all 3 tasks

node dist\src\cli.js auto history --config %CFG%
node dist\src\cli.js auto show --config %CFG%
git -C %FIX% log --oneline --graph --all
```

Your branch in `%FIX%` stays at the fixture commit; the three accepted tasks are stacked commits
on the `asf/...` branches. To exercise rejection and tamper detection, use the single-task
commands from milestone 2: after `execute`, change a file in the worktree and check that `accept`
fails with `TAMPER_DETECTED`, then `reject <id> "reason"`. Delete `%FIX%` when you are done.

## Configuration

`factory.config.json` (paths are relative to the config file):

```json
{
  "version": 1,
  "projectRoot": ".",
  "dataDir": ".factory",
  "limits": {
    "maxRetries": 2,
    "maxTasksPerRun": 5,
    "commandTimeoutMs": 60000,
    "maxOutputBytes": 65536,
    "agentTimeoutMs": 1800000,
    "agentMaxOutputBytes": 1048576
  },
  "allowedExecutables": ["node"],
  "commands": {
    "test": { "executable": "node", "args": ["--test"], "description": "Run unit tests" }
  },
  "agent": {
    "type": "claude-code",
    "executable": "claude",
    "permissionMode": "dontAsk",
    "tools": ["Read", "Edit", "Write", "Glob", "Grep"],
    "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep"],
    "maxBudgetUsd": 2,
    "passEnv": []
  },
  "execution": {
    "enabled": true,
    "validationCommands": ["test"],
    "allowedPaths": ["src", "test"],
    "protectedPaths": [],
    "maxChangedFiles": 50,
    "maxDiffBytes": 1048576,
    "allowDeletions": false,
    "maxRepairAttempts": 1
  },
  "autonomy": {
    "enabled": true,
    "maxRunDurationMs": 3600000,
    "maxTaskDurationMs": 900000,
    "maxCostUsd": 10,
    "autoAccept": {
      "enabled": false,
      "taskIds": [],
      "paths": [],
      "maxChangedFiles": 5,
      "maxDiffBytes": 20000
    }
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
| `agentMaxOutputBytes` | 1048576 | 65536–16777216 |

Agent settings:

| Setting | Default | Notes |
| --- | --- | --- |
| `permissionMode` | `plan` | Execution requires `dontAsk` or `acceptEdits`. `bypassPermissions` and `auto` are rejected. |
| `tools` | Read, Edit, Write, Glob, Grep | The only tools that exist for the agent. Allowed for execution: Read, Edit, Write, Glob, Grep, NotebookEdit. |
| `allowedTools` | Read, Glob, Grep | Auto-approved tools; must be a subset of `tools`. |
| `maxBudgetUsd` | none | Spend cap per invocation (`--max-budget-usd`). Required for `autonomy.maxCostUsd`. |
| `passEnv` | `[]` | Variable names passed to Claude Code, e.g. `ANTHROPIC_API_KEY` if you authenticate by API key. Their values are redacted from all output. |

Execution settings: `enabled` (default `false`), `validationCommands` (at least one is required),
`allowedPaths` (if non-empty, every change must be under these prefixes), `protectedPaths`
(added to the built-in list), `maxChangedFiles`, `maxDiffBytes`, `allowDeletions` and
`maxRepairAttempts` (default 0, at most 3).

Autonomy settings: `enabled` (default `false`; requires `execution.enabled`),
`maxRunDurationMs`, `maxTaskDurationMs`, `maxCostUsd` and `autoAccept` (see above). With
`autoAccept.enabled`, `taskIds` and `paths` must be non-empty; `paths` must be specific
relative directories or files (not `.`, absolute, or containing `..`), and `taskIds` must be
real task ids (no wildcards).

Unknown setting names and out-of-range values are rejected rather than ignored.

### Data directory layout

```
.factory\
  project.json, tasks.json             spec and tasks
  factory.lock                         present only while a writing command or a runner works
  runs\<runId>\run.json                evidence: agent result, repairs, validation, findings, hashes
  runs\<runId>\diff.patch              redacted diff against the base commit
  worktrees\<runId>\                   isolated working copy (kept after every run)
  autoruns\<autoRunId>\autorun.json    autonomous run history
  autoruns\<autoRunId>\control.json    the last pause/stop request
  stale-locks\                         archived locks from crashed processes
  .gitignore                           written once; ignores the local state above
```

The data directory's contents are excluded from the clean-repository check. You can commit
`project.json` and `tasks.json`, or ignore the whole directory.

## Diff review

Passing tests are not enough. These are **violations**, and any one fails the run:

- no changes at all; too many changed files; diff too large
- changes under `.git`, `.github`, `.claude`, `.gitmodules`, `.gitattributes`, the data
  directory, the **factory config file** (when it is inside the repository), or any
  `execution.protectedPaths` entry
- sensitive files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `*credentials*`,
  `secrets.*`, …), including git-ignored ones
- changes outside `execution.allowedPaths` (when set)
- deletions (unless `allowDeletions`), symlinks and submodule changes
- added lines that look like secrets (API key formats, private key blocks, hard-coded passwords)
- validation commands that modified tracked files, or a worktree HEAD that moved

**Warnings** are shown to the reviewer: renames, executable files, `.gitignore` changes, and
other git-ignored files that are not part of the diff. Any warning also prevents auto-accept.

## Safety model

- **No arbitrary commands.** Only commands named in `commands` can run, and each executable must
  be a bare name in `allowedExecutables`. This is checked when the config loads and again at run
  time. Nothing from a task description, check output or Claude's output is ever executed.
- **No shell.** Every process (git, Claude Code, validation) is spawned with `shell: false`.
- **Restricted agent.** Claude Code runs non-interactively with:
  `--print --output-format json --permission-mode dontAsk --allowedTools … --tools Read,Edit,Write,Glob,Grep
  --restricted --safe-mode --strict-mcp-config --permission-prompts none --no-session-persistence
  --disable-slash-commands [--max-budget-usd N]`.
  The agent has no Bash, PowerShell, web or MCP tools. `--restricted` confines its file tools to
  the worktree and ignores user/project settings. `--safe-mode` disables CLAUDE.md, hooks and
  plugins. Anything that would need a permission prompt is denied. Permission checks are never
  bypassed, and no `--dangerously-*` flag is used. The prompt goes on stdin. Any `passEnv`
  secret values are stripped from it. Repair invocations use the identical flags.
- **Policy the agent cannot change.** The config (security policy, budgets, permissions) is read
  from your working tree, never from a worktree, and any agent change to the config file is a
  diff-review violation. Autonomous budgets are fixed when a run starts. Task text and check
  output are delimited as untrusted data in prompts and cannot relax the rules.
- **Minimal environment.** Child processes get PATH, SYSTEMROOT, TEMP, USERPROFILE and a few
  similar variables. API keys and tokens are withheld unless named in `agent.passEnv`.
- **Bounded execution.** The agent and every command have timeouts and size-limited output. On
  timeout the whole process tree is killed (`taskkill /PID <pid> /T /F` on Windows, process
  group kill elsewhere). If termination cannot be confirmed, the run fails closed and reports it.
  Autonomous runs are bounded by task count, active time, per-task time and cost; repairs by
  `maxRepairAttempts`; retries by `maxRetries`. Nothing retries indefinitely.
- **Git isolation.** All work happens in a new worktree. The factory only reads your working
  tree, index and branches. Hooks are disabled for every git call it makes. It commits accepted
  work only on its own `asf/...` branches. It never merges into your branches, resets, stashes,
  pushes or deletes.
- **Redaction.** Agent output, check output, repair prompts, stored diffs, summaries, events and
  errors pass through secret redaction.
- **Atomic, validated state.** JSON writes are atomic, and every write to the task store happens
  under the cross-process lock. A runner verifies it still holds the lock before each task.

## Known limitations and remaining risks

- **Validation runs agent-written code.** The tests the agent writes or changes run with your
  user account, the minimal environment and a timeout, but **without network or filesystem
  sandboxing**. In autonomous mode this happens without a person looking first. Review tasks
  that could make tests do something harmful, keep validation commands narrow, and keep
  auto-accept off for anything you would not run unreviewed.
- **Auto-accept is a heuristic gate.** The security-sensitive keyword list and size limits are
  conservative but cannot understand intent. A listed task whose harmful change avoids every
  keyword and finding could be accepted. Accepted work is never merged into your branch, so it
  is still reviewed when you merge.
- **The cost cap is checked between invocations.** A run can exceed `maxCostUsd` by at most one
  invocation's `agent.maxBudgetUsd`.
- **Pause and stop take effect between tasks.** A running task (including its repairs) finishes
  first. Ctrl+C on Windows also interrupts the Claude Code child process.
- **Process-tree kill on Windows** uses `taskkill /T`, which follows parent/child links.
  Descendants whose parent already exited (orphans) are not found. Windows Job Objects would
  close this gap but need native code. Failure to confirm termination is reported and fails the
  run, but stray processes must be cleaned up by hand.
- **Lock and pid reuse.** Locks are trusted only on the same host. If a dead owner's pid is
  reused by an unrelated process, `recover` treats it as alive and refuses (fail closed). Wait,
  or confirm and move the lock away manually. Locks on network drives shared between machines
  are never broken automatically.
- **Two simultaneous `recover` commands** have a very small race window when archiving a stale
  lock. Run `recover` from one terminal.
- **Git configuration from your global/system config still applies** to `git add` and checkouts
  in the worktree (for example `core.autocrlf`, or clean/smudge filters such as Git LFS).
  Commit signing (`commit.gpgsign`) also applies to factory commits. Hooks and fsmonitor are
  disabled.
- **Windows `.cmd` shims cannot be executed.** Without a shell, Node cannot start `.cmd` or `.bat`
  files, so `npm`, `npx` or an npm-installed `claude.cmd` won't work as an executable. Use real
  binaries (`node`, `git`, the native `claude.exe`).
- **Claude Code flags are version-specific.** They were checked against Claude Code 2.1.296. If a
  future version rejects a flag, execution fails (it never falls back to weaker settings).
- **Redaction and secret detection are pattern-based** and won't catch every secret format.
- **Worktrees and branches accumulate.** Every execution keeps its worktree and branch for
  inspection; remove old ones yourself.
