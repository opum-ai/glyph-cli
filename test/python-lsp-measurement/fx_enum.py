import ast, json, os
import sys
# usage: python3 -I fx_enum.py <fixtures/pkg dir> <fixtures/expected.json> <out-dir>
R = sys.argv[1].rstrip("/")
PFX = os.path.basename(R)
exp = json.load(open(sys.argv[2]))
OUTD = sys.argv[3].rstrip("/") + "/"
os.makedirs(OUTD, exist_ok=True)
syms = []; calls = []
for f in sorted(os.listdir(R)):
    if not f.endswith(".py"): continue
    t = ast.parse(open(f"{R}/{f}").read())
    def walk(n, st):
        for c in ast.iter_child_nodes(n):
            if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                kw = "class " if isinstance(c, ast.ClassDef) else "async def " if isinstance(c, ast.AsyncFunctionDef) else "def "
                syms.append({"file": f"{PFX}/{f}", "name": c.name, "qualname": ".".join(st + [c.name]), "line": c.lineno, "col": c.col_offset + len(kw), "kind": "class" if isinstance(c, ast.ClassDef) else "function", "bases": [ast.unparse(b) for b in c.bases] if isinstance(c, ast.ClassDef) else []})
                walk(c, st + [c.name])
            else: walk(c, st)
    walk(t, [])
    for n in ast.walk(t):
        if isinstance(n, ast.Call):
            fn = n.func
            if isinstance(fn, ast.Name): calls.append({"file": f"{PFX}/{f}", "line": fn.lineno, "col": fn.col_offset, "name": fn.id, "form": "name"})
            elif isinstance(fn, ast.Attribute): calls.append({"file": f"{PFX}/{f}", "line": fn.end_lineno, "col": fn.end_col_offset - len(fn.attr), "name": fn.attr, "form": "attr"})
tg = []
for k in exp:
    if k.startswith("_") or k == "symbols_expected_count": continue
    loc, q = k.split(" ", 1); f, l = loc.rsplit(":", 1)
    m = [s for s in syms if s["file"] == f and s["line"] == int(l) and s["qualname"] == q]
    assert len(m) == 1, k
    tg.append(m[0])
json.dump(tg, open(OUTD + "fx_targets.json", "w"), indent=1); json.dump(syms, open(OUTD + "fx_symbols.json", "w"), indent=1); json.dump(calls, open(OUTD + "fx_allcalls.json", "w"), indent=1)
print(len(syms), len(tg), len(calls))
