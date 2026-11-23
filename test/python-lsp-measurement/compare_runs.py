"""Determinism, open-mode and timing summaries from raw harness runs.
usage: python3 -I compare_runs.py <dir holding real-default-1..6.json, real-none-1..2.json, real-default-out.json>
(run on the gunzipped files of results/raw/). Prints three sections; results/ holds the committed output."""
import json, sys, statistics

D = sys.argv[1].rstrip("/") + "/"


def load(name):
    d = json.load(open(D + name))
    meta = {k: d.pop(k) for k in ("timing", "stats", "latency")}
    return d, meta


runs = {n: load(f"real-default-{n}.json") for n in range(1, 7)}
base = runs[1][0]
print("== determinism: six runs, every file opened before any query ==")
for n in range(2, 7):
    print(f"run {n} equals run 1 (all fields except timing, stats, latency):", runs[n][0] == base)

print("\n== open-mode: files opened only for their own query ('none') vs every file opened first ('all') ==")
none = {n: load(f"real-none-{n}.json")[0] for n in (1, 2)}
for n, d in none.items():
    diff_targets = [k for k in base["targets"] if d["targets"][k] != base["targets"][k]]
    print(f"none run {n} vs all run 1: {len(diff_targets)} of {len(base['targets'])} targets differ: {diff_targets}")
print("none run 1 vs none run 2:", [k for k in none[1]["targets"] if none[1]["targets"][k] != none[2]["targets"][k]])
syms = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else None
for label, d in (("all", base), ("none run 1", none[1])):
    found = tot = 0
    if syms:
        for s in syms:
            tot += 1
            found += any(h["file"] == s["file"] and h["line"] == s["line"] for h in d["workspaceSymbol"].get(s["name"], []))
        print(f"workspace/symbol recall, {label}: {found}/{tot}")

print("\n== timing: cold server start each run, idle machine ==")
print("run  initMs  allDocumentSymbolsMs  totalMs  requests")
for n in range(1, 7):
    m = runs[n][1]
    print(f"{n:3}  {m['timing']['initMs']:6.0f}  {m['timing']['firstAllDocumentSymbolsMs']:20.0f}  {m['timing']['totalMs']:7.0f}  {m['stats']['requests']}")
out_d, out_m = load("real-default-out.json")
print(f"with the per-symbol outgoingCalls pass: totalMs {out_m['timing']['totalMs']:.0f}, requests {out_m['stats']['requests']}")
for kind in ("textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls", "callHierarchy/outgoingCalls", "textDocument/references", "textDocument/definition"):
    means = [runs[n][1]["latency"][kind]["meanMs"] for n in range(1, 7)]
    maxes = [runs[n][1]["latency"][kind]["maxMs"] for n in range(1, 7)]
    print(f"{kind}: mean of means {statistics.mean(means):.1f} ms (range {min(means):.1f}-{max(means):.1f}), max {max(maxes):.0f} ms, n/run {runs[1][1]['latency'][kind]['n']}")
