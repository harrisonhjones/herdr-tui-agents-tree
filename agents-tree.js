#!/usr/bin/env node
// herdr-agents-tree: renders a workspace -> agent tree in herdr's Agents sidebar
// by writing per-pane metadata tokens. Every run is an idempotent full reconcile.
//
// Usage: node agents-tree.js [event|refresh|clear|doctor]
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERDR = process.env.HERDR_BIN_PATH || 'herdr';
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(__dirname, '.state');
const SOURCE = 'agents-tree';
const STATUSES = ['working', 'blocked', 'done', 'idle', 'unknown'];
const GLYPH = { working: '◐', blocked: '!', done: '✓', idle: '○', unknown: '?' };
const MAX_LABEL = Number(process.env.AGENTS_TREE_MAX_LABEL || 22);
const PAD = Number(process.env.AGENTS_TREE_PAD || 2);
// herdr trims leading whitespace from token values, so pad with an invisible non-whitespace
// character (U+2800 braille blank, one cell wide).
const PAD_CHAR = process.env.AGENTS_TREE_PAD_CHAR || '⠀';
const mode = process.argv[2] || 'refresh';

// Optional config.json in the plugin config dir (`herdr plugin config-dir <id>`):
//   { "show_agent_kind": true }
// show_agent_kind prefixes each label with the agent's kind (e.g. "claude", "kiro").
// Off unless set to true.
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || __dirname;
function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') process.stderr.write(`config.json ignored: ${e.message}\n`); return {}; }
}
const SHOW_KIND = readConfig().show_agent_kind === true;

fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOCK = path.join(STATE_DIR, 'lock');
const DIRTY = path.join(STATE_DIR, 'dirty');
const DEMO = path.join(STATE_DIR, 'demo'); // while present, agents are shown under fake workspaces/names/statuses

// Writes carry no --seq, so only the lock keeps two runs from writing at once. A run whose lock is
// older than LOCK_STALE_MS is presumed dead and another run takes the lock over (see main). Each
// run therefore stops by RUN_BUDGET_MS, before that can happen: herdr() gives every call only the
// time left, and a run that runs out stops writing, releases the lock, and leaves the rest to the
// next run. RUN_BUDGET_MS must stay below LOCK_STALE_MS.
const LOCK_STALE_MS = 30000;
const RUN_BUDGET_MS = 25000;
const DEADLINE = Date.now() + RUN_BUDGET_MS;
const outOfTime = () => Date.now() >= DEADLINE;

