# Python gate: held-out ground truth (GCLI-69, ADR 0008)

The held-out repository of the DEC-303 (a2) gate is pallets/click at `1784558ed7c75c65764d2a434bd9cbb206ca939d` (tag 7.1.2),
package directory `src/click`. Everything here is committed before any analyzer run; the order is checkable from file history:

1. the rules (`gt_rules_click.md`), the enumeration script and its candidate list (`click-7.1.2/candidates.txt` and the JSON beside it, no classification), and the seeded blind sample;
2. the classification (`click-7.1.2/classified-batch0.json`), after the candidate list, batch by batch under the stopping rule in the rules.

Reproduce the candidate list (scratch checkout of the pinned commit; `python3 -I` only):

```sh
python3 -I gt_click_enumerate.py <checkout>/src/click <out>      # deterministic; diff against click-7.1.2/
python3 -I gt_click_sample.py click-7.1.2/targets.json 30 <out>/blind-sample.txt
```

## The gate scorer (GCLI-72)

`gate_score.py` scores a GlyphIndex JSON (the `src/types.ts` shape) for a
repository checkout against the committed ground truth: click 7.1.2
(`click-7.1.2/`) and requests at 3c7baaa (`requests-3c7baaa/`, with
`../python-lsp-measurement/gt3_classified.json` as the pyright baseline). Standard
library only; no analyzer runs. It implements the conventions committed with the
ground truth and cited in its docstring: the true / poly / excluded /
other-definition sets and their evidence (`gt_rules_click.md` R1'-R5' and Addenda
1-6), both recall denominators, both precision sides, poly reported and not scored
(Addendum 4 Q4), the site-level Wilson gate and the information-only target-level
figure and cluster bootstrap.

**The repository verdict (DEC-303 (a5) Q5, arm B).** `REPOSITORY VERDICT: PASS|FAIL`
is computed from the INDEPENDENT (all-attributable) side only: its recall >= 0.9,
its site-level Wilson lower bound >= 0.8 and its precision (the independent
precision side, a point value) >= 0.95. The pyright-comparable side is printed
beside it as a **baseline comparison** and contributes no verdict. A truth below
62 true sites (DEC-303 (a2) item 8) is `UNSUITABLE` and yields no verdict line.

**Mapping (an explicit requirement on the analyzer).** A target is
`file:defline qualname`. Per DEC-303 (a5) Q6 (arm A) the Python indexer emits an
additive, optional `qualname` field on symbols carrying the full enclosing
qualified name (for example `Parameter.type_cast_value._convert`); it is absent
for TypeScript and recorded in ADR 0002. `container` keeps its documented meaning
(the nearest class/interface/enum). The scorer reads `qualname`; a symbol without
it for a target is a missing symbol, named, and the run exits 6 rather than
scoring it as a miss (pinned by a test). A ground-truth site matches an edge when
the file and the call's first line agree, by multiplicity; only callers under the
scored package directory count.

**Constructors (ruling 1, arm A).** The analyzer records a construction against
the class AND its resolved `__init__` (two edges per construction); the scorer
credits each edge only to the symbol its `calleeId` names, so one edge per
construction scores at most one hit and one miss. On requests the 6 constructor
sites (PreparedRequest 3, MockRequest 2, HTTPBasicAuth 1) give a one-edge ceiling
of **59/65 = 0.9077 (Wilson lower 0.8129)**, pinned by a test; a class whose
`__init__` is inherited needs the second edge to the class's RESOLVED `__init__`
along the MRO. On click the two constructor sites (Exit, BadParameter) give
78/80, also pinned.

**Overload groups (requests, Addendum 6 item 1).** A target keyed to an `@overload`
stub maps to the index symbol at the implementation line in
`overload-groups.json`; `targets.json` and the classification stay keyed at the
stub line. A symbol at the stub line only is a missing symbol (exit 6). Click has
no overloads.

```sh
python3 -I gate_score.py click <click-index.json>        # package src/click
python3 -I gate_score.py requests <requests-index.json>  # package src/requests
```

