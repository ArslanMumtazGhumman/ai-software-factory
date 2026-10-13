// AI Software Factory dashboard. Plain JavaScript; every value is rendered as text (never as HTML).
// The server is the source of truth: views are refetched, never edited locally.
'use strict';

const TOKEN = document.querySelector('meta[name="asf-token"]').content;
const app = document.getElementById('app');
const banner = document.getElementById('banner');
const live = document.getElementById('live');
const crumbs = document.getElementById('crumbs');
const modalRoot = document.getElementById('modal-root');

const POLL_MS = 5000;
const POLL_HIDDEN_MS = 30000;
const POLL_MAX_BACKOFF_MS = 60000;

const ui = {
  taskFilter: 'all',
  activityFilter: 'all',
  open: new Set(), // expanded <details> keys
};

// ------------------------------------------------------------------ helpers

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtUsd = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(4)}`);
function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
const short = (sha) => (sha ? String(sha).slice(0, 10) : '—');
const enc = encodeURIComponent;
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2, 12)}`);

const STATUS_CLASS = {
  completed: 'ok', 'auto-accepted': 'ok', accepted: 'ok', passed: 'ok',
  awaiting_review: 'info', 'awaiting-review': 'info', running: 'info', in_progress: 'info', paused: 'warn',
  failed: 'err', needs_attention: 'err', 'needs-attention': 'err', error: 'err', rejected: 'warn', interrupted: 'warn',
  stopped: 'warn', pending: '', blocked: 'warn',
};
const badge = (text, cls) => h('span', { class: `badge ${cls ?? STATUS_CLASS[text] ?? ''}`, text: String(text).replace(/_/g, ' ') });

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', { text: k }), h('dd', {}, v === null || v === undefined || v === '' ? '—' : v)]));
}

function persistentDetails(key, summary, ...content) {
  const d = h('details', { open: ui.open.has(key) }, h('summary', {}, summary), ...content);
  d.addEventListener('toggle', () => (d.open ? ui.open.add(key) : ui.open.delete(key)));
  return d;
}

function table(headers, rows, onRowClick) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, headers.map((t) => h('th', { text: t })))),
      h(
        'tbody',
        {},
        rows.length === 0
          ? h('tr', {}, h('td', { colspan: headers.length, class: 'muted', text: 'Nothing to show.' }))
          : rows.map((r) => {
              const tr = h('tr', { class: r.href ? 'clickable' : '' }, r.cells.map((c) => h('td', {}, c)));
              if (r.href) tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) location.hash = r.href; });
              return tr;
            }),
      ),
    ),
  );
}

function diffView(patch) {
  const pre = h('pre', { class: 'diff' });
  for (const line of patch.split('\n')) {
    let cls = '';
    if (line.startsWith('diff --git') || line.startsWith('+++') || line.startsWith('---')) cls = 'file';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    pre.append(cls ? h('span', { class: cls, text: line }) : document.createTextNode(`${line}\n`));
  }
  return pre;
}

// --------------------------------------------------------------------- API

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: options.method || 'GET',
      headers: { 'X-ASF-Token': TOKEN, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'UNAVAILABLE', 'Cannot reach the dashboard server. Is it still running in its CMD window?');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP', data?.error?.message ?? `Request failed (${res.status}).`);
  return data;
}

function errorBox(err) {
  return h('div', { class: 'notice err' }, h('strong', { text: err.code === 'UNAVAILABLE' ? 'Server unavailable. ' : 'Error. ' }), err.message || String(err));
}

// ------------------------------------------------------------------ modals

let modalOpen = false;

function closeModal() {
  modalRoot.replaceChildren();
  modalOpen = false;
}

/**
 * Confirmation dialog. `action` is called at most once per dialog: the confirm
 * button is disabled while the request runs and the same requestId is reused,
 * so a double click can never submit an action twice.
 */
function confirmDialog({ title, body, confirmText, danger, action, validate }) {
  const requestId = newRequestId();
  const status = h('div');
  let busy = false;
  const confirmBtn = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', text: confirmText });
  const cancelBtn = h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeModal });
  confirmBtn.addEventListener('click', async () => {
    if (busy) return;
    const problem = validate ? validate() : null;
    if (problem) {
      status.replaceChildren(h('div', { class: 'notice err', text: problem }));
      return;
    }
    busy = true;
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Working…';
    status.replaceChildren(h('div', { class: 'notice info', text: 'Request sent. Waiting for the factory…' }));
    try {
      const result = await action(requestId);
      status.replaceChildren(h('div', { class: 'notice ok', text: result?.message ?? 'Done.' }));
      confirmBtn.remove();
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Close';
      render();
    } catch (err) {
      status.replaceChildren(errorBox(err));
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Close';
      confirmBtn.remove();
    }
  });
  const backdrop = h(
    'div',
    { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal' }, h('h2', { text: title }), body, status, h('div', { class: 'actions' }, cancelBtn, confirmBtn)),
  );
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !busy) closeModal(); });
  modalRoot.replaceChildren(backdrop);
  modalOpen = true;
  confirmBtn.focus();
}

// ----------------------------------------------------------------- routing

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'p' || !parts[1]) return { view: 'overview' };
  const pid = parts[1];
  if (parts[2] === 't' && parts[3]) return { view: 'task', pid, tid: parts[3] };
  if (parts[2] === 'review' && parts[3]) return { view: 'review', pid, tid: parts[3] };
  if (parts[2] === 'run' && parts[3]) return { view: 'run', pid, rid: parts[3] };
  return { view: 'project', pid, tab: parts[2] || 'tasks' };
}

