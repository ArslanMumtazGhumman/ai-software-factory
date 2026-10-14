import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { CliRunLauncher, cliArgs, type LaunchRequest, type LaunchResult, type RunLauncher } from '../src/dashboard/launcher.js';
import { loadProjects, type DashboardProject } from '../src/dashboard/projects.js';
import { startDashboardServer, type DashboardServer } from '../src/dashboard/server.js';
import { DashboardService } from '../src/dashboard/service.js';
import type { AutoRunRecord } from '../src/persistence/autoRunStore.js';
import { FakeAgent, GOOD, chainAgent, git, makeChainFixture, ok, type AgentBehavior, type Fixture } from './gitFixture.js';
import { makeTempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'src', 'cli.js');

// ------------------------------------------------------------------ helpers

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function rawRequest(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Runs a run in this process (with the fake agent) instead of spawning the CLI. */
class InProcessLauncher implements RunLauncher {
  calls: LaunchRequest[] = [];
  done: Promise<AutoRunRecord> | undefined;

  async launch(project: DashboardProject, request: LaunchRequest): Promise<LaunchResult> {
    this.calls.push(request);
    const before = new Set(await project.store.list());
    const done =
      request.kind === 'start'
        ? project.runner.start({ retryFailed: request.retryFailed, ...(request.maxTasks !== undefined ? { maxTasks: request.maxTasks } : {}) })
        : project.runner.resume({ retryFailed: request.retryFailed });
    this.done = done;
    let settled = false;
    done.then(() => (settled = true), () => (settled = true));
    for (;;) {
      const active = await project.store.findActive().catch(() => undefined); // a run being created has no record yet
      if (active?.state === 'running' && (request.kind === 'resume' || !before.has(active.autoRunId))) {
        return { state: 'running', autoRunId: active.autoRunId, message: `Run ${active.autoRunId} is running.` };
      }
      if (settled) {
        const record = await done;
        return { state: 'finished', autoRunId: record.autoRunId, message: `Run ${record.autoRunId} is ${record.state}.` };
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

/** A fake agent behavior that blocks a task until released. */
function gate() {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const behavior: AgentBehavior = async (cwd, hooks, request) => {
    started();
    await released;
    return chainAgent(cwd, hooks, request);
  };
  return { behavior, release, started: startedP };
}

/** Asserts a 200 response, showing the body otherwise. */
function ok200(res: Response): Response {
  assert.equal(res.status, 200, res.text);
  return res;
}

/** Waits for the gated agent call; fails (instead of hanging) if the run ends before the agent starts. */
async function agentStarted(g: ReturnType<typeof gate>, launcher: InProcessLauncher): Promise<void> {
  await Promise.race([
    g.started,
    launcher.done!.then((r) => assert.fail(`run ended before the agent started: ${JSON.stringify(r.stop)}`)),
  ]);
}

const costed = (cost: number | undefined, behavior: AgentBehavior = chainAgent): AgentBehavior => async (cwd, hooks, request) => {
  const result = await behavior(cwd, hooks, request);
  const details = { exitCode: 0, timedOut: false, durationMs: 1, truncated: false, killFailed: false, stdout: '', stderr: '' };
  return { ...result, details: cost === undefined ? details : { ...details, costUsd: cost } };
};

/** Every file under a directory with a content hash: proves nothing was written. */
async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)}:${createHash('sha256').update(await readFile(p)).digest('hex')}`);
    }
  };
  await walk(dir);
  return out.sort();
}

describe('dashboard', () => {
  let fx: Fixture | undefined;
  let scratch: { dir: string; cleanup: () => Promise<void> } | undefined;
  let dashboard: DashboardServer | undefined;
  let launcher: InProcessLauncher | undefined;
  afterEach(async () => {
    await dashboard?.close();
    await launcher?.done?.catch(() => undefined);
    await fx?.cleanup();
    await scratch?.cleanup();
    fx = scratch = dashboard = launcher = undefined;
  });

  interface SetupOptions {
    behavior?: AgentBehavior;
    fixture?: Parameters<typeof makeChainFixture>[0];
    launcher?: RunLauncher;
    agentAvailable?: boolean;
  }

  async function setup(options: SetupOptions = {}) {
    fx = await makeChainFixture(options.fixture ?? {});
    scratch = await makeTempDir();
    // The config file lives outside the repository so the working tree stays clean.
    const configFile = path.join(scratch.dir, 'factory.config.json');
    await writeFile(configFile, JSON.stringify({ ...fx.rawConfig, projectRoot: fx.dir }));
    const agent = new FakeAgent(options.behavior ?? chainAgent);
    const projects = await loadProjects([configFile], { agent: () => agent });
    launcher = new InProcessLauncher();
    const service = new DashboardService(projects, {
      launcher: options.launcher ?? launcher,
      agentAvailable: async () => options.agentAvailable ?? true,
    });
    dashboard = await startDashboardServer({ service, port: 0 });
    const d = dashboard;
    const project = projects[0]!;
    const base = { Host: `127.0.0.1:${d.port}`, 'X-ASF-Token': d.token };
    const get = (p: string, headers: Record<string, string> = {}) => rawRequest(d.port, 'GET', p, { ...base, ...headers });
    const post = (p: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
      rawRequest(
        d.port,
        'POST',
        p,
        { ...base, Origin: `http://127.0.0.1:${d.port}`, 'Content-Type': 'application/json', ...headers },
        JSON.stringify({ requestId: `req-${Math.random().toString(16).slice(2, 14)}`, ...body }),
      );
    const api = `/api/projects/${project.id}`;
    return { fx: fx!, configFile, agent, project, service, dashboard: d, get, post, api, launcher: launcher! };
  }

  // ------------------------------------------------------- binding & access

  describe('network exposure', () => {
    it('listens on 127.0.0.1 only', async () => {
      const { dashboard } = await setup();
      const address = dashboard.server.address() as net.AddressInfo;
      assert.equal(address.address, '127.0.0.1');
      assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      // A non-loopback address of this machine must not reach the server.
      const external = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
      if (external !== undefined) {
        const reached = await new Promise<boolean>((resolve) => {
          const socket = net.connect({ host: external.address, port: dashboard.port, timeout: 2000 });
          socket.once('connect', () => (socket.destroy(), resolve(true)));
          socket.once('error', () => resolve(false));
          socket.once('timeout', () => (socket.destroy(), resolve(false)));
        });
        assert.equal(reached, false, `reachable on ${external.address}`);
      }
    });

    it('the CLI offers no way to bind another interface and validates the port', () => {
      const host = spawnSync(process.execPath, [CLI, 'dashboard', '--host', '0.0.0.0'], { encoding: 'utf8', windowsHide: true });
      assert.equal(host.status, 2);
      assert.match(host.stderr, /Unknown option --host/);
      const port = spawnSync(process.execPath, [CLI, 'dashboard', '--port', '80'], { encoding: 'utf8', windowsHide: true });
      assert.equal(port.status, 2);
      assert.match(port.stderr, /--port requires a number from 1024 to 65535/);
    });

    it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
      const { get, dashboard } = await setup();
      for (const host of ['evil.example', `evil.example:${dashboard.port}`, `192.168.1.10:${dashboard.port}`, `127.0.0.1:${dashboard.port + 1}`]) {
        assert.equal((await get('/', { Host: host })).status, 403, host);
        assert.equal((await get('/api/overview', { Host: host })).status, 403, host);
      }
      assert.equal((await get('/api/overview', { Host: `localhost:${dashboard.port}` })).status, 200);
    });

    it('serves the page with the per-launch token and strict security headers', async () => {
      const { get, dashboard } = await setup();
      const page = await get('/');
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(`content="${dashboard.token}"`));
      assert.match(String(page.headers['content-security-policy']), /default-src 'none'; script-src 'self'/);
      assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(page.headers['x-frame-options'], 'DENY');
      assert.equal(page.headers['x-content-type-options'], 'nosniff');
      assert.equal(page.headers['access-control-allow-origin'], undefined);
      assert.equal((await get('/app.js')).status, 200);
      for (const p of ['/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fpackage.json', '/src/cli.ts', '/public/app.js', '/app.js%00']) {
        assert.equal((await get(p)).status, 404, p);
      }
    });

    it('requires the token for every API request', async () => {
      const { get, dashboard } = await setup();
      assert.equal((await rawRequest(dashboard.port, 'GET', '/api/overview', { Host: `127.0.0.1:${dashboard.port}` })).status, 403);
      assert.equal((await get('/api/overview', { 'X-ASF-Token': 'x'.repeat(48) })).status, 403);
      assert.equal((await get('/api/overview')).status, 200);
    });
  });

  // -------------------------------------------------- cross-site protection

  describe('state-changing requests', () => {
    it('refuse missing or foreign origins, cross-site fetches, other content types and bad tokens without acting', async () => {
      const { post, api, launcher, dashboard, fx } = await setup();
      const before = await snapshotTree(fx.config.dataDir);
      const start = `${api}/runs/start`;
      const body = { confirm: true };
      assert.equal((await post(start, body, { Origin: 'http://evil.example' })).status, 403);
      assert.equal((await post(start, body, { Origin: `http://127.0.0.1:${dashboard.port + 1}` })).status, 403);
      assert.equal((await post(start, body, { Origin: 'null' })).status, 403);
      assert.equal((await post(start, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await post(start, body, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await post(start, body, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
      assert.equal((await post(start, body, { 'X-ASF-Token': 'wrong' })).status, 403);
      const noOrigin = await rawRequest(
        dashboard.port,
        'POST',
        start,
        { Host: `127.0.0.1:${dashboard.port}`, 'X-ASF-Token': dashboard.token, 'Content-Type': 'application/json' },
        JSON.stringify({ requestId: 'abcdefgh-1', confirm: true }),
      );
      assert.equal(noOrigin.status, 403);
      assert.equal(launcher.calls.length, 0);
      assert.deepEqual(await snapshotTree(fx.config.dataDir), before);
    });

    it('separates read-only from state-changing routes by method and grants no CORS', async () => {
      const { get, post, api, dashboard } = await setup();
      assert.equal((await get(`${api}/runs/start`)).status, 405);
      assert.equal((await get(`${api}/runs/pause`)).status, 405);
      assert.equal((await get(`${api}/tasks/T1/accept`)).status, 405);
      assert.equal((await post('/api/overview')).status, 405);
      assert.equal((await post(`${api}/tasks`)).status, 405);
      const options = await rawRequest(dashboard.port, 'OPTIONS', `${api}/runs/start`, {
        Host: `127.0.0.1:${dashboard.port}`,
        Origin: 'http://evil.example',
        'Access-Control-Request-Method': 'POST',
      });
      // CORS preflights are refused and no CORS header is ever granted.
      assert.equal(options.status, 405);
      assert.equal(options.headers['access-control-allow-origin'], undefined);
      assert.equal(options.headers['access-control-allow-methods'], undefined);
      assert.equal((await rawRequest(dashboard.port, 'DELETE', '/', { Host: `127.0.0.1:${dashboard.port}` })).status, 405);
    });

    it('GET requests never change state (a browser refresh cannot start or repeat anything)', async () => {
      const { get, api, launcher, fx, supervisor } = await setupWithReview();
      const tasksBefore = await readFile(fx.repository.tasksFile, 'utf8');
      const dataBefore = await snapshotTree(fx.config.dataDir);
      const runs = (await get(`${api}/runs`)).json.runs as { autoRunId: string }[];
      for (let i = 0; i < 3; i++) {
        for (const p of ['/', '/api/overview', '/api/status', api, `${api}/tasks`, `${api}/tasks/T1`, `${api}/tasks/T1/review`, `${api}/runs`, `${api}/activity`, `${api}/controls`, `${api}/launch-log`, ...runs.map((r) => `${api}/runs/${r.autoRunId}`)]) {
          assert.equal((await get(p)).status, 200, p);
        }
      }
      assert.equal(launcher.calls.length, 0);
      assert.equal(await readFile(fx.repository.tasksFile, 'utf8'), tasksBefore);
      assert.deepEqual(await snapshotTree(fx.config.dataDir), dataBefore);
      void supervisor;
    });
  });

  // ------------------------------------------------------- input validation

  describe('input validation', () => {
    it('rejects unknown projects, malformed ids and path tricks', async () => {
      const { get, post, api } = await setup();
      assert.equal((await get('/api/projects/000000000000')).status, 404);
      assert.equal((await get('/api/projects/..%2f..%2fetc')).status, 404);
      assert.equal((await get('/api/projects/C%3A%5CWindows')).status, 404);
      assert.equal((await get(`${api}/tasks/..%2f..%2ftasks.json`)).status, 400);
      assert.equal((await get(`${api}/tasks/T1%3Brm`)).status, 400);
      assert.equal((await get(`${api}/tasks/NOPE`)).status, 404);
      assert.equal((await get(`${api}/runs/..%5C..%5Cwindows`)).status, 400);
      assert.equal((await get(`${api}/runs/20990101T000000Z-deadbeef`)).status, 404);
      assert.equal((await get(`${api}/tasks?path=C:/Windows`)).status, 400);
      assert.equal((await get('/api/nothing')).status, 404);
      assert.equal((await post(`${api}/tasks/%25/accept`, { confirm: true })).status, 400);
    });

    it('validates action bodies strictly and never accepts limits or policy from the browser', async () => {
      const { post, api, launcher, dashboard } = await setup();
      const start = `${api}/runs/start`;
      const cases: [Record<string, unknown>, number, RegExp][] = [
        [{}, 400, /confirmation/],
        [{ confirm: 'yes' }, 400, /confirmation/],
        [{ confirm: true, maxCostUsd: 100 }, 400, /Unexpected field\(s\): maxCostUsd/],
        [{ confirm: true, maxRunDurationMs: 999999999 }, 400, /Unexpected field/],
        [{ confirm: true, autoAccept: { enabled: true } }, 400, /Unexpected field/],
        [{ confirm: true, command: 'rm -rf /' }, 400, /Unexpected field/],
        [{ confirm: true, maxTasks: 11 }, 400, /between 1 and the configured limit \(10\)/],
        [{ confirm: true, maxTasks: 0 }, 400, /between 1 and the configured limit/],
        [{ confirm: true, maxTasks: 1.5 }, 400, /whole number/],
        [{ confirm: true, retryFailed: 'true' }, 400, /true or false/],
      ];
      for (const [body, status, message] of cases) {
        const res = await post(start, body);
        assert.equal(res.status, status, JSON.stringify(body));
        assert.match(res.json.error.message, message);
      }
      assert.equal((await post(start, { confirm: true, requestId: 'x' })).status, 400);
      const big = await rawRequest(
        dashboard.port,
        'POST',
        start,
        { Host: `127.0.0.1:${dashboard.port}`, 'X-ASF-Token': dashboard.token, Origin: `http://127.0.0.1:${dashboard.port}`, 'Content-Type': 'application/json' },
        JSON.stringify({ requestId: 'abcdefgh-2', confirm: true, pad: 'x'.repeat(20_000) }),
      );
      assert.equal(big.status, 413);
      const malformed = await rawRequest(
        dashboard.port,
        'POST',
        start,
        { Host: `127.0.0.1:${dashboard.port}`, 'X-ASF-Token': dashboard.token, Origin: `http://127.0.0.1:${dashboard.port}`, 'Content-Type': 'application/json' },
        '{"confirm": tru',
      );
      assert.equal(malformed.status, 400);
      assert.equal(launcher.calls.length, 0);
    });

    it('internal errors do not reveal details', async () => {
      const failing: RunLauncher = {
        launch: async () => {
          throw new Error('boom at C:\\secret\\path with sk-ant-abcdefghijklmnopqrstuvwxyz');
        },
      };
      const { post, api } = await setup({ launcher: failing });
      const res = await post(`${api}/runs/start`, { confirm: true });
      assert.equal(res.status, 500);
      assert.doesNotMatch(res.text, /boom|secret|sk-ant|stack|at /);
      assert.match(res.json.error.message, /Internal error/);
    });
  });

  // ----------------------------------------------------- project path policy

  describe('project registration', () => {
    async function configWith(dir: string, name: string, overrides: Record<string, unknown>): Promise<string> {
      const file = path.join(dir, name);
      await writeFile(file, JSON.stringify({ ...fx!.rawConfig, projectRoot: fx!.dir, ...overrides }));
      return file;
    }

    it('accepts only validated config files given at startup', async () => {
      fx = await makeChainFixture();
      scratch = await makeTempDir();
      const good = await configWith(scratch.dir, 'a.json', {});
      await assert.rejects(loadProjects([]), /at least one --config/);
      await assert.rejects(loadProjects([path.join(scratch.dir, 'missing.json')]), /Cannot open config file/);
      await writeFile(path.join(scratch.dir, 'a.txt'), '{}');
      await assert.rejects(loadProjects([path.join(scratch.dir, 'a.txt')]), /must be a \.json file/);
      await assert.rejects(loadProjects([await configWith(scratch.dir, 'escape.json', { dataDir: '../outside' })]), /must stay inside/);
      await assert.rejects(loadProjects([good, good]), /listed more than once/);
      await assert.rejects(loadProjects([good, await configWith(scratch.dir, 'b.json', {})]), /use the same data directory/);
      const [project] = await loadProjects([good]);
      assert.match(project!.id, /^[0-9a-f]{12}$/);
      assert.ok(!project!.id.includes(path.sep));
    });

    it('rejects a data directory that escapes the project through a link', async () => {
      fx = await makeChainFixture();
      scratch = await makeTempDir();
      const outside = path.join(scratch.dir, 'outside');
      await mkdir(outside);
      await symlink(outside, path.join(fx.dir, 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(loadProjects([await configWith(scratch.dir, 'link.json', { dataDir: 'linked-data' })]), /resolves outside its project root/);
    });
  });

  // ------------------------------------------------------------- read views

  describe('read views', () => {
    it('overview, project, tasks and blocked reasons come from the factory state', async () => {
      const { get, api, project } = await setup();
      const overview = (await get('/api/overview')).json;
      assert.equal(overview.projectCount, 1);
      assert.equal(overview.projects[0].id, project.id);
      assert.equal(overview.projects[0].location, project.config.projectRoot);
      assert.deepEqual(overview.projects[0].counts, { total: 3, completed: 0, awaitingReview: 0, failed: 0, needsAttention: 0, inProgress: 0, pending: 3 });
      assert.equal(overview.usage.actual.available, false);
      assert.equal(overview.usage.estimated.kind, 'estimate');

      const tasks = (await get(`${api}/tasks`)).json.tasks as any[];
      assert.deepEqual(tasks.map((t) => [t.id, t.eligible]), [['T1', true], ['T2', false], ['T3', false]]);
      assert.match(tasks[1].eligibility, /waiting on dependencies: T1/);
      assert.deepEqual(tasks[1].blockedBy, [{ id: 'T1', status: 'pending' }]);
      assert.deepEqual(tasks[0].acceptanceCriteria, ['greet test passes']);

      const detail = (await get(api)).json;
      assert.equal(detail.spec.name, 'Sample');
      assert.equal(detail.config.agent.passEnvCount, 0);
      assert.equal('passEnv' in detail.config.agent, false);
    });

    it('the configuration view never contains environment variable names or values', async () => {
      process.env.ASF_DASHBOARD_TEST_SECRET = 'value-that-must-not-appear';
      try {
        const { get, api } = await setup({ fixture: { config: { agent: { permissionMode: 'dontAsk', tools: ['Read'], allowedTools: ['Read'], passEnv: ['ASF_DASHBOARD_TEST_SECRET'] } } } });
        const text = (await get(api)).text;
        assert.doesNotMatch(text, /ASF_DASHBOARD_TEST_SECRET|value-that-must-not-appear/);
        assert.match(text, /"passEnvCount":1/);
      } finally {
        delete process.env.ASF_DASHBOARD_TEST_SECRET;
      }
    });

    it('a project with broken state is reported without taking the dashboard down', async () => {
      const { get, fx } = await setup();
      await writeFile(fx.repository.tasksFile, '{ not json');
      const overview = await get('/api/overview');
      assert.equal(overview.status, 200);
      assert.equal(overview.json.projects[0].status, 'error');
      assert.match(overview.json.projects[0].error, /Cannot parse/);
    });
  });

  // ------------------------------------------------------- execution control

  describe('run controls', () => {
    it('shows the configured limits before a start and disables controls that cannot apply', async () => {
      const { get, api } = await setup();
      const controls = (await get(`${api}/controls`)).json;
      assert.deepEqual(controls.controls.start, { allowed: true, reason: '' });
      assert.equal(controls.controls.pause.allowed, false);
      assert.equal(controls.controls.resume.allowed, false);
      assert.equal(controls.controls.stop.allowed, false);
      assert.equal(controls.limits.maxTasks, 10);
      assert.equal(controls.limits.maxRepairAttempts, 0);
      assert.equal(typeof controls.limits.maxTaskDurationMs, 'number');
      assert.equal(controls.limits.runBudgetUsd, null);
      assert.match(controls.limits.budgetNote, /No per-call budget/);
    });

    it('refuses to start when autonomy is disabled or the agent is unavailable', async () => {
      const disabled = await setup({ fixture: { autonomy: { enabled: false } } });
      let res = await disabled.post(`${disabled.api}/runs/start`, { confirm: true });
      assert.equal(res.status, 409);
      assert.match(res.json.error.message, /Autonomous mode is disabled/);
      assert.equal(disabled.launcher.calls.length, 0);
      await dashboard!.close();
      dashboard = undefined;
      await fx!.cleanup();
      await scratch!.cleanup();

      const noAgent = await setup({ agentAvailable: false });
      res = await noAgent.post(`${noAgent.api}/runs/start`, { confirm: true });
      assert.equal(res.status, 409);
      assert.match(res.json.error.message, /was not found on PATH/);
      assert.equal(noAgent.launcher.calls.length, 0);
    });

    it('starts exactly one run for concurrent or repeated start requests', async () => {
      let release!: () => void;
      const blocked = new Promise<void>((r) => (release = r));
      let calls = 0;
      const slow: RunLauncher = {
        launch: async () => {
          calls += 1;
          await blocked;
          return { state: 'running', message: 'started' };
        },
      };
      const { post, api } = await setup({ launcher: slow });
      const first = post(`${api}/runs/start`, { confirm: true, requestId: 'same-request-1' });
      // Wait until the first request is inside the launcher (no fixed sleep: the suite runs files in parallel).
      for (let i = 0; calls === 0; i++) {
        assert.ok(i < 500, 'first start request never reached the launcher');
        await new Promise((r) => setTimeout(r, 20));
      }
      const second = await post(`${api}/runs/start`, { confirm: true });
      assert.equal(second.status, 409);
      assert.match(second.json.error.message, /already being processed/);
      const repeat = post(`${api}/runs/start`, { confirm: true, requestId: 'same-request-1' });
      release();
      const [a, b] = await Promise.all([first, repeat]);
      assert.equal(a.status, 200);
      assert.deepEqual(b.json, a.json);
      assert.equal(calls, 1);
      const reused = await post(`${api}/runs/pause`, { requestId: 'same-request-1' });
      assert.equal(reused.status, 409);
      assert.match(reused.json.error.message, /already used for a different action/);
    });

    it('start, pause and resume drive the real autonomous runner; a second start is refused while one is active', async () => {
      const g = gate();
      const { get, post, api, launcher, fx } = await setup({ behavior: g.behavior });
      const started = await post(`${api}/runs/start`, { confirm: true, maxTasks: 3 });
      assert.equal(started.status, 200, started.text);
      assert.equal(started.json.state, 'running');
      await agentStarted(g, launcher);

      const controls = (await get(`${api}/controls`)).json;
      assert.equal(controls.controls.start.allowed, false);
      assert.match(controls.controls.start.reason, /is running/);
      assert.equal(controls.controls.pause.allowed, true);
      assert.equal(controls.lock.state, 'held');
      const again = await post(`${api}/runs/start`, { confirm: true });
      assert.equal(again.status, 409);
      assert.equal(launcher.calls.length, 1);

      const run = (await get(`${api}/runs/${started.json.autoRunId}`)).json;
      assert.equal(run.current.taskId, 'T1');
      assert.equal(run.summary.limits.maxTasks, 3);

      const pause = await post(`${api}/runs/pause`);
      assert.equal(pause.status, 200);
      assert.match(pause.json.message, /Pause requested/);
      g.release();
      const paused = await launcher.done!;
      assert.equal(paused.state, 'paused', JSON.stringify(paused.stop));
      assert.equal(paused.stop?.reason, 'pause-requested');
      assert.deepEqual(paused.executions.map((e) => [e.taskId, e.result]), [['T1', 'auto-accepted']]);

      assert.equal((await post(`${api}/runs/pause`)).status, 409); // already paused
      const resumed = await post(`${api}/runs/resume`, { confirm: true });
      assert.equal(resumed.status, 200, resumed.text);
      const finished = await launcher.done!;
      assert.equal(finished.state, 'completed', JSON.stringify(finished.stop));
      assert.deepEqual((await fx.repository.loadTasks()).map((t) => t.status), ['completed', 'completed', 'completed']);
      const none = await post(`${api}/runs/stop`, { confirm: true });
      assert.equal(none.status, 409);
      assert.match(none.json.error.message, /no active run/);
    });

    it('stop prevents new tasks while the active task finishes safely', async () => {
      const g = gate();
      const { post, api, launcher, agent } = await setup({ behavior: g.behavior });
      ok200(await post(`${api}/runs/start`, { confirm: true }));
      await agentStarted(g, launcher);
      assert.equal((await post(`${api}/runs/stop`, {})).status, 400); // needs confirmation
      const stop = await post(`${api}/runs/stop`, { confirm: true });
      assert.equal(stop.status, 200);
      assert.match(stop.json.message, /No new task will start/);
      g.release();
      const record = await launcher.done!;
      assert.equal(record.state, 'stopped', JSON.stringify(record.stop));
      assert.equal(record.stop?.reason, 'stop-requested');
      assert.deepEqual(record.executions.map((e) => [e.taskId, e.result]), [['T1', 'auto-accepted']]);
      assert.deepEqual(agent.requests.map((r) => r.task.id), ['T1']);
    });

    it('launches the real CLI with a fixed argument list and reports why it could not start', async () => {
      assert.deepEqual(cliArgs('C:\\p\\factory.config.json', { kind: 'start', maxTasks: 2, retryFailed: true }), [
        'auto', 'start', '--max-tasks', '2', '--retry-failed', '--config', 'C:\\p\\factory.config.json',
      ]);
      assert.deepEqual(cliArgs('c.json', { kind: 'resume', maxTasks: 5, retryFailed: false }), ['auto', 'resume', '--config', 'c.json']);
      assert.throws(() => cliArgs('c.json', { kind: 'start', maxTasks: -1, retryFailed: false }), RangeError);

      // An untracked file makes the git preflight fail in the child before any agent call.
      const { post, api, fx, project } = await setup({ launcher: new CliRunLauncher({ waitMs: 60_000 }) });
      await writeFile(path.join(fx.dir, 'untracked.txt'), 'dirty');
      const res = await post(`${api}/runs/start`, { confirm: true });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.json.error.code, 'LAUNCH_FAILED');
      assert.match(res.json.error.message, /uncommitted changes/);
      assert.deepEqual(await project.store.list(), []);
    });
  });

  // ------------------------------------------------------------ human review

  async function setupWithReview(options: SetupOptions = {}) {
    const s = await setup({ behavior: async (cwd) => {
      await writeFile(path.join(cwd, 'src', 'greet.js'), GOOD);
      return ok('implemented greet');
    }, ...options });
    const supervisor = s.project.supervisor;
    const report = await supervisor.execute('T1');
    assert.equal(report.task.status, 'awaiting_review');
    return { ...s, supervisor, report };
  }

  describe('human review', () => {
    it('shows the summary, checks, changed files and recorded diff of a result awaiting review', async () => {
      const { get, api, report } = await setupWithReview();
      const review = (await get(`${api}/tasks/T1/review`)).json;
      assert.equal(review.decidable, true);
      assert.deepEqual(review.integrityProblems, []);
      assert.equal(review.run.agent.summary, 'implemented greet');
      assert.deepEqual(review.run.validation.map((v: any) => [v.name, v.passed]), [['test', true]]);
      assert.deepEqual(review.run.review.changedFiles.map((f: any) => f.path), ['src/greet.js']);
      assert.match(review.patch, /\+  return `Hello, \$\{name\}!`;/);
      assert.deepEqual(review.fingerprint, { runId: report.runId, diffSha256: report.run.review!.diffSha256 });
      assert.equal('stdout' in review.run.agent, false);
    });

    it('accept requires confirmation and the exact reviewed result, then uses the existing review service', async () => {
      const { get, post, api, fx, report } = await setupWithReview();
      const fingerprint = (await get(`${api}/tasks/T1/review`)).json.fingerprint;
      const accept = `${api}/tasks/T1/accept`;
      assert.equal((await post(accept, { ...fingerprint })).status, 400);
      const stale = await post(accept, { confirm: true, runId: fingerprint.runId, diffSha256: '0'.repeat(64) });
      assert.equal(stale.status, 409);
      assert.match(stale.json.error.message, /differs from the one you reviewed/);
      assert.equal((await fx.repository.loadTasks())[0]!.status, 'awaiting_review');

      const res = await post(accept, { confirm: true, ...fingerprint });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.task.status, 'completed');
      assert.equal(git(fx.dir, 'rev-parse', report.run.branch!).trim(), res.json.acceptedCommit);
      assert.equal(git(fx.dir, 'rev-parse', 'HEAD').trim(), fx.head); // nothing merged into the user's branch
      const again = await post(accept, { confirm: true, ...fingerprint });
      assert.equal(again.status, 409);
      assert.match(again.json.error.message, /no longer awaiting review/);
    });

    it('refuses to accept a worktree that changed after review', async () => {
      const { post, api, fx, report } = await setupWithReview();
      await writeFile(path.join(report.run.worktreePath!, 'src', 'greet.js'), 'export const greet = () => "tampered";\n');
      const res = await post(`${api}/tasks/T1/accept`, { confirm: true, runId: report.runId, diffSha256: report.run.review!.diffSha256 });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'TAMPER_DETECTED');
      assert.match(res.json.error.message, /worktree content changed since review/);
      assert.equal((await fx.repository.loadTasks())[0]!.status, 'awaiting_review');
    });

    it('reject requires a reason and preserves the work and evidence', async () => {
      const { post, get, api, fx, report } = await setupWithReview();
      const reject = `${api}/tasks/T1/reject`;
      const fp = { runId: report.runId, diffSha256: report.run.review!.diffSha256 };
      assert.equal((await post(reject, { confirm: true, ...fp })).status, 400);
      assert.equal((await post(reject, { confirm: true, ...fp, reason: '   ' })).status, 400);
      const res = await post(reject, { confirm: true, ...fp, reason: 'Needs a docstring' });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.task.status, 'failed');
      assert.ok((await stat(report.run.worktreePath!)).isDirectory());
      assert.equal(await readFile(path.join(report.run.worktreePath!, 'src', 'greet.js'), 'utf8'), GOOD);
      const task = (await get(`${api}/tasks/T1`)).json;
      assert.equal(task.latestRun.decision.decision, 'rejected');
      assert.equal(task.latestRun.decision.reason, 'Needs a docstring');
      const activity = (await get(`${api}/activity`)).json.items as any[];
      assert.ok(activity.some((i) => i.kind === 'decision' && /T1 rejected by a person: Needs a docstring/.test(i.message)));
      assert.equal((await fx.repository.loadTasks())[0]!.currentRunId, undefined);
    });
  });

  // ------------------------------------------------------------------ budget

  describe('budget display', () => {
    const agent = { permissionMode: 'dontAsk', tools: ['Read', 'Edit', 'Write'], allowedTools: ['Read', 'Edit', 'Write'], maxBudgetUsd: 1 };
    const budgetFixture = (maxCostUsd: number) => ({
      autonomy: { enabled: true, maxCostUsd, autoAccept: { enabled: true, taskIds: ['T1', 'T2', 'T3'], paths: ['src', 'test'] } },
      config: { agent, commands: { test: { executable: 'node', args: ['--test'] } } },
    });

    it('shows reported cost as an estimate with the remaining configured budget', async () => {
      const { get, post, api, launcher } = await setup({ behavior: costed(1), fixture: budgetFixture(3) });
      const controls = (await get(`${api}/controls`)).json;
      assert.equal(controls.limits.perCallBudgetUsd, 1);
      assert.equal(controls.limits.runBudgetUsd, 3);
      assert.match(controls.limits.budgetNote, /not a hard guarantee/);
      const res = await post(`${api}/runs/start`, { confirm: true });
      assert.equal(res.status, 200, res.text);
      const record = await launcher.done!;
      assert.equal(record.state, 'completed', JSON.stringify(record.stop));
      const run = (await get(`${api}/runs/${record.autoRunId}`)).json;
      assert.equal(run.budget.kind, 'estimate');
      assert.match(run.budget.label, /not an actual charge/);
      assert.equal(run.budget.estimatedUsd, 3);
      assert.equal(run.budget.remainingUsd, 0);
      assert.equal(run.budget.incomplete, false);
      assert.match(run.budget.guarantee, /Not a hard spending guarantee/);
      const overview = (await get('/api/overview')).json;
      assert.equal(overview.usage.estimated.usd, 3);
      assert.equal(overview.usage.actual.available, false);
    });

    it('marks usage incomplete and the remaining budget unknown when a call reports no cost', async () => {
      const { get, post, api, launcher } = await setup({ behavior: costed(undefined), fixture: budgetFixture(3) });
      ok200(await post(`${api}/runs/start`, { confirm: true }));
      const record = await launcher.done!;
      assert.equal(record.stop?.reason, 'cost-limit');
      const run = (await get(`${api}/runs/${record.autoRunId}`)).json;
      assert.equal(run.budget.incomplete, true);
      assert.equal(run.budget.remainingUsd, null);
      assert.match(run.budget.note, /cannot be measured/);
      assert.ok(run.budgetEvents.length > 0);
      const overview = (await get('/api/overview')).json;
      assert.equal(overview.usage.estimated.incomplete, true);
      const activity = (await get(`${api}/activity`)).json.items as any[];
      assert.ok(activity.some((i) => i.kind === 'budget'));
    });
  });

  // ---------------------------------------------------------------- polling

  it('the status endpoint changes version only when project state changes', async () => {
    const { get, post, api, launcher } = await setup();
    const v1 = (await get('/api/status')).json.projects[0].version;
    assert.equal((await get('/api/status')).json.projects[0].version, v1);
    ok200(await post(`${api}/runs/start`, { confirm: true }));
    await launcher.done;
    const v2 = (await get('/api/status')).json.projects[0].version;
    assert.notEqual(v2, v1);
  });
});
