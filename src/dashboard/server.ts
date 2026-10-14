import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryError, ValidationError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { redactSecrets } from '../security/redact.js';
import { RUN_ID, TASK_ID } from '../tasks/task.js';
import { PROJECT_ID } from './projects.js';
import type { PlanningService } from '../planning/planningService.js';
import { planDetailView, planSummaryView, workspaceView } from './planningViews.js';
import { ConflictError, NotFoundError, safeMessage, type DashboardService } from './service.js';

/** The dashboard only ever listens on the loopback interface. There is no option to change this. */
export const DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4317;
export const MAX_BODY_BYTES = 16 * 1024;
/** An idea may include pasted research notes. */
export const MAX_IDEA_BODY_BYTES = 256 * 1024;
export const TOKEN_HEADER = 'x-asf-token';

const PUBLIC_DIR = fileURLToPath(new URL('../../../src/dashboard/public/', import.meta.url));
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export interface DashboardServerOptions {
  service: DashboardService;
  /** 0 picks a free port (tests). */
  port?: number;
  publicDir?: string;
  log?: (line: string) => void;
}

export interface DashboardServer {
  url: string;
  port: number;
  /** Per-launch secret the page sends with every API request. */
  token: string;
  server: http.Server;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  PATH_NOT_ALLOWED: 400,
  DEPENDENCY_ERROR: 409,
  NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  LOCK_HELD: 409,
  TAMPER_DETECTED: 409,
  LIMIT_EXCEEDED: 409,
  EXECUTION_POLICY_ERROR: 409,
  AGENT_EXECUTION_DISABLED: 409,
  COMMAND_NOT_ALLOWED: 409,
  GIT_ISOLATION_ERROR: 409,
  LAUNCH_FAILED: 409,
};

// ------------------------------------------------------------ input checks

type Body = Record<string, unknown>;

function only(body: Body, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new ValidationError(`Unexpected field(s): ${extra.join(', ')}`);
}

function bool(body: Body, key: string, fallback: boolean): boolean {
  const v = body[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new ValidationError(`${key} must be true or false`);
  return v;
}

function requireConfirm(body: Body): void {
  if (body.confirm !== true) throw new ValidationError('This action needs explicit confirmation (confirm: true).');
}

function str(body: Body, key: string, pattern: RegExp, label: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !pattern.test(v)) throw new ValidationError(`${label} is missing or invalid`);
  return v;
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// ------------------------------------------------------------------ routes

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Names of the captured groups, validated before the handler runs. */
  params: readonly ('pid' | 'tid' | 'rid' | 'kind' | 'plan' | 'doc')[];
  handler: (service: DashboardService, p: Record<string, string>, body: Body) => Promise<unknown>;
  /** Body size limit for this route (default MAX_BODY_BYTES). */
  maxBody?: number;
}

