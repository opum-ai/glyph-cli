"""Alias-aware candidates (added after the review pointed out that gt2_listing.py matches callee NAMES only, so a call
through `from m import f as g` is never a candidate). usage: python3 -I alias_enum.py <package-src-dir> <symbols.json> <out-dir>
Finds every `from .m import a as b` / `from m import a as b` in the package where `a` is a def or class defined in the
package, then every Name call `b(...)` of the alias in the importing file. Rule R1: such a call is a true call to `a`
(the number of rebinds of the alias name is printed; a nonzero count means the sites need a hand check).
Writes alias_targets.json (same shape as targets.json) and gt4_alias.json (same shape as gt3_classified.json).
These targets were added AFTER the first results, because the first ground truth could not contain alias calls; the
rule is mechanical, and the result is reported separately from the pre-registered sample."""
import ast, json, os, sys

ROOT = sys.argv[1].rstrip("/")
syms = json.load(open(sys.argv[2]))
OUT = sys.argv[3].rstrip("/") + "/"
defs = {}
for s in syms:
    defs.setdefault(s["name"], []).append(s)
targets, truth = [], {}
for f in sorted(x for x in os.listdir(ROOT) if x.endswith(".py")):
    tree = ast.parse(open(f"{ROOT}/{f}", encoding="utf-8").read())
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level >= 1 and node.module:
            # in-package relative import: the original must be DEFINED in the module it is imported from
            modfile = node.module.split(".")[-1] + ".py"
            for a in node.names:
                if a.asname and a.asname != a.name and any(d["file"] == modfile for d in defs.get(a.name, [])):
                    aliases[a.asname] = (a.name, modfile)
    for alias, (orig, modfile) in aliases.items():
        rebinds = sum(1 for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == alias and isinstance(n.ctx, ast.Store))
        sites = [n.func.lineno for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == alias]
        cands = [d for d in defs[orig] if d["file"] == modfile]
        if len(cands) != 1:
            print("AMBIGUOUS original name, skipped", orig, [(c["file"], c["line"]) for c in cands])
            continue
        t = dict(cands[0], stratum="alias")
        key = f'{t["file"]}:{t["line"]} {t["qualname"]}'
        if key not in truth:
            truth[key] = {"true": [], "note": f"alias call sites; alias bound in {f}"}
            targets.append(t)
        truth[key]["true"] += [f"{f}:{ln}" for ln in sites]
        print(f"{f}: {alias} -> {orig} ({t['file']}:{t['line']}) rebinds={rebinds} calls={len(sites)}")
# direct (unaliased) calls of each alias target, so precision on these targets is scored against a complete truth:
# a Name call `orig(...)` in a file that imports `orig` without an alias from its defining module, or in the defining file.
for key, entry in truth.items():
    t = next(x for x in targets if f'{x["file"]}:{x["line"]} {x["qualname"]}' == key)
    modname = t["file"][:-3]
    for f in sorted(x for x in os.listdir(ROOT) if x.endswith(".py")):
        tree = ast.parse(open(f"{ROOT}/{f}", encoding="utf-8").read())
        imports_plain = f == t["file"] or any(
            isinstance(n, ast.ImportFrom) and n.level >= 1 and n.module == modname and any(a.name == t["name"] and not a.asname for a in n.names)
            for n in ast.walk(tree)
        )
        if imports_plain:
            entry["true"] += [f"{f}:{n.func.lineno}" for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == t["name"]]
    print(f"{key}: {len(entry['true'])} true sites in total (alias plus direct)")
json.dump(targets, open(OUT + "alias_targets.json", "w"), indent=1)
json.dump(truth, open(OUT + "gt4_alias.json", "w"), indent=1)
