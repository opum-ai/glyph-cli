"""Count how annotated a Python source tree is (GCLI-68, ADR 0008).

Usage: python3 -I annotation_count.py <source-root>

Exits 1 (and prints the files) if any .py file under the root fails to parse, so a clean run also shows the tree parses under
the host Python's `ast`. Prints one line per measure:
  defs                 every def and async def, including @overload stubs and nested defs; lambdas are not defs
  overload stubs       defs decorated with `overload` or `typing.overload` (counted in defs; shown so they can be discounted)
  defs annotated (any) a def with any annotated parameter or a return annotation (lenient: a lone `-> None` counts)
  params               parameters excluding a first parameter named self or cls on a def inside a class
  params annotated     of those, the ones with an annotation
Type comments and .pyi stubs are ignored.
"""
import ast
import os
import sys

root = sys.argv[1]
files = calls = classes = defs = overloads = ann_any = params = params_ann = 0
skipped = []


def is_overload(n):
    for d in n.decorator_list:
        t = d.id if isinstance(d, ast.Name) else d.attr if isinstance(d, ast.Attribute) else None
        if t == 'overload':
            return True
    return False


for d, _, fs in os.walk(root):
    for f in sorted(fs):
        if not f.endswith('.py'):
            continue
        path = os.path.join(d, f)
        try:
            tree = ast.parse(open(path, encoding='utf-8').read())
        except Exception as e:
            skipped.append((path, type(e).__name__))
            continue
        files += 1
        parents = {}
        for n in ast.walk(tree):
            for c in ast.iter_child_nodes(n):
                parents[c] = n
        for n in ast.walk(tree):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs += 1
                overloads += is_overload(n)
                a = n.args
                ps = a.posonlyargs + a.args + a.kwonlyargs + ([a.vararg] if a.vararg else []) + ([a.kwarg] if a.kwarg else [])
                if n.returns or any(p.annotation for p in ps):
                    ann_any += 1
                in_class = isinstance(parents.get(n), ast.ClassDef)
                counted = ps[1:] if in_class and ps and ps[0].arg in ('self', 'cls') else ps
                params += len(counted)
                params_ann += sum(1 for p in counted if p.annotation)
            elif isinstance(n, ast.ClassDef):
                classes += 1
            elif isinstance(n, ast.Call):
                calls += 1

print(f'root {root}')
print(f'files parsed {files}, skipped {len(skipped)}')
print(f'defs {defs}, overload stubs {overloads}, defs annotated (any) {ann_any} ({ann_any / max(defs, 1):.3f})')
print(f'params (excluding self/cls) {params}, annotated {params_ann} ({params_ann / max(params, 1):.3f})')
print(f'classes {classes}, ast.Call nodes {calls}')
if skipped:
    for p, e in skipped:
        print(f'SKIPPED {p} {e}')
    sys.exit(1)