const projectNames = new Map();
function setCrumbs(items) {
  crumbs.replaceChildren(...items.flatMap((item, i) => [
    ...(i > 0 ? [h('span', { text: '/' })] : []),
    item.href ? h('a', { href: item.href, text: item.text }) : h('span', { text: item.text }),
  ]));
}

/** Project name for breadcrumbs when a page is opened directly. */
async function projectName(pid) {
  if (!projectNames.has(pid)) projectNames.set(pid, (await api(`/api/projects/${enc(pid)}`)).name);
  return projectNames.get(pid);
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const r = route();
  let view;
  try {
    if (r.view === 'overview') view = await renderOverview();
    else if (r.view === 'project') view = await renderProject(r.pid, r.tab);
    else if (r.view === 'task') view = await renderTask(r.pid, r.tid);
    else if (r.view === 'review') view = await renderReview(r.pid, r.tid);
    else if (r.view === 'run') view = await renderRun(r.pid, r.rid);
  } catch (err) {
    view = h('div', {}, errorBox(err), h('p', {}, h('a', { href: '#/', text: 'Back to overview' })));
  }
  if (seq !== renderSeq) return; // a newer render started
  const y = window.scrollY;
  app.replaceChildren(view);
  window.scrollTo(0, y);
}

function progressBar(fraction) {
  const pct = Math.round(fraction * 100);
  const fill = h('span');
  fill.style.width = `${pct}%`; // CSSOM, allowed by the page's CSP (inline style attributes are not)
  return h('div', { class: 'progress', title: `${pct}%` }, fill);
}

// ---------------------------------------------------------------- overview

async function renderOverview() {
  const data = await api('/api/overview');
  setCrumbs([{ text: 'Overview' }]);
  for (const p of data.projects) projectNames.set(p.id, p.name);
  const est = data.usage.estimated;
  const activeCards = data.active.length === 0
    ? [h('div', { class: 'muted', text: 'No active run.' })]
    : data.active.map((a) =>
        h('div', {},
          h('a', { href: `#/p/${enc(a.projectId)}/run/${enc(a.run.autoRunId)}`, text: a.projectName }), ' ', badge(a.run.state),
          h('div', { class: 'small muted', text: a.run.currentTask ? `Current task: ${a.run.currentTask.taskId}` : a.run.stop ? `${a.run.stop.reason}: ${a.run.stop.message}` : '' })));
  return h('div', {},
    h('h1', { text: 'Overview' }),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('div', { class: 'label', text: 'Projects' }), h('div', { class: 'value', text: String(data.projectCount) })),
      h('div', { class: 'card' }, h('div', { class: 'label', text: 'Active runs' }), ...activeCards),
      h('div', { class: 'card' },
        h('div', { class: 'label', text: 'Estimated usage' }),
        h('div', { class: 'value', text: fmtUsd(est.usd) }),
        h('div', { class: 'small' }, badge('estimate', 'info'), ' ', est.incomplete ? badge('incomplete', 'warn') : null),
        h('div', { class: 'small muted', text: est.label }),
        h('div', { class: 'small muted', text: est.note })),
      h('div', { class: 'card' },
        h('div', { class: 'label', text: 'Actual charges' }),
        h('div', { class: 'value muted', text: 'Not available' }),
        h('div', { class: 'small muted', text: data.usage.actual.note }))),
    h('h2', { text: 'Projects' }),
    table(['Project', 'Location', 'Status', 'Tasks', 'Progress', 'Current run', 'Last activity'],
      data.projects.map((p) => ({
        href: p.status === 'ok' ? `#/p/${enc(p.id)}` : null,
        cells: [
          h('a', { href: `#/p/${enc(p.id)}`, text: p.name }),
          h('span', { class: 'mono small', text: p.location }),
          p.status === 'ok' ? badge('ok', 'ok') : h('div', {}, badge('error', 'err'), h('div', { class: 'small', text: p.error })),
          p.counts ? `${p.counts.completed}/${p.counts.total} completed${p.counts.awaitingReview ? `, ${p.counts.awaitingReview} awaiting review` : ''}` : '—',
          progressBar(p.progress),
          p.run ? h('div', {}, badge(p.run.state), p.run.ownerAlive === false ? h('div', { class: 'small', text: 'runner not running' }) : null) : h('span', { class: 'muted', text: 'none' }),
          fmtTime(p.lastActivity),
        ],
      }))),
  );
}

// ----------------------------------------------------------------- project

async function renderProject(pid, tab) {
  const [detail, controls] = await Promise.all([api(`/api/projects/${enc(pid)}`), api(`/api/projects/${enc(pid)}/controls`)]);
  projectNames.set(pid, detail.name);
  setCrumbs([{ text: 'Overview', href: '#/' }, { text: detail.name }]);
  const tabs = [['tasks', 'Tasks'], ['runs', 'Runs'], ['activity', 'Activity'], ['spec', 'Specification'], ['config', 'Configuration']];
  let content;
  if (tab === 'runs') content = await projectRuns(pid);
  else if (tab === 'activity') content = await projectActivity(pid);
  else if (tab === 'spec') content = projectSpec(detail);
  else if (tab === 'config') content = projectConfig(detail);
  else content = await projectTasks(pid);
  return h('div', {},
    h('h1', { text: detail.name }),
    h('div', { class: 'muted small mono', text: detail.location }),
    runPanel(pid, detail, controls),
    h('nav', { class: 'tabs' }, tabs.map(([key, label]) => h('a', { href: `#/p/${enc(pid)}/${key}`, class: key === tab ? 'active' : '', text: label }))),
    content,
  );
}

