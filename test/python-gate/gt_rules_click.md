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

## Addendum, written with the classification (after the candidate list, commit 2ac429b; the rules above are unchanged)

1. **`multiply-bound` is an exclusion reason.** A callee defined twice under `if PY2:` / `else:` (here `get_text_stdin`, lines 248
   and 446 of `_compat.py`) is a call to whichever definition the run-time branch binds; a static analyzer sees both, so the site is
   excluded from both targets and counted, as `platform-conditional` code was handled for requests.
2. **Candidate-finding is by callee name** (and alias, and subclass construction). A call whose callee has no name (`cls(...)`,
   `f = obj.m; f()`) is never a candidate: the `dynamic` blind spot of R5, shared with the requests ground truth, stated, not measured.
3. **The unit of the classification is the (target, site) pair.** A site that is a candidate of several targets (e.g. `self.invoke(...)`
   for five `invoke` definitions) is classified once per target; the same site can be true for one target and `other-definition`
   for another. `other_definition` counts in `classified-batch0.json` are therefore per target.
4. **Batch 0 reached the stopping rule** (cumulative true sites at or above 62), so batches 1 and 2 are not classified and are
   not scored: see `classified-batch0.json` `summary`. Two targets (`echo`, `term_len`) hold 36 of the true sites; the target-level
   figure and the cluster bootstrap are reported beside the site-level interval for that reason.

## Addendum 2, 2026-11-23T20:39Z: rule gaps found by the blind classifier (batch-0 labels in `classified-batch0.json` are NOT changed)

The independent blind unit agreed with all 30 labels of the seeded sample (15 true, 15 other-definition; receiver evidence agrees on
all 14 direct and the 1 inferred). 30 pairs is a small sample: no agreement rate is quoted. It found five gaps in the rules. Each
gets one rule below, the pair that motivated it, and its effect on the committed batch-0 counts (81 true, 71 direct, 10 inferred; 8
polymorphic; 2 excluded). Where a gap is a design choice rather than a clarification it is an open question for opum-doc, the labels
stay as committed, and the effect of the alternative is reported.

1. **A decorator that returns a plain forwarding function (`@contextmanager`, `functools.wraps`-style).** Motivating pair: 29,
   `TextWrapper.extra_indent` (`@contextmanager`). R5' `decorator-replaced` applies only when the call goes through a returned
   OBJECT's `__call__` that does not forward to the decorated definition (click's `@command` replacing a function with a `Command`).
   A forwarding wrapper keeps the call attributable to the decorated definition: **true**. *Open for opum-doc (design choice):*
   (A, recommended) as stated, a forwarding decorator keeps attribution, so no label moves; (B) treat every decorator not provably
   transparent as `decorator-replaced`, which moves one label: `formatting.py:85:21` for `extra_indent` true to excluded, 81 to 80 and
   71 to 70, and `extra_indent` becomes a zero-truth target.
2. **Platform and version branches.** Motivating pairs: 8 (Windows-only `_winconsole.py`) and 10 (a Python-3 branch). *Open for
   opum-doc (design choice):* (A, recommended) a **version** branch (`PY2`) is evaluated under Python 3, so a site or definition in
   the Python-2-only arm is unreachable and the site in an `else` arm is reached; a **platform** branch (`WIN`, `sys.platform`) is
   treated as reachable (the `pythonPlatform: "All"` reading used for requests), and a callee defined in both arms of a platform
   branch is `multiply-bound`. (B) every branch is reachable (the static view): both arms of `PY2` count. The committed labels
   follow B. Under A exactly two labels move, found by an `ast` check of every batch-0 true, polymorphic and excluded site against
   `PY2`, `not PY2`, `WIN` and `not WIN` branches: `testing.py:190:24` (`EchoingStdin`, in the `if PY2:` arm) true to excluded
   (`unreachable-version-branch`), 81 to 80 and 71 to 70; and `_compat.py:525:15` (`get_text_stdin` at line 248, in the `if PY2:` arm)
   excluded `multiply-bound` to other-definition (excluded 2 to 1). Excluded sites are ignored by both recall and precision, so the
   analyzer is not penalised either way; the choice only fixes the denominator. The Windows sites (`_winconsole.py`, `_compat.py:703`)
   are true under both.
