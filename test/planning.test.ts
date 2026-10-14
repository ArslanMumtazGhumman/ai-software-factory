import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { loadFactoryConfig } from '../src/config/factoryConfig.js';
import { ValidationError } from '../src/core/errors.js';
import { ClaudeCodeAdapter } from '../src/agents/claudeCodeAdapter.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FileLock } from '../src/persistence/fileLock.js';
import { ProjectRepository } from '../src/persistence/projectRepository.js';
import { DOCUMENT_NAMES, backlogTasks, factoryConfigFor, renderDocuments } from '../src/planning/documents.js';
import { initializeProject } from '../src/planning/initializer.js';
import { ideaCheck, planCheck, proposalCheck, type IdeaInput, type ProductPlan } from '../src/planning/model.js';
import { ClaudeCodePlanner, FixturePlanner, extractJson, plannerArgs, plannerTools, type PlannerRequest, type PlannerResult, type ProductPlanner } from '../src/planning/planner.js';
import { PlanningService } from '../src/planning/planningService.js';
import type { PlanRecord } from '../src/planning/planStore.js';
import { validate } from '../src/planning/schema.js';
import { validatePlan, validateProposal } from '../src/planning/validatePlan.js';
import { loadWorkspaceConfig, parseWorkspaceConfig, type WorkspaceConfig } from '../src/planning/workspace.js';
import type { CommandResult } from '../src/testing/commandRunner.js';
import { git } from './gitFixture.js';
import { makeTempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, '..', '..', 'examples', 'sample-idea');
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;
const clone = <T>(v: T): T => structuredClone(v);
const exists = (p: string) => stat(p).then(() => true, () => false);

async function sample() {
  const idea = validate(ideaCheck, await readJson(path.join(SAMPLE, 'idea.json')), 'idea').value!;
  const proposal = validate(proposalCheck, await readJson(path.join(SAMPLE, 'proposal.json')), 'proposal').value!;
  const plan = validate(planCheck, await readJson(path.join(SAMPLE, 'plan.json')), 'plan').value!;
  return { idea, proposal, plan, rawIdea: await readJson(path.join(SAMPLE, 'idea.json')) as Record<string, unknown> };
}

/** Planner double: replays scripted results per step and records every request. */
class ScriptedPlanner implements ProductPlanner {
  readonly name = 'scripted';
  readonly webResearch: boolean;
  requests: PlannerRequest[] = [];
  gate: Promise<void> | undefined;

  constructor(
    private readonly script: { propose: (PlannerResult | (() => PlannerResult))[]; finalize: (PlannerResult | (() => PlannerResult))[] },
    webResearch = false,
  ) {
    this.webResearch = webResearch;
  }

  async run(request: PlannerRequest): Promise<PlannerResult> {
    this.requests.push(request);
    if (this.gate !== undefined) await this.gate;
    const queue = this.script[request.step];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === undefined) return { error: 'no scripted answer', costKnown: true, durationMs: 0 };
    return typeof next === 'function' ? next() : next;
  }
}

const answer = (output: unknown, costUsd = 0.1): PlannerResult => ({ output: clone(output), costUsd, costKnown: true, durationMs: 1 });

