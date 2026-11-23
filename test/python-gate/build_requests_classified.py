"""Build the requests classification under the independent human-attributable definition (GCLI-74 / S0b, DEC-303 (a2) ruling 2).

Run: python3 -I build_requests_classified.py <requests-3c7baaa/targets.json> <gt3_classified.json> <out.json>

The 46 pre-registered targets and their candidate sites come from `gt_requests_candidates.py` (committed first, a0f7eba). Every candidate
site of every target was re-read against the pinned source under gt_rules_click.md (R1', Addenda 1-4). The result of that re-read, recorded
here as data so it can be checked:
  * every site gt3_classified.json lists as `true` is true under the independent definition; every `poly` stays poly (Addendum 3 / (a3) Q4);
  * every other candidate of a target is other-definition (a different definition: dict/Mapping `.get`, `.items`, `.copy`, `.close` on a
    Response, Session or urllib3 object, `super().__init__()` into a different class, module functions of the same name);
  * NO site that R1 left undecidable was found among the candidates: requests is annotated (265 of 268 defs, results/annotation-count.txt), so
    every candidate receiver was attributable. The number of newly attributable sites beyond the 65 is therefore 0.
`receiver_evidence` per true site (Addendum 4 / R1'): name-form and constructor sites and `self.m()` / annotated-parameter / bound-once
receivers are `direct`; a receiver that is an attribute of another value or a loop variable over a collection is `inferred`. The three
`inferred` sites are listed in INFERRED below.
gt3_classified.json is read, never written.
"""
import json
import sys

INFERRED = {  # (target key, site as in gt3) -> why
    ("structures.py:89 CaseInsensitiveDict.copy", "models.py:460"): "self.headers.copy(): attribute of self",
    ("adapters.py:153 BaseAdapter.close", "sessions.py:886"): "for v in self.adapters.values(): v.close(): loop variable over a collection",
    ("models.py:456 PreparedRequest.copy", "auth.py:302"): "r.request.copy(): attribute of an annotated parameter",
}
targets = json.load(open(sys.argv[1]))
gt = json.load(open(sys.argv[2]))
out, bad = {}, 0
for t in targets:
    key = f"{t['file']}:{t['line']} {t['qualname']}"
    g = gt[key]
    byline = {}
    for c in t["candidates"]:
        byline.setdefault(f"{c['file']}:{c['call_start_line']}", []).append(c)
        byline.setdefault(f"{c['file']}:{c['line']}", []).append(c)
    rec = {"true": [], "poly": [], "excluded": [], "other_definition": 0, "batch": 0}
    ids = set()
    for kind in ("true", "poly"):
        for s in g.get(kind, []):
            cs = byline.get(s)
            if not cs:
                print("NOT A CANDIDATE:", key, s, file=sys.stderr)
                bad += 1
                continue
            c = cs[0]
            ids.add(f"{c['file']}:{c['line']}:{c['col']}")
            r = {"site": f"{c['file']}:{c['line']}:{c['col']}", "call_start_line": c["call_start_line"], "form": c["form"]}
            if kind == "true":
                r["receiver_evidence"] = "inferred" if ((key, s) in INFERRED and c["form"] == "attr") else "direct"
            rec[kind].append(r)
    rec["other_definition"] = len(t["candidates"]) - len(ids)
    out[key] = rec
tot = {"targets": len(out), "true": sum(len(v["true"]) for v in out.values()),
       "true_direct": sum(1 for v in out.values() for s in v["true"] if s["receiver_evidence"] == "direct"),
       "true_inferred": sum(1 for v in out.values() for s in v["true"] if s["receiver_evidence"] == "inferred"),
       "poly": sum(len(v["poly"]) for v in out.values()), "excluded": 0,
       "other_definition": sum(v["other_definition"] for v in out.values()),
       "newly_attributable_beyond_gt3": 0,
       "targets_with_a_true_site": sum(1 for v in out.values() if v["true"]),
       "zero_truth_targets": sum(1 for v in out.values() if not v["true"])}
json.dump({"summary": tot, "targets": out}, open(sys.argv[3], "w"), indent=1)
print(tot)
sys.exit(1 if bad else 0)
