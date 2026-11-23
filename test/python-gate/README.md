# Python gate: held-out ground truth (GCLI-69, ADR 0008)

The held-out repository of the DEC-303 (a2) gate is pallets/click at `1784558ed7c75c65764d2a434bd9cbb206ca939d` (tag 7.1.2),
package directory `src/click`. Everything here is committed before any analyzer run; the order is checkable from file history:

1. the rules (`gt_rules_click.md`), the enumeration script and its candidate list (`click-7.1.2/candidates.txt` and the JSON beside it, no classification), and the seeded blind sample;
2. the classification (`click-7.1.2/classified.json`), after the candidate list, batch by batch under the stopping rule in the rules.

Reproduce the candidate list (scratch checkout of the pinned commit; `python3 -I` only):

```sh
python3 -I gt_click_enumerate.py <checkout>/src/click <out>      # deterministic; diff against click-7.1.2/
python3 -I gt_click_sample.py click-7.1.2/targets.json 30 <out>/blind-sample.txt
```

## The gate scorer (GCLI-72)

`gate_score.py` scores a GlyphIndex JSON (the `src/types.ts` shape) for a
repository checkout against this ground truth. Standard library only; no analyzer
runs. It implements the conventions committed with the ground truth and cited in
its docstring: the click batch-0 sets (true / poly / excluded / other-definition,
`gt_rules_click.md` R1'-R5' and Addenda 1-4), the two recall denominators
(all-attributable and pyright-comparable, DEC-303 (a2) item 2, Addendum 4 Q3),
poly sites reported and not scored (Addendum 4 Q4), the two precision sides
(Addendum 4 Q3), the site-level Wilson gate (Addendum 4 / ADR 0008) and the
target-level figure plus cluster bootstrap as information only.

**Mapping.** A target is `file:defline qualname`; `SymbolEntry` has no `qualname`
field, so the symbol's qualified name is read as `container + "." + name` (or
`name` when `container` is null). A target must map to exactly one symbol with the
same package-relative file, the same `line` and that qualified name; a target
with no such symbol is named and the run exits 6 rather than scoring it as a
miss. A ground-truth site matches an edge when the file and the call's first line
agree, by multiplicity; only callers under the scored package directory count.

```sh
python3 -I gate_score.py <click-index.json>                 # click 7.1.2, package src/click
python3 -I gate_score.py requests <requests-index.json>     # second reader, comparable recall only
```

Exit codes: 0 ran (the verdict, pass or fail, is in the output); 2 usage; 6 a
malformed input or a target with no matching symbol; 7 zero invocation edges
inside the scored package (a run that read nothing fails rather than passes).

**The requests second reader.** `gate_score.py requests` reads
`../python-lsp-measurement/gt3_classified.json` for the pyright-comparable recall
side only. Its `true` sites were classified under `gt_rules.md` R1, so they are
that denominator. The independent (all-attributable) denominator needs the
R1-undecidable sites classified, and that is **not committed**, so it is reported
as `not scorable`; precision is not scorable either (no candidate set or evidence
flags are committed). No labels are invented.

**Tests.** `test_gate_score.py` builds stub indexes from this ground truth (no
analyzer) and pins the expected numbers. From this directory:

```sh
python3 -I test_gate_score.py                                  # 14 tests
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
