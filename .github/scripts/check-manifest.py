"""Sanity-check herdr-plugin.toml: it parses, has the required keys, and every `node <file>.js` it runs exists."""

import pathlib
import sys
import tomllib

manifest = tomllib.loads(pathlib.Path("herdr-plugin.toml").read_text(encoding="utf-8"))
errors = [f"missing top-level key: {k}" for k in ("id", "name", "version") if not manifest.get(k)]

sections = ("startup", "events", "actions", "panes")
for section in sections:
    for entry in manifest.get(section, []):
        command = entry.get("command", [])
        if not command:
            errors.append(f"[[{section}]] entry has no command: {entry}")
        elif command[0] == "node" and not pathlib.Path(command[1]).is_file():
            errors.append(f"[[{section}]] runs a missing file: {command[1]}")

for error in errors:
    print(f"error: {error}")
sys.exit(1 if errors else 0)
