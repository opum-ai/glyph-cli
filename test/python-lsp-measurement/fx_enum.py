import ast, json, os
R = "/private/tmp/claude-501/-Volumes-external-repos-glyph-cli/f49f7d09-3ac6-45aa-b911-af683fb9e242/scratchpad/py/fx/pkg"
exp = json.load(open("/private/tmp/claude-501/-Volumes-external-repos-glyph-cli/f49f7d09-3ac6-45aa-b911-af683fb9e242/scratchpad/py/fx/expected.json"))
syms = []; calls = []
for f in sorted(os.listdir(R)):
    if not f.endswith(".py"): continue
    t = ast.parse(open(f"{R}/{f}").read())
    def walk(n, st):
        for c in ast.iter_child_nodes(n):
            if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                kw = "class " if isinstance(c, ast.ClassDef) else "async def " if isinstance(c, ast.AsyncFunctionDef) else "def "
                syms.append({"file": f"pkg/{f}", "name": c.name, "qualname": ".".join(st + [c.name]), "line": c.lineno, "col": c.col_offset + len(kw)})
                walk(c, st + [c.name])
            else: walk(c, st)
    walk(t, [])
    for n in ast.walk(t):
        if isinstance(n, ast.Call):
            fn = n.func
            if isinstance(fn, ast.Name): calls.append({"file": f"pkg/{f}", "line": fn.lineno, "col": fn.col_offset, "name": fn.id, "form": "name"})
            elif isinstance(fn, ast.Attribute): calls.append({"file": f"pkg/{f}", "line": fn.end_lineno, "col": fn.end_col_offset - len(fn.attr), "name": fn.attr, "form": "attr"})
tg = []
for k in exp:
    if k.startswith("_") or k == "symbols_expected_count": continue
    loc, q = k.split(" ", 1); f, l = loc.rsplit(":", 1)
    m = [s for s in syms if s["file"] == f and s["line"] == int(l) and s["qualname"] == q]
    assert len(m) == 1, k
    tg.append(m[0])
json.dump(tg, open("fx_targets.json", "w"), indent=1); json.dump(syms, open("fx_symbols.json", "w"), indent=1); json.dump(calls, open("fx_allcalls.json", "w"), indent=1)
print(len(syms), len(tg), len(calls))
