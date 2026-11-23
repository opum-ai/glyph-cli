import json, sys
# usage: python3 -I gt2_listing.py <package-src-dir> <dir holding allcalls.json, symbols.json, targets.json>
ROOT = sys.argv[1].rstrip("/") + "/"
D = sys.argv[2].rstrip("/") + "/"
allcalls = json.load(open(D + "allcalls.json"))
symbols = json.load(open(D + "symbols.json"))
targets = json.load(open(D + "targets.json"))
src = {}
def line(f, n):
    if f not in src:
        src[f] = open(ROOT + f, encoding="utf-8").read().split("\n")
    return src[f][n - 1].strip()[:110]
names = []
for t in targets:
    if t["name"] == "__init__":
        names.append(t["qualname"].split(".")[0])  # constructor callers by class name
    names.append(t["name"])
seen = set()
for nm in names:
    if nm in seen:
        continue
    seen.add(nm)
    sites = [c for c in allcalls if c["name"] == nm]
    print(f"\n## {nm}  ({len(sites)} sites)")
    for c in sites:
        print(f'{c["file"]}:{c["line"]}:{c["col"]} [{c["form"]}] in {c["in"] or "<module>"} :: {line(c["file"], c["line"])}')
