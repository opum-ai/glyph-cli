import re, sys, hashlib, json, os
repo, pkg, seed = sys.argv[1], sys.argv[2], sys.argv[3]
maxt = int(sys.argv[4]) if len(sys.argv) > 4 else 60
root = f"corpus/{repo}"
files = []
for d, _, fs in os.walk(f"{root}/{pkg}"):
    if "/tests" in d or "__pycache__" in d: continue
    for f in fs:
        if f.endswith(".py"): files.append(os.path.relpath(f"{d}/{f}", root))
files.sort()
lines = {f: open(f"{root}/{f}", encoding="utf8").read().split("\n") for f in files}
defs = []
for f in files:
    stack = []
    for i, l in enumerate(lines[f], 1):
        m = re.match(r"^(\s*)(async\s+def|def|class)\s+(\w+)", l)
        if not m: continue
        ind = len(m.group(1)); kind = "class" if m.group(2) == "class" else "def"
        while stack and stack[-1][0] >= ind: stack.pop()
        qual = ".".join([s[1] for s in stack] + [m.group(3)])
        encl = stack[-1][1] if stack and stack[-1][2] == "class" else None
        defs.append(dict(file=f, line=i, column=m.start(3) + 1, kind=kind, name=m.group(3), qual=qual, encl=encl))
        stack.append((ind, m.group(3), kind))
cands = [d for d in defs if not (d["name"].startswith("__") and d["name"].endswith("__"))]
cands.sort(key=lambda d: hashlib.sha256((seed + d["file"] + ":" + d["qual"]).encode()).hexdigest())
out = []
total = 0
for d in cands:
    n = d["name"]
    pat = re.compile(r"(?<![\w])" + re.escape(n) + r"\s*\(")
    ref = re.compile(r"(?<![\w])" + re.escape(n) + r"(?![\w(])")
    sites = []
    for f in files:
        for i, l in enumerate(lines[f], 1):
            if f == d["file"] and i == d["line"]: continue
            s = l.split("#")[0]
            if pat.search(s): sites.append(dict(file=f, line=i, form="call", src=l.strip()))
            elif ref.search(s) and not s.strip().startswith(("import ", "from ")) or (ref.search(s) and " as " in s):
                sites.append(dict(file=f, line=i, form="ref", src=l.strip()))
    ncall = sum(1 for s in sites if s["form"] == "call")
    if ncall < 1 or len(sites) > 14: continue
    d["sites"] = sites; out.append(d); total += len(sites)
    if len(out) >= maxt: break
json.dump(out, open(f"enum-{repo}.json", "w"), indent=1)
print(repo, "defs", len(defs), "targets", len(out), "candidate sites", total)