function runPanel(pid, detail, data) {
  const run = detail.run;
  const c = data.controls;
  const button = (label, state, onClick, cls) => h('button', { class: `btn ${cls ?? ''}`, type: 'button', disabled: !state.allowed, title: state.allowed ? '' : state.reason, text: label, onclick: onClick });
  const reasons = Object.entries(c).filter(([, s]) => !s.allowed).map(([k, s]) => h('li', {}, h('strong', { text: `${k[0].toUpperCase()}${k.slice(1)}: ` }), s.reason));
  return h('div', { class: 'card section' },
    h('div', { class: 'controls' },
      h('strong', { text: 'Autonomous run:' }),
      run ? [badge(run.state), h('a', { href: `#/p/${enc(pid)}/run/${enc(run.autoRunId)}`, class: 'mono small', text: run.autoRunId })] : h('span', { class: 'muted', text: 'none yet' }),
      run?.currentTask ? h('span', { class: 'small', text: `current: ${run.currentTask.taskId}` }) : null,
      h('span', { class: 'spacer' }),
      button('Start run…', c.start, () => startDialog(pid, data), 'primary'),
      button('Pause', c.pause, () => controlDialog(pid, 'pause')),
      button('Resume…', c.resume, () => resumeDialog(pid, data)),
      button('Stop…', c.stop, () => controlDialog(pid, 'stop'), 'danger'),
    ),
    run?.stop ? h('div', { class: `notice ${run.state === 'completed' ? 'ok' : 'warn'}` }, h('strong', { text: `${run.stop.reason}: ` }), run.stop.message, h('div', { class: 'small', text: `Next: ${run.stop.action}` })) : null,
    run?.ownerAlive === false ? h('div', { class: 'notice err', text: 'The run is marked running but its runner process is gone. Run "recover" from CMD (see the README), then resume.' }) : null,
    data.lock.state === 'held' ? h('div', { class: 'small muted', text: `Project lock held by pid ${data.lock.pid} (${data.lock.command}) since ${fmtTime(data.lock.since)}.` }) : null,
    reasons.length ? h('ul', { class: 'control-note' }, reasons) : null,
  );
}

function limitsView(l) {
  return kv([
    ['Task limit', `${l.maxTasks} task(s) per run`],
    ['Run time limit', fmtMs(l.maxRunDurationMs) + ' of active time'],
    ['Task timeout', `${fmtMs(l.maxTaskDurationMs)} per task (agent call timeout ${fmtMs(l.agentTimeoutMs)})`],
    ['Repair limit', `${l.maxRepairAttempts} repair attempt(s) per task`],
    ['Retry limit', `${l.maxRetries} retr${l.maxRetries === 1 ? 'y' : 'ies'} per task`],
    ['Per-call budget', l.perCallBudgetUsd === null ? 'not configured' : `$${l.perCallBudgetUsd} (enforced by Claude Code --max-budget-usd)`],
    ['Run budget', l.runBudgetUsd === null ? 'not configured' : `$${l.runBudgetUsd} (estimated, tracked by the factory)`],
    ['Checks', l.validationCommands.join(', ')],
    ['Auto-accept', l.autoAccept.enabled ? `tasks ${l.autoAccept.taskIds.join(', ')} under ${l.autoAccept.paths.join(', ')}` : 'off: every result waits for human review'],
  ]);
}

function startDialog(pid, data) {
  const l = data.limits;
  const maxInput = h('input', { type: 'number', min: 1, max: l.maxTasks, step: 1, value: l.maxTasks });
  const retry = h('input', { type: 'checkbox' });
  confirmDialog({
    title: 'Start an autonomous run?',
    confirmText: 'Start run',
    body: h('div', {},
      h('p', { text: 'The factory will run eligible tasks one at a time through Claude Code, within these configured limits. They come from the config file and cannot be raised here.' }),
      limitsView(l),
      h('div', { class: 'notice info small', text: l.budgetNote }),
      h('label', {}, 'Tasks for this run (at most the configured limit)', maxInput),
      h('label', {}, retry, ' Also retry tasks that failed earlier (within the retry limit)')),
    validate: () => {
      const n = Number(maxInput.value);
      return Number.isInteger(n) && n >= 1 && n <= l.maxTasks ? null : `Enter a whole number from 1 to ${l.maxTasks}.`;
    },
    action: (requestId) => api(`/api/projects/${enc(pid)}/runs/start`, { method: 'POST', body: { requestId, confirm: true, maxTasks: Number(maxInput.value), retryFailed: retry.checked } }),
  });
}

function resumeDialog(pid, data) {
  const retry = h('input', { type: 'checkbox' });
  confirmDialog({
    title: 'Resume the paused run?',
    confirmText: 'Resume run',
    body: h('div', {},
      h('p', { text: 'The run continues with the limits it was started with. State is reloaded and reconciled first.' }),
      limitsView(data.limits),
      h('label', {}, retry, ' Also retry tasks that failed earlier (within the retry limit)')),
    action: (requestId) => api(`/api/projects/${enc(pid)}/runs/resume`, { method: 'POST', body: { requestId, confirm: true, retryFailed: retry.checked } }),
  });
}

