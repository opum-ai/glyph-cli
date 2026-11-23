"""Positions of in-repository absolute imports, in the shape harness.mjs reads as its allcalls argument, so `definition` can
be asked at each imported module path. usage: python3 -I import_probe.py <src dir> <package dir name under it> <out.json>
Writes one entry per `import X.y` / `from X.y import ...` whose top-level module X is the in-repository package."""
import ast, json, os, sys
SRC, PKG, OUT = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
out = []
for root, _, files in os.walk(os.path.join(SRC, PKG)):
    for f in sorted(files):
        if not f.endswith(".py"):
            continue
        path = os.path.join(root, f)
        rel = os.path.relpath(path, SRC)
        for n in ast.walk(ast.parse(open(path, encoding="utf-8").read())):
            mods = []
            if isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
                mods.append((n.module, n.lineno, n.col_offset + len("from ")))
            elif isinstance(n, ast.Import):
                mods += [(a.name, n.lineno, n.col_offset + len("import ")) for a in n.names]
            for mod, line, col in mods:
                if mod.split(".")[0] == PKG:
                    out.append({"file": rel, "line": line, "col": col, "name": mod, "form": "import"})
json.dump(out, open(OUT, "w"), indent=1)
print(len(out), "in-repository absolute imports")
