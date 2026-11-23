"""Score a harness raw result against the ground truth fixed before pyright ran.
usage: python3 -I score.py <raw.json> <truth.json> <symbols.json> <srcroot> [--verbose]
"""
import json, sys, collections, math

raw = json.load(open(sys.argv[1]))
if raw["stats"]["answered"] == 0 or raw["stats"]["errors"] > 0:
    print("ERROR: the raw run answered no request or had request errors; refusing to score", file=sys.stderr)
    sys.exit(2)
truth = json.load(open(sys.argv[2]))
symbols = json.load(open(sys.argv[3]))
srcroot = sys.argv[4]
verbose = "--verbose" in sys.argv


def srcline(f, n):
    try:
        return open(f"{srcroot}/{f}", encoding="utf-8").read().split("\n")[n - 1].strip()[:100]
    except Exception:
        return "?"


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - a) / d), min(1.0, (c + a) / d))


def fmt(k, n):
    if n == 0:
        return "n/a (n=0)"
    lo, hi = wilson(k, n)
    return f"{k}/{n} = {k / n:.3f} (95% Wilson {lo:.3f}-{hi:.3f})"


res = {}
# ---- symbols
want = collections.defaultdict(list)
for s in symbols:
    want[s["file"]].append(s)
found = tot = 0
missing = []
kindmis = []
extra_decl = []
for f, lst in want.items():
    flat = raw["symbols"].get(f, [])
    have = {(x["name"], x["line"]): x for x in flat}
    for s in lst:
        tot += 1
        x = have.get((s["name"], s["line"]))
        if x:
            found += 1
            k = x["kind"]
            exp = 5 if s.get("kind") == "class" or s.get("category") == "class" else None
            if exp and k != exp:
                kindmis.append((f, s["name"], k))
        else:
            missing.append((f, s["name"], s["line"]))
    ast_keys = {(s["name"], s["line"]) for s in lst}
    for x in flat:
        if x["kind"] in (5, 6, 12) and (x["name"], x["line"]) not in ast_keys:
            extra_decl.append((f, x["name"], x["line"], x["kind"]))
res["symbols_documentSymbol_recall"] = fmt(found, tot)
res["symbols_documentSymbol_precision(class/method/function kinds)"] = fmt(sum(1 for f in want for x in raw["symbols"].get(f, []) if x["kind"] in (5, 6, 12)) - len(extra_decl), sum(1 for f in want for x in raw["symbols"].get(f, []) if x["kind"] in (5, 6, 12)))
res["symbols_missing"] = missing
res["symbols_class_kind_mismatch"] = kindmis
res["symbols_extra_decl"] = extra_decl

wfound = wtot = 0
wmiss = []
for s in symbols:
    wtot += 1
    hits = raw["workspaceSymbol"].get(s["name"], [])
    if any(h["file"] == s["file"] and h["line"] == s["line"] for h in hits):
        wfound += 1
    else:
        wmiss.append((s["file"], s["name"], s["line"]))
res["symbols_workspaceSymbol_recall"] = fmt(wfound, wtot)
res["symbols_workspaceSymbol_missing"] = wmiss

# ---- calls
TP = FP = FN = 0
TPr = FNr = 0  # references recall over true call sites
poly_seen = blind_seen = 0
per = []
nonempty_true_targets = 0
neg_targets = neg_clean = 0
prep_null = 0
refs_extra = []
dup_incoming = 0
for key, tr in truth.items():
    if key in ("_note", "symbols_expected_count"):
        continue
    rec = raw["targets"].get(key)
    if rec is None:
        print(f"ERROR: no harness record for target {key}; refusing to score with a smaller denominator", file=sys.stderr)
        sys.exit(2)
    truelist = collections.Counter(tr["true"])
    poly = collections.Counter(tr.get("poly", []))
    blind = collections.Counter(tr.get("blind", []))
    dup_incoming += len(rec["incoming"]) - len({(x["file"], x["line"], x["col"]) for x in rec["incoming"]})
    got = collections.Counter(f'{x["file"]}:{x["line"]}' for x in {(x["file"], x["line"], x["col"]): x for x in rec["incoming"]}.values())
    if not rec["prepared"]:
        prep_null += 1
    tp = sum(min(truelist[k], got[k]) for k in truelist)
    extras = got - truelist
    ps = sum(min(poly[k], extras[k]) for k in poly)
    bs = sum(min(blind[k], extras[k]) for k in blind)
    fp = sum(extras.values()) - ps - bs
    fn = sum(truelist.values()) - tp
    poly_seen += ps
    blind_seen += bs
    TP += tp
    FP += fp
    FN += fn
    if truelist:
        nonempty_true_targets += 1
    else:
        neg_targets += 1
        if fp == 0:
            neg_clean += 1
    rgot = collections.Counter(f'{x["file"]}:{x["line"]}' for x in rec["references"])
    rtp = sum(min(truelist[k], rgot[k]) for k in truelist)
    TPr += rtp
    FNr += sum(truelist.values()) - rtp
    for k in (rgot - truelist):
        refs_extra.append((key, k, srcline(k.rsplit(":", 1)[0], int(k.rsplit(":", 1)[1]))))
    per.append((key, f"true={sum(truelist.values())} pyright_incoming={sum(got.values())} tp={tp} fp={fp} fn={fn} poly_ok={ps} blind_found={bs} prepared={'yes' if rec['prepared'] else 'NULL'} refs={sum(rgot.values())} refs_tp={rtp}",
                [("MISSED", k) for k in (truelist - got)] + [("EXTRA", k, srcline(k.rsplit(':', 1)[0], int(k.rsplit(':', 1)[1]))) for k in (extras - poly - blind)]))
