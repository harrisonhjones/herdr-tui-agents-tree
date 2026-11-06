// Run with: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkManifest } = require('./check-manifest.js');

const exists = new Set(['plugin.js']);
const isFile = (file) => exists.has(file);
const valid = () => ({
  id: 'owner.plugin',
  name: 'Plugin',
  version: '0.1.0',
  startup: [{ command: ['node', 'plugin.js', 'startup'] }],
  events: [{ on: 'pane.created', command: ['node', 'plugin.js', 'pane.created'] }],
  actions: [{ id: 'clear', command: ['node', 'plugin.js', 'clear'] }],
});

test('a valid manifest has no errors', () => {
  assert.deepEqual(checkManifest(valid(), isFile), []);
});

test('missing top-level keys are reported', () => {
  const manifest = valid();
  delete manifest.version;
  manifest.name = '';
  assert.deepEqual(checkManifest(manifest, isFile), ['missing top-level key: name', 'missing top-level key: version']);
});

test('a node command that points at a missing file is reported with its section', () => {
  const manifest = valid();
  manifest.actions[0].command = ['node', 'nope.js', 'clear'];
  assert.deepEqual(checkManifest(manifest, isFile), ['[[actions]] runs a missing file: nope.js']);
});

test('a bare node command with no file is reported', () => {
  const manifest = valid();
  manifest.events[0].command = ['node'];
  assert.deepEqual(checkManifest(manifest, isFile), ['[[events]] runs a missing file: (none given)']);
});

test('an entry with no command is reported', () => {
  const manifest = valid();
  manifest.panes = [{ id: 'list' }];
  assert.deepEqual(checkManifest(manifest, isFile), ['[[panes]] entry has no command: {"id":"list"}']);
});

test('commands that do not run node are not checked against the filesystem', () => {
  const manifest = valid();
  manifest.actions.push({ id: 'ps', command: ['powershell.exe', '-File', 'notify.ps1'] });
  assert.deepEqual(checkManifest(manifest, isFile), []);
});
