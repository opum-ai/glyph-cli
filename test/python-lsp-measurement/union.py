"""Union of incoming and outgoing call hierarchy against the ground truth.
usage: python3 -I union.py <incoming raw.json> <outgoing raw.json> <truth.json> <targets.json>
A true site counts as found by incoming if the target's incomingCalls lists that file:line; by outgoing if
any function's outgoingCalls lists a range on that file:line whose callee is the target (same name, and the
callee's file and a line within 3 of the target's definition line; for an __init__ target, a callee named
after its class or __init__). The strict match is by callee identity; a loose count (line only) is also shown."""
import json, sys, math, collections
inc = json.load(open(sys.argv[1])); out = json.load(open(sys.argv[2])); truth = json.load(open(sys.argv[3])); targets = json.load(open(sys.argv[4]))
truth.pop("_note", None); truth.pop("symbols_expected_count", None)
tinfo = {f'{t["file"]}:{t["line"]} {t["qualname"]}': t for t in targets}
def wilson(k, n, z=1.96):
    if n == 0: return (None, None)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - a) / d), min(1.0, (c + a) / d))
by_line = collections.defaultdict(list)
for o in out["outgoing"]: by_line[(o["file"], o["line"])].append(o)
tot = n_in = n_out = n_union = loose = 0
miss = []; out_fp = []
for key, v in truth.items():
    t = tinfo[key]
    got_in = collections.Counter(f'{x["file"]}:{x["line"]}' for x in {(x["file"], x["line"], x["col"]): x for x in inc["targets"][key]["incoming"]}.values())
    names = {t["name"]}
    if t["name"] == "__init__": names.add(t["qualname"].split(".")[0])
    def out_matches(o):
        return o["toName"] in names and o["toFile"] == t["file"] and abs(o["toLine"] - t["line"]) <= 3
    want = collections.Counter(v["true"])
    for s, m in want.items():
        f, l = s.rsplit(":", 1); l = int(l); tot += m
        a = min(m, got_in[s])
        b = min(m, len({o["col"] for o in by_line[(f, l)] if out_matches(o)}))
        if by_line[(f, l)]: loose += m
        u = max(a, b)  # same site may be found by both; at most m sites exist on the line
        n_in += a; n_out += b; n_union += u
        if u < m: miss.extend([(key, s)] * (m - u))
    ts = collections.Counter(v["true"])
    for o in {(o["file"], o["line"], o["col"], o["toName"], o["toFile"], o["toLine"]): o for o in out["outgoing"]}.values():
        if out_matches(o):
            site = f'{o["file"]}:{o["line"]}'
            if site not in ts: out_fp.append((key, site))
found = n_union
lo, hi = wilson(found, tot)
print(f"true sites {tot}; found by incoming {n_in}, by outgoing {n_out}, by the union {n_union}, by neither {tot - n_union}")
print(f"UNION recall {found}/{tot} = {found / tot:.3f} (95% Wilson {lo:.3f}-{hi:.3f})")
li, hi2 = wilson(n_in, tot); print(f"incoming only {n_in}/{tot} = {n_in / tot:.3f} ({li:.3f}-{hi2:.3f})")
lo3, hi3 = wilson(n_out, tot); print(f"outgoing only {n_out}/{tot} = {n_out / tot:.3f} ({lo3:.3f}-{hi3:.3f})  [line-only loose match found a range on {loose}/{tot}]")
print("neither:", miss)
print("outgoing edges to a target that are not true sites (false positives):", len(out_fp), out_fp[:10])
