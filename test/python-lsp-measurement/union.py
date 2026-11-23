"""Score incoming calls, outgoing calls, their union, and the union plus the constructor mapping against the ground truth.
usage: python3 -I union.py <raw run with OUT_ALL=1> <truth.json> <targets.json> <symbols.json> [<second truth.json> ...]
Every number is per SITE (a line that holds two true sites needs two found sites), with recall AND precision, and also per
TARGET (a target is fully correct if every true site is found and nothing else is listed), because sites cluster by target
and a site-level interval is optimistic.

Matching rules, stated once:
  incoming  : the sites `incomingCalls` lists for the target (duplicates removed by file/line/column).
  outgoing  : the ranges any function's `outgoingCalls` lists whose callee item is at the target's definition: same file and a
              callee line on a definition of the target's qualified name in that file (an @overload stub or the implementation, on
              its def line or a decorator line above): location, not name, because an aliased import reports the alias.
  union     : the distinct sites of the two sets above.
  ctor map  : for an `__init__` target of class C, also the union (incoming + outgoing, as above) of class C and of every class that has
              C as a base and defines no `__init__` of its own (a constructor call to such a subclass runs C.__init__).
A predicted site is a false positive if its line is not a true site of the target (poly and blind lines in the truth file are
neutral and not counted as false). A predicted line with fewer sites than the truth has on it is a miss for the rest."""
import collections, json, math, random, sys

raw = json.load(open(sys.argv[1]))
truths = [json.load(open(p)) for p in [sys.argv[2]] + sys.argv[5:]]
targets = json.load(open(sys.argv[3]))
symbols = json.load(open(sys.argv[4]))
if "outgoing" not in raw:
    sys.exit("ERROR: raw run has no outgoing pass (run the harness with OUT_ALL=1)")
if raw["stats"]["answered"] == 0 or raw["stats"]["errors"] > 0:
    sys.exit("ERROR: the raw run answered no request or had request errors; refusing to score")
tinfo = {f'{t["file"]}:{t["line"]} {t["qualname"]}': t for t in targets}
class_target = {(t["file"], t["name"]): f'{t["file"]}:{t["line"]} {t["qualname"]}' for t in targets if t.get("kind") == "class"}
has_init = {(s["file"], s["qualname"].rsplit(".", 1)[0]) for s in symbols if s["name"] == "__init__"}
subclasses = collections.defaultdict(list)  # (file, base simple name) -> subclass symbols (same file or any)
for s in symbols:
    if s["kind"] == "class":
        for b in s.get("bases", []):
            subclasses[b.split(".")[-1]].append(s)


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - a) / d), min(1.0, (c + a) / d))


def fmt(k, n):
    if n == 0:
        return "n/a (n=0)"
    lo, hi = wilson(k, n)
    return f"{k}/{n} = {k / n:.3f} ({lo:.3f}-{hi:.3f})"


by_line = collections.defaultdict(list)
for o in raw["outgoing"]:
    by_line[(o["file"], o["line"])].append(o)


def incoming_sites(key):
    rec = raw["targets"].get(key)
    return {(x["file"], x["line"], x["col"]) for x in rec["incoming"]} if rec else set()


def outgoing_sites(t):
    # By callee LOCATION, not name: an aliased import reports the alias as the callee's name (measured: `_is_prepared` for
    # `is_prepared`), so a name match would lose exactly the alias calls this set exists to find. The location is any
    # definition of the target's qualified name in its file (an @overload stub and the implementation are all "the target"),
    # on its `def` line or on a decorator line above it. A window of +-3 lines was tried first and conflated neighbours.
    spans = [
        (s["line"] - len(s.get("decorators", [])), s["line"])
        for s in symbols
        if s["file"] == t["file"] and s["qualname"] == t["qualname"]
    ]
    return {
        (o["file"], o["line"], o["col"])
        for o in raw["outgoing"]
        if o["toFile"] == t["file"] and any(lo <= o["toLine"] <= hi for lo, hi in spans)
    }


def ctor_sites(t):
    if t["name"] != "__init__":
        return set()
    cls = t["qualname"].rsplit(".", 1)[0]
    out = set()
    classes = [(t["file"], cls)]
    for sub in subclasses.get(cls.split(".")[-1], []):
        if (sub["file"], sub["qualname"]) not in has_init:
            classes.append((sub["file"], sub["qualname"]))
    for f, c in classes:
        k = class_target.get((f, c.split(".")[-1]))
        if k:
            out |= incoming_sites(k) | outgoing_sites(tinfo[k])
    return out