describe('idea-to-project planning', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => undefined);
  });

  async function workspace(overrides: Record<string, unknown> = {}): Promise<{ ws: WorkspaceConfig; dir: string }> {
    const { dir, cleanup } = await makeTempDir();
    cleanups.push(cleanup);
    const file = path.join(dir, 'factory.workspace.json');
    await writeFile(file, JSON.stringify({ version: 1, ...overrides }));
    return { ws: await loadWorkspaceConfig(file), dir };
  }

  async function service(planner: ProductPlanner, overrides: Record<string, unknown> = {}, onProjectReady?: (configFile: string) => Promise<void>) {
    const { ws, dir } = await workspace(overrides);
    const svc = new PlanningService(ws, { planner, ...(onProjectReady ? { onProjectReady } : {}) });
    return { svc, ws, dir };
  }

  // ------------------------------------------------------------- idea input

  describe('idea input', () => {
    it('requires only a name and the idea, and fills defaults for the rest', () => {
      const ok = validate(ideaCheck, { name: 'Tool Share', idea: 'A way for neighbours to lend tools to each other.' }, 'idea');
      assert.deepEqual(ok.issues, []);
      assert.deepEqual(ok.value!.platforms, []);
      assert.equal(ok.value!.research, '');
      assert.deepEqual(ok.value!.referenceUrls, []);
    });

    it('rejects missing, too short or malformed input with clear messages', () => {
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ idea: 'A way for neighbours to lend tools.' }, /idea\.name must be a string/],
        [{ name: 'X', idea: 'A way for neighbours to lend tools.' }, /idea\.name must have at least 2 characters/],
        [{ name: 'Tools', idea: 'too short' }, /idea\.idea must have at least 20 characters/],
        [{ name: 'Tools', idea: 'A way for neighbours to lend tools.', platforms: ['web3'] }, /platforms\[0\] must be one of website, saas, android, ios, desktop, api/],
        [{ name: 'Tools', idea: 'A way for neighbours to lend tools.', referenceUrls: ['javascript:alert(1)'] }, /must be an http\(s\) URL/],
        [{ name: 'Tools', idea: 'A way for neighbours to lend tools.', research: 'x'.repeat(100_001) }, /research must have at most 100000/],
      ];
      for (const [raw, message] of cases) {
        const r = validate(ideaCheck, raw, 'idea');
        assert.equal(r.value, undefined, JSON.stringify(raw).slice(0, 80));
        assert.match(r.issues.join('\n'), message);
      }
    });

    it('creating a plan validates the idea before anything is stored or any planner call', async () => {
      const planner = new ScriptedPlanner({ propose: [], finalize: [] });
      const { svc } = await service(planner);
      await assert.rejects(svc.create({ name: 'X', idea: 'short' }), (err: unknown) => err instanceof ValidationError && /at least 2 characters/.test(err.message));
      assert.deepEqual(await svc.store.list(), []);
      assert.equal(planner.requests.length, 0);
    });

    it('accepts an existing codebase only under the configured roots', async () => {
      const { dir, cleanup } = await makeTempDir();
      cleanups.push(cleanup);
      const allowed = path.join(dir, 'allowed');
      const outside = path.join(dir, 'outside');
      await mkdir(path.join(allowed, 'app'), { recursive: true });
      await mkdir(outside);
      const planner = new ScriptedPlanner({ propose: [], finalize: [] });
      const { svc } = await service(planner, { existingProjectRoots: [allowed] });
      const idea = { name: 'Add export', idea: 'Add CSV export to the existing reporting app.' };
      await assert.rejects(svc.create({ ...idea, existingCodebasePath: outside }), /not inside an allowed folder/);
      await assert.rejects(svc.create({ ...idea, existingCodebasePath: 'app' }), /must be absolute/);
      await assert.rejects(svc.create({ ...idea, existingCodebasePath: path.join(allowed, 'missing') }), /not an accessible folder/);
      await assert.rejects(svc.create({ ...idea, existingCodebasePath: path.join(allowed, 'app', '..', '..', 'outside') }), /not inside an allowed folder/);
      const { svc: closed } = await service(planner);
      await assert.rejects(closed.create({ ...idea, existingCodebasePath: path.join(allowed, 'app') }), /not enabled/);
      assert.equal(planner.requests.length, 0);
    });
  });

  // -------------------------------------------------- generation & validation

  describe('plan validation', () => {
    it('the sample plan passes every check and renders consistent documents', async () => {
      const { idea, proposal, plan } = await sample();
      const { ws } = await workspace();
      const docs = renderDocuments(plan, idea, proposal, '2026-10-13');
      const result = validatePlan(plan, idea, ws, docs);
      assert.deepEqual(result.errors, []);
      assert.equal(result.valid, true);
      assert.deepEqual(Object.keys(docs).sort(), [...DOCUMENT_NAMES].sort());
      // Cross-references between documents come from the same plan.
      assert.match(docs['REQUIREMENTS.md'], /### FR-4: Request a loan \(MVP\)[\s\S]*Implemented by: T6/);
      assert.match(docs['DATA_MODEL.md'], /## Loan[\s\S]*Implemented by: T2, T6, T7/);
      assert.match(docs['UX_PLAN.md'], /SCR-4 My loans[\s\S]*tasks: T7, T8/);
      assert.match(docs['ARCHITECTURE.md'], /\*\*Trade-offs:\*\*/);
      assert.match(docs['RELEASE_PLAN.md'], /SMTP_URL \| Email delivery/);
      assert.match(docs['PRODUCT.md'], /### Assumptions \(unverified\)\n- Hosting a small Node\.js app/);
      const tasks = JSON.parse(docs['TASKS.json']) as { schemaVersion: number; tasks: { id: string; status: string }[] };
      assert.equal(tasks.schemaVersion, 1);
      assert.deepEqual(tasks.tasks.map((t) => t.id), plan.tasks.map((t) => t.id));
      assert.deepEqual(result.waves[0], ['T1']);
      assert.deepEqual(result.waves[7], ['T8', 'T9']);
    });

    it('the backlog uses the existing task schema, with scope, checks, risk and evidence in the description', async () => {
      const { plan } = await sample();
      const tasks = backlogTasks(plan);
      assert.equal(tasks.length, 11);
      const t3 = tasks.find((t) => t.id === 'T3')!;
      assert.deepEqual(Object.keys(t3).sort(), ['acceptanceCriteria', 'dependencies', 'description', 'id', 'results', 'retryCount', 'status', 'title']);
      assert.equal(t3.status, 'pending');
      assert.deepEqual(t3.dependencies, ['T2']);
      assert.match(t3.description, /Checks \(factory validation commands\): test, build/);
      assert.match(t3.description, /Risk: high \(authentication, personal-data, secrets\)/);
      assert.match(t3.description, /Completion evidence:\n- Tests for sign-up/);
      assert.match(t3.description, /Deliverables:\n- src\/auth\.js/);
    });

    it('rejects task schema problems from the planner', async () => {
      const { plan } = await sample();
      const bad = clone(plan) as unknown as { tasks: Record<string, unknown>[] };
      bad.tasks[0]!.id = 'T 1';
      bad.tasks[1]!.acceptanceCriteria = [];
      bad.tasks[2]!.checks = [];
      bad.tasks[3]!.risk = 'extreme';
      delete bad.tasks[4]!.evidence;
      const r = validate(planCheck, bad, 'plan');
      const text = r.issues.join('\n');
      assert.match(text, /plan\.tasks\[0\]\.id must be a task id/);
      assert.match(text, /plan\.tasks\[1\]\.acceptanceCriteria must have at least 1 item/);
      assert.match(text, /plan\.tasks\[2\]\.checks must have at least 1 item/);
      assert.match(text, /plan\.tasks\[3\]\.risk must be one of low, medium, high/);
      assert.match(text, /plan\.tasks\[4\]\.evidence must be a list/);
    });

    it('detects duplicate ids, cycles and missing dependencies in the task graph', async () => {
      const { idea, plan } = await sample();
      const { ws } = await workspace();
      const cyclic = clone(plan);
      cyclic.tasks[0]!.dependencies = ['T11'];
      assert.match(validatePlan(cyclic, idea, ws).errors.join('\n'), /task graph: .*[Cc]ycle/);
      const missing = clone(plan);
      missing.tasks[4]!.dependencies = ['T99'];
      assert.match(validatePlan(missing, idea, ws).errors.join('\n'), /task graph: .*T99/);
      const dup = clone(plan);
      dup.tasks[5]!.id = 'T5';
      assert.match(validatePlan(dup, idea, ws).errors.join('\n'), /task id T5 is used more than once/);
    });

    it('finds inconsistencies between the documents and the backlog', async () => {
      const { idea, plan } = await sample();
      const { ws } = await workspace();
      const p = clone(plan);
      p.tasks = p.tasks.map((t) => ({ ...t, covers: t.covers.filter((c) => c !== 'FR-4'), entities: t.entities.filter((e) => e !== 'Loan' || t.id !== 'T2'), screens: t.screens.filter((s) => s !== 'SCR-5') }));
      p.tasks.find((t) => t.id === 'T6')!.entities = [];
      p.tasks.find((t) => t.id === 'T7')!.entities = [];
      p.tasks[0]!.checks = ['lint'];
      p.tasks[1]!.covers = ['FR-42'];
      p.architecture.integrations.push({ name: 'Maps', purpose: 'Show distance', configKeys: ['MAPS_API_KEY'], sensitive: true, paid: true, verified: false });
      p.ux.screens[0]!.requirementIds = ['FR-77'];
      const errors = validatePlan(p, idea, ws).errors.join('\n');
      assert.match(errors, /MVP requirement FR-4 \("Request a loan"\) is not covered by any task/);
      assert.match(errors, /entity Loan appears in the data model but no task implements it/);
      assert.match(errors, /screen SCR-5 \("My tools"\) is in the UX plan but no task builds it/);
      assert.match(errors, /task T1 requires check "lint", which is not a defined command/);
      assert.match(errors, /task T2 covers unknown requirement FR-42/);
      assert.match(errors, /integration "Maps" needs MAPS_API_KEY, which is not documented/);
      assert.match(errors, /screen SCR-1 refers to unknown requirement FR-77/);
    });

    it('reports conflicting requirements, dropped platforms, unsafe risk labels and infeasibility', async () => {
      const { idea, plan } = await sample();
      const { ws } = await workspace();
      const p = clone(plan);
      p.product.outOfScope.push('Request a loan');
      p.architecture.platforms = ['saas'];
      p.tasks.find((t) => t.id === 'T3')!.risk = 'low';
      p.feasibility = { feasible: false, issues: ['needs bank integration'] };
      const errors = validatePlan(p, { ...idea, platforms: ['website'] }, ws).errors.join('\n');
      assert.match(errors, /MVP requirement FR-4 \("Request a loan"\) is also listed as out of scope/);
      assert.match(errors, /architecture drops the requested platform "website"/);
      assert.match(errors, /task T3 is flagged authentication, secrets and cannot be low risk/);
      assert.match(errors, /not feasible as approved: needs bank integration/);
    });

    it('only accepts narrow, allowlisted validation commands', async () => {
      const { idea, plan } = await sample();
      const { ws } = await workspace();
      const commands: [ProductPlan['commands'][number], RegExp][] = [
        [{ name: 'test', executable: 'npm', args: ['test'], description: '' }, /uses "npm", which is not in the workspace's allowedExecutables \(node\)/],
        [{ name: 'test', executable: 'node', args: ['-e', 'require("child_process")'], description: '' }, /node commands must be "node --test \[files\]" or "node --run <script>"/],
        [{ name: 'test', executable: 'node', args: ['--run', 'install'], description: '' }, /not an install, publish or deploy script/],
        [{ name: 'test', executable: 'node', args: ['--run', 'build', 'extra'], description: '' }, /takes exactly one package.json script name/],
        [{ name: 'test', executable: 'node', args: ['--test', '--import=./evil.js'], description: '' }, /only takes test files and --test-\* options/],
        [{ name: 'test', executable: 'node', args: ['--test', 'a.js;calc'], description: '' }, /shell syntax|only takes test files/],
      ];
      for (const [command, message] of commands) {
        const p = clone(plan);
        p.commands = [command, p.commands[1]!];
        assert.match(validatePlan(p, idea, ws).errors.join('\n'), message, JSON.stringify(command));
      }
      const fine = clone(plan);
      fine.commands[0] = { name: 'test', executable: 'node', args: ['--test', 'test/user-update.test.js', '--test-reporter=spec'], description: '' };
      assert.deepEqual(validatePlan(fine, idea, ws).errors, []);
    });

    it('keeps secrets out of generated documents', async () => {
      const { idea, plan } = await sample();
      const { ws } = await workspace();
      const p = clone(plan);
      p.release.monitoring = 'Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz for the uptime service';
      const docs = renderDocuments(p, idea, undefined, '2026-10-13');
      assert.match(validatePlan(p, idea, ws, docs).errors.join('\n'), /looks like a secret \(Anthropic API key\)/);
    });

    it('enforces the task limit and reports execution estimates as upper bounds', async () => {
      const { idea, plan } = await sample();
      const { ws } = await workspace({ limits: { maxTasks: 5 }, projectDefaults: { maxTasksPerRun: 4, maxRepairAttempts: 1, agent: { maxBudgetUsd: 1 }, autonomy: { maxCostUsd: 0.5 } } });
      const result = validatePlan(plan, idea, ws);
      assert.match(result.errors.join('\n'), /the backlog has 11 tasks; the workspace allows at most 5/);
      assert.match(result.errors.join('\n'), /run budget \(\$0\.5\) cannot cover a single agent call \(\$1\)/);
      assert.deepEqual({ runs: result.estimate.runs, calls: result.estimate.maxAgentCalls, cost: result.estimate.maxCostUsd }, { runs: 3, calls: 22, cost: 22 });
      assert.match(result.estimate.notes.join(' '), /Upper bounds, not predictions/);
    });
  });

  // -------------------------------------------------------- research sources

  describe('research and sources', () => {
    it('refuses web sources and "verified" claims when no live research was possible', async () => {
      const { idea, proposal, plan } = await sample();
      const { ws } = await workspace();
      const p = clone(proposal);
      p.sources.push({ id: 'SRC-2', title: 'Competitor pricing page', kind: 'web', url: 'https://example.com/pricing', retrievedAt: '2026-10-01', notes: '' });
      p.statements.push({ statement: 'Competitors charge 5 USD per month.', basis: 'verified', sourceIds: ['SRC-2'] });
      p.statements.push({ statement: 'Neighbours want this.', basis: 'verified', sourceIds: ['SRC-1'] });
      p.statements.push({ statement: 'Cites nothing real.', basis: 'assumption', sourceIds: ['SRC-9'] });
      const errors = validateProposal(p, idea, ws).errors.join('\n');
      assert.match(errors, /source SRC-2 \("Competitor pricing page"\) is marked as web research, but live research is disabled/);
      assert.match(errors, /statement 6 is marked verified but cites no web or codebase source/);
      assert.match(errors, /statement 7 cites unknown source SRC-9/);

      const withResearch = (await workspace({ planner: { webResearch: true } })).ws;
      const ok = validateProposal(p, idea, withResearch).errors.join('\n');
      assert.doesNotMatch(ok, /SRC-2/);

      const docs = renderDocuments(plan, { ...idea, referenceUrls: ['https://example.org/notes'] }, proposal, '2026-10-13');
      assert.match(docs['RESEARCH.md'], /\*\*SRC-1\*\* Notes supplied with the idea - kind: user-supplied - retrieval date: not recorded/);
      assert.match(docs['RESEARCH.md'], /https:\/\/example\.org\/notes \(provided by the user; not retrieved by the factory\)/);
      const noSources = renderDocuments({ ...clone(plan), sources: [] }, idea, proposal, '2026-10-13');
      assert.match(noSources['RESEARCH.md'], /No live research was performed; external facts in these documents are assumptions/);
    });

    it('tells the planner whether live research is available, and passes user research through', async () => {
      const { rawIdea, proposal } = await sample();
      const planner = new ScriptedPlanner({ propose: [answer(proposal)], finalize: [] });
      const { svc } = await service(planner);
      const record = await svc.create(rawIdea);
      await svc.settled(record.planId);
      const request = planner.requests[0]!;
      assert.match(request.idea.research, /about 10 'does anyone have a \.\.\.' messages a week/);
      const { proposalPrompt } = await import('../src/planning/prompts.js');
      assert.match(proposalPrompt(request, false), /Live research is NOT available in this session/);
      assert.match(proposalPrompt(request, true), /You may use WebSearch and WebFetch/);
      assert.match(proposalPrompt(request, false), /Never invent citations, competitor data, prices/);
    });
  });

  // ----------------------------------------------------------- the planner

  describe('Claude Code planner', () => {
    const settings = (overrides: Record<string, unknown> = {}) => parseWorkspaceConfig({ version: 1, planner: { maxBudgetUsdPerCall: 0.5, maxCostUsdPerPlan: 2, ...overrides } }, 'C:\\ws\\factory.workspace.json').planner;

    it('runs without file-changing or command tools, hardened, with a per-call budget', () => {
      const s = settings();
      assert.deepEqual(plannerTools(s, false), []);
      assert.deepEqual(plannerTools(s, true), ['Read', 'Glob', 'Grep']);
      assert.deepEqual(plannerTools(settings({ webResearch: true }), false), ['WebSearch', 'WebFetch']);
      const args = plannerArgs(s, []);
      assert.deepEqual(args.slice(0, 8), ['--print', '--output-format', 'json', '--permission-mode', 'dontAsk', '--tools', '', '--restricted']);
      for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
      assert.deepEqual(args.slice(-2), ['--max-budget-usd', '0.5']);
      assert.ok(!args.some((a) => /Bash|Edit|Write|PowerShell/.test(a)));
    });

    it('parses the answer and the reported cost; failures and missing usage are reported', async () => {
      const { proposal, idea } = await sample();
      const runs: { args: string[]; stdin: string; cwd: string }[] = [];
      const fake = (stdout: string, extra: Partial<CommandResult> = {}) => async (cmd: { args: string[]; cwd: string }, opts: { stdin?: string } = {}): Promise<CommandResult> => {
        runs.push({ args: cmd.args, stdin: opts.stdin ?? '', cwd: cmd.cwd });
        return { name: 'planner', exitCode: 0, timedOut: false, durationMs: 5, stdout, stderr: '', truncated: false, ...extra };
      };
      const request: PlannerRequest = { step: 'propose', idea, previousIssues: [], workingDirectory: 'C:\\sandbox', today: '2026-10-13' };
      const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.12, result: `Here it is:\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\`` });
      const ok = await new ClaudeCodePlanner(settings(), { runCommand: fake(result) as never }).run(request);
      assert.deepEqual(ok.output, proposal);
      assert.equal(ok.costUsd, 0.12);
      assert.equal(ok.costKnown, true);
      assert.equal(runs[0]!.cwd, 'C:\\sandbox');
      assert.match(runs[0]!.stdin, /Prepare a concise product PROPOSAL/);

      const noCost = await new ClaudeCodePlanner(settings(), { runCommand: fake(JSON.stringify({ subtype: 'success', result: '{}' })) as never }).run(request);
      assert.equal(noCost.costKnown, false);
      const timeout = await new ClaudeCodePlanner(settings(), { runCommand: fake('', { exitCode: null, timedOut: true }) as never }).run(request);
      assert.match(timeout.error!, /timed out/);
      assert.equal(timeout.costKnown, false);
      const notJson = await new ClaudeCodePlanner(settings(), { runCommand: fake(JSON.stringify({ subtype: 'success', total_cost_usd: 0.01, result: 'I cannot help with that.' })) as never }).run(request);
      assert.match(notJson.error!, /not valid JSON/);
      const missing = await new ClaudeCodePlanner(settings(), { runCommand: fake('', { exitCode: null, error: 'spawn claude ENOENT' }) as never }).run(request);
      assert.match(missing.error!, /could not be started/);
      assert.equal(missing.costKnown, true);
      assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    });
  });

  // ------------------------------------------------------ approval workflow

  describe('approval workflow', () => {
    async function proposed(overrides: Record<string, unknown> = {}, planner?: ScriptedPlanner) {
      const { rawIdea, proposal, plan } = await sample();
      const p = planner ?? new ScriptedPlanner({ propose: [answer(proposal)], finalize: [answer(plan)] });
      const ctx = await service(p, overrides);
      const record = await ctx.svc.create(rawIdea);
      await ctx.svc.settled(record.planId);
      return { ...ctx, planner: p, planId: record.planId, plan };
    }

    it('prepares a proposal and waits for the one approval', async () => {
      const { svc, planId, planner } = await proposed();
      const { record } = await svc.view(planId);
      assert.equal(record.state, 'proposed');
      assert.equal(record.proposal!.productName, 'Tool Share');
      assert.equal(planner.requests.length, 1);
      assert.equal(await svc.document(planId, 'PRODUCT.md'), undefined); // nothing is generated before approval
    });

    it('approval finalizes, validates and initializes the project without further approvals', async () => {
      const { svc, planId, planner, ws } = await proposed();
      await svc.approve(planId);
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(record.state, 'ready', JSON.stringify(record.failure ?? record.validation?.errors));
      assert.deepEqual(planner.requests.map((r) => r.step), ['propose', 'finalize']);
      assert.equal(record.project!.root, path.join(ws.projectsDir, 'tool-share'));
      assert.equal(record.validation!.valid, true);
      assert.equal(record.decision!.decision, 'approved');
    });

    it('rejection needs a reason, creates nothing and is final', async () => {
      const { svc, planId, ws, planner } = await proposed();
      await assert.rejects(svc.reject(planId, '  '), /reason is required/);
      await svc.reject(planId, 'Not now');
      const { record } = await svc.view(planId);
      assert.equal(record.state, 'rejected');
      assert.equal(record.decision!.reason, 'Not now');
      assert.equal(await exists(ws.projectsDir), false);
      await assert.rejects(svc.approve(planId), /The plan is rejected/);
      assert.equal(planner.requests.length, 1);
    });

    it('a double approval starts the work only once', async () => {
      const { svc, planId, planner } = await proposed();
      let release!: () => void;
      planner.gate = new Promise((r) => (release = r));
      const results = await Promise.allSettled([svc.approve(planId), svc.approve(planId)]);
      assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.match(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason), /already being worked on/);
      release();
      await svc.settled(planId);
      assert.deepEqual(planner.requests.map((r) => r.step), ['propose', 'finalize']);
    });

    it('asks one blocking question when the planner needs it, then plans again with the answer', async () => {
      const { rawIdea, proposal } = await sample();
      const asking = { ...clone(proposal), blockingQuestion: 'Is this for one building or a whole district?' };
      const planner = new ScriptedPlanner({ propose: [answer(asking), answer(proposal)], finalize: [] });
      const { svc } = await service(planner);
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      assert.equal((await svc.view(planId)).record.state, 'needs-input');
      await assert.rejects(svc.approve(planId), /needs-input/);
      await svc.answer(planId, 'One building with 120 flats.');
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(record.state, 'proposed');
      assert.deepEqual(planner.requests[1]!.idea.clarifications, [{ question: 'Is this for one building or a whole district?', answer: 'One building with 120 flats.' }]);
    });

    it('pauses instead of substituting another product when the approved idea is infeasible', async () => {
      const { rawIdea, proposal, plan } = await sample();
      const infeasible = { ...clone(plan), feasibility: { feasible: false, issues: ['Requires access to a bank API that is not available'] } };
      const planner = new ScriptedPlanner({ propose: [answer(proposal)], finalize: [answer(infeasible)] });
      const { svc, ws } = await service(planner);
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      await svc.approve(planId);
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(record.state, 'needs-attention');
      assert.match(record.attention!.message, /not to be feasible as approved: Requires access to a bank API/);
      assert.equal(await exists(ws.projectsDir), false);
    });

    it('feeds validation problems back to the planner, and stops as invalid after the allowed attempts', async () => {
      const { rawIdea, proposal, plan } = await sample();
      const broken = clone(plan);
      broken.tasks = broken.tasks.map((t) => ({ ...t, covers: t.covers.filter((c) => c !== 'FR-4') }));
      const planner = new ScriptedPlanner({ propose: [answer(proposal)], finalize: [answer(broken), answer(broken)] });
      const { svc, ws } = await service(planner, { planner: { maxAttemptsPerStep: 2 } });
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      await svc.approve(planId);
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(record.state, 'invalid');
      assert.match(record.validation!.errors.join('\n'), /FR-4 .* is not covered by any task/);
      assert.match(planner.requests[2]!.previousIssues.join('\n'), /FR-4/);
      assert.equal(planner.requests.length, 3);
      assert.equal(await exists(ws.projectsDir), false);
      // The documents of the invalid attempt can still be inspected.
      assert.match((await svc.document(planId, 'REQUIREMENTS.md'))!, /FR-4/);
    });
  });

  // ----------------------------------------------------- budget and limits

  describe('planning budget and limits', () => {
    it('never starts a call the remaining budget cannot cover', async () => {
      const { rawIdea } = await sample();
      const planner = new ScriptedPlanner({ propose: [answer({ nope: true }, 0.8)], finalize: [] });
      const { svc } = await service(planner, { planner: { maxBudgetUsdPerCall: 1, maxCostUsdPerPlan: 1.5, maxAttemptsPerStep: 3 } });
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(planner.requests.length, 1); // $0.70 left cannot cover a $1 call
      assert.equal(record.state, 'failed');
      assert.match(record.failure!.message, /planning budget is used up \(\$0\.8000 of \$1\.5; another call may cost up to \$1\)/);
      assert.ok(record.cost.usd <= 1.5);
    });

    it('stops when the cost of a call is unknown and a budget is configured', async () => {
      const { rawIdea } = await sample();
      const planner = new ScriptedPlanner({ propose: [{ error: 'The planner timed out', costKnown: false, durationMs: 1 }], finalize: [] });
      const { svc } = await service(planner, { planner: { maxBudgetUsdPerCall: 1, maxCostUsdPerPlan: 5, maxAttemptsPerStep: 3 } });
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(planner.requests.length, 1);
      assert.equal(record.cost.unknown, true);
      assert.match(record.failure!.message, /cost of an earlier planner call is unknown/);
    });

    it('caps the number of planner calls per idea across retries', async () => {
      const { rawIdea } = await sample();
      const planner = new ScriptedPlanner({ propose: [answer({ nope: true }, 0)], finalize: [] });
      const { svc } = await service(planner, { planner: { maxAttemptsPerStep: 2, maxCallsPerPlan: 3 } });
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      assert.equal((await svc.view(planId)).record.state, 'failed');
      await svc.retry(planId);
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(planner.requests.length, 3);
      assert.match(record.failure!.message, /limit of 3 planner calls/);
    });
  });

  // -------------------------------------------------------- initialization

  describe('project initialization', () => {
    async function ready() {
      const { rawIdea, proposal, plan } = await sample();
      const planner = new ScriptedPlanner({ propose: [answer(proposal)], finalize: [answer(plan)] });
      const ctx = await service(planner);
      const { planId } = await ctx.svc.create(rawIdea);
      await ctx.svc.settled(planId);
      await ctx.svc.approve(planId);
      await ctx.svc.settled(planId);
      const { record } = await ctx.svc.view(planId);
      assert.equal(record.state, 'ready', JSON.stringify(record.failure));
      return { ...ctx, planId, record, plan, proposal, rawIdea };
    }

    it('creates a git repository with the documents, a valid factory config and the imported backlog', async () => {
      const { record, ws } = await ready();
      const root = record.project!.root;
      for (const name of DOCUMENT_NAMES) assert.ok(await exists(path.join(root, 'docs', name)), name);
      const config = await loadFactoryConfig(path.join(root, 'factory.config.json'));
      assert.equal(config.projectRoot, root);
      assert.deepEqual(config.execution.validationCommands, ['test', 'build']);
      assert.deepEqual(config.allowedExecutables, ['node']);
      assert.equal(config.autonomy.enabled, true);
      assert.equal(config.autonomy.autoAccept.enabled, false); // every result waits for review by default
      assert.equal(config.agent.permissionMode, 'dontAsk');
      const repo = new ProjectRepository(config.dataDir);
      assert.equal((await repo.loadProject()).id, 'tool-share');
      assert.equal((await repo.loadTasks()).length, 11);
      // One initial commit with only the generated files; nothing left uncommitted; factory state ignored.
      assert.equal(git(root, 'rev-list', '--count', 'HEAD').trim(), '1');
      assert.equal(git(root, 'status', '--porcelain').trim(), '');
      const files = git(root, 'ls-files').trim().split('\n').sort();
      assert.deepEqual(files, ['.gitignore', 'README.md', 'docs/ARCHITECTURE.md', 'docs/DATA_MODEL.md', 'docs/PRODUCT.md', 'docs/RELEASE_PLAN.md', 'docs/REQUIREMENTS.md', 'docs/RESEARCH.md', 'docs/TASKS.json', 'docs/TEST_PLAN.md', 'docs/UX_PLAN.md', 'factory.config.json']);
      assert.match(git(root, 'log', '-1', '--format=%an <%ae>%n%s'), /AI Software Factory <factory@localhost>\nPlan Tool Share/);
      const registry = await readJson(path.join(ws.stateDir, 'projects.json')) as { projects: { configFile: string }[] };
      assert.deepEqual(registry.projects.map((p) => p.configFile), [path.join(root, 'factory.config.json')]);
    });

    it('the existing orchestrator finds the first eligible task (no coding session is started)', async () => {
      const { record } = await ready();
      const config = await loadFactoryConfig(record.project!.configFile);
      const repository = new ProjectRepository(config.dataDir);
      const agent = new ClaudeCodeAdapter(config.agent, config.limits, config.projectRoot, { executionEnabled: false });
      const orchestrator = new Orchestrator({ config, repository, agent, lock: new FileLock(config.dataDir) });
      assert.deepEqual((await orchestrator.nextTasks()).map((t) => t.id), ['T1']);
      const dryRun = await orchestrator.planTask();
      assert.equal(dryRun!.task.id, 'T1');
      assert.match(dryRun!.plan.stdin, /Project skeleton and health check/);
      assert.ok(dryRun!.plan.args.includes('--restricted'));
      const status = await orchestrator.status();
      assert.match(status.find((s) => s.task.id === 'T2')!.eligibility.reason, /waiting on dependencies: T1/);
    });

    it('an interrupted initialization resumes without a second project or lost files', async () => {
      const { rawIdea, proposal, plan } = await sample();
      let failCommit = true;
      const flakyGit = async (args: string[], cwd: string) => {
        if (failCommit && args.includes('commit')) {
          failCommit = false;
          return { code: 1, stdout: '', stderr: 'simulated crash during commit' };
        }
        const { defaultGitRunner } = await import('../src/git/gitWorkspace.js');
        return defaultGitRunner(args, cwd);
      };
      const { ws } = await workspace();
      const svc = new PlanningService(ws, { planner: new ScriptedPlanner({ propose: [answer(proposal)], finalize: [answer(plan)] }), git: flakyGit });
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      await svc.approve(planId);
      await svc.settled(planId);
      let { record } = await svc.view(planId);
      assert.equal(record.state, 'failed');
      assert.equal(record.failure!.step, 'initialize');
      assert.match(record.failure!.message, /simulated crash during commit/);
      const root = record.destination!;
      assert.ok(await exists(path.join(root, 'docs', 'PRODUCT.md')));

      await svc.retry(planId);
      await svc.settled(planId);
      ({ record } = await svc.view(planId));
      assert.equal(record.state, 'ready', JSON.stringify(record.failure));
      assert.equal(record.project!.root, root);
      assert.deepEqual(await readdir(ws.projectsDir), ['tool-share']);
      assert.equal(git(root, 'rev-list', '--count', 'HEAD').trim(), '1');
      assert.equal(record.attempts.finalize, 1); // the planner was not asked again
      const registry = await svc.store.registry();
      assert.equal(registry.length, 1);
    });

    it('a step interrupted by a crash is detected and can be retried', async () => {
      const { rawIdea, proposal } = await sample();
      const planner = new ScriptedPlanner({ propose: [answer(proposal)], finalize: [] });
      const { svc } = await service(planner);
      const { planId } = await svc.create(rawIdea);
      await svc.settled(planId);
      // Simulate a dashboard that died while proposing: working state, job owned by a dead process.
      const record = await svc.store.load(planId);
      record.state = 'proposing';
      record.job = { step: 'propose', pid: 999_999_999, startedAt: record.updatedAt };
      await svc.store.save(record);
      assert.equal((await svc.view(planId)).interrupted, true);
      await svc.retry(planId);
      await svc.settled(planId);
      const after = await svc.view(planId);
      assert.equal(after.record.state, 'proposed');
      assert.equal(after.interrupted, false);
    });

    it('never creates a duplicate project and never takes over a folder it did not create', async () => {
      const { rawIdea, proposal, plan } = await sample();
      const { ws } = await workspace();
      // A folder with the same name already exists with someone else's files.
      await mkdir(path.join(ws.projectsDir, 'tool-share'), { recursive: true });
      await writeFile(path.join(ws.projectsDir, 'tool-share', 'notes.txt'), 'mine');
      const make = () => new PlanningService(ws, { planner: new ScriptedPlanner({ propose: [answer(proposal)], finalize: [answer(plan)] }) });
      const first = make();
      const a = await first.create(rawIdea);
      await first.settled(a.planId);
      await first.approve(a.planId);
      await first.settled(a.planId);
      const b = await first.create(rawIdea);
      await first.settled(b.planId);
      await first.approve(b.planId);
      await first.settled(b.planId);
      const ra = (await first.view(a.planId)).record;
      const rb = (await first.view(b.planId)).record;
      assert.equal(path.basename(ra.project!.root), 'tool-share-2');
      assert.equal(path.basename(rb.project!.root), 'tool-share-3');
      assert.equal(await readFile(path.join(ws.projectsDir, 'tool-share', 'notes.txt'), 'utf8'), 'mine');
      assert.equal((await first.store.registry()).length, 2);

      // Running the initialization of plan A again changes nothing and creates nothing new.
      const before = git(ra.project!.root, 'rev-parse', 'HEAD');
      const again = await initializeProject(ws, ra, plan, new Date().toISOString());
      assert.equal(again.root, ra.project!.root);
      assert.equal(git(ra.project!.root, 'rev-parse', 'HEAD'), before);
      assert.deepEqual(again.actions, ['imported 11 task(s) into the task engine']);
      // Another plan cannot claim plan A's folder.
      await assert.rejects(initializeProject(ws, { ...rb, destination: ra.project!.root } as PlanRecord, plan, new Date().toISOString()), /was created by another plan/);
    });

    it('keeps an already started backlog when initialization runs again', async () => {
      const { record, plan, ws } = await ready();
      const repo = new ProjectRepository(path.join(record.project!.root, '.factory'));
      const tasks = await repo.loadTasks();
      tasks[0]!.status = 'completed';
      await repo.saveTasks(tasks);
      const again = await initializeProject(ws, record, plan, new Date().toISOString());
      assert.match(again.actions.join('\n'), /kept the existing backlog \(1 task\(s\) already started\)/);
      assert.equal((await repo.loadTasks())[0]!.status, 'completed');
    });
  });

  // ------------------------------------------------------- existing projects

  describe('existing codebases', () => {
    async function existingRepo() {
      const { dir, cleanup } = await makeTempDir();
      cleanups.push(cleanup);
      const roots = path.join(dir, 'code');
      const app = path.join(roots, 'reports');
      await mkdir(path.join(app, 'src'), { recursive: true });
      await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'reports', scripts: { test: 'node --test' } }));
      await writeFile(path.join(app, 'src', 'index.js'), 'export const x = 1;\n');
      git(app, 'init', '-q');
      git(app, 'add', '.');
      git(app, 'commit', '-q', '-m', 'user work');
      return { roots, app };
    }

    it('inspects the codebase, lets the planner read it, and adds only factory files without touching git', async () => {
      const { roots, app } = await existingRepo();
      const { rawIdea, proposal, plan } = await sample();
      const existingProposal = { ...clone(proposal), projectType: 'existing-codebase' };
      const existingPlan = clone(plan);
      existingPlan.architecture.projectType = 'existing-codebase';
      const planner = new ScriptedPlanner({ propose: [answer(existingProposal)], finalize: [answer(existingPlan)] });
      const { svc } = await service(planner, { existingProjectRoots: [roots] });
      const head = git(app, 'rev-parse', 'HEAD');
      const { planId } = await svc.create({ ...rawIdea, existingCodebasePath: app });
      await svc.settled(planId);
      assert.equal(planner.requests[0]!.workingDirectory, app);
      assert.deepEqual(planner.requests[0]!.codebase!.packageJson!.scripts, ['test']);
      assert.equal(planner.requests[0]!.codebase!.isGitRepo, true);
      await svc.approve(planId);
      await svc.settled(planId);
      const { record } = await svc.view(planId);
      assert.equal(record.state, 'ready', JSON.stringify(record.failure ?? record.validation?.errors));
      assert.equal(record.project!.root, app);
      assert.equal(git(app, 'rev-parse', 'HEAD'), head);
      assert.equal(git(app, 'log', '--format=%s').trim(), 'user work');
      assert.equal(await readFile(path.join(app, 'src', 'index.js'), 'utf8'), 'export const x = 1;\n');
      for (const name of DOCUMENT_NAMES) assert.ok(await exists(path.join(app, '.factory', 'docs', name)), name);
      const config = await loadFactoryConfig(path.join(app, '.factory', 'factory.config.json'));
      assert.equal(config.projectRoot, app);
      assert.equal(config.dataDir, path.join(app, '.factory'));
      const tasks = await new ProjectRepository(config.dataDir).loadTasks();
      assert.match(tasks[0]!.description, /\.factory\/docs\/PRODUCT\.md/);
      // Only untracked factory files were added; the user's files are unchanged.
      assert.deepEqual(git(app, 'status', '--porcelain', '--untracked-files=normal').trim().split('\n'), ['?? .factory/']);
    });

    it('refuses projects that already have factory state, and repositories without commits', async () => {
      const { roots, app } = await existingRepo();
      const planner = new ScriptedPlanner({ propose: [], finalize: [] });
      const { svc } = await service(planner, { existingProjectRoots: [roots] });
      const idea = { name: 'Add export', idea: 'Add CSV export to the existing reporting app.' };
      await mkdir(path.join(app, '.factory'));
      await writeFile(path.join(app, '.factory', 'project.json'), '{}');
      await assert.rejects(svc.create({ ...idea, existingCodebasePath: app }), /already has factory state/);

      const empty = path.join(roots, 'empty');
      await mkdir(empty);
      git(empty, 'init', '-q');
      const { rawIdea, proposal, plan } = await sample();
      const p2 = new ScriptedPlanner({ propose: [answer({ ...clone(proposal), projectType: 'existing-codebase' })], finalize: [answer({ ...clone(plan), architecture: { ...clone(plan).architecture, projectType: 'existing-codebase' } })] });
      const { svc: svc2 } = await service(p2, { existingProjectRoots: [roots] });
      const { planId } = await svc2.create({ ...rawIdea, existingCodebasePath: empty });
      await svc2.settled(planId);
      const created = (await svc2.view(planId)).record;
      assert.match(created.events.map((e) => e.message).join('\n'), /no commits yet/);
      await svc2.approve(planId);
      await svc2.settled(planId);
      const { record } = await svc2.view(planId);
      assert.equal(record.state, 'failed');
      assert.match(record.failure!.message, /must be a git repository with at least one commit/);
      assert.equal(await exists(path.join(empty, '.factory', 'project.json')), false);
    });
  });

  // -------------------------------------------------------------- fixtures

  it('the fixture planner replays saved output without any AI call', async () => {
    const planner = new FixturePlanner(SAMPLE);
    const { idea } = await sample();
    const r = await planner.run({ step: 'finalize', idea: idea as IdeaInput, previousIssues: [], workingDirectory: SAMPLE, today: '2026-10-13' });
    assert.equal((r.output as ProductPlan).tasks.length, 11);
    assert.equal(r.costUsd, 0);
    const missing = await new FixturePlanner(path.join(SAMPLE, 'nope')).run({ step: 'propose', idea: idea as IdeaInput, previousIssues: [], workingDirectory: SAMPLE, today: '2026-10-13' });
    assert.match(missing.error!, /cannot read proposal\.json/);
  });

  it('the generated factory config cannot carry planner-chosen permissions or limits', async () => {
    const { plan } = await sample();
    const { ws } = await workspace({ projectDefaults: { maxTasksPerRun: 3, agent: { maxBudgetUsd: 1 }, autonomy: { maxCostUsd: 3 }, autoAcceptLowRisk: true } });
    const p = clone(plan) as ProductPlan & Record<string, unknown>;
    p.agent = { permissionMode: 'bypassPermissions', tools: ['Bash'] };
    p.limits = { maxTasksPerRun: 50 };
    const raw = factoryConfigFor(p, ws, { projectRoot: '.', dataDir: '.factory', configDir: ws.root }) as Record<string, any>;
    assert.equal(raw.agent.permissionMode, 'dontAsk');
    assert.deepEqual(raw.agent.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    assert.equal(raw.limits.maxTasksPerRun, 3);
    assert.equal(raw.autonomy.maxCostUsd, 3);
    // Auto-accept (when enabled in the workspace) only covers low-risk tasks without sensitive flags.
    assert.deepEqual(raw.autonomy.autoAccept.taskIds, ['T1', 'T5', 'T8', 'T10']);
  });
});
