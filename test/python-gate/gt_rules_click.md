# Ground-truth rules for the held-out Python gate (GCLI-69, ADR 0008, DEC-303 (a2) items 2, 8 and 10)

Fixed BEFORE any classification and before any analyzer run. Repository: pallets/click at
`1784558ed7c75c65764d2a434bd9cbb206ca939d` (tag 7.1.2), package directory `src/click`, 17 files. Python 3.15.2 `ast`
enumerates symbols and candidate sites (`gt_click_enumerate.py`, seed 303). These rules are `test/python-lsp-measurement/gt_rules.md`
(R1 to R5) with the changes below; the requests ground truth is not edited.

## What counts

R1'. A candidate site is a TRUE call to target T when, in normal runtime flow, the callee is T's definition, judged by hand
    from the whole repository (DEC-303 (a2) item 2: "every call a human with the whole repository can attribute, defined
    independently of the analyzer's rules"). The classifier may trace assignments, constructor calls, arguments passed by
    callers and class hierarchies anywhere under `src/click`; the analyzer's own limits (self/cls/known-class bindings) play no part.
    - A call whose receiver could be one of several unrelated classes and cannot be settled by reading the repository is
      AMBIGUOUS: excluded from recall and precision, counted, with the reason `ambiguous-receiver`.
    - Each true site also carries `receiver_evidence`, recorded WITHOUT regard to what any analyzer does:
      `direct` (a name, `self`, `cls`, an imported or in-module class, or a name bound once to a constructor call or annotated
      with a class) or `inferred` (the receiver's class needs flow or call-site tracing). The pyright-comparable denominator
      (R1 as written in `gt_rules.md`: a parameter with no annotation or doc evidence is undecidable) is: every true site except
      those with `receiver_evidence = inferred`. Both denominators are scored; neither is chosen after a run.
R2'. `Cls(...)` is a call to `Cls` (class targets) AND to `Cls.__init__` (init targets). A construction of a subclass that
    inherits `__init__` is a true call to the base `__init__` (addendum item 8; candidate-finding includes these).
R3. `super().m(...)` is a true call to the next base-class `m` in the enclosing class's MRO. (unchanged)
R4. A decorator application `@d` / `@d(...)` is a call to `d`; it is scored as an incoming edge to `d`, kind `decorator`
    (ADR 0008, decision 10). A function passed or stored without being called is NOT a call. (unchanged apart from the kind)
R5'. Excluded by construction and counted by reason: a call through a variable holding the callable, `getattr`, `__dict__`
    dispatch, strings (`dynamic`); a call to a decorated name whose decorator returns another object, so that the call goes
    through that object's `__call__` (`decorator-replaced`); calls in files outside `src/click` (tests, docs, examples); and
    sites that are textually a candidate but whose callee is a different definition (`other-definition`, the ordinary false candidate).
R6. Aliased and re-exported calls are candidates (`from m import a as b`, `import m as n`; enumerated in `allcalls.json`) and are
    classified like any other.

## Scoring conventions (committed with the ground truth; ADR 0008 "The gate")

- A site matches when the file and the first line of the call expression agree (`call_start_line` in `allcalls.json`); when two
  sites of one target share that line they are matched by multiplicity.
- Only edges whose caller is a file under `src/click` are scored (R5); glyph indexes every `.py` outside excluded paths.
- Recall = true sites found / true sites (both denominators); precision = true sites found / sites listed, over the emitted
  edges to the seeded targets. The Wilson interval at the site level is the gate; the cluster bootstrap is reported for information.
- Decorator sites are incoming edges; a constructor site is credited to the class and to its resolved `__init__` (ruling 1).
- Zero-truth targets (strata `zero-candidates`) are precision controls; targets whose only calls are aliased are not drawn into
  that stratum (an alias-aware candidate count of zero is required).

## Sample, batches and the stopping rule (pre-registered)

`gt_click_enumerate.py` draws three batches of about 45 targets from one seeded shuffle per stratum. Classification proceeds
batch by batch (batch 0, then 1, then 2) and stops at the first batch boundary at which the cumulative true sites (under the
all-attributable denominator) reach 62. If all three batches leave fewer than 62, the repository is declared unsuitable and
reported to opum-doc; it is not run. No other stopping rule, and no target is added, dropped or reclassified after an analyzer run.