function herdr(args, { json = true } = {}) {
  const timeout = DEADLINE - Date.now();
  if (timeout <= 0) throw new Error(`herdr ${args[0]} ${args[1]}: run time budget used up`);
  const r = spawnSync(HERDR, args, { encoding: 'utf8', windowsHide: true, timeout });
  if (r.error) throw r.error; // includes ETIMEDOUT when the call outlives the budget
  if (r.status !== 0) throw new Error(`herdr ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

function truncate(s, n) {
  const chars = [...String(s)];
  return chars.length <= n ? chars.join('') : chars.slice(0, n - 1).join('') + '…';
}

// Fake workspaces/agents for demo mode. Tokens can only be written to real panes, so the first N
// real agents (in sidebar order) are relabelled with these, workspace by workspace. If there are
// more real agents than entries here the list repeats with a numeric suffix.
const DEMO_TREE = [
  { ws: 'billing-api', agents: [['refactor-invoices', 'working'], ['fix-flaky-tests', 'blocked'], ['write-migration', 'done']] },
  { ws: 'mobile-app', agents: [['crash-triage', 'working'], ['update-deps', 'idle']] },
  { ws: 'docs-site', agents: [['rewrite-quickstart', 'done'], ['broken-links', 'idle'], ['api-reference', 'working'], ['changelog', 'unknown']] },
  { ws: 'infra', agents: [['terraform-plan', 'blocked']] },
  { ws: 'data-pipeline', agents: [['backfill-job', 'working'], ['schema-review', 'blocked'], ['cost-report', 'done']] },
];

function demoSlots(count) {
  const slots = [];
  for (let w = 0; slots.length < count; w++) {
    const g = DEMO_TREE[w % DEMO_TREE.length];
    const round = Math.floor(w / DEMO_TREE.length);
    const take = g.agents.slice(0, count - slots.length);
    take.forEach(([name, status], i) => slots.push({
      ws: round ? `${g.ws}-${round + 1}` : g.ws, name, status, first: i === 0, last: i === take.length - 1,
    }));
  }
  return slots;
}

function entry(status, label, wsLabel, first, last) {
  const branch = last ? '└─' : '├─';
  const tokens = {};
  for (const s of STATUSES) tokens['t_' + s] = null;
  // The sidebar indents an entry's first row by 1 and later rows by 3. The first agent of a
  // workspace has a header row above its tree line (indent 3); the others do not (indent 1).
  // Pad those so every tree line starts in the same column.
  const pad = first ? '' : PAD_CHAR.repeat(PAD);
  tokens['t_' + status] = `${pad}${branch} ${GLYPH[status]} ${label}`;
  tokens.tp = `${pad}${branch}`; // connector (+ alignment pad), for layouts that use herdr's own state_icon
  tokens.tl = label;
  tokens.ws_header = first ? `▾ ${wsLabel}` : null;
  return { status, tokens };
}

// Pick the first descriptive label. Skipped as uninformative: agent names that herdr
// generates from the pane ID (e.g. "r-wh-p7" for pane wH:p7), purely numeric tab labels,
// and terminal titles that are just the agent's product name (e.g. "Claude Code").
function agentLabel(agent, tabLabel, title) {
  const paneSlug = agent.pane_id.toLowerCase().replace(':', '-');
  const name = agent.name && !agent.name.toLowerCase().endsWith(paneSlug) ? agent.name : '';
  const tab = tabLabel && !/^\d+$/.test(tabLabel) ? tabLabel : '';
  const term = title && title !== 'Claude Code' ? title : '';
  const fallback = tabLabel ? `tab ${tabLabel}` : agent.agent;
  const prefix = SHOW_KIND && agent.agent ? `${agent.agent} ` : '';
  return prefix + truncate(name || tab || term || fallback, MAX_LABEL);
}

// Build desired tokens per agent pane: { pane_id: { status, tokens: {name: value} } }
function buildDesired(snap) {
  const tabLabel = new Map(snap.tabs.map((t) => [t.tab_id, t.label]));
  const tabOrder = new Map(snap.tabs.map((t, i) => [t.tab_id, i]));
  const paneOrder = new Map(snap.panes.map((p, i) => [p.pane_id, i]));
  const paneTitle = new Map(snap.panes.map((p) => [p.pane_id, p.terminal_title_stripped]));
  const workspaces = [...snap.workspaces].sort((a, b) => a.number - b.number);
  const desired = {};
  const demo = fs.existsSync(DEMO);
  const ordered = []; // real agents in sidebar order, grouped by real workspace
  for (const ws of workspaces) {
    const agents = snap.agents
      .filter((a) => a.workspace_id === ws.workspace_id)
      .sort((a, b) =>
        (tabOrder.get(a.tab_id) ?? 0) - (tabOrder.get(b.tab_id) ?? 0) ||
        (paneOrder.get(a.pane_id) ?? 0) - (paneOrder.get(b.pane_id) ?? 0));
    if (demo) { ordered.push(...agents); continue; }
    agents.forEach((a, i) => {
      const status = STATUSES.includes(a.agent_status) ? a.agent_status : 'unknown';
      const label = agentLabel(a, tabLabel.get(a.tab_id), paneTitle.get(a.pane_id));
      desired[a.pane_id] = entry(status, label, ws.label, i === 0, i === agents.length - 1);
    });
  }
  if (demo) {
    const slots = demoSlots(ordered.length);
    ordered.forEach((a, i) => {
      const f = slots[i];
      desired[a.pane_id] = entry(f.status, truncate(f.name, MAX_LABEL), f.ws, f.first, f.last);
    });
  }
  return desired;
}

function writeTokens(paneId, tokens) {
  const args = ['pane', 'report-metadata', paneId, '--source', SOURCE];
  for (const [k, v] of Object.entries(tokens)) {
    if (v === null) args.push('--clear-token', k);
    else args.push('--token', `${k}=${v}`);
  }
  herdr(args, { json: false });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function reconcile() {
  const snap = herdr(['api', 'snapshot']).result.snapshot;
  const desired = mode === 'clear' ? {} : buildDesired(snap);
  const prev = loadState();
  const livePanes = new Set(snap.panes.map((p) => p.pane_id));
  const next = {};
  let writes = 0;
  const clearAll = {};
  for (const s of STATUSES) clearAll['t_' + s] = null;
  clearAll.ws_header = null;

  // A pane is recorded in `next` only once its write succeeded, so panes skipped here (a failed
  // write, or the run out of time) are written on the next run.
  for (const [paneId, d] of Object.entries(desired)) {
    const sig = JSON.stringify(d.tokens);
    if (prev[paneId] === sig) { next[paneId] = sig; continue; }
    if (outOfTime()) continue;
    try { writeTokens(paneId, d.tokens); writes++; next[paneId] = sig; }
    catch (e) { console.error(String(e.message)); }
  }
  // Panes we tagged earlier that no longer host an agent: clear their tokens. A pane whose clear
  // didn't happen keeps its old entry, so the next run tries again.
  for (const paneId of Object.keys(prev)) {
    if (desired[paneId] || !livePanes.has(paneId)) continue;
    if (outOfTime()) { next[paneId] = prev[paneId]; continue; }
    try { writeTokens(paneId, clearAll); writes++; }
    catch (e) { next[paneId] = prev[paneId]; console.error(String(e.message)); }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(next));
  return { writes, agents: Object.keys(desired).length, desired };
}

function doctor() {
  const snap = herdr(['api', 'snapshot']).result.snapshot;
  const desired = buildDesired(snap);
  const byWs = new Map();
  for (const a of snap.agents) byWs.set(a.workspace_id, true);
  for (const [paneId, d] of Object.entries(desired)) {
    if (d.tokens.ws_header) console.log(d.tokens.ws_header);
    console.log('  ' + d.tokens['t_' + d.status] + `   [${paneId}]`);
  }
}

function main() {
  if (mode === 'doctor') return doctor();
  if (mode === 'demo') fs.writeFileSync(DEMO, '1');
  if (mode === 'demo-off') { try { fs.unlinkSync(DEMO); } catch {} }
  // Serialize runs: events arrive in bursts. A losing run flags "dirty" and exits;
  // the lock holder loops until no further events arrived.
  let held = false;
  try { fs.mkdirSync(LOCK); held = true; }
  catch {
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(LOCK); fs.mkdirSync(LOCK); held = true; }
    } catch { /* lost the race */ }
  }
  if (!held) { try { fs.writeFileSync(DIRTY, '1'); } catch {} return; }
  try {
    let rounds = 0;
    do {
      try { fs.unlinkSync(DIRTY); } catch {}
      const r = reconcile();
      if (mode !== 'refresh' || rounds === 0) console.log(`[${mode}] agents=${r.agents} writes=${r.writes}`);
      rounds++;
    } while (fs.existsSync(DIRTY) && rounds < 5 && !outOfTime());
  } finally {
    try { fs.rmdirSync(LOCK); } catch {}
  }
}

try { main(); } catch (e) { console.error(String(e.stack || e)); process.exit(1); }
