"""Mechanical receiver-evidence flag for the NON-true candidate sites of a classified batch (GCLI-69, DEC-303 (a3) Q3).

Run: python3 -I derive_site_evidence.py <targets.json> <classified.json> <out.json> [<package-dir>]
Q3 makes the pyright-comparable precision side exclude edges at `inferred` sites, which needs the flag on sites that are not true
sites too (Addendum 2 rule 3; Addendum 4). Rule, applied mechanically so no label is a judgment made after any analyzer output:
a name-form or decorator site is `direct`; an attribute-form site is `direct` when its receiver is `self`, `cls`, `super()`, a
module name from {io, os, sys}, ends in a capitalised name (a class used as the receiver), or (when <package-dir> is given) is a plain
name that is an ANNOTATED PARAMETER of the enclosing function (R1 as written treats an annotated receiver as decidable, so the
pyright-comparable side must too); any other receiver is `inferred`. On a package with no annotations the last clause never fires, so
the click output is identical with or without <package-dir>.
True sites keep the hand-recorded `receiver_evidence` in classified-batch0.json and are not touched here.
"""
import ast
import json
import os
import sys

targets = json.load(open(sys.argv[1]))
classified = json.load(open(sys.argv[2]))["targets"]
root = sys.argv[4].rstrip("/") if len(sys.argv) > 4 else None
_funcs = {}


def annotated_params(path, line):
    """Names of annotated parameters of the innermost function containing `line` in `path` (empty without a package dir)."""
    if root is None:
        return set()
    if path not in _funcs:
        tree = ast.parse(open(os.path.join(root, path), encoding="utf-8").read())
        _funcs[path] = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    best = None
    for n in _funcs[path]:
        if n.lineno <= line <= n.end_lineno and (best is None or n.lineno >= best.lineno):
            best = n
    if best is None:
        return set()
    a = best.args
    return {p.arg for p in a.posonlyargs + a.args + a.kwonlyargs if p.annotation}


out = {}
for t in targets:
    key = f"{t['file']}:{t['line']} {t['qualname']}"
    if key not in classified:
        continue
    true_sites = {s["site"] for s in classified[key]["true"]}
    for c in t["candidates"]:
        site = f"{c['file']}:{c['line']}:{c['col']}"
        if site in true_sites:
            continue
        if c["form"] in ("name", "decorator", "other"):
            ev = "direct"
        else:
            recv = c["callee"].rsplit(".", 1)[0]
            last = recv.split(".")[-1]
            ev = "direct" if recv in ("self", "cls", "super()", "io", "os", "sys") or last[:1].isupper() else "inferred"
            if ev == "inferred" and recv.isidentifier() and recv in annotated_params(c["file"], c["line"]):
                ev = "direct"
        out[f"{key} | {site}"] = ev
json.dump(out, open(sys.argv[3], "w"), indent=1)
from collections import Counter
print(len(out), dict(Counter(out.values())))
