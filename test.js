// Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The module reads these at load time, so point them at scratch dirs before requiring it.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tree-state-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tree-config-'));
process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
const { truncate, demoSlots, entry, agentLabel, buildDesired } = require('./agents-tree.js');

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

const PAD = '⠀'.repeat(2); // two U+2800 braille blanks, the default alignment pad

test('truncate keeps short text and counts code points, not UTF-16 units', () => {
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('🙂🙂🙂', 2), '🙂…');
});

test('agentLabel prefers a descriptive agent name', () => {
  assert.equal(agentLabel({ pane_id: 'wH:p7', name: 'fix-login', agent: 'claude' }, 'Docs', 'vim'), 'fix-login');
});

test('agentLabel skips names herdr generates from the pane id', () => {
  const agent = { pane_id: 'wH:p7', name: 'r-wh-p7', agent: 'claude' };
  assert.equal(agentLabel(agent, 'Write docs', ''), 'Write docs');
});

test('agentLabel skips numeric tab labels and the bare "Claude Code" title', () => {
  const agent = { pane_id: 'w1:p1', name: '', agent: 'claude' };
  assert.equal(agentLabel(agent, '2', 'Claude Code'), 'tab 2');
  assert.equal(agentLabel(agent, '2', 'vim notes.md'), 'vim notes.md');
  assert.equal(agentLabel(agent, undefined, ''), 'claude');
});

test('agentLabel truncates long labels to the default maximum of 22', () => {
  const label = agentLabel({ pane_id: 'w1:p1', name: 'x'.repeat(30), agent: 'claude' }, '', '');
  assert.equal(label, 'x'.repeat(21) + '…');
});

test('entry gives the first agent a header and no alignment pad', () => {
  const { status, tokens } = entry('working', 'Fix it', 'my-ws', true, false);
  assert.equal(status, 'working');
  assert.equal(tokens.t_working, '├─ ◐ Fix it');
  assert.equal(tokens.tp, '├─');
  assert.equal(tokens.tl, 'Fix it');
  assert.equal(tokens.ws_header, '▾ my-ws');
});

test('entry pads later agents, uses the last connector, and sets exactly one status token', () => {
  const { tokens } = entry('done', 'Docs', 'my-ws', false, true);
  assert.equal(tokens.t_done, `${PAD}└─ ✓ Docs`);
  assert.equal(tokens.tp, `${PAD}└─`);
  assert.equal(tokens.ws_header, null);
  const set = Object.keys(tokens).filter((k) => k.startsWith('t_') && tokens[k] !== null);
  assert.deepEqual(set, ['t_done']);
});

const glyph = (status) => entry(status, 'x', 'ws', true, true).tokens['t_' + status];

test('entry uses one glyph per status', () => {
  assert.equal(glyph('working'), '└─ ◐ x');
  assert.equal(glyph('blocked'), '└─ ! x');
  assert.equal(glyph('done'), '└─ ✓ x');
  assert.equal(glyph('idle'), '└─ ○ x');
  assert.equal(glyph('unknown'), '└─ ? x');
});

const snapshot = () => ({
  workspaces: [
    { workspace_id: 'w2', number: 2, label: 'beta' },
    { workspace_id: 'w1', number: 1, label: 'alpha' },
  ],
  tabs: [
    { tab_id: 't1', label: 'Fix login' },
    { tab_id: 't2', label: '3' },
    { tab_id: 't3', label: 'Docs' },
  ],
  panes: [
    { pane_id: 'w1:p1', terminal_title_stripped: '' },
    { pane_id: 'w1:p2', terminal_title_stripped: '' },
    { pane_id: 'w2:p1', terminal_title_stripped: '' },
  ],
  agents: [
    { pane_id: 'w2:p1', tab_id: 't3', workspace_id: 'w2', agent: 'claude', agent_status: 'done', name: '' },
    { pane_id: 'w1:p2', tab_id: 't2', workspace_id: 'w1', agent: 'cursor', agent_status: 'weird', name: '' },
    { pane_id: 'w1:p1', tab_id: 't1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', name: '' },
  ],
});

test('buildDesired groups agents by workspace number and tab order', () => {
  const desired = buildDesired(snapshot());
  assert.deepEqual(Object.keys(desired), ['w1:p1', 'w1:p2', 'w2:p1']);
  assert.equal(desired['w1:p1'].tokens.t_working, '├─ ◐ Fix login');
  assert.equal(desired['w1:p1'].tokens.ws_header, '▾ alpha');
  assert.equal(desired['w1:p2'].tokens.ws_header, null);
  assert.equal(desired['w2:p1'].tokens.ws_header, '▾ beta');
});

test('buildDesired files an unrecognised status under unknown and labels numeric tabs', () => {
  const desired = buildDesired(snapshot());
  assert.equal(desired['w1:p2'].status, 'unknown');
  assert.equal(desired['w1:p2'].tokens.t_unknown, `${PAD}└─ ? tab 3`);
});

test('buildDesired draws a single agent as first and last', () => {
  assert.equal(buildDesired(snapshot())['w2:p1'].tokens.t_done, '└─ ✓ Docs');
});

test('demoSlots lists fake workspaces and repeats with a numeric suffix when it runs out', () => {
  assert.deepEqual(demoSlots(0), []);
  const two = demoSlots(2);
  assert.deepEqual(
    two.map((s) => [s.ws, s.name, s.status, s.first, s.last]),
    [
      ['billing-api', 'refactor-invoices', 'working', true, false],
      ['billing-api', 'fix-flaky-tests', 'blocked', false, true],
    ],
  );
  // The built-in tree has 13 agents, so the 14th starts a second round.
  assert.deepEqual(demoSlots(14)[13], {
    ws: 'billing-api-2',
    name: 'refactor-invoices',
    status: 'working',
    first: true,
    last: true,
  });
});

test('buildDesired relabels real agents with fake ones while the demo flag exists', () => {
  const flag = path.join(stateDir, 'demo');
  fs.writeFileSync(flag, '1');
  try {
    const desired = buildDesired(snapshot());
    assert.equal(desired['w1:p1'].tokens.ws_header, '▾ billing-api');
    assert.equal(desired['w1:p1'].tokens.t_working, '├─ ◐ refactor-invoices');
    assert.equal(desired['w1:p2'].status, 'blocked');
    assert.equal(desired['w2:p1'].tokens.t_done, `${PAD}└─ ✓ write-migration`);
  } finally {
    fs.rmSync(flag, { force: true });
  }
});