3. **Evidence on sites that are not true.** Motivating pairs: 15 and 25 needed flow tracing to reach other-definition, and the file
   has no field for it. Rule: from the next classification onward a polymorphic or other-definition site whose attribution needed
   flow or call-site tracing is flagged `inferred` too. *Open for opum-doc:* whether the pyright-comparable PRECISION side excludes
   edges an analyzer lists at `inferred` sites (ruling 2 names the pair of denominators for recall; precision is not stated). Batch 0
   is not re-labelled; no true-site count changes.
4. **A receiver that can never be the target's class.** Motivating pair: 21 (`sub_ctx.command.invoke(...)`, target `CliRunner.invoke`).
   Rule: `ambiguous-receiver` only when the receiver could be an instance of the target's class (or a subclass); when every class it
   can be is provably not the target's, the site is `other-definition`. No batch-0 label moves (pair 21 was already
   other-definition; the one `ambiguous-receiver`, `_compat.py:744:22`, can be a `_NonClosingTextIOWrapper`, a stdout wrapper, so it stays).
5. **Which line identifies a decorated definition.** Rule: a symbol is identified by the line of its `def` or `class` keyword (the
   `lineno` of the `ast` node under Python 3.8 or later; the host is 3.15.2), not by a decorator line above it; a decorator
   application site is identified by the line of the decorator expression. Every committed target and site already follows this; no label moves.

## Addendum 3, 2026-11-23T20:41Z: downward polymorphic dispatch (found by the second blind pass; batch-0 labels NOT changed)

The committed `poly` label follows the polymorphic bullet of `gt_rules.md` R1, which is written for ONE direction: the receiver's
evident type is the class that overrides `m` (true for the override, polymorphic for the base). `gt_rules_click.md` R1' omitted that
bullet. Sites 3, 5, 7, 9 and 10 of the exclusion set run the other way: the receiver's evident type is a BASE (`self` inside a base
method, `except ClickException as e`) and the target is a subclass override reached by dynamic dispatch; site 9 has no base definition at
all (`Parameter` defines no `_parse_decls`; `Option` and `Argument` do). The comparison is in `click-7.1.2/second-pass-comparison.txt`
(9 of 10 labels agree; the one disagreement, `exceptions.py:42:37`, should be other-definition, poly 8 to 7, no true-site change).

