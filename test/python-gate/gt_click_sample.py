"""Draw the seeded sample for the independent blind classifier (GCLI-69). Seed 7, committed before the classification exists.

Run: python3 -I gt_click_sample.py <targets.json> <n> <out.txt>
Draws n (target, candidate site) pairs from batch 0, uniformly without replacement among pairs of targets with a candidate,
and writes them with the source line and NO classification. The classifier reads the pinned click 7.1.2 source itself.
"""
import json
import random
import sys

targets = json.load(open(sys.argv[1]))
n = int(sys.argv[2])
pairs = [(t, c) for t in targets if t["batch"] == 0 for c in t["candidates"]]
rng = random.Random(7)
pick = rng.sample(range(len(pairs)), n)
with open(sys.argv[3], "w") as out:
    out.write(f"# blind sample: {n} of {len(pairs)} batch-0 (target, candidate site) pairs, seed 7, in draw order. NOT classified.\n")
    for i, k in enumerate(pick, 1):
        t, c = pairs[k]
        out.write(f"{i}. target {t['file']}:{t['line']} {t['qualname']} ({t['kind']}); site {c['file']}:{c['call_start_line']} "
                  f"(callee at line {c['line']} col {c['col']}) [{c['form']}] via {c['via']} in {c['in'] or '<module>'} :: {c['callee']}\n")
print(len(pairs), "pairs; drew", n)
