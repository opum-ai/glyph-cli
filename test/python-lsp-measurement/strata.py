"""Incoming-call recall per sampling stratum. usage: python3 -I strata.py <raw run> <truth.json> <targets.json>"""
import json, collections, sys, math
raw = json.load(open(sys.argv[1])); truth = json.load(open(sys.argv[2])); truth.pop("_note")
tg = {f'{t["file"]}:{t["line"]} {t["qualname"]}': t["stratum"] for t in json.load(open(sys.argv[3]))}
agg = collections.defaultdict(lambda: [0, 0, 0, 0])  # targets, true sites, tp, fp
for k, v in truth.items():
    rec = raw["targets"][k]
    got = collections.Counter(f'{x["file"]}:{x["line"]}' for x in {(x["file"], x["line"], x["col"]): x for x in rec["incoming"]}.values())
    tl = collections.Counter(v["true"])
    tp = sum(min(tl[s], got[s]) for s in tl)
    fp = sum((got - tl).values())
    a = agg[tg[k]]; a[0] += 1; a[1] += sum(tl.values()); a[2] += tp; a[3] += fp
print(f'{"stratum":16} targets true_sites found false_extra')
for s, a in agg.items(): print(f"{s:16} {a[0]:7} {a[1]:10} {a[2]:5} {a[3]:11}")
