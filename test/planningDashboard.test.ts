import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { createDashboard } from '../src/dashboard/bootstrap.js';
import type { RunLauncher } from '../src/dashboard/launcher.js';
import { startDashboardServer, type DashboardServer } from '../src/dashboard/server.js';
import { makeTempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, '..', '..', 'examples', 'sample-idea');

interface Res {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}

function request(d: DashboardServer, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: d.port,
        method,
        path: urlPath,
        agent: false,
        headers: {
          Host: `127.0.0.1:${d.port}`,
          'X-ASF-Token': d.token,
          ...(method === 'POST' ? { Origin: `http://127.0.0.1:${d.port}`, 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
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
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let counter = 0;
const rid = () => `req-${Date.now()}-${counter++}`;

describe('idea-to-project in the dashboard', () => {
  let dashboard: DashboardServer | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await dashboard?.close();
    await cleanup?.();
    dashboard = cleanup = undefined;
  });

  async function setup(workspace: Record<string, unknown> = {}) {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    const file = path.join(tmp.dir, 'factory.workspace.json');
    await writeFile(file, JSON.stringify({ version: 1, planner: { type: 'fixture', fixtureDir: SAMPLE }, ...workspace }));
    const launches: unknown[] = [];
    const launcher: RunLauncher = { launch: async (_p, r) => (launches.push(r), { state: 'running', message: 'started' }) };
    const { service, planning } = await createDashboard({ configPaths: [], workspaceFile: file, launcher, agentAvailable: async () => true });
    dashboard = await startDashboardServer({ service, port: 0 });
    return { d: dashboard, service, planning: planning!, dir: tmp.dir, launches };
  }

  async function waitFor(d: DashboardServer, planId: string, state: string) {
    for (let i = 0; i < 300; i++) {
      const plan = (await request(d, 'GET', `/api/plans/${planId}`)).json;
      if (plan.state === state && !plan.running) return plan;
      if (['failed', 'invalid', 'needs-attention'].includes(plan.state) && plan.state !== state) assert.fail(`plan is ${plan.state}: ${JSON.stringify(plan.failure ?? plan.validation?.errors)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`plan never reached ${state}`);
  }

  it('creates a project from an idea: proposal, one approval, documents, task graph, registration and a ready-to-start project', async () => {
    const { d, launches } = await setup();
    const ws = (await request(d, 'GET', '/api/workspace')).json;
    assert.equal(ws.enabled, true);
    assert.equal(ws.planner.name, 'fixture');
    assert.equal(ws.planner.webResearch, false);
    assert.equal((await request(d, 'GET', '/api/overview')).json.projectCount, 0);

    const idea = JSON.parse(await readFile(path.join(SAMPLE, 'idea.json'), 'utf8'));
    assert.equal((await request(d, 'POST', '/api/plans', { requestId: rid(), idea })).status, 400); // needs confirmation
    const created = await request(d, 'POST', '/api/plans', { requestId: rid(), confirm: true, idea });
    assert.equal(created.status, 200, created.text);
    const planId = created.json.planId as string;

    const proposed = await waitFor(d, planId, 'proposed');
    assert.deepEqual(proposed.actions, ['approve', 'reject']);
    assert.equal(proposed.proposal.productName, 'Tool Share');
    assert.deepEqual(proposed.documents, []);
    assert.equal((await request(d, 'GET', `/api/plans/${planId}/documents/PRODUCT.md`)).status, 404);

    assert.equal((await request(d, 'POST', `/api/plans/${planId}/approve`, { requestId: rid() })).status, 400);
    const approved = await request(d, 'POST', `/api/plans/${planId}/approve`, { requestId: rid(), confirm: true });
    assert.equal(approved.status, 200, approved.text);
    const ready = await waitFor(d, planId, 'ready');
    assert.equal(ready.validation.valid, true);
    assert.equal(ready.tasks.length, 11);
    assert.deepEqual(ready.waves[7], ['T8', 'T9']);
    assert.equal(ready.documents.length, 9);
    const doc = (await request(d, 'GET', `/api/plans/${planId}/documents/ARCHITECTURE.md`)).json;
    assert.match(doc.content, /## Recommended stack/);
    assert.equal(ready.cost.kind, 'estimate');

    // The new project is visible in the existing dashboard views and ready to start.
    const projectId = ready.project.projectId as string;
    const overview = (await request(d, 'GET', '/api/overview')).json;
    assert.deepEqual(overview.projects.map((p: { id: string; name: string }) => [p.id, p.name]), [[projectId, 'Tool Share']]);
    const tasks = (await request(d, 'GET', `/api/projects/${projectId}/tasks`)).json.tasks;
    assert.deepEqual(tasks.filter((t: { eligible: boolean }) => t.eligible).map((t: { id: string }) => t.id), ['T1']);
    const controls = (await request(d, 'GET', `/api/projects/${projectId}/controls`)).json;
    assert.deepEqual(controls.controls.start, { allowed: true, reason: '' });
    assert.equal(controls.limits.maxRepairAttempts, 1);
    const start = await request(d, 'POST', `/api/projects/${projectId}/runs/start`, { requestId: rid(), confirm: true });
    assert.equal(start.status, 200, start.text);
    assert.equal(launches.length, 1); // the existing start control (a fake launcher here: no coding session)

    const list = (await request(d, 'GET', '/api/plans')).json.plans;
    assert.deepEqual(list.map((p: { planId: string; state: string }) => [p.planId, p.state]), [[planId, 'ready']]);
  });

  it('registered projects come back when the dashboard restarts', async () => {
    const { d, dir } = await setup();
    const idea = JSON.parse(await readFile(path.join(SAMPLE, 'idea.json'), 'utf8'));
    const { planId } = (await request(d, 'POST', '/api/plans', { requestId: rid(), confirm: true, idea })).json;
    await waitFor(d, planId, 'proposed');
    await request(d, 'POST', `/api/plans/${planId}/approve`, { requestId: rid(), confirm: true });
    const ready = await waitFor(d, planId, 'ready');
    await d.close();
    dashboard = undefined;
    const again = await createDashboard({ configPaths: [], workspaceFile: path.join(dir, 'factory.workspace.json'), launcher: { launch: async () => ({ state: 'running', message: '' }) } });
    assert.deepEqual(again.service.projects.map((p) => p.id), [ready.project.projectId]);
    assert.deepEqual(again.warnings, []);
  });

  it('validates planning requests and refuses actions that do not apply', async () => {
    const { d } = await setup();
    const bad = await request(d, 'POST', '/api/plans', { requestId: rid(), confirm: true, idea: { name: 'X', idea: 'short' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /at least 2 characters/);
    const extra = await request(d, 'POST', '/api/plans', { requestId: rid(), confirm: true, idea: { name: 'Tools', idea: 'A way for neighbours to lend tools.' }, planner: 'evil' });
    assert.equal(extra.status, 400);
    assert.equal((await request(d, 'GET', '/api/plans/not-an-id')).status, 400);
    assert.equal((await request(d, 'GET', '/api/plans/20990101T000000Z-deadbeef')).status, 404);
    assert.equal((await request(d, 'GET', '/api/plans/20990101T000000Z-deadbeef/documents/..%2F..%2Fsecret.md')).status, 400);
    const idea = JSON.parse(await readFile(path.join(SAMPLE, 'idea.json'), 'utf8'));
    const { planId } = (await request(d, 'POST', '/api/plans', { requestId: rid(), confirm: true, idea })).json;
    await waitFor(d, planId, 'proposed');
    assert.equal((await request(d, 'POST', `/api/plans/${planId}/retry`, { requestId: rid(), confirm: true })).status, 409);
    assert.equal((await request(d, 'POST', `/api/plans/${planId}/answer`, { requestId: rid(), answer: 'x' })).status, 409);
    const noReason = await request(d, 'POST', `/api/plans/${planId}/reject`, { requestId: rid(), confirm: true, reason: '' });
    assert.equal(noReason.status, 400);
    assert.equal((await request(d, 'POST', `/api/plans/${planId}/reject`, { requestId: rid(), confirm: true, reason: 'Not now' })).status, 200);
    assert.equal((await request(d, 'GET', `/api/plans/${planId}`)).json.state, 'rejected');
    // Cross-site requests are refused like every other action.
    assert.equal((await request(d, 'POST', '/api/plans', { requestId: rid(), confirm: true, idea }, { Origin: 'http://evil.example' })).status, 403);
  });

  it('without a workspace, planning is reported as disabled and its actions are refused', async () => {
    const { DashboardService } = await import('../src/dashboard/service.js');
    const service = new DashboardService([], { launcher: { launch: async () => ({ state: 'running', message: '' }) } });
    dashboard = await startDashboardServer({ service, port: 0 });
    const ws = (await request(dashboard, 'GET', '/api/workspace')).json;
    assert.equal(ws.enabled, false);
    assert.match(ws.reason, /--workspace/);
    const res = await request(dashboard, 'POST', '/api/plans', { requestId: rid(), confirm: true, idea: { name: 'Tools', idea: 'A way for neighbours to lend tools.' } });
    assert.equal(res.status, 409);
    assert.match(res.json.error.message, /Planning is not enabled/);
  });
});
