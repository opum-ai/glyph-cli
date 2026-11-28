#!/usr/bin/env python3
"""Site-ordered census for the fresh blind sample (DEC-303 (a36) item 3, (a100)).

This is the ONE change (a36) item 3 allows to the development census: the draw
unit is the CALL SITE, not the def or target, and the order key names the site —
sha256(seed + file + ":" + line + ":" + column) — not the qualname.

It enumerates from the checkout text by regular expression, independently of
glyph: no analyzer, no LSP, no glyph resolution. Eligibility is the development
census's, unchanged: a non-dunder def or class with at least one call form and at
most 14 occurrences of any form; tests and caches are excluded.

    python3 -I census.py <repo-root> <package-dir> <seed>

Writes <repo>-sites.json: the candidate call sites in draw order, each with the
targets whose name it matches and whose declaration site the labeller resolves it
to. Labels index this list from 1; the stopping rule is the 62nd true site
((a36) item 3, (a100)).
"""
import hashlib
import json
import os
import re
import sys

EXCLUDED_DIR_PARTS = ("/tests", "__pycache__", "/.tox", "/venv", "/.venv")
DEF_RE = re.compile(r"^(\s*)(async\s+def|def|class)\s+(\w+)")
MAX_OCCURRENCES = 14


def python_files(root, pkg):
    files = []
    for dirpath, _, filenames in os.walk(os.path.join(root, pkg)):
        if any(part in dirpath for part in EXCLUDED_DIR_PARTS):
            continue
        for name in filenames:
            if name.endswith(".py"):
                files.append(os.path.relpath(os.path.join(dirpath, name), root))
    return sorted(files)


def defined_targets(lines_by_file, files):
    targets = []
    for path in files:
        stack = []
        for number, line in enumerate(lines_by_file[path], 1):
            match = DEF_RE.match(line)
            if not match:
                continue
            indent = len(match.group(1))
            kind = "class" if match.group(2) == "class" else "def"
            name = match.group(3)
            while stack and stack[-1][0] >= indent:
                stack.pop()
            qual = ".".join([entry[1] for entry in stack] + [name])
            enclosure = stack[-1][1] if stack and stack[-1][2] == "class" else None
            targets.append(
                {
                    "file": path,
                    "line": number,
                    "column": match.start(3) + 1,
                    "kind": kind,
                    "name": name,
                    "qual": qual,
                    "enclosure": enclosure,
                }
            )
            stack.append((indent, name, kind))
    return targets


def occurrences(lines_by_file, files, target):
    """(file, line, column, form, src) for one target's name, def line excluded."""
    name = target["name"]
    call_re = re.compile(r"(?<![\w])" + re.escape(name) + r"\s*\(")
    ref_re = re.compile(r"(?<![\w])" + re.escape(name) + r"(?![\w(])")
    found = []
    for path in files:
        for number, line in enumerate(lines_by_file[path], 1):
            if path == target["file"] and number == target["line"]:
                continue
            source = line.split("#")[0]
            call = call_re.search(source)
            if call:
                found.append((path, number, call.start() + 1, "call", line.strip()))
            elif ref_re.search(source) and (
                not source.strip().startswith(("import ", "from ")) or " as " in source
            ):
                found.append((path, number, ref_re.search(source).start() + 1, "ref", line.strip()))
    return found


def main():
    if len(sys.argv) != 4:
        sys.stderr.write("usage: census.py <repo-root> <package-dir> <seed>\n")
        return 2
    root, pkg, seed = sys.argv[1], sys.argv[2], sys.argv[3]
    files = python_files(root, pkg)
    if not files:
        sys.stderr.write(f"no .py files under {root}/{pkg}\n")
        return 2
    lines_by_file = {}
    for path in files:
        with open(os.path.join(root, path), encoding="utf8") as handle:
            lines_by_file[path] = handle.read().split("\n")

    defined = [
        target
        for target in defined_targets(lines_by_file, files)
        if not (target["name"].startswith("__") and target["name"].endswith("__"))
    ]

    sites = {}
    eligible = 0
    for target in defined:
        found = occurrences(lines_by_file, files, target)
        calls = [entry for entry in found if entry[3] == "call"]
        if not calls or len(found) > MAX_OCCURRENCES:
            continue
        eligible += 1
        for path, number, column, _unused, src in calls:
            key = f"{path}:{number}:{column}"
            entry = sites.setdefault(
                key, {"file": path, "line": number, "column": column, "src": src, "targets": []}
            )
            entry["targets"].append(
                {
                    "file": target["file"],
                    "line": target["line"],
                    "column": target["column"],
                    "kind": target["kind"],
                    "qual": target["qual"],
                }
            )

    ordered = sorted(
        sites.values(),
        key=lambda site: hashlib.sha256(
            (seed + site["file"] + ":" + str(site["line"]) + ":" + str(site["column"])).encode()
        ).hexdigest(),
    )
    for index, site in enumerate(ordered, 1):
        site["drawIndex"] = index

    repository = os.path.basename(os.path.abspath(root))
    payload = {
        "repository": repository,
        "package": pkg,
        "seed": seed,
        "orderKey": "sha256(seed + file + ':' + line + ':' + column)",
        "drawUnit": "call site",
        "stoppingRule": "62 true sites",
        "siteCount": len(ordered),
        "sites": ordered,
    }
    out = f"{repository}-sites.json"
    with open(out, "w", encoding="utf8") as handle:
        json.dump(payload, handle, indent=1)
    multi = sum(1 for site in ordered if len(site["targets"]) > 1)
    print(
        f"{repository}: {len(ordered)} candidate call sites from {eligible} eligible targets "
        f"({multi} site(s) matching more than one target) -> {out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
