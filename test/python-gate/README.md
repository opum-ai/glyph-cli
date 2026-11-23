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
