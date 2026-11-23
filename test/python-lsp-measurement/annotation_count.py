import ast, sys, os

root = sys.argv[1]
defs = ann = files = calls = cls = 0
for d, _, fs in os.walk(root):
    for f in fs:
        if not f.endswith('.py'):
            continue
        try:
            t = ast.parse(open(os.path.join(d, f), encoding='utf-8').read())
        except Exception:
            continue
        files += 1
        for n in ast.walk(t):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs += 1
                a = n.args
                ps = a.posonlyargs + a.args + a.kwonlyargs + ([a.vararg] if a.vararg else []) + ([a.kwarg] if a.kwarg else [])
                if n.returns or any(p.annotation for p in ps):
                    ann += 1
            elif isinstance(n, ast.ClassDef):
                cls += 1
            elif isinstance(n, ast.Call):
                calls += 1
print(root, 'files', files, 'defs', defs, 'annotated', ann, '%.3f' % (ann / max(defs, 1)), 'classes', cls, 'calls', calls)
