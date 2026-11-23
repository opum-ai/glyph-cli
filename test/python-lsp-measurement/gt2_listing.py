import json
D = "/private/tmp/claude-501/-Volumes-external-repos-glyph-cli/f49f7d09-3ac6-45aa-b911-af683fb9e242/scratchpad/py/"
ROOT = D + "requests/src/requests/"
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
