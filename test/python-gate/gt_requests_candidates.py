"""Requests candidate list for the independent denominator (GCLI-74 / S0b, DEC-303 (a2) ruling 2). Derived from gt_click_enumerate.py (GCLI-69): the
same alias-aware and subclass-construction candidate-finding, but the targets are the 46 PRE-REGISTERED requests targets, not a new draw.
Original docstring follows.

Held-out ground truth, step 1 (GCLI-69, ADR 0008, DEC-303 (a2) item 8): enumerate symbols and candidate call sites for a
flat Python package with the standard library's `ast` and draw the seeded, stratified target sample. No analyzer, no classification.

Run: python3 -I gt_requests_candidates.py <package-dir> <out-dir> <pre-registered targets.json>
Writes symbols.json, allcalls.json, targets.json and candidates.txt into <out-dir>.

Derived from test/python-lsp-measurement/gt1_enumerate.py, with the three changes the ADR names for the held-out set:
  1. alias-aware candidate-finding: a call through `from m import a as b` or `import m as n` is a candidate of `a` (gt_rules_addendum.md
     item 1 recorded that the requests sampler was blind to them);
  2. subclass constructions: constructing a subclass that inherits `__init__` is a candidate of the base `__init__` (item 8);
  3. targets are drawn in numbered BATCHES from one seeded shuffle per stratum (the pre-registered fork: classification proceeds
     batch by batch and stops at the first batch boundary at which at least 62 true sites are reached; no other stopping rule).

Seed 303, the same as the requests set. Quotas per batch are those of gt1_enumerate.py: function 10, method 12, staticmethod 2,
classmethod 2, class 8, nested 2, overridden 6, zero-candidates 3, init 3 (46 targets per batch). Batch b takes pool[b*n:(b+1)*n].
"""
import ast
import json
import os
import random
import sys

ROOT = sys.argv[1].rstrip("/")
OUT = sys.argv[2].rstrip("/") + "/"
os.makedirs(OUT, exist_ok=True)
BATCHES = 3
files = sorted(f for f in os.listdir(ROOT) if f.endswith(".py"))
trees, srcs = {}, {}
for f in files:
    text = open(os.path.join(ROOT, f), encoding="utf-8").read()
    srcs[f] = text.split("\n")
    trees[f] = ast.parse(text)

symbols = []


def decorators(node):
    return [ast.unparse(d) for d in node.decorator_list]


def walk(f, node, stack):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kind = "class" if isinstance(child, ast.ClassDef) else "function"
            parent_kinds = [k for k, _ in stack]
            decs = decorators(child)
            if kind == "function":
                if parent_kinds and parent_kinds[-1] == "class":
                    if any(d == "staticmethod" for d in decs):
                        cat = "staticmethod"
                    elif any(d == "classmethod" for d in decs):
                        cat = "classmethod"
                    elif any(d == "property" or d.endswith(".setter") for d in decs):
                        cat = "property"
                    else:
                        cat = "method"
                elif parent_kinds and parent_kinds[-1] == "function":
                    cat = "nested"
                else:
                    cat = "function"
            else:
                cat = "class"
            qual = ".".join([n for _, n in stack] + [child.name])
            symbols.append({
                "file": f, "name": child.name, "qualname": qual, "kind": kind, "category": cat,
                "line": child.lineno, "decorators": decs,
                "bases": [ast.unparse(b) for b in child.bases] if kind == "class" else [],
            })
            walk(f, child, stack + [("class" if kind == "class" else "function", child.name)])
        else:
            walk(f, child, stack)


for f in files:
    walk(f, trees[f], [])

# aliases: asname -> original last-component name, over every import in the package
aliases = {}  # original name -> set of alias names
for f in files:
    for node in ast.walk(trees[f]):
        if isinstance(node, ast.ImportFrom):
            for a in node.names:
                if a.asname and a.asname != a.name:
                    aliases.setdefault(a.name, set()).add(a.asname)
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.asname and a.asname != a.name.split(".")[-1]:
                    aliases.setdefault(a.name.split(".")[-1], set()).add(a.asname)

calls = []
for f in files:
    class V(ast.NodeVisitor):
        def __init__(self):
            self.stack = []

        def visit_ClassDef(self, node):
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef

        def visit_Call(self, node):
            fn = node.func
            if isinstance(fn, ast.Name):
                name, form, col, line = fn.id, "name", fn.col_offset, fn.lineno
            elif isinstance(fn, ast.Attribute):
                name, form = fn.attr, "attr"
                col, line = fn.end_col_offset - len(fn.attr), fn.end_lineno
            else:
                name, form, col, line = None, "other", fn.col_offset, fn.lineno
            calls.append({"file": f, "line": line, "col": col, "name": name, "form": form,
                          "call_start_line": node.lineno, "callee": ast.unparse(fn)[:80], "in": ".".join(self.stack)})
            self.generic_visit(node)

    V().visit(trees[f])

