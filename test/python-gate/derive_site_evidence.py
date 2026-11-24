"""Mechanical receiver-evidence flag for the NON-true candidate sites of a classified batch (GCLI-69, DEC-303 (a3) Q3).

Run: python3 -I derive_site_evidence.py <targets.json> <classified.json> <out.json> [<package-dir>]
Q3 makes the pyright-comparable precision side exclude edges at `inferred` sites, which needs the flag on sites that are not true
sites too (Addendum 2 rule 3; Addendum 4). Rule, applied mechanically so no label is a judgment made after any analyzer output:
a name-form or decorator site is `direct`; an attribute-form site is `direct` when its receiver is `self`, `cls`, `super()`,
a module name from {io, os, sys} or ends in a capitalised name (a class used as the receiver); and, when <package-dir> is given
(Addendum 6, after the blind pass on the requests sample), also when it is
  - a module imported in the file (`import x`, or `from . import x` for a sibling module), or an attribute chain off one (os.environ, copy, sys.stdout);
  - a plain name that is an annotated parameter of the enclosing function;
  - a plain name bound exactly once in the enclosing function to a constructor call (`p = PreparedRequest()`);
  - `self.x` where x is annotated in the enclosing class (class-level or `self.x: T`);
  - `p.x` where p is an annotated parameter whose annotation names an in-package class (Optional / `| None` / string forward
    reference unwrapped) that annotates x.
R1 treats an annotated receiver as decidable, so the pyright-comparable side must too. Any other receiver is `inferred`.
True sites keep the hand-recorded `receiver_evidence` in classified-batch0.json and are not touched here.
"""
import ast
import json
import os
import sys

targets = json.load(open(sys.argv[1]))
classified = json.load(open(sys.argv[2]))["targets"]
root = sys.argv[4].rstrip("/") if len(sys.argv) > 4 else None
_trees = {}
_classes = {}  # simple class name -> set of annotated attribute names (class level AnnAssign and self.x: T in any method)


def tree_of(path):
    if path not in _trees:
        _trees[path] = ast.parse(open(os.path.join(root, path), encoding="utf-8").read())
    return _trees[path]


def class_annotations():
    if _classes or root is None:
        return _classes
    for f in sorted(os.listdir(root)):
        if not f.endswith(".py"):
            continue
        for n in ast.walk(tree_of(f)):
            if isinstance(n, ast.ClassDef):
                names = _classes.setdefault(n.name, set())
                for m in ast.walk(n):
                    if isinstance(m, ast.AnnAssign):
                        t = m.target
                        if isinstance(t, ast.Name):
                            names.add(t.id)
                        elif isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == "self":
                            names.add(t.attr)
    return _classes


def enclosing(path, line):
    """(innermost function, innermost class) containing `line`."""
    fn = cl = None
    for n in ast.walk(tree_of(path)):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.lineno <= line <= n.end_lineno:
            if fn is None or n.lineno >= fn.lineno:
                fn = n
        if isinstance(n, ast.ClassDef) and n.lineno <= line <= n.end_lineno:
            if cl is None or n.lineno >= cl.lineno:
                cl = n
    return fn, cl


def annotation_class(a):
    """The simple class name an annotation names, unwrapping `X | None`, Optional[X] and a string forward reference."""
    if isinstance(a, ast.Constant) and isinstance(a.value, str):
        try:
            a = ast.parse(a.value, mode="eval").body
        except SyntaxError:
            return None
    if isinstance(a, ast.Name):
        return a.id
    if isinstance(a, ast.Attribute):
        return a.attr
    if isinstance(a, ast.BinOp) and isinstance(a.op, ast.BitOr):
        for side in (a.left, a.right):
            if not (isinstance(side, ast.Constant) and side.value is None):
                return annotation_class(side)
    if isinstance(a, ast.Subscript) and isinstance(a.value, (ast.Name, ast.Attribute)) and getattr(a.value, "id", getattr(a.value, "attr", "")) in ("Optional",):
        return annotation_class(a.slice)
    return None


def modules_imported(path):
    mods = set()
    for n in ast.walk(tree_of(path)):
        if isinstance(n, ast.Import):
            for a in n.names:
                mods.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, ast.ImportFrom) and n.level > 0 and n.module is None:  # `from . import sessions`: a sibling module
            for a in n.names:
                mods.add(a.asname or a.name)
    return mods


def receiver_direct(c):
    """Extended mechanical rule (needs the package directory): see the module docstring."""
    recv = c["callee"].rsplit(".", 1)[0]
    parts = recv.split(".")
    if recv in ("self", "cls", "super()", "io", "os", "sys") or parts[-1][:1].isupper():
        return True
    if root is None:
        return False
    fn, cl = enclosing(c["file"], c["line"])
    if parts[0] in modules_imported(c["file"]) and all(p.isidentifier() for p in parts):
        return True  # a module, or an attribute chain off an imported module (os.environ, copy)
    ann = {}
    if fn is not None:
        a = fn.args
        ann = {p.arg: p.annotation for p in a.posonlyargs + a.args + a.kwonlyargs if p.annotation}
    if len(parts) == 1 and parts[0] in ann:
        return True
    if len(parts) == 1 and fn is not None:  # bound exactly once in the function, to a constructor call
        binds = [n for n in ast.walk(fn) if isinstance(n, (ast.Assign, ast.AnnAssign, ast.For, ast.With, ast.NamedExpr))
                 and any(isinstance(x, ast.Name) and x.id == parts[0] and isinstance(x.ctx, ast.Store) for x in ast.walk(n))]
        if len(binds) == 1 and isinstance(binds[0], ast.Assign) and isinstance(binds[0].value, ast.Call):
            f = binds[0].value.func
            last = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""
            if last[:1].isupper():
                return True
    if len(parts) == 2 and parts[0] == "self" and cl is not None:
        return parts[1] in class_annotations().get(cl.name, set())
    if len(parts) == 2 and parts[0] in ann:
        cname = annotation_class(ann[parts[0]])
        return cname is not None and parts[1] in class_annotations().get(cname, set())
    return False


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
            ev = "direct" if receiver_direct(c) else "inferred"
        out[f"{key} | {site}"] = ev
json.dump(out, open(sys.argv[3], "w"), indent=1)
from collections import Counter
print(len(out), dict(Counter(out.values())))