Rule proposed (a clarification of R1 in both directions): **a site whose receiver's evident class is D resolves to the definition D finds
for the method (nearest in D's MRO); an override of that method in a subclass of D is reached only by dynamic dispatch and the site is a
polymorphic site for that override.** *Open for opum-doc (design choice; it changes what is a true site on click):*
- (A, recommended) a polymorphic site, in either direction, is reported separately and is not scored for recall or precision, as R1 did
  for requests: the committed counts stand, **81 true, 71 direct**; cost: a real call to an override is invisible to the gate, so an
  analyzer that resolves it (by class-hierarchy analysis) earns nothing for it and is not penalised for it.
- (B-live) a downward-dispatch site counts as TRUE for each override that is live (constructed or raised in the repository, one per
  site and target; site 9 counts once for `Option._parse_decls`): batch-0 sites 3, 7, 9, 10 become true (sites 4, 5, 6 are for
  `CommandCollection`, never constructed in `src/click`, and stay polymorphic): **85 true, 75 direct** (all four have receivers
  `self` or an `except ... as e` name, so direct).
- (B-all) every override counts: sites 3, 4, 5, 6, 7, 9, 10 become true: **88 true, 76 direct, 12 inferred** (sites 4 and 6 have
  inferred receivers).
Under A the gate cannot reward class-hierarchy resolution; under B it can, at the price of a liveness judgment (B-live) or of
counting calls that cannot occur at run time (B-all). Combined with Addendum 2 option A the batch-0 counts under each reading are
80/70 (A, A), 84/74 (A, B-live), 87/75 (A, B-all) in the same order of tuple (true, direct) with testing.py:190 removed from the true set.

## Addendum 4, 2026-11-23T20:44Z: DEC-303 (a3), the operator's rulings on Addendum 2 and 3 (opum-ai/opum-doc#1932, commit e540d4ff, accepted, decided by operator)

Quoted verbatim as relayed:

> Q1 Forwarding decorators (for example @contextmanager): attribution stays and the site is true.
> Q2 Version and platform branches: PY2 branches are evaluated under Python 3. Platform branches (WIN, sys.platform) are all reachable, matching pythonPlatform "All". A callee defined in both arms of a platform branch is multiply-bound.
> Q3 Precision: the pyright-comparable precision side excludes edges at inferred sites, for comparability with the baseline. The independent side counts them.
> Q4 Polymorphic dispatch: polymorphic sites are reported separately and NOT scored. The gate measures resolution glyph claims to do, not class-hierarchy dispatch it deliberately does not guess.

Label effect of each, on the batch-0 classification (`classified-batch0.json`, rebuilt from `classify-batch0.txt`; history: fd0fc6b original,
661dada correction from the second blind pass, 8a49c2d this addendum's Q2):
- **Q1:** no label moves (`formatting.py:85:21` stays true). This is Addendum 2 rule 1, option A.
- **Q2:** two labels move, both done in 8a49c2d: `testing.py:190:24` true to excluded (`unreachable-version-branch`) and `_compat.py:525:15`
  excluded `multiply-bound` to other-definition. Final batch-0 counts: **80 true, 70 direct, 10 inferred; 7 polymorphic; 2 excluded**
  (`_compat.py:744:22` ambiguous-receiver, `testing.py:190:24` unreachable-version-branch); 80 other-definition pairs (per target).
  `multiply-bound` now means only a callee defined in both arms of a platform branch.
- **Q3:** no true-site label moves. The comparable side needs an evidence flag on sites that are not true: `derive_site_evidence.py` writes it
  mechanically to `click-7.1.2/non-true-site-evidence-batch0.json` (89 non-true pairs: 70 direct, 19 inferred) by the rule in its docstring (a receiver of
  `self`, `cls`, a class or a stdlib module name is direct; any other attribute receiver is inferred; name and decorator sites are direct). It adds
  no judgment after any analyzer output and does not relabel the classification. Recall under the pyright-comparable denominator is over the 70 direct
  true sites; precision on that side excludes emitted edges at sites flagged inferred (true or not); the independent side counts every emitted edge.
- **Q4:** no label moves. Addendum 3 option A: polymorphic sites, in either direction, are reported separately and not scored. This also settles that
  a polymorphic site is neither a recall miss nor a precision false positive.

**Standing rule (the operator's, relayed with (a3); applied from now on, quoted verbatim):** "glyph-cli applies the principle already ruled. A site
counts when a human with the whole repository can attribute it without dynamic dispatch or runtime state; when it is genuinely ambiguous, exclude it
and report it. glyph-cli records each such convention in gt_rules with its label effect. It escalates to opum-doc only when a convention would change
whether a repository PASSES the gate." Applied as an instruction: a further convention is recorded here as a dated addendum with its label effect on
the committed counts; a convention that would change whether a repository passes the gate (its recall, its Wilson lower bound or its precision crossing
0.9, 0.8 or 0.95 on either denominator) goes to the leader before it is applied. It is not used to relabel batch 0 beyond what (a3) states.

## Addendum 5, 2026-11-23T20:48Z: requests under the independent denominator (GCLI-74 / S0b); standing-rule conventions

Applied to the 46 pre-registered requests targets at `3c7baaa`, `src/requests`: candidate list `requests-3c7baaa/candidates.txt` (197 sites, committed a0f7eba before any
label), classification `requests-3c7baaa/classified-requests-independent.json` built by `build_requests_classified.py` from `gt3_classified.json` (read, never written;
byte-identical) plus a re-read of every candidate against the pinned source. Result: **65 true sites (62 direct, 3 inferred), 1 polymorphic, 131 other-definition,
0 excluded, 0 newly attributable beyond the 65**; 37 targets with a true site, 9 zero-truth. The re-read found NO site that R1 had left undecidable
among the candidates: requests is annotated (265 of 268 defs, 399 of 399 non-`self` parameters, `results/annotation-count.txt`), so every candidate receiver
was attributable. The three `inferred` true sites are `models.py:460` (`self.headers.copy()`, an attribute of `self`), `sessions.py:886` (`v.close()`, a loop variable
over `self.adapters.values()`) and `auth.py:302` (`r.request.copy()`, an attribute of an annotated parameter). The 1 polymorphic site is `v.close()` for
`HTTPAdapter.close` (downward dispatch from the `BaseAdapter` receiver; (a3) Q4, not scored).

Conventions decided under the standing rule (each with its effect; none changes whether a repository passes the gate, since no analyzer has run):
1. **Denominators on requests.** The pyright-comparable recall denominator is `gt3_classified.json`'s 65 (R1 as written, the set pyright's baseline was scored on, kept
   byte-identical). The independent denominator is the new file's 65 (identical: no new site). The `direct`-only count, 62, is reported beside them as information.
   Effect: the two recall denominators coincide on requests; the sides can differ only in PRECISION (Q3). No label changes.
2. **Evidence on non-true sites uses annotated parameters.** `derive_site_evidence.py` takes an optional package directory; a plain-name receiver that is an
   annotated parameter of the enclosing function is `direct` (R1 treats an annotated receiver as decidable, so the pyright-comparable side must too). On click
   (no annotations) the output is byte-identical with or without the directory (checked: 70 direct, 19 inferred, unchanged); on requests it gives 132 non-true pairs
   (58 direct, 74 inferred) in `requests-3c7baaa/non-true-site-evidence.json`. Effect: the comparable precision side drops an emitted edge at a site flagged
   `inferred`, so for requests it ignores the analyzer's edges at 74 non-true sites and at the 3 true `inferred` ones; the independent side counts them all.
3. **Control.** Because the candidate re-read produced no site beyond the 65, the "newly attributable" part of the blind control is empty; the control is the seeded sample of
   30 pairs (`requests-3c7baaa/blind-sample.txt`, seed 7), classified blind by an independent reader before it sees any of this file.

## Addendum 6, 2026-11-23T20:56Z: conventions found by the blind pass on the requests sample (GCLI-74); standing rule applied

The blind unit agreed with all 30 labels of the requests sample (12 true: 11 direct and 1 inferred, 1 polymorphic, 17 other-definition, 0 excluded; evidence agrees on every
true pair). 30 pairs is a small sample: no rate is quoted. Mechanical checks behind this addendum: `requests_convention_checks.py` → `requests-3c7baaa/convention-checks.txt`.
No convention below changes whether a repository passes the gate on either denominator, as far as can be known before an analyzer has run; if one does, it goes to the leader.

1. **@overload groups.** Three targets are overload STUBS, not the implementation: `to_key_val_list` (`utils.py:373`, implementation 376), `LookupDict.get` (`structures.py:127`,
   implementation 129) and `RequestEncodingMixin._encode_params` (`models.py:134`, implementation 151); `HTTPBasicAuth.__init__` (96) already is the implementation. Rule: an overload group is
   collapsed to its implementation before classification and scoring, and a call attributes to the group. `requests-3c7baaa/overload-groups.json` maps each stub-keyed target to its implementation line
   (`targets.json` and the classification are NOT rewritten; the scorer maps through the file; the S6 scorer needs that small follow-up). Effect: 7 of the 65 true sites sit on stub-keyed targets
   (`to_key_val_list` 5, `_encode_params` 2); their labels do not change (they are true under the collapse reading, which is also what the pyright baseline measured: `union.py` matches
   a callee at any definition line of the qualified name, stub or implementation). The 65 and the comparison with pyright's baseline are unchanged; `gt3_classified.json` is untouched. Click has
   no overloads (0 stubs, `results/annotation-count.txt`).
2. **Receiver evidence on non-true sites, extended.** `derive_site_evidence.py` (with a package directory) now also treats as `direct`: a module imported in the file (including `from . import x`) and an attribute
   chain off it (`os.environ`, `copy`); an annotated parameter; a name bound once in the enclosing function to a constructor call; `self.x` where `x` is annotated in the enclosing class; and `p.x` where
   `p` is an annotated parameter whose in-package class annotates `x`. Click output is byte-identical (`cmp`: 70 direct, 19 inferred, unchanged). Requests non-true pairs: **93 direct, 39 inferred** (the earlier
   rule gave 58/74). On the 18 non-true pairs of the blind sample the rule gives 12 direct / 6 inferred against the blind unit's 13 / 5 (one pair differs; the rule is not tuned further).
   Effect on the true labels: two requests true sites change from `inferred` to `direct` under the same rule, `models.py:460` (`self.headers.copy()`, `headers` is annotated in the class) and `auth.py:302`
   (`r.request.copy()`, `request` is annotated in `Response`); the classification file changes only in a separate commit citing the blind pass: **direct 62 to 64, inferred 3 to 1** (`sessions.py:886`
   stays inferred: a loop variable). The pyright-comparable RECALL denominator for requests is still `gt3_classified.json`'s 65, so the information-only direct count moves and no gate number does; the
   comparable PRECISION side now ignores analyzer edges at 39 non-true sites and the 1 true inferred site, not 74 and 3.
3. **Abstract-base methods.** A base method whose body is only `raise NotImplementedError` is a true target by the declared type of the receiver (Addendum 3 / (a3) Q4: overrides are polymorphic, not scored).
   Count: of the 65 true sites exactly **1** is on an abstract base after the overload collapse (`BaseAdapter.close`, `v.close()` at `sessions.py:886`); the check also flags 7 sites on the overload stubs
   (their `...` bodies), which rule 1 removes from the question. The alternative would make the denominator 64; the recall bar needs 59 of 65 hits against 58 of 64, so the convention does not by itself flip
   a verdict.
4. **Capability and build branches.** A branch on a capability or build property (`getattr(ssl, "HAS_SNI", False)`, an import guard, `TYPE_CHECKING`) is reachable, like a platform branch (consistent with (a3) Q2,
   `pythonPlatform: "All"`). Count: of the 65 true sites **1** sits under such a branch (`__init__.py:145:8`, `_check_cryptography`). The other conditionals in `convention-checks.txt` section 3 test data or run-time
   values (`if params is not None`, `isinstance`, `hasattr(self.raw, "stream")`), not capabilities, and the one platform branch (`proxy_bypass_registry`, `sys.platform == "win32"`) is covered by Q2: true.
5. **Both `os.environ.get` calls of `utils.py:820`** (columns 26 and 49) are candidates of `LookupDict.get` (`convention-checks.txt` section 5), both other-definition.
6. **"No in-repo subclass"** was a first-base grep; the check is now an `ast` test over ANY base (`convention-checks.txt` section 4). `MockRequest`, `HTTPAdapter`, `Session`, `Response`,
   `CaseInsensitiveDict` and `LookupDict` have none, which confirms pairs 8, 20, 27 and 28. In-package subclasses that exist: `BaseAdapter`→`HTTPAdapter`, `HTTPBasicAuth`→`HTTPProxyAuth`,
   `InvalidJSONError`→`JSONDecodeError`, `InvalidURL`→`InvalidProxyURL`, `PreparedRequest`→`_types.py:_ValidatedRequest`, `RequestEncodingMixin`→`PreparedRequest`,
   `SessionRedirectMixin`→`Session`; the candidate-finding already used any base for subclass constructions.
