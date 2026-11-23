# Addendum to gt_rules.md (written after the first results; gt_rules.md itself is unchanged)

`gt_rules.md` and `gt3_classified.json` are kept byte-identical to what was committed before pyright ran
(blob ids in `results/ground-truth-provenance.txt`). What was learned or decided afterwards is recorded here, so
nothing in the original file is edited.

1. **Alias blindness of the pre-registered sample (review finding).** `gt2_listing.py` collects candidate call sites by
   comparing the callee NAME with the target's name, so a call through `from m import f as g` is never a candidate and
   never classified. R5 should have listed it as excluded. None of the 46 sampled targets happened to have an aliased call
   site, so the 58/65 and 59/65 figures cannot show how pyright handles aliases; the fixtures can, and did.
2. **Alias set, added after the first results.** `alias_enum.py` lists every in-package relative `from .m import a as b`
   whose original `a` is defined in `m`, and every Name call of the alias (rule R1: a call to `a`; rebinding count printed,
   zero for all), plus the direct (unaliased) calls of those targets so precision on them is scored against a complete
   truth. It adds 4 targets and 15 true sites (`gt4_alias.json`). This is **post hoc**: chosen after seeing that the first
   sample had no alias calls. It is reported separately from the pre-registered sample and never merged into its figures.
3. **The constructor mapping is post hoc.** After the first results showed that call hierarchy attributes a constructor call
   to the class and not to `__init__`, the "union + ctor map" row of `union.py` was defined: for an `__init__` target of class
   C, also count the union (incoming plus outgoing) sites of class C and of subclasses that define no `__init__`. R2 already
   said `Cls(...)` is a call to `Cls.__init__`, so the ground truth is unchanged; the mapping was designed on the data it is
   then scored on, so that row is not an independent test of the mapping.
4. **No threshold was fixed in advance.** `gt_rules.md` says "not decided here". The 0.9 recall / 0.8 lower bound proposed in
   ADR 0008 was proposed after the results were seen. It is a proposal for opum-doc to rule on, not a pre-registered bar.
5. **Outgoing matches by location.** `outgoingCalls` names an aliased callee by its alias (`_is_prepared` for
   `is_prepared`), so `union.py` matches an outgoing range to a target by the callee's location (a definition of the target's
   qualified name in its file, on its `def` line or a decorator line above it). A first version matched by name and lost
   exactly the alias calls; a second used a window of +-3 lines and conflated neighbouring definitions (two false matches).
6. **A stale metadata field.** `fixtures/expected.json` carries `symbols_expected_count: 17`; 22 symbols exist and are
   scored. The field is not used by any script and the file is left as committed.
7. **Overloads and platform branches.** An `@overload` stub is a definition in the ground truth (it is a `def`); pyright's
   `documentSymbol` reports the implementation only, so stubs count as missing symbols (20 of the 22 misses on the default
   platform; the other 2 are the Windows-only definitions, recovered by `pythonPlatform: "All"`).