function controlDialog(pid, kind) {
  confirmDialog({
    title: kind === 'pause' ? 'Pause the run?' : 'Stop the run?',
    confirmText: kind === 'pause' ? 'Request pause' : 'Request stop',
    danger: kind === 'stop',
    body: h('p', {
      text: kind === 'pause'
        ? 'The current task finishes first; then the run pauses and can be resumed.'
        : 'No new task will start. A task in progress finishes first (its result is kept for review). A stopped run cannot be resumed.',
    }),
    action: (requestId) => api(`/api/projects/${enc(pid)}/runs/${kind}`, { method: 'POST', body: { requestId, confirm: true } }),
  });
}

const TASK_FILTERS = [
  ['all', 'All'], ['eligible', 'Ready to run'], ['blocked', 'Blocked'], ['pending', 'Pending'], ['in_progress', 'In progress'],
  ['awaiting_review', 'Awaiting review'], ['failed', 'Failed'], ['needs_attention', 'Needs attention'], ['completed', 'Completed'],
];

async function projectTasks(pid) {
  const data = await api(`/api/projects/${enc(pid)}/tasks`);
  const matches = (t) =>
    ui.taskFilter === 'all' ? true
    : ui.taskFilter === 'eligible' ? t.eligible
    : ui.taskFilter === 'blocked' ? !t.eligible && t.status !== 'completed'
    : t.status === ui.taskFilter;
  const count = (key) => data.tasks.filter((t) => (key === 'all' ? true : key === 'eligible' ? t.eligible : key === 'blocked' ? !t.eligible && t.status !== 'completed' : t.status === key)).length;
  return h('div', {},
    h('div', { class: 'chips' }, TASK_FILTERS.map(([key, label]) =>
      h('button', { type: 'button', class: `chip ${ui.taskFilter === key ? 'active' : ''}`, text: `${label} (${count(key)})`, onclick: () => { ui.taskFilter = key; render(); } }))),
    table(['ID', 'Title', 'Status', 'Dependencies', 'Retries', 'Checks', 'Why / next'],
      data.tasks.filter(matches).map((t) => ({
        href: `#/p/${enc(pid)}/t/${enc(t.id)}`,
        cells: [
          h('a', { href: `#/p/${enc(pid)}/t/${enc(t.id)}`, class: 'mono', text: t.id }),
          h('div', {}, t.title, t.branch ? h('div', { class: 'small muted mono', title: t.worktreePath ?? '', text: t.branch }) : null),
          badge(t.status),
          t.dependencies.length ? t.dependencies.join(', ') : h('span', { class: 'muted', text: 'none' }),
          `${t.retryCount}/${data.maxRetries}`,
          t.validation.length ? t.validation.map((v) => badge(v.name, v.passed ? 'ok' : 'err')) : h('span', { class: 'muted', text: '—' }),
          t.status === 'awaiting_review'
            ? h('a', { href: `#/p/${enc(pid)}/review/${enc(t.id)}`, text: 'Review →' })
            : h('span', { class: t.eligible ? '' : 'muted', text: t.eligible ? `eligible (${t.eligibility})` : t.eligibility }),
        ],
      }))),
  );
}

async function projectRuns(pid) {
  const data = await api(`/api/projects/${enc(pid)}/runs`);
  return table(['Run', 'State', 'Stop reason', 'Tasks', 'Started', 'Est. cost'],
    data.runs.map((r) => ({
      href: `#/p/${enc(pid)}/run/${enc(r.autoRunId)}`,
      cells: [
        h('a', { href: `#/p/${enc(pid)}/run/${enc(r.autoRunId)}`, class: 'mono small', text: r.autoRunId }),
        badge(r.state),
        r.stop ? r.stop.reason : '—',
        r.results.map((e) => badge(`${e.taskId}: ${e.result}`, STATUS_CLASS[e.result])),
        fmtTime(r.createdAt),
        h('span', {}, fmtUsd(r.costUsd), r.costUnknown ? ' (incomplete)' : ''),
      ],
    })));
}

const ACTIVITY_FILTERS = [['all', 'All'], ['run', 'Runs'], ['task', 'Tasks'], ['decision', 'Decisions'], ['validation', 'Validation'], ['budget', 'Budget'], ['recovery', 'Recovery'], ['warning', 'Warnings']];

async function projectActivity(pid) {
  const data = await api(`/api/projects/${enc(pid)}/activity`);
  const items = data.items.filter((i) => ui.activityFilter === 'all' || i.kind === ui.activityFilter);
  return h('div', {},
    h('div', { class: 'chips' }, ACTIVITY_FILTERS.map(([key, label]) =>
      h('button', { type: 'button', class: `chip ${ui.activityFilter === key ? 'active' : ''}`, text: label, onclick: () => { ui.activityFilter = key; render(); } }))),
    h('div', { class: 'card' },
      items.length === 0 ? h('p', { class: 'muted', text: 'No activity recorded.' }) : h('ul', { class: 'timeline' }, items.map((i) =>
        h('li', {},
          h('span', { class: 'small muted', text: fmtTime(i.at) }),
          h('span', {}, badge(i.kind, i.severity === 'error' ? 'err' : i.severity === 'warning' ? 'warn' : 'info')),
          h('span', {}, i.message, i.autoRunId ? [' ', h('a', { class: 'small', href: `#/p/${enc(pid)}/run/${enc(i.autoRunId)}`, text: 'run' })] : null,
            i.taskId ? [' ', h('a', { class: 'small', href: `#/p/${enc(pid)}/t/${enc(i.taskId)}`, text: i.taskId })] : null))))),
    data.truncated ? h('p', { class: 'small muted', text: 'Older entries are not shown.' }) : null,
  );
}

