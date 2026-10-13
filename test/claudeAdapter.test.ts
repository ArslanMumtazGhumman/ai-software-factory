import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ClaudeCodeAdapter, assertSafeAgentConfig, interpretResult } from '../src/agents/claudeCodeAdapter.js';
import { AgentExecutionDisabledError, ExecutionPolicyError, PathSafetyError } from '../src/core/errors.js';
import type { ResolvedCommand } from '../src/testing/commandPolicy.js';
import type { CommandResult, RunOptions } from '../src/testing/commandRunner.js';
import { makeConfig, makeTask, sampleProject } from './helpers.js';

const root = path.resolve('adapter-root');
const config = makeConfig(root, {
  agent: { permissionMode: 'dontAsk', tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedTools: ['Read', 'Edit', 'Write'], passEnv: ['ANTHROPIC_API_KEY'] },
});
const SECRET = 'sk-ant-api03-THIS-IS-A-TEST-KEY-123456';
const env = { ANTHROPIC_API_KEY: SECRET };

const result = (over: Partial<CommandResult>): CommandResult => ({
  name: 'claude-code',
  exitCode: 0,
  timedOut: false,
  durationMs: 10,
  stdout: '',
  stderr: '',
  truncated: false,
  ...over,
});
const json = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...o });

function adapter(fake: (cmd: ResolvedCommand, opts: RunOptions) => CommandResult, executionEnabled = true) {
  const calls: { cmd: ResolvedCommand; opts: RunOptions }[] = [];
  const a = new ClaudeCodeAdapter(config.agent, config.limits, root, {
    executionEnabled,
    env,
    runCommand: async (cmd, opts = {}) => {
      calls.push({ cmd, opts });
      return fake(cmd, opts);
    },
  });
  const plan = a.plan({ project: sampleProject, task: makeTask('A', { description: `use key ${SECRET}` }), workingDirectory: path.join(root, 'wt') });
  return { a, plan, calls };
}

