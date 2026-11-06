#!/usr/bin/env node
// Sanity-check herdr-plugin.toml: it parses, has the required keys, and every `node <file>` command it
// runs points at a file that exists. Run from the repo root: `npm run check:manifest`.
'use strict';
const fs = require('node:fs');

const REQUIRED_KEYS = ['id', 'name', 'version'];
const SECTIONS = ['startup', 'events', 'actions', 'panes'];

// manifest: the parsed TOML. fileExists: (path) => boolean. Returns a list of error messages.
function checkManifest(manifest, fileExists) {
  const errors = REQUIRED_KEYS.filter((key) => !manifest[key]).map((key) => `missing top-level key: ${key}`);
  for (const section of SECTIONS) {
    for (const entry of manifest[section] ?? []) {
      const command = entry.command ?? [];
      if (command.length === 0) {
        errors.push(`[[${section}]] entry has no command: ${JSON.stringify(entry)}`);
      } else if (command[0] === 'node' && !(command[1] && fileExists(command[1]))) {
        errors.push(`[[${section}]] runs a missing file: ${command[1] ?? '(none given)'}`);
      }
    }
  }
  return errors;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function main() {
  // Required here, not at the top, so the tests can load this file without installing anything.
  const { parse } = require('smol-toml');
  let manifest;
  try {
    manifest = parse(fs.readFileSync('herdr-plugin.toml', 'utf8'));
  } catch (e) {
    console.error(`error: herdr-plugin.toml: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const errors = checkManifest(manifest, isFile);
  for (const error of errors) console.error(`error: ${error}`);
  process.exitCode = errors.length ? 1 : 0;
}

if (require.main === module) main();

module.exports = { checkManifest };
