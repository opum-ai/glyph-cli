"""Build classified-batch0.json from classify-batch0.txt and targets.json, validating every listed site against the candidates.
Run: python3 -I build_classified.py <targets.json> <classify.txt> <out.json>. Exits 1 on any listed site that is not a candidate of its target."""
import json, sys
targets = json.load(open(sys.argv[1]))
key = {f"{t['file']}:{t['line']} {t['qualname']}": t for t in targets}
out, cur, bad = {}, None, 0
for raw in open(sys.argv[2]):
    line = raw.rstrip("\n")
    if not line or line.startswith("#"):
        continue
    kind, rest = line[0], line[2:]
    if kind == "T":
        cur = out.setdefault(rest, {"true": [], "poly": [], "excluded": [], "other_definition": 0})
        t = key[rest]
        cands = {f"{c['file']}:{c['line']}:{c['col']}": c for c in t["candidates"]}
        cur["_cands"] = cands
        continue
    parts = rest.split()
    site = parts[0]
    c = cur["_cands"].get(site)
    if c is None:
        print("NOT A CANDIDATE:", site, file=sys.stderr); bad += 1; continue
    rec = {"site": site, "call_start_line": c["call_start_line"], "form": c["form"]}
    if kind == "+":
        cur["true"].append(dict(rec, receiver_evidence=parts[1]))
    elif kind == "p":
        cur["poly"].append(rec)
    elif kind == "x":
        cur["excluded"].append(dict(rec, reason=parts[1]))
for k, v in out.items():
    listed = {s["site"] for s in v["true"] + v["poly"] + v["excluded"]}
    v["other_definition"] = len(v.pop("_cands")) - len(listed)
    v["batch"] = key[k]["batch"]
tot = {"targets": len(out), "true": sum(len(v["true"]) for v in out.values()),
       "true_direct": sum(1 for v in out.values() for s in v["true"] if s["receiver_evidence"] == "direct"),
       "true_inferred": sum(1 for v in out.values() for s in v["true"] if s["receiver_evidence"] == "inferred"),
       "poly": sum(len(v["poly"]) for v in out.values()), "excluded": sum(len(v["excluded"]) for v in out.values()),
       "other_definition": sum(v["other_definition"] for v in out.values()),
       "targets_with_a_true_site": sum(1 for v in out.values() if v["true"]),
       "zero_truth_targets": sum(1 for v in out.values() if not v["true"])}
json.dump({"summary": tot, "targets": out}, open(sys.argv[3], "w"), indent=1)
print(tot)
sys.exit(1 if bad else 0)