function projectSpec(detail) {
  const s = detail.spec;
  return h('div', { class: 'card' },
    kv([['Project id', h('span', { class: 'mono', text: s.id })], ['Name', s.name], ['Config file', h('span', { class: 'mono small', text: detail.configFile })]]),
    h('h3', { text: 'Description' }), h('pre', { text: s.description }),
    h('h3', { text: 'Goals' }), s.goals.length ? h('ul', { class: 'plain' }, s.goals.map((g) => h('li', { text: g }))) : h('p', { class: 'muted', text: 'none' }),
    h('h3', { text: 'Constraints' }), s.constraints.length ? h('ul', { class: 'plain' }, s.constraints.map((g) => h('li', { text: g }))) : h('p', { class: 'muted', text: 'none' }),
  );
}

function projectConfig(detail) {
  const c = detail.config;
  return h('div', {},
    h('div', { class: 'notice info small', text: 'Read-only. The dashboard cannot change the configuration, security policy or limits; edit the config file and restart the dashboard.' }),
    h('div', { class: 'card' },
      h('h3', { text: 'Agent' }),
      kv([
        ['Executable', c.agent.executable], ['Model', c.agent.model ?? 'default'], ['Permission mode', c.agent.permissionMode],
        ['Tools', c.agent.tools.join(', ')], ['Auto-approved tools', c.agent.allowedTools.join(', ')],
        ['Per-call budget', c.agent.maxBudgetUsd === null ? 'not configured' : `$${c.agent.maxBudgetUsd}`],
        ['Passed environment variables', `${c.agent.passEnvCount} (names and values hidden)`],
      ]),
      h('h3', { text: 'Commands (allowlisted)' }),
      table(['Name', 'Command', 'Timeout'], c.commands.map((cmd) => ({ cells: [cmd.name, h('code', { text: cmd.command }), fmtMs(cmd.timeoutMs)] }))),
      h('h3', { text: 'Limits' }), h('pre', { text: JSON.stringify(c.limits, null, 2) }),
      h('h3', { text: 'Execution' }), h('pre', { text: JSON.stringify(c.execution, null, 2) }),
      h('h3', { text: 'Autonomy' }), h('pre', { text: JSON.stringify(c.autonomy, null, 2) }),
      kv([['Project root', h('span', { class: 'mono small', text: c.projectRoot })], ['Data directory', h('span', { class: 'mono small', text: c.dataDir })], ['Allowed executables', c.allowedExecutables.join(', ')]]),
    ),
  );
}

// -------------------------------------------------------------------- task

function agentBlock(a) {
  if (!a) return h('p', { class: 'muted', text: 'The agent has not reported yet.' });
  return h('div', {},
    kv([
      ['Outcome', badge(a.outcome === 'success' ? 'passed' : 'failed', a.outcome === 'success' ? 'ok' : 'err')],
      ['Exit status', `${a.exitCode ?? 'none'}${a.timedOut ? ' (timed out)' : ''}`],
      ['Duration', fmtMs(a.durationMs)],
      ['Estimated cost', a.costUsd === null ? 'not reported' : `${fmtUsd(a.costUsd)} (Claude Code estimate)`],
      ['Turns', a.numTurns],
      ['Permission denials', a.permissionDenials],
      a.error ? ['Error', a.error] : null,
    ]),
    h('h3', { text: 'Agent summary' }), h('pre', { text: a.summary || '(empty)' }));
}

function validationBlock(list, keyPrefix) {
  if (!list || list.length === 0) return h('p', { class: 'muted', text: 'No checks were run.' });
  return list.map((v, i) =>
    persistentDetails(`${keyPrefix}-v${i}`,
      h('span', {}, badge(v.passed ? 'passed' : 'failed', v.passed ? 'ok' : 'err'), ' ', h('strong', { text: v.name }), ' ', h('code', { text: v.command }), ` → exit ${v.exitCode ?? 'none'}${v.timedOut ? ' (timed out)' : ''} in ${fmtMs(v.durationMs)}`),
      v.error ? h('div', { class: 'notice err', text: v.error }) : null,
      v.outputTail !== undefined ? h('pre', { text: v.outputTail || '(no output)' }) : null,
      v.truncated ? h('div', { class: 'small muted', text: 'Output was truncated by limits.maxOutputBytes.' }) : null));
}

function runEvidence(run, keyPrefix) {
  return h('div', {},
    kv([
      ['Run', h('span', { class: 'mono small', text: run.runId })],
      ['State', h('span', {}, badge(run.state), ' ', run.stage)],
      ['Started / finished', `${fmtTime(run.startedAt)} → ${fmtTime(run.finishedAt)}`],
      ['Branch', run.branch ? h('code', { text: run.branch }) : null],
      ['Worktree', run.worktreePath ? h('span', { class: 'mono small', text: run.worktreePath }) : null],
      ['Base commit', h('code', { text: short(run.baseCommit) })],
      ['Accepted commit', run.acceptedCommit ? h('code', { text: short(run.acceptedCommit) }) : null],
      ['Decision', run.decision ? `${run.decision.decision} by ${run.decision.by ?? 'human'} at ${fmtTime(run.decision.at)}${run.decision.reason ? `: ${run.decision.reason}` : ''}` : null],
      ['Failure', run.failureReason],
      ['Estimated cost', `${fmtUsd(run.cost.estimatedUsd)} over ${run.cost.agentCalls} agent call(s)${run.cost.incomplete ? ' (incomplete: a call did not report cost)' : ''}`],
    ]),
    h('h3', { text: 'Agent' }), agentBlock(run.agent),
    h('h3', { text: 'Checks (build / type-check / tests as configured)' }), validationBlock(run.validation, keyPrefix),
    run.repairs.length ? [h('h3', { text: `Repair attempts (${run.repairs.length})` }), run.repairs.map((r) =>
      persistentDetails(`${keyPrefix}-r${r.attempt}`, `Repair ${r.attempt}: after ${r.failedChecks.map((c) => c.name).join(', ')} failed → agent ${r.agent?.outcome ?? '?'}`, agentBlock(r.agent)))] : null,
    run.review ? [
      h('h3', { text: `Changed files (${run.review.changedFiles.length})` }),
      changedFiles(run.review.changedFiles),
      h('h3', { text: 'Review findings' }),
      findings(run.review.findings),
    ] : null,
  );
}

