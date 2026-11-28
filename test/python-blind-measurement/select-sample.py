#!/usr/bin/env python3
"""Selection measurement for the fresh blind sample (DEC-303 (a36) item 2).

Reads ONE candidate repository's text and prints the selection criteria, with no
analyzer involved: no glyph run, no index, no resolution. This is the only
permitted use of a sample checkout before the draw ((a36) item 7); it clones
nothing itself.

    python3 -I select-sample.py <repo-root> <package-dir> [--json]

The criteria are (a36) item 2 and item 3:

- package lines, 15k to 60k: non-blank, non-comment-source lines in the package;
- class-heavy: the class share of non-dunder def and class declarations;
- annotation density: the share of non-dunder defs declaring at least one
  annotated parameter or a return annotation;
- in-package star imports: `from .x import *` or `from <package>.x import *`;
- census reach: the call-form sites an eligible target contributes under the
  same eligibility census.py applies (non-dunder name; at least one call form;
  at most 14 occurrences of any form), which bounds the labels a draw can reach.
  A repository whose whole census cannot reach 62 true sites must be ruled out
  before the draw ((a36) item 3), and this is the measurement that does it.

Exit 0 on success, 2 on usage.
"""
import json
import os
import re
import sys

EXCLUDED_DIR_PARTS = ("/tests", "__pycache__", "/.tox", "/venv", "/.venv")
DEF_RE = re.compile(r"^(\s*)(async\s+def|def|class)\s+(\w+)")
STAR_RE = re.compile(r"^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+\*")
COMMENT_RE = re.compile(r"^\s*#")


def python_files(root, pkg):
    """Every .py file under <root>/<pkg>, tests and caches excluded, sorted."""
    files = []
    for dirpath, _, filenames in os.walk(os.path.join(root, pkg)):
        if any(part in dirpath for part in EXCLUDED_DIR_PARTS):
            continue
        for name in filenames:
            if name.endswith(".py"):
                files.append(os.path.relpath(os.path.join(dirpath, name), root))
    return sorted(files)


def defined_nodes(lines_by_file, files):
    """(file, line, column, kind, name, qual) for every def and class."""
    nodes = []
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
            nodes.append((path, number, match.start(3) + 1, kind, name, qual))
            stack.append((indent, name, kind))
    return nodes


def signature_lines(lines, start_index):
    """The def's signature: its line and continuation lines until brackets close."""
    depth = 0
    opened = False
    collected = []
    for line in lines[start_index:]:
        collected.append(line)
        for char in line.split("#")[0]:
            if char in "([{":
                depth += 1
                opened = True
            elif char in ")]}":
                depth -= 1
        if (opened and depth <= 0) or (not opened and line.rstrip().endswith(":")):
            return collected
        if len(collected) > 40:
            return collected
    return collected


def has_annotation(signature):
    """True when any parameter or the return is annotated.

    Parameters are split at top-level commas; an annotation is a ':' inside a
    parameter before any '='. The return annotation is the text after the
    signature's closing bracket, before the final ':'.
    """
    joined = " ".join(part.split("#")[0].rstrip() for part in signature)
    open_at = joined.find("(")
    if open_at < 0:
        return False
    depth = 0
    close_at = -1
    for index in range(open_at, len(joined)):
        char = joined[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                close_at = index
                break
    if close_at < 0:
        return False
    params = joined[open_at + 1 : close_at]
    after = joined[close_at + 1 :]
    if re.search(r"->", after):
        return True
    depth = 0
    current = []
    parts = []
    for char in params:
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        if char == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    for part in parts:
        before_default = part.split("=")[0]
        if ":" in before_default:
            return True
    return False


def is_in_package(module, pkg):
    if module.startswith("."):
        return True
    return module == pkg or module.startswith(pkg + ".")


def main():
    args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    as_json = "--json" in sys.argv[1:]
    if len(args) != 2:
        sys.stderr.write("usage: select-sample.py <repo-root> <package-dir> [--json]\n")
        return 2
    root, pkg = args
    files = python_files(root, pkg)
    if not files:
        sys.stderr.write(f"no .py files under {root}/{pkg}\n")
        return 2
    lines_by_file = {}
    for path in files:
        with open(os.path.join(root, path), encoding="utf8") as handle:
            lines_by_file[path] = handle.read().split("\n")

    source_lines = 0
    for path in files:
        for line in lines_by_file[path]:
            if line.strip() and not COMMENT_RE.match(line):
                source_lines += 1

    nodes = defined_nodes(lines_by_file, files)
    named = [node for node in nodes if not (node[4].startswith("__") and node[4].endswith("__"))]
    classes = [node for node in named if node[3] == "class"]
    functions = [node for node in named if node[3] == "def"]
    annotated = 0
    for node in functions:
        path, number = node[0], node[1]
        signature = signature_lines(lines_by_file[path], number - 1)
        if has_annotation(signature):
            annotated += 1

    star_imports = []
    for path in files:
        for number, line in enumerate(lines_by_file[path], 1):
            match = STAR_RE.match(line)
            if match and is_in_package(match.group(1), pkg):
                star_imports.append(f"{path}:{number}")

    call_sites = 0
    eligible_targets = 0
    for node in named:
        path_of_node, line_of_node, name = node[0], node[1], node[4]
        call_re = re.compile(r"(?<![\w])" + re.escape(name) + r"\s*\(")
        ref_re = re.compile(r"(?<![\w])" + re.escape(name) + r"(?![\w(])")
        occurrences = 0
        calls = 0
        for path in files:
            for number, line in enumerate(lines_by_file[path], 1):
                if path == path_of_node and number == line_of_node:
                    continue
                source = line.split("#")[0]
                if call_re.search(source):
                    occurrences += 1
                    calls += 1
                elif ref_re.search(source) and (
                    not source.strip().startswith(("import ", "from ")) or " as " in source
                ):
                    occurrences += 1
        if calls >= 1 and occurrences <= 14:
            eligible_targets += 1
            call_sites += calls

    result = {
        "repository": os.path.basename(os.path.abspath(root)),
        "package": pkg,
        "python_files": len(files),
        "package_lines": source_lines,
        "defs": len(functions),
        "classes": len(classes),
        "class_share": round(len(classes) / (len(classes) + len(functions)), 4)
        if functions or classes
        else 0.0,
        "annotated_defs": annotated,
        "annotation_density": round(annotated / len(functions), 4) if functions else 0.0,
        "in_package_star_imports": len(star_imports),
        "star_import_sites": star_imports,
        "eligible_targets": eligible_targets,
        "candidate_call_sites": call_sites,
    }
    if as_json:
        print(json.dumps(result, indent=1, sort_keys=True))
    else:
        for key in (
            "repository",
            "package",
            "python_files",
            "package_lines",
            "defs",
            "classes",
            "class_share",
            "annotated_defs",
            "annotation_density",
            "in_package_star_imports",
            "eligible_targets",
            "candidate_call_sites",
        ):
            print(f"{key}\t{result[key]}")
        for site in star_imports:
            print(f"star\t{site}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