res["calls_duplicate_incoming_sites_removed_before_scoring"] = dup_incoming
res["calls_incoming_recall"] = fmt(TP, TP + FN)
res["calls_incoming_precision"] = fmt(TP, TP + FP)
res["calls_poly_sites_counted_neutral"] = poly_seen
res["calls_blind_sites_found_by_pyright"] = blind_seen
res["calls_targets_with_true_sites"] = nonempty_true_targets
res["calls_negative_targets (no true site)"] = f"{neg_clean}/{neg_targets} returned no false site"
res["calls_prepareCallHierarchy_null_targets"] = prep_null
res["references_recall_over_true_call_sites"] = fmt(TPr, TPr + FNr)
res["references_extras_not_true_calls (hand-classify)"] = len(refs_extra)

# ---- definitions (unresolved-site rate)
defs = raw["definitions"]
cats = collections.Counter()
mism = []
bysym = {(s["file"], s["line"]): s["name"] for s in symbols}
for d in defs:
    if not d["targets"]:
        cats["none"] += 1
    elif all(t["file"].startswith("EXTERNAL:") for t in d["targets"]):
        cats["external (typeshed or stdlib)" if "typeshed" in d["targets"][0]["file"] else "external (installed package)"] += 1
    else:
        cats["in-package"] += 1
        t = next(t for t in d["targets"] if not t["file"].startswith("EXTERNAL:"))
        nm = bysym.get((t["file"], t["line"]))
        if nm is None:
            cats["in-package, not at a def (variable/import/alias)"] += 1
        elif nm not in (d["name"], "__init__"):
            mism.append((d["file"], d["line"], d["name"], "->", nm))
res["definition_at_call_site_total"] = len(defs)
res["definition_at_call_site_outcomes"] = dict(cats)
res["definition_in_package_name_mismatches (hand-review)"] = mism
res["definition_in_package_name_mismatch_count"] = len(mism)

# definition vs ground truth: at every ground-truth call site, does `definition` at a callee of that name resolve to the
# target's own definition? The target's definition is the exact line span of any definition of its qualified name in its
# file (an @overload stub and the implementation, `def` line or a decorator line above); for an `__init__` target the
# class's own definition spans also count (a constructor call may resolve to the class). No line window: a window of +-3
# conflated neighbouring definitions. Sites whose callee name is not the target's name (aliases) are not checkable by name
# here and are counted separately.
def spans_of(file, qualname):
    return [(s["line"] - len(s.get("decorators", [])), s["line"]) for s in symbols if s["file"] == file and s["qualname"] == qualname]


tdefs = collections.defaultdict(list)
for d in defs:
    tdefs[(d["file"], d["line"])].append(d)
dg_ok = dg_total = dg_skipped = 0
dg_bad = []
for key, tr in truth.items():
    if key in ("_note", "symbols_expected_count"):
        continue
    loc, qual = key.split(" ", 1)
    tfile = loc.rsplit(":", 1)[0]
    simple = qual.split(".")[-1]
    names = {simple}
    spans = spans_of(tfile, qual)
    if simple == "__init__":
        names.add(qual.split(".")[0])
        spans += spans_of(tfile, qual.rsplit(".", 1)[0])
    for site in tr["true"]:
        f, l = site.rsplit(":", 1)
        cands = [d for d in tdefs.get((f, int(l)), []) if d["name"] in names]
        if not cands:
            dg_skipped += 1
            continue
        for d in cands:
            dg_total += 1
            if any(t["file"] == tfile and lo <= t["line"] <= hi for t in d["targets"] for lo, hi in spans):
                dg_ok += 1
            else:
                dg_bad.append((key, site, d["targets"][:2]))
res["definition_at_true_sites_resolves_to_the_target (exact def spans, no window)"] = fmt(dg_ok, dg_total)
res["definition_at_true_sites_not_checkable_by_name (aliases)"] = dg_skipped
res["definition_at_true_sites_disagreements"] = dg_bad
res["timing_ms"] = raw["timing"]
res["latency_ms"] = {k: (None if v is None else {"n": v["n"], "mean": round(v["meanMs"], 1), "max": round(v["maxMs"], 1)}) for k, v in raw["latency"].items()}
res["stats"] = raw["stats"]
print(json.dumps(res, indent=1, default=str))
if verbose:
    print("\n-- per target")
    for p in per:
        print(p[0], "|", p[1])
        for extra in (p[2] if len(p) > 2 else []):
            print("    ", extra)
    print("\n-- references extras")
    for e in refs_extra:
        print("   ", e)