function changedFiles(files) {
  return files.length === 0 ? h('p', { class: 'muted', text: 'No files changed.' }) : h('ul', { class: 'plain mono small' }, files.map((f) => h('li', { text: `${f.status} ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}` })));
}

function findings(list) {
  return list.length === 0 ? h('p', { class: 'muted', text: 'None.' }) : h('ul', { class: 'plain' }, list.map((f) => h('li', {}, badge(f.severity, f.severity === 'violation' ? 'err' : 'warn'), ` ${f.rule}: ${f.message}`)));
}

async function renderTask(pid, tid) {
  const data = await api(`/api/projects/${enc(pid)}/tasks/${enc(tid)}`);
  const t = data.task;
  setCrumbs([{ text: 'Overview', href: '#/' }, { text: await projectName(pid), href: `#/p/${enc(pid)}` }, { text: t.id }]);
  return h('div', {},
    h('h1', {}, h('span', { class: 'mono', text: t.id }), ' ', t.title),
    h('div', { class: 'controls' }, badge(t.status), h('span', { class: 'small', text: `retries ${t.retryCount}, attempts ${t.attempts}` }),
      t.status === 'awaiting_review' ? h('a', { class: 'btn primary small', href: `#/p/${enc(pid)}/review/${enc(t.id)}`, text: 'Review result' }) : null),
    !t.eligible && t.status !== 'completed' ? h('div', { class: 'notice warn' }, h('strong', { text: 'Not eligible: ' }), t.eligibility,
      t.blockedBy.length ? h('div', { class: 'small' }, 'Blocked by: ', t.blockedBy.map((b, i) => [i ? ', ' : '', h('a', { href: `#/p/${enc(pid)}/t/${enc(b.id)}`, text: b.id }), ` (${b.status.replace(/_/g, ' ')})`])) : null) : null,
    t.eligible ? h('div', { class: 'notice ok', text: `Eligible to run (${t.eligibility}).` }) : null,
    h('div', { class: 'card section' },
      h('h3', { text: 'Description' }), h('pre', { text: t.description }),
      h('h3', { text: 'Acceptance criteria' }), h('ul', { class: 'plain' }, t.acceptanceCriteria.map((c) => h('li', { text: c }))),
      h('h3', { text: 'Dependencies' }), t.dependencies.length ? h('ul', { class: 'plain' }, t.dependencies.map((d) => h('li', {}, h('a', { href: `#/p/${enc(pid)}/t/${enc(d)}`, text: d })))) : h('p', { class: 'muted', text: 'none' })),
    h('h2', { text: 'Latest execution' }),
    data.latestRun ? h('div', { class: 'card' }, runEvidence(data.latestRun, `task-${t.id}`)) : h('p', { class: 'muted', text: 'This task has not been executed by the factory.' }),
    h('h2', { text: 'History' }),
    table(['Attempt', 'Outcome', 'Finished', 'Summary', 'Review'], data.results.slice().reverse().map((r) => ({
      cells: [String(r.attempt), badge(r.outcome === 'success' ? 'passed' : 'failed', r.outcome === 'success' ? 'ok' : 'err'), fmtTime(r.finishedAt),
        h('div', {}, r.summary, r.error ? h('div', { class: 'small', text: r.error }) : null),
        r.review ? `${r.review.decision} by ${r.review.by ?? 'human'}${r.review.reason ? `: ${r.review.reason}` : ''}` : '—'],
    }))),
  );
}

// ------------------------------------------------------------------ review