describe('Claude Code adapter', () => {
  it('plans a restricted, non-interactive invocation with the prompt on stdin', () => {
    const { plan } = adapter(() => result({}));
    assert.deepEqual(plan.args.slice(0, 5), ['--print', '--output-format', 'json', '--permission-mode', 'dontAsk']);
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) {
      assert.ok(plan.args.includes(flag), flag);
    }
    assert.equal(plan.args[plan.args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(plan.args[plan.args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep');
    assert.ok(!plan.args.includes('--dangerously-skip-permissions'));
    assert.ok(!plan.args.join(' ').includes('bypassPermissions'));
    assert.equal(plan.cwd, path.join(root, 'wt'));
    // Secrets never reach the prompt.
    assert.ok(!plan.stdin.includes(SECRET));
  });

  it('passes agent.maxBudgetUsd to Claude Code as --max-budget-usd, and omits it when unset', () => {
    const budgeted = makeConfig(root, { agent: { permissionMode: 'dontAsk', maxBudgetUsd: 1.5 } });
    const plan = new ClaudeCodeAdapter(budgeted.agent, budgeted.limits, root).plan({ project: sampleProject, task: makeTask('A'), workingDirectory: root });
    assert.equal(plan.args[plan.args.indexOf('--max-budget-usd') + 1], '1.5');
    assert.equal(plan.args.filter((a) => a === '--max-budget-usd').length, 1);
    const { plan: unbudgeted } = adapter(() => result({}));
    assert.ok(!unbudgeted.args.includes('--max-budget-usd'));
  });

  it('reads usage only from total_cost_usd; missing or killed runs report no cost', () => {
    assert.equal(interpretResult(result({ stdout: json({ total_cost_usd: 0.42 }) })).details?.costUsd, 0.42);
    assert.equal(interpretResult(result({ stdout: json({}) })).details?.costUsd, undefined);
    assert.equal(interpretResult(result({ stdout: json({ total_cost_usd: '0.42' }) })).details?.costUsd, undefined);
    assert.equal(interpretResult(result({ timedOut: true, exitCode: null })).details?.costUsd, undefined);
  });

  it('is disabled unless execution is enabled', async () => {
    const { a, plan, calls } = adapter(() => result({}), false);
    await assert.rejects(a.execute(plan), AgentExecutionDisabledError);
    assert.equal(calls.length, 0);
  });

  it('passes the prompt on stdin, bounded output, and forwards only passEnv', async () => {
    const { a, plan, calls } = adapter(() => result({ stdout: json({ total_cost_usd: 0.5, num_turns: 3, permission_denials: [{}] }) }));
    const r = await a.execute(plan);
    assert.equal(r.outcome, 'success');
    assert.equal(r.details?.costUsd, 0.5);
    assert.equal(r.details?.numTurns, 3);
    assert.equal(r.details?.permissionDenials, 1);
    const call = calls[0]!;
    assert.equal(call.opts.stdin, plan.stdin);
    assert.equal(call.cmd.cwd, plan.cwd);
    assert.equal(call.cmd.maxOutputBytes, config.limits.agentMaxOutputBytes);
    assert.equal(call.cmd.timeoutMs, config.limits.agentTimeoutMs);
    assert.deepEqual(call.opts.extraEnv, { ANTHROPIC_API_KEY: SECRET });
    assert.deepEqual(call.opts.secrets, [SECRET]);
  });

  it('redacts secrets that appear in agent output', async () => {
    const { a, plan } = adapter(() => result({ stdout: json({ result: `the key is ${SECRET}` }), stderr: `debug ${SECRET}` }));
    const r = await a.execute(plan);
    assert.ok(!r.summary.includes(SECRET));
    assert.ok(!r.details!.stderr.includes(SECRET));
    assert.ok(!r.details!.stdout.includes(SECRET));
  });

  it('maps failures, timeouts and garbage output to failure outcomes', () => {
    assert.equal(interpretResult(result({ exitCode: 1, stdout: json({}) })).outcome, 'failure');
    assert.match(interpretResult(result({ exitCode: null, timedOut: true })).summary, /timed out/);
    assert.match(interpretResult(result({ exitCode: null, timedOut: true, killFailed: true })).summary, /could not be confirmed/);
    assert.equal(interpretResult(result({ truncated: true, stdout: json({}) })).outcome, 'failure');
    assert.match(interpretResult(result({ stdout: 'not json' })).summary, /did not produce JSON/);
    assert.match(interpretResult(result({ stdout: json({ is_error: true, subtype: 'error_max_budget_usd' }) })).summary, /error_max_budget_usd/);
    assert.match(interpretResult(result({ exitCode: null, error: 'Failed to start "claude": ENOENT' })).summary, /could not be started/);
    assert.equal(interpretResult(result({ stdout: json({ result: 'ok' }) })).outcome, 'success');
  });

  it('refuses unsafe configurations before running anything', async () => {
    for (const bad of [
      { ...config.agent, permissionMode: 'plan' as const },
      { ...config.agent, permissionMode: 'default' as const },
      { ...config.agent, tools: ['Read', 'Bash'] },
      { ...config.agent, allowedTools: ['WebFetch'] },
      { ...config.agent, tools: ['Read'], allowedTools: ['Edit'] },
    ]) {
      assert.throws(() => assertSafeAgentConfig(bad), ExecutionPolicyError);
    }
    const unsafe = new ClaudeCodeAdapter({ ...config.agent, tools: ['Bash'] }, config.limits, root, {
      executionEnabled: true,
      runCommand: async () => assert.fail('must not run'),
    });
    const plan = unsafe.plan({ project: sampleProject, task: makeTask('A'), workingDirectory: root });
    await assert.rejects(unsafe.execute(plan), ExecutionPolicyError);
  });

  it('refuses tampered plans and working directories outside the project', async () => {
    const { a, plan, calls } = adapter(() => result({}));
    await assert.rejects(a.execute({ ...plan, args: plan.args.filter((x) => x !== '--restricted') }), /--restricted/);
    await assert.rejects(a.execute({ ...plan, cwd: path.dirname(root) }), PathSafetyError);
    assert.equal(calls.length, 0);
  });
});