decor_sites = []
for f in files:
    for node in ast.walk(trees[f]):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for d in node.decorator_list:
                t = d.func if isinstance(d, ast.Call) else d
                if isinstance(t, ast.Name):
                    decor_sites.append({"file": f, "line": t.lineno, "col": t.col_offset, "name": t.id, "form": "decorator",
                                        "call_start_line": t.lineno, "callee": ast.unparse(d)[:80], "in": node.name})
                elif isinstance(t, ast.Attribute):
                    decor_sites.append({"file": f, "line": t.end_lineno, "col": t.end_col_offset - len(t.attr), "name": t.attr,
                                        "form": "decorator", "call_start_line": t.lineno, "callee": ast.unparse(d)[:80], "in": node.name})

allsites = calls + decor_sites
by_name = {}
for c in allsites:
    if c["name"]:
        by_name.setdefault(c["name"], []).append(c)

classes = [s for s in symbols if s["kind"] == "class"]
has_init = {(s["file"], s["qualname"].rsplit(".", 1)[0]) for s in symbols if s["name"] == "__init__" and "." in s["qualname"]}
by_cls_name = {}
for c in classes:
    by_cls_name.setdefault(c["name"], []).append(c)


def subclasses_inheriting_init(base_name, seen=None):
    """In-package classes (by simple name) that derive from base_name, directly or not, and define no __init__ of their own."""
    seen = seen if seen is not None else set()
    out = []
    for c in classes:
        if c["qualname"] in seen:
            continue
        if any(b.split(".")[-1] == base_name for b in c["bases"]):
            seen.add(c["qualname"])
            if (c["file"], c["qualname"]) not in has_init:
                out.append(c["name"])
                out += subclasses_inheriting_init(c["name"], seen)
    return out


def names_for(symbol):
    """Every callee name whose call sites are candidates of this symbol."""
    n = symbol["name"]
    if n == "__init__" and "." in symbol["qualname"]:
        cls = symbol["qualname"].rsplit(".", 1)[0].split(".")[-1]
        names = {"__init__", cls} | aliases.get(cls, set())
        for sub in subclasses_inheriting_init(cls):  # constructing a subclass that inherits __init__ runs it
            names |= {sub} | aliases.get(sub, set())
        return names
    return {n} | aliases.get(n, set())


def candidates_of(symbol):
    out, seen = [], set()
    for nm in sorted(names_for(symbol)):
        for c in by_name.get(nm, []):
            k = (c["file"], c["line"], c["col"])
            if k not in seen:
                seen.add(k)
                out.append(dict(c, via=nm))
    return sorted(out, key=lambda c: (c["file"], c["line"], c["col"]))


name_count = {}
for s in symbols:
    name_count[s["name"]] = name_count.get(s["name"], 0) + 1

PRE = json.load(open(sys.argv[3]))  # the 46 pre-registered targets (test/python-lsp-measurement/derived/targets.json): no new sampling
cand_cache = {(s["file"], s["qualname"], s["line"]): candidates_of(s) for s in symbols}
bykey = {(s["file"], s["qualname"], s["line"]): s for s in symbols}
targets = []
for p in PRE:
    k = (p["file"], p["qualname"], p["line"])
    targets.append(dict(bykey[k], stratum=p["stratum"], batch=0))

for t in targets:
    t["candidates"] = cand_cache[(t["file"], t["qualname"], t["line"])]
    t["candidate_names"] = sorted(names_for(t))

json.dump(symbols, open(OUT + "symbols.json", "w"), indent=1)
json.dump(allsites, open(OUT + "allcalls.json", "w"), indent=1)
json.dump(targets, open(OUT + "targets.json", "w"), indent=1)

with open(OUT + "candidates.txt", "w") as out:
    out.write(f"# candidate call sites per target, NOT classified. package {ROOT}; {len(files)} files, {len(symbols)} symbols, "
              f"{len(calls)} calls, {len(decor_sites)} decorator sites, {sum(len(v) for v in aliases.values())} import aliases\n")
    for t in targets:
        out.write(f"\n## batch {t['batch']} [{t['stratum']}] {t['file']}:{t['line']} {t['qualname']} ({t['kind']}, {t['category']}) "
                  f"names={','.join(t['candidate_names'])} candidates={len(t['candidates'])}\n")
        if t["kind"] == "class" or t["name"] == "__init__":
            out.write(f"   bases: {', '.join(t['bases']) or '-'}\n")
        for c in t["candidates"]:
            line = srcs[c["file"]][c["line"] - 1].strip()[:140]
            out.write(f"{c['file']}:{c['line']}:{c['col']} [{c['form']}] via {c['via']} in {c['in'] or '<module>'} :: {line}\n")

per = {}
for t in targets:
    per.setdefault(t["batch"], []).append(len(t["candidates"]))
print("files", len(files), "symbols", len(symbols), "calls", len(calls), "decorator sites", len(decor_sites), "aliases", sum(len(v) for v in aliases.values()))
for b, v in sorted(per.items()):
    print(f"batch {b}: {len(v)} targets, {sum(v)} candidate sites (zero-candidate targets {sum(1 for x in v if x == 0)})")