async function renderReview(pid, tid) {
  const data = await api(`/api/projects/${enc(pid)}/tasks/${enc(tid)}/review`);
  setCrumbs([{ text: 'Overview', href: '#/' }, { text: await projectName(pid), href: `#/p/${enc(pid)}` }, { text: tid, href: `#/p/${enc(pid)}/t/${enc(tid)}` }, { text: 'Review' }]);
  const run = data.run;
  const canDecide = data.decidable && data.integrityProblems.length === 0;
  return h('div', {},
    h('h1', { text: `Review ${data.task.id}: ${data.task.title}` }),
    h('div', { class: 'controls' }, badge(data.task.status),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger', type: 'button', disabled: !data.decidable, text: 'Reject…', onclick: () => rejectDialog(pid, data) }),
      h('button', { class: 'btn primary', type: 'button', disabled: !canDecide, text: 'Accept…', onclick: () => acceptDialog(pid, data) })),
    !data.decidable ? h('div', { class: 'notice info', text: `This result is not awaiting review (task status: ${data.task.status.replace(/_/g, ' ')}).` }) : null,
    data.integrityProblems.length ? h('div', { class: 'notice err' }, h('strong', { text: 'Integrity problems; acceptance is blocked:' }), h('ul', { class: 'plain' }, data.integrityProblems.map((p) => h('li', { text: p })))) : null,
    h('div', { class: 'card section' },
      h('h3', { text: 'Acceptance criteria' }), h('ul', { class: 'plain' }, data.task.acceptanceCriteria.map((c) => h('li', { text: c }))),
      run.agent ? [h('h3', { text: 'Summary of changes (agent)' }), h('pre', { text: run.agent.summary || '(empty)' })] : null,
      h('h3', { text: 'Validation' }), validationBlock(run.validation, `review-${tid}`),
      run.repairs.length ? h('p', { class: 'small', text: `${run.repairs.length} repair attempt(s) were needed.` }) : null,
      h('h3', { text: `Changed files (${run.review?.changedFiles.length ?? 0})` }), changedFiles(run.review?.changedFiles ?? []),
      h('h3', { text: 'Review findings' }), findings(run.review?.findings ?? []),
      kv([['Branch', run.branch ? h('code', { text: run.branch }) : null], ['Worktree', h('span', { class: 'mono small', text: run.worktreePath ?? '—' })], ['Base commit', h('code', { text: short(run.baseCommit) })]])),
    h('h2', { text: `Recorded diff (${run.review?.diffBytes ?? 0} bytes)` }),
    data.patchTruncated ? h('div', { class: 'notice warn', text: 'The diff is too large to show completely. Inspect the worktree before accepting.' }) : null,
    data.patch ? diffView(data.patch) : h('p', { class: 'muted', text: '(empty diff)' }),
  );
}

function acceptDialog(pid, data) {
  confirmDialog({
    title: `Accept ${data.task.id}?`,
    confirmText: 'Accept result',
    body: h('div', {},
      h('p', { text: 'The factory first verifies that the worktree and evidence still match exactly what was reviewed, then commits the reviewed tree on the factory branch:' }),
      h('p', {}, h('code', { text: data.run.branch ?? '' })),
      h('p', { text: 'Nothing is merged into your branch. Dependent tasks may become eligible.' })),
    action: (requestId) => api(`/api/projects/${enc(pid)}/tasks/${enc(data.task.id)}/accept`, { method: 'POST', body: { requestId, confirm: true, ...data.fingerprint } }),
  });
}

function rejectDialog(pid, data) {
  const reason = h('textarea', { maxlength: 2000, placeholder: 'Why is this result rejected?' });
  confirmDialog({
    title: `Reject ${data.task.id}?`,
    confirmText: 'Reject result',
    danger: true,
    body: h('div', {},
      h('p', { text: 'The task is marked failed (or needs attention when retries are used up). The worktree, branch and all evidence are kept for inspection.' }),
      h('label', {}, 'Reason (required)', reason)),
    validate: () => (reason.value.trim() ? null : 'A reason is required.'),
    action: (requestId) => api(`/api/projects/${enc(pid)}/tasks/${enc(data.task.id)}/reject`, { method: 'POST', body: { requestId, confirm: true, ...data.fingerprint, reason: reason.value.trim() } }),
  });
}

// --------------------------------------------------------------------- run

