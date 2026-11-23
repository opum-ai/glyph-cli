"""Mechanical checks behind Addendum 6 (GCLI-74 / S0b, after the blind pass on the requests sample).

Run: python3 -I requests_convention_checks.py <package-dir> <targets.json> <classified-requests-independent.json>
Prints, from `ast` only: (1) overload groups among the 46 targets and which true sites sit on a stub-keyed target; (2) true sites whose
target definition is an abstract base (body only a docstring, `pass`, `...` or `raise NotImplementedError`); (3) true sites that sit
under a conditional or `try` block, with the condition text; (4) in-repository subclasses (ANY base, not the first only) of every
class that owns a method or is itself a target; (5) that both `os.environ.get` calls of utils.py:820 are candidates of LookupDict.get.
"""
import ast
import json
import os
import sys

root = sys.argv[1].rstrip("/")
targets = json.load(open(sys.argv[2]))
classified = json.load(open(sys.argv[3]))["targets"]
trees = {f: ast.parse(open(os.path.join(root, f), encoding="utf-8").read()) for f in sorted(os.listdir(root)) if f.endswith(".py")}
true_sites = {}
for k, v in classified.items():
    for s in v["true"]:
        true_sites.setdefault(k, []).append(s)


def defs_in(tree):
    out = []

    def walk(node, stack):
        for ch in ast.iter_child_nodes(node):
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                out.append((".".join(stack + [ch.name]), ch))
                walk(ch, stack + [ch.name])
            else:
                walk(ch, stack)

    walk(tree, [])
    return out


def is_overload(n):
    return any((isinstance(d, ast.Name) and d.id == "overload") or (isinstance(d, ast.Attribute) and d.attr == "overload") for d in n.decorator_list)


def is_abstract(n):
    body = [b for b in n.body if not (isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and isinstance(b.value.value, str))]
    if not body:
        return True
    if len(body) != 1:
        return False
    b = body[0]
    if isinstance(b, ast.Pass):
        return True
    if isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and b.value.value is Ellipsis:
        return True
    if isinstance(b, ast.Raise):
        e = b.exc.func if isinstance(b.exc, ast.Call) else b.exc
        return isinstance(e, ast.Name) and e.id == "NotImplementedError"
    return False


alldefs = {f: defs_in(t) for f, t in trees.items()}
print("== (1) overload groups among the targets")
n_on_stub = 0
for t in targets:
    key = f"{t['file']}:{t['line']} {t['qualname']}"
    group = [(q, n) for q, n in alldefs[t["file"]] if q == t["qualname"] and not isinstance(n, ast.ClassDef)]
    if len(group) > 1 and any(is_overload(n) for _, n in group):
        impl = [n for _, n in group if not is_overload(n)]
        me = [n for _, n in group if n.lineno == t["line"]][0]
        ns = len(true_sites.get(key, []))
        print(f"{key}: {len(group)} defs at lines {[n.lineno for _, n in group]}; implementation line {impl[0].lineno if impl else None}; "
              f"this target is {'a STUB' if is_overload(me) else 'the implementation'}; true sites keyed to it: {ns}")
        if is_overload(me):
            n_on_stub += ns
print(f"true sites keyed to an @overload STUB target: {n_on_stub} of {sum(len(v) for v in true_sites.values())}")

print("\n== (2) true sites whose target is an abstract base (docstring/pass/.../raise NotImplementedError only)")
n_abs = 0
for t in targets:
    key = f"{t['file']}:{t['line']} {t['qualname']}"
    node = [n for q, n in alldefs[t["file"]] if q == t["qualname"] and n.lineno == t["line"]][0]
    if not isinstance(node, ast.ClassDef) and is_abstract(node) and key in true_sites:
        print(f"{key}: {len(true_sites[key])} true site(s)")
        n_abs += len(true_sites[key])
print(f"true sites on abstract-base targets: {n_abs} of {sum(len(v) for v in true_sites.values())}")

print("\n== (3) true sites under an if/try block (condition text)")
n_cond = 0
for t in targets:
    key = f"{t['file']}:{t['line']} {t['qualname']}"
    for s in true_sites.get(key, []):
        f, line, _ = s["site"].split(":")
        line = int(line)
        conds = []
        for n in ast.walk(trees[f]):
            if isinstance(n, ast.If) and n.body[0].lineno <= line <= max(x.end_lineno for x in n.body + n.orelse):
                conds.append("if " + ast.unparse(n.test)[:60])
            if isinstance(n, ast.Try) and n.body[0].lineno <= line <= n.body[-1].end_lineno:
                conds.append("try/except")
        if conds:
            n_cond += 1
            print(f"{key} | {s['site']} | {conds}")
print(f"true sites under a conditional or try: {n_cond}")

print("\n== (4) in-repository subclasses, ANY base (not only the first), of every class that owns a target or a target method")
classes = {}
for f, ds in alldefs.items():
    for q, n in ds:
        if isinstance(n, ast.ClassDef):
            classes[(f, q)] = n
owners = set()
for t in targets:
    if t["kind"] == "class":
        owners.add(t["qualname"].split(".")[-1])
    elif "." in t["qualname"]:
        owners.add(t["qualname"].rsplit(".", 1)[0].split(".")[-1])
for name in sorted(owners):
    subs = []
    for (f, q), n in classes.items():
        if any((isinstance(b, ast.Name) and b.id == name) or (isinstance(b, ast.Attribute) and b.attr == name) for b in n.bases):
            subs.append(f"{f}:{q}")
    print(f"{name}: {subs or 'none'}")

print("\n== (5) utils.py:820 candidates of LookupDict.get")
for t in targets:
    if t["qualname"] == "LookupDict.get":
        print([(c["line"], c["col"]) for c in t["candidates"] if c["file"] == "utils.py" and c["line"] == 820])
