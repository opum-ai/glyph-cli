"""Mechanical receiver-evidence flag for the NON-true candidate sites of a classified batch (GCLI-69, DEC-303 (a3) Q3).

Run: python3 -I derive_site_evidence.py <targets.json> <classified.json> <out.json>
Q3 makes the pyright-comparable precision side exclude edges at `inferred` sites, which needs the flag on sites that are not true
sites too (Addendum 2 rule 3; Addendum 4). Rule, applied mechanically so no label is a judgment made after any analyzer output:
a name-form or decorator site is `direct`; an attribute-form site is `direct` when its receiver is `self`, `cls`, `super()`, a
module name from {io, os, sys}, or ends in a capitalised name (a class used as the receiver); any other receiver is `inferred`.
True sites keep the hand-recorded `receiver_evidence` in classified-batch0.json and are not touched here.
"""
import json
import sys

targets = json.load(open(sys.argv[1]))
classified = json.load(open(sys.argv[2]))["targets"]
out = {}
for t in targets:
    key = f"{t['file']}:{t['line']} {t['qualname']}"
    if key not in classified:
        continue
    true_sites = {s["site"] for s in classified[key]["true"]}
    for c in t["candidates"]:
        site = f"{c['file']}:{c['line']}:{c['col']}"
        if site in true_sites:
            continue
        if c["form"] in ("name", "decorator", "other"):
            ev = "direct"
        else:
            recv = c["callee"].rsplit(".", 1)[0]
            last = recv.split(".")[-1]
            ev = "direct" if recv in ("self", "cls", "super()", "io", "os", "sys") or last[:1].isupper() else "inferred"
        out[f"{key} | {site}"] = ev
json.dump(out, open(sys.argv[3], "w"), indent=1)
from collections import Counter
print(len(out), dict(Counter(out.values())))