async function renderRun(pid, rid) {
  const [data, launch] = await Promise.all([api(`/api/projects/${enc(pid)}/runs/${enc(rid)}`), api(`/api/projects/${enc(pid)}/launch-log`).catch(() => ({ log: null }))]);
  const s = data.summary;
  const b = data.budget;
  setCrumbs([{ text: 'Overview', href: '#/' }, { text: await projectName(pid), href: `#/p/${enc(pid)}/runs` }, { text: `Run ${rid}` }]);
  return h('div', {},
    h('h1', {}, 'Run ', h('span', { class: 'mono', text: s.autoRunId })),
    h('div', { class: 'controls' }, badge(s.state), data.ownerAlive === false ? badge('runner process gone', 'err') : null, h('a', { class: 'small', href: `#/p/${enc(pid)}`, text: 'Controls →' })),
    s.stop ? h('div', { class: `notice ${s.state === 'completed' ? 'ok' : 'warn'}` }, h('strong', { text: `${s.stop.reason}: ` }), s.stop.message, h('div', { class: 'small', text: `Next: ${s.stop.action}` })) : null,
    h('div', { class: 'grid section' },
      h('div', { class: 'card' }, h('div', { class: 'label', text: 'Current task' }),
        data.current ? [h('div', { class: 'value mono', text: data.current.taskId }), h('div', { class: 'small', text: `Stage: ${data.current.stage}` }), h('div', { class: 'small muted', text: `since ${fmtTime(data.current.startedAt)}` })] : h('div', { class: 'muted', text: 'none' })),
      h('div', { class: 'card' }, h('div', { class: 'label', text: 'Tasks executed' }), h('div', { class: 'value', text: `${s.executions} / ${s.limits.maxTasks}` }), h('div', { class: 'small muted', text: `active time ${fmtMs(s.activeMs)} of ${fmtMs(s.limits.maxRunDurationMs)}` })),
      h('div', { class: 'card' },
        h('div', { class: 'label', text: 'Budget' }),
        h('div', { class: 'value', text: fmtUsd(b.estimatedUsd) }),
        h('div', { class: 'small' }, badge('estimate', 'info'), ' ', b.incomplete ? badge('incomplete', 'warn') : null),
        h('div', { class: 'small', text: b.runCapUsd === null ? 'No run cap' : `Run cap $${b.runCapUsd}; remaining ${b.remainingUsd === null ? 'unknown' : fmtUsd(b.remainingUsd)}` }),
        h('div', { class: 'small', text: b.perCallCapUsd === null ? 'No per-call cap' : `Per-call cap $${b.perCallCapUsd}` }),
        h('div', { class: 'small muted', text: b.note }),
        h('div', { class: 'small muted', text: b.guarantee }))),
    data.budgetEvents.length ? [h('h2', { text: 'Budget events' }), h('ul', { class: 'plain' }, data.budgetEvents.map((e) => h('li', { text: `${fmtTime(e.at)}: ${e.message}` })))] : null,
    h('h2', { text: 'Task executions' }),
    data.executions.length === 0 ? h('p', { class: 'muted', text: 'No task executed yet.' }) : data.executions.map((e, i) =>
      h('div', { class: 'card section' },
        h('div', { class: 'controls' }, h('a', { class: 'mono', href: `#/p/${enc(pid)}/t/${enc(e.taskId)}`, text: e.taskId }), badge(e.result),
          h('span', { class: 'small', text: `${fmtTime(e.startedAt)} · ${e.durationMs === null ? 'running' : fmtMs(e.durationMs)} · agent exit ${e.agentExitCode ?? '—'}${e.agentTimedOut ? ' (timed out)' : ''} · repairs ${e.repairs} · ${e.costUsd === null ? 'cost not reported' : `${fmtUsd(e.costUsd)} est.`}` }),
          e.result === 'awaiting-review' && e.taskStatus === 'awaiting_review' ? h('a', { class: 'btn small primary', href: `#/p/${enc(pid)}/review/${enc(e.taskId)}`, text: 'Review' }) : null),
        e.validation.length ? h('div', { class: 'small' }, 'Checks: ', e.validation.map((v) => badge(`${v.name}: ${v.timedOut ? 'timeout' : `exit ${v.exitCode ?? '—'}`}`, v.exitCode === 0 && !v.timedOut ? 'ok' : 'err'))) : null,
        e.failureReason ? h('div', { class: 'notice err', text: e.failureReason }) : null,
        e.reviewReasons.length ? h('div', { class: 'small muted' }, 'Review policy: ', e.reviewReasons.join('; ')) : null,
        e.branch ? h('div', { class: 'small' }, 'Branch ', h('code', { text: e.branch }), e.acceptedCommit ? [' · commit ', h('code', { text: short(e.acceptedCommit) })] : null) : null,
        e.run ? persistentDetails(`exec-${rid}-${i}`, 'Evidence (agent, checks, repairs, changed files)', runEvidence(e.run, `exec-${rid}-${i}`)) : null)),
    h('h2', { text: 'Remaining tasks' }),
    data.remainingTasks.length === 0 ? h('p', { class: 'muted', text: 'Every task is completed.' }) :
      table(['ID', 'Title', 'Status', 'Why'], data.remainingTasks.map((t) => ({ href: `#/p/${enc(pid)}/t/${enc(t.id)}`, cells: [h('span', { class: 'mono', text: t.id }), t.title, badge(t.status), t.eligibility] }))),
    h('h2', { text: 'Run log' }),
    data.droppedEvents ? h('p', { class: 'small muted', text: `${data.droppedEvents} older events were dropped.` }) : null,
    h('div', { class: 'card' }, h('ul', { class: 'timeline' }, data.events.slice().reverse().map((e) => h('li', {}, h('span', { class: 'small muted', text: fmtTime(e.at) }), h('span', {}, badge(e.type)), h('span', { text: e.message }))))),
    launch.log ? persistentDetails(`launch-${pid}`, `Runner output from the last dashboard launch (${launch.log.file}, redacted)`, h('pre', { text: launch.log.tail || '(empty)' })) : null,
  );
}

// ----------------------------------------------------------------- polling

let lastVersions = null;
let failures = 0;
let timer = null;

function scheduleNext() {
  clearTimeout(timer);
  const base = document.hidden ? POLL_HIDDEN_MS : POLL_MS;
  const delay = failures === 0 ? base : Math.min(POLL_MAX_BACKOFF_MS, base * 2 ** Math.min(failures, 4));
  timer = setTimeout(poll, delay);
}

/** One cheap status request; the current view is refetched only when its data changed. */
async function poll() {
  try {
    const status = await api('/api/status');
    failures = 0;
    banner.hidden = true;
    live.className = 'live ok';
    live.textContent = `updated ${new Date().toLocaleTimeString()}`;
    const r = route();
    const relevant = status.projects.filter((p) => r.view === 'overview' || p.id === r.pid).map((p) => `${p.id}:${p.version}`).join(',');
    if (lastVersions !== null && relevant !== lastVersions && !modalOpen) render();
    lastVersions = relevant;
  } catch (err) {
    failures += 1;
    live.className = 'live bad';
    live.textContent = 'disconnected';
    banner.hidden = false;
    banner.textContent = err.status === 403 ? 'The dashboard was restarted. Reload this page.' : `${err.message} Retrying…`;
  }
  scheduleNext();
}

window.addEventListener('hashchange', () => { lastVersions = null; closeModal(); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); else scheduleNext(); });
document.getElementById('refresh').addEventListener('click', () => render());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen && !modalRoot.querySelector('button:disabled')) closeModal(); });

render();
poll();