Exit codes: 0 ran (the verdict, pass or fail, is in the output); 2 usage (including
a refused non-default `--truth-dir`); 6 a malformed input, a sha256 mismatch, or a
target with no matching symbol; 7 zero invocation edges inside the scored package
(a run that read nothing fails rather than passes).

**Requests, both denominators.** The independent recall set and the precision
categories come from `requests-3c7baaa/classified-requests-independent.json`
(65 true, 64 direct and 1 inferred, 1 poly, 131 other-definition, 0 excluded);
the pyright-comparable recall set is `gt3_classified.json` (Addendum 5 item 1).
Both are 65 today; the direct-only count (64) is printed as information. The
independent precision side counts every emitted edge to the seeded targets inside
`src/requests`; the comparable side drops edges at sites flagged `inferred` (the 1
true inferred site and the non-true sites in `non-true-site-evidence.json`),
exactly as for click. The report prints both denominators, the unresolved shares,
the excluded and poly counts, and the sha256 of every input.

**Input and index integrity.** The sha256 of the 3 click and 5 requests inputs is
pinned in `gate_score.py`; a mismatch is exit 6 naming the file and both hashes.
A site listed twice in `true`, or in both `true` and `poly`/`excluded`, is exit 6;
so are two symbols matching one target, a duplicate symbol id, an unknown
`calleeId`, and an unknown site kind.

**Lines with both a true and a non-true candidate.** The line convention ignores
columns, so a line holding both a true and a non-true candidate of one target would
be scored on the line alone. The committed ground truth has **0** such lines for
click and **0** for requests. Reproduce:

```sh
python3 -I - <<'PY'
import json, collections
for label, truth, targets in (
    ("click", "click-7.1.2/classified-batch0.json", "click-7.1.2/targets.json"),
    ("requests", "requests-3c7baaa/classified-requests-independent.json", "requests-3c7baaa/targets.json"),
):
    d = json.load(open(truth)); t = {f"{x['file']}:{x['line']} {x['qualname']}": x for x in json.load(open(targets))}
    n = 0
    for k, v in d["targets"].items():
        true = {e["site"] for e in v["true"]}
        seen = collections.defaultdict(set)
        for c in t[k]["candidates"]:
            s = f"{c['file']}:{c['line']}:{c['col']}"
            seen[(c["file"], c["call_start_line"])].add("true" if s in true else "non-true")
        n += sum(1 for cats in seen.values() if len(cats) > 1)
    print(label, n)
PY
```

**Tests.** `test_gate_score.py` builds stub indexes from the ground truth (no
analyzer) and pins the expected numbers. From this directory:

```sh
python3 -I test_gate_score.py                                  # 39 tests
python3 -I -m unittest discover -s . -p 'test_gate_score.py'   # same, via unittest
```

`python3 -I -m unittest test_gate_score` does not work on Python 3.11+: `-I`
implies `-P` (`sys.flags.safe_path`), so cwd is not on `sys.path` and unittest
cannot import the sibling module by name; use one of the two forms above, or
`python3 -m unittest test_gate_score` without `-I`.

## Requests under the independent denominator (GCLI-74, S0b)

DEC-303 (a2) ruling 2 scores requests under both denominators. `gt3_classified.json` (the 65 sites pyright was scored on) is untouched. The
candidate list for the SAME 46 pre-registered targets at `psf/requests` `3c7baaa05ab4aa49cc819ce3a819d260de19c157`, `src/requests`, is re-derived with the
click tooling (alias-aware, subclass constructions): `python3 -I gt_requests_candidates.py <checkout>/src/requests <out> test/python-lsp-measurement/derived/targets.json`
(deterministic; `requests-3c7baaa/`). It has 197 candidate sites for the 46 targets (986 calls and 43 decorator sites in the package); all 65
pre-registered true sites are among them. The classification is written to a new file AFTER this candidate list, under the rules in `gt_rules_click.md`
(Addenda 1-4), with `receiver_evidence` per true site.