def score(sites, want, neutral):
    """sites: set of (file,line,col); want: Counter of 'file:line' true sites; neutral: set of 'file:line'. -> (tp, fp, fn)"""
    per_line = collections.Counter(f"{f}:{l}" for f, l, _ in sites)
    tp = sum(min(m, per_line[s]) for s, m in want.items())
    fp = sum(n for s, n in per_line.items() if s not in want and s not in neutral) + sum(
        max(0, per_line[s] - want[s]) for s in want
    )
    return tp, fp, sum(want.values()) - tp


def cluster_bootstrap(rows, reps=10000, seed=20261123):
    """95% percentile interval of sum(tp)/sum(tp+fn) (recall) and sum(tp)/sum(tp+fp) (precision), resampling TARGETS with
    replacement (sites cluster by target). rows: list of (tp, fp, fn) per target."""
    rng = random.Random(seed)
    rec, prec = [], []
    for _ in range(reps):
        pick = [rows[rng.randrange(len(rows))] for _ in rows]
        tp = sum(r[0] for r in pick)
        fp = sum(r[1] for r in pick)
        fn = sum(r[2] for r in pick)
        if tp + fn:
            rec.append(tp / (tp + fn))
        if tp + fp:
            prec.append(tp / (tp + fp))
    q = lambda xs, p: sorted(xs)[int(p * (len(xs) - 1))]
    return (q(rec, 0.025), q(rec, 0.975)), ((q(prec, 0.025), q(prec, 0.975)) if prec else (float("nan"), float("nan")))


names = ["incoming", "outgoing", "union", "union + ctor map"]
for ti, truth in enumerate(truths):
    agg = {n: [0, 0, 0] for n in names}
    rows = {n: [] for n in names}  # per target (tp, fp, fn), only targets with at least one true site
    full = {n: 0 for n in names}
    ntargets = 0
    detail = []
    for key, tr in truth.items():
        if key in ("_note", "symbols_expected_count"):
            continue
        t = tinfo[key]
        ntargets += 1
        want = collections.Counter(tr["true"])
        neutral = set(tr.get("poly", [])) | set(tr.get("blind", []))
        inc, out = incoming_sites(key), outgoing_sites(t)
        sets = {"incoming": inc, "outgoing": out, "union": inc | out, "union + ctor map": inc | out | ctor_sites(t)}
        row = []
        for n in names:
            tp, fp, fn = score(sets[n], want, neutral)
            agg[n][0] += tp
            agg[n][1] += fp
            agg[n][2] += fn
            if sum(want.values()) > 0:
                rows[n].append((tp, fp, fn))
            ok = fp == 0 and fn == 0
            full[n] += ok
            row.append(f"{n}: tp={tp} fp={fp} fn={fn}")
        detail.append((key, row))
    print(f"\n== truth set {ti + 1}: {ntargets} targets, {agg['incoming'][0] + agg['incoming'][2]} true sites ==")
    print(f'{"set":18} {"site recall":34} {"site precision":34} {"targets fully correct":28}')
    for n in names:
        tp, fp, fn = agg[n]
        print(f"{n:18} {fmt(tp, tp + fn):34} {fmt(tp, tp + fp):34} {fmt(full[n], ntargets):28}")
    withtruth = len(rows["incoming"])
    print(f"\ncluster view over the {withtruth} targets that have at least one true site (the zero-truth targets are precision controls and"
          f" would inflate a target-level figure):")
    print(f'{"set":18} {"targets fully correct":30} {"recall, cluster bootstrap 95%":34} {"precision, cluster bootstrap 95%":34}')
    for n in names:
        fully = sum(1 for tp, fp, fn in rows[n] if fp == 0 and fn == 0)
        (rl, rh), (pl, ph) = cluster_bootstrap(rows[n])
        print(f"{n:18} {fmt(fully, withtruth):30} {rl:.3f}-{rh:.3f}                       {pl:.3f}-{ph:.3f}")
    for key, row in detail:
        bad = [r for r in row if " fp=0 fn=0" not in r]
        if bad:
            print("  differs:", key, "|", "; ".join(bad))
