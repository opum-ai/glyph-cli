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

## Requests under the independent denominator (GCLI-74, S0b)

DEC-303 (a2) ruling 2 scores requests under both denominators. `gt3_classified.json` (the 65 sites pyright was scored on) is untouched. The
candidate list for the SAME 46 pre-registered targets at `psf/requests` `3c7baaa05ab4aa49cc819ce3a819d260de19c157`, `src/requests`, is re-derived with the
click tooling (alias-aware, subclass constructions): `python3 -I gt_requests_candidates.py <checkout>/src/requests <out> test/python-lsp-measurement/derived/targets.json`
(deterministic; `requests-3c7baaa/`). It has 197 candidate sites for the 46 targets (986 calls and 43 decorator sites in the package); all 65
pre-registered true sites are among them. The classification is written to a new file AFTER this candidate list, under the rules in `gt_rules_click.md`
(Addenda 1-4), with `receiver_evidence` per true site.
