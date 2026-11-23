"""Ground-truth step 1 (no pyright involved): enumerate symbols and candidate call sites with Python's ast.

Run: python3 -I gt1_enumerate.py
Writes symbols.json, targets.json, candidates.json next to this file.
Targets are chosen by a seeded stratified sample (seed 303) fixed BEFORE pyright is run.
"""
import ast, json, os, random, sys

ROOT = "/private/tmp/claude-501/-Volumes-external-repos-glyph-cli/f49f7d09-3ac6-45aa-b911-af683fb9e242/scratchpad/py/requests/src/requests"
OUT = "/private/tmp/claude-501/-Volumes-external-repos-glyph-cli/f49f7d09-3ac6-45aa-b911-af683fb9e242/scratchpad/py/"
files = sorted(f for f in os.listdir(ROOT) if f.endswith(".py"))
trees = {}
srcs = {}
for f in files:
    text = open(os.path.join(ROOT, f), encoding="utf-8").read()
    srcs[f] = text.split("\n")
    trees[f] = ast.parse(text)

symbols = []  # every def/class


def decorators(node):
    out = []
    for d in node.decorator_list:
        out.append(ast.unparse(d))
    return out


def walk(f, node, stack):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kind = "class" if isinstance(child, ast.ClassDef) else "function"
            container = [s for s in stack]
            parent_kinds = [k for k, _ in container]
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
            qual = ".".join([n for _, n in container] + [child.name])
            symbols.append({
                "file": f, "name": child.name, "qualname": qual, "kind": kind, "category": cat,
                "line": child.lineno, "col": child.col_offset + (len("class ") if kind == "class" else len("async def ") if isinstance(child, ast.AsyncFunctionDef) else len("def ")),
                "decorators": decs,
                "bases": [ast.unparse(b) for b in child.bases] if kind == "class" else [],
            })
            walk(f, child, stack + [("class" if kind == "class" else "function", child.name)])
        else:
            walk(f, child, stack)


for f in files:
    walk(f, trees[f], [])

# candidate call sites: every ast.Call whose callee's last name == target name
calls = []  # all call sites in the package
for f in files:
    class V(ast.NodeVisitor):
        def __init__(self):
            self.stack = []

        def enclosing(self):
            return ".".join(self.stack)

        def visit_ClassDef(self, node):
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef

        def visit_Call(self, node):
            fn = node.func
            if isinstance(fn, ast.Name):
                name, form = fn.id, "name"
                col = fn.col_offset
            elif isinstance(fn, ast.Attribute):
                name, form = fn.attr, "attr"
                # position of the attribute name itself
                col = fn.end_col_offset - len(fn.attr)
            else:
                name, form, col = None, "other", fn.col_offset
            calls.append({"file": f, "line": fn.end_lineno if form == "attr" else fn.lineno, "col": col, "name": name,
                          "form": form, "callee": ast.unparse(fn)[:80], "in": self.enclosing()})
            self.generic_visit(node)

    V().visit(trees[f])

# decorator applications are calls too (R4 in gt_rules.md)
decor_sites = []
for f in files:
    for node in ast.walk(trees[f]):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for d in node.decorator_list:
                target = d.func if isinstance(d, ast.Call) else d
                if isinstance(target, ast.Name):
                    decor_sites.append({"file": f, "line": target.lineno, "col": target.col_offset, "name": target.id, "form": "decorator", "callee": ast.unparse(d)[:80], "in": node.name})
                elif isinstance(target, ast.Attribute):
                    decor_sites.append({"file": f, "line": target.end_lineno, "col": target.end_col_offset - len(target.attr), "name": target.attr, "form": "decorator", "callee": ast.unparse(d)[:80], "in": node.name})

json.dump(symbols, open(OUT + "symbols.json", "w"), indent=1)
json.dump(calls + decor_sites, open(OUT + "allcalls.json", "w"), indent=1)

by_name = {}
for c in calls + decor_sites:
    if c["name"]:
        by_name.setdefault(c["name"], []).append(c)

name_count = {}
for s in symbols:
    name_count[s["name"]] = name_count.get(s["name"], 0) + 1

rng = random.Random(303)
quota = {"function": 10, "method": 12, "staticmethod": 2, "classmethod": 2, "class": 8, "nested": 2}
targets = []
for cat, n in quota.items():
    pool = [s for s in symbols if s["category"] == cat and not s["name"].startswith("__")]
    withc = [s for s in pool if s["name"] in by_name]
    rng.shuffle(withc)
    targets += [dict(s, stratum=cat) for s in withc[:n]]
# overridden: same simple name defined in 2+ symbols, method category
over = [s for s in symbols if s["category"] == "method" and name_count[s["name"]] >= 2 and not s["name"].startswith("__") and s["name"] in by_name]
rng.shuffle(over)
seen = {t["qualname"] + t["file"] for t in targets}
targets += [dict(s, stratum="overridden") for s in over if s["qualname"] + s["file"] not in seen][:6]
# negative controls: defined, never syntactically called by name anywhere
zero = [s for s in symbols if s["category"] in ("function", "method") and s["name"] not in by_name and not s["name"].startswith("__")]
rng.shuffle(zero)
targets += [dict(s, stratum="zero-candidates") for s in zero[:3]]
# super().__init__ chains are covered by the 'super' stratum: two named base __init__ methods
inits = [s for s in symbols if s["name"] == "__init__"]
rng.shuffle(inits)
targets += [dict(s, stratum="init") for s in inits[:3]]

for t in targets:
    t["candidates"] = by_name.get(t["name"], [])
json.dump(targets, open(OUT + "targets.json", "w"), indent=1)

print("files", len(files), "symbols", len(symbols), "calls", len(calls), "decorator sites", len(decor_sites))
cats = {}
for s in symbols:
    cats[s["category"]] = cats.get(s["category"], 0) + 1
print("symbol categories", cats)
print("targets", len(targets))
for t in targets:
    print(f'{t["stratum"]:15} {t["file"]}:{t["line"]} {t["qualname"]:40} candidates={len(t["candidates"])}')