const SEG = '([^/]+)';
const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/overview$/, params: [], handler: (s) => s.overview() },
  { method: 'GET', pattern: /^\/api\/status$/, params: [], handler: (s) => s.status() },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}$`), params: ['pid'], handler: (s, p) => s.projectDetail(p.pid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/tasks$`), params: ['pid'], handler: (s, p) => s.tasks(p.pid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/tasks/${SEG}$`), params: ['pid', 'tid'], handler: (s, p) => s.task(p.pid!, p.tid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/tasks/${SEG}/review$`), params: ['pid', 'tid'], handler: (s, p) => s.review(p.pid!, p.tid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/runs$`), params: ['pid'], handler: (s, p) => s.runs(p.pid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/runs/${SEG}$`), params: ['pid', 'rid'], handler: (s, p) => s.run(p.pid!, p.rid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/activity$`), params: ['pid'], handler: (s, p) => s.activity(p.pid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/controls$`), params: ['pid'], handler: (s, p) => s.controls(p.pid!) },
  { method: 'GET', pattern: new RegExp(`^/api/projects/${SEG}/launch-log$`), params: ['pid'], handler: (s, p) => s.launchLog(p.pid!) },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/projects/${SEG}/runs/start$`),
    params: ['pid'],
    handler: (s, p, b) => {
      only(b, ['requestId', 'confirm', 'maxTasks', 'retryFailed']);
      requireConfirm(b);
      let maxTasks: number | undefined;
      if (b.maxTasks !== undefined) {
        if (typeof b.maxTasks !== 'number' || !Number.isInteger(b.maxTasks)) throw new ValidationError('maxTasks must be a whole number');
        maxTasks = b.maxTasks;
      }
      return s.start(p.pid!, { retryFailed: bool(b, 'retryFailed', false), ...(maxTasks !== undefined ? { maxTasks } : {}) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/projects/${SEG}/runs/resume$`),
    params: ['pid'],
    handler: (s, p, b) => {
      only(b, ['requestId', 'confirm', 'retryFailed']);
      requireConfirm(b);
      return s.resume(p.pid!, { retryFailed: bool(b, 'retryFailed', false) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/projects/${SEG}/runs/(pause|stop)$`),
    params: ['pid', 'kind'],
    handler: (s, p, b) => {
      only(b, ['requestId', 'confirm']);
      if (p.kind === 'stop') requireConfirm(b);
      return s.request(p.pid!, p.kind as 'pause' | 'stop');
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/projects/${SEG}/tasks/${SEG}/accept$`),
    params: ['pid', 'tid'],
    handler: (s, p, b) => {
      only(b, ['requestId', 'confirm', 'runId', 'diffSha256']);
      requireConfirm(b);
      return s.accept(p.pid!, p.tid!, { runId: str(b, 'runId', RUN_ID, 'runId'), diffSha256: str(b, 'diffSha256', SHA256, 'diffSha256') });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/projects/${SEG}/tasks/${SEG}/reject$`),
    params: ['pid', 'tid'],
    handler: (s, p, b) => {
      only(b, ['requestId', 'confirm', 'runId', 'diffSha256', 'reason']);
      requireConfirm(b);
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (reason.length === 0 || reason.length > 2000) throw new ValidationError('A rejection reason (1-2000 characters) is required.');
      return s.reject(p.pid!, p.tid!, { runId: str(b, 'runId', RUN_ID, 'runId'), diffSha256: str(b, 'diffSha256', SHA256, 'diffSha256'), reason });
    },
  },
  // ------------------------------------------------ idea-to-project planning
  { method: 'GET', pattern: /^\/api\/workspace$/, params: [], handler: async (s) => workspaceView(s.planning) },
  { method: 'GET', pattern: /^\/api\/plans$/, params: [], handler: async (s) => ({ plans: await Promise.all((await planning(s).list()).map(planSummaryView)) }) },
  { method: 'GET', pattern: new RegExp(`^/api/plans/${SEG}$`), params: ['plan'], handler: (s, p) => planDetailView(planning(s), p.plan!) },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/plans/${SEG}/documents/${SEG}$`),
    params: ['plan', 'doc'],
    handler: async (s, p) => {
      const content = await planning(s).document(p.plan!, p.doc!);
      if (content === undefined) throw new NotFoundError('This document has not been generated yet.');
      return { name: p.doc, content: redactSecrets(content) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/plans$/,
    params: [],
    maxBody: MAX_IDEA_BODY_BYTES,
    handler: async (s, _p, b) => {
      only(b, ['requestId', 'confirm', 'idea']);
      requireConfirm(b);
      const record = await planning(s).create(b.idea);
      return { planId: record.planId, state: record.state, message: 'Idea saved. The planner is preparing a proposal.' };
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/plans/${SEG}/(approve|reject|answer|retry)$`),
    params: ['plan', 'kind'],
    handler: async (s, p, b) => {
      const svc = planning(s);
      const id = p.plan!;
      switch (p.kind) {
        case 'approve':
          only(b, ['requestId', 'confirm']);
          requireConfirm(b);
          await svc.approve(id);
          return { message: 'Approved. The plan is being finalized, validated and set up as a project.' };
        case 'reject': {
          only(b, ['requestId', 'confirm', 'reason']);
          requireConfirm(b);
          const reason = typeof b.reason === 'string' ? b.reason : '';
          if (reason.trim().length === 0 || reason.length > 2000) throw new ValidationError('A reason (1-2000 characters) is required.');
          await svc.reject(id, reason);
          return { message: 'The idea was rejected. Its records are kept.' };
        }
        case 'answer':
          only(b, ['requestId', 'answer']);
          if (typeof b.answer !== 'string') throw new ValidationError('An answer is required.');
          await svc.answer(id, b.answer);
          return { message: 'Thanks. The planner is preparing the proposal again.' };
        default:
          only(b, ['requestId', 'confirm']);
          requireConfirm(b);
          await svc.retry(id);
          return { message: 'Retrying the failed step.' };
      }
    },
  },
];

function planning(s: DashboardService): PlanningService {
  if (s.planning === undefined) throw new ConflictError('Planning is not enabled: start the dashboard with --workspace <factory.workspace.json>.');
  return s.planning;
}

const PARAM_PATTERNS: Record<string, RegExp> = {
  pid: PROJECT_ID,
  tid: TASK_ID,
  rid: RUN_ID,
  kind: /^(pause|stop|approve|reject|answer|retry)$/,
  plan: RUN_ID,
  doc: /^[A-Z_]{3,20}.(md|json)$/,
};

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } {
  let invalid: HttpError | undefined;
  let otherMethod = false;
  for (const route of routes) {
    const m = route.pattern.exec(pathname);
    if (m === null) continue;
    if (route.method !== method) {
      otherMethod = true;
      continue;
    }
    const params: Record<string, string> = {};
    let problem: HttpError | undefined;
    route.params.forEach((name, i) => {
      let value: string | undefined;
      try {
        value = decodeURIComponent(m[i + 1]!);
      } catch {
        problem ??= new HttpError(400, 'Malformed URL.');
        return;
      }
      if (!PARAM_PATTERNS[name]!.test(value)) {
        problem ??= name === 'pid' ? new HttpError(404, 'Unknown project.') : new HttpError(400, `Invalid ${name === 'tid' ? 'task' : 'run'} id.`);
        return;
      }
      params[name] = value;
    });
    if (problem === undefined) return { route, params };
    invalid ??= problem;
  }
  // An action path used with the wrong method is reported as such, even if a broader pattern also matched.
  if (otherMethod) throw new HttpError(405, 'Method not allowed.');
  throw invalid ?? new HttpError(404, 'Not found.');
}

// ------------------------------------------------------------------ server

/**
 * Local dashboard HTTP server.
 *
 * - Listens on 127.0.0.1 only.
 * - Rejects any Host header other than 127.0.0.1:<port> / localhost:<port> (DNS rebinding).
 * - Every API request must carry the per-launch token, which only a page served
 *   by this server can read; state-changing requests must also be same-origin
 *   POSTs with a JSON body (no CORS is ever granted).
 * - State-changing requests carry a requestId; a repeated id returns the first
 *   result instead of running the action again.
 */
export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServer> {
  const { service } = options;
  const log = options.log ?? (() => undefined);
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const indexTemplate = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  const assets = new Map<string, Buffer>();
  for (const [route, { file }] of Object.entries(STATIC_FILES)) assets.set(route, await readFile(path.join(publicDir, file)));
  const recent = new Map<string, { key: string; at: number; result: Promise<{ status: number; body: unknown }> }>();

  let port = options.port ?? DEFAULT_PORT;
  const allowedHosts = () => [`${DASHBOARD_HOST}:${port}`, `localhost:${port}`];
  const allowedOrigins = () => allowedHosts().map((h) => `http://${h}`);

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts().includes(host)) throw new HttpError(403, 'Forbidden host.');
    const url = new URL(req.url ?? '/', `http://${host}`);
    const pathname = url.pathname;
    if (url.search !== '') throw new HttpError(400, 'Query parameters are not supported.');

    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      if (pathname === '/' || pathname === '/index.html') {
        send(res, 200, indexTemplate.replace('__ASF_TOKEN__', token), 'text/html; charset=utf-8');
        return;
      }
      const asset = assets.get(pathname);
      if (asset === undefined) throw new HttpError(404, 'Not found.');
      send(res, 200, asset, STATIC_FILES[pathname]!.type);
      return;
    }

    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const given = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ''));
    if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
      throw new HttpError(403, 'Missing or invalid dashboard token. Reload the page.');
    }
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') throw new HttpError(403, 'Cross-site requests are not allowed.');

    const { route, params } = matchRoute(method, pathname);
    if (method === 'GET') {
      json(res, 200, await route.handler(service, params, {}));
      return;
    }

    // State-changing request.
    const origin = req.headers.origin;
    if (origin === undefined || !allowedOrigins().includes(origin.toLowerCase())) throw new HttpError(403, 'Requests must come from the dashboard page itself.');
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be application/json.');
    const body = await readBody(req, route.maxBody ?? MAX_BODY_BYTES);
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new HttpError(400, 'requestId is missing or invalid.');
    const key = `${pathname}`;
    const now = Date.now();
    for (const [id, entry] of recent) if (now - entry.at > 10 * 60_000) recent.delete(id);
    const seen = recent.get(requestId);
    if (seen !== undefined) {
      if (seen.key !== key) throw new HttpError(409, 'requestId was already used for a different action.');
      const replay = await seen.result;
      json(res, replay.status, replay.body);
      return;
    }
    const result = (async () => {
      try {
        return { status: 200, body: await route.handler(service, params, body) };
      } catch (err) {
        return errorResponse(err, log);
      }
    })();
    recent.set(requestId, { key, at: now, result });
    if (recent.size > 1000) recent.delete(recent.keys().next().value!);
    const outcome = await result;
    log(`${method} ${pathname} -> ${outcome.status}`);
    json(res, outcome.status, outcome.body);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const { status, body } = errorResponse(err, log);
      if (!res.headersSent) json(res, status, body);
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, DASHBOARD_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${DASHBOARD_HOST}:${port}/`,
    port,
    token,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function errorResponse(err: unknown, log: (line: string) => void): { status: number; body: unknown } {
  if (err instanceof HttpError) return { status: err.status, body: { error: { code: 'HTTP', message: err.message } } };
  if (err instanceof FactoryError) {
    return { status: STATUS_BY_CODE[err.code] ?? 500, body: { error: { code: err.code, message: safeMessage(err) } } };
  }
  log(`Internal error: ${redactSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err))}`);
  return { status: 500, body: { error: { code: 'INTERNAL', message: safeMessage(err) } } };
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Body> {
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    req.resume();
    throw new HttpError(413, 'Request body too large.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep draining an oversized body (without storing it) so the error response can still be sent.
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  if (size > limit) throw new HttpError(413, 'Request body too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'Request body must be a JSON object.');
  return parsed;
}
