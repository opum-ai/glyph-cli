---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Add Python through a native in-process indexer
tags:
  - python
  - tree-sitter
  - indexer
  - measurement
summary: Python in glyph 0.1.0 is a native in-process tree-sitter indexer with glyph-owned semantics and no language server (DEC-303 (a1)); drafts the gate and a held-out repository.
generated:
  by: lore/0.14.1
  at: 2026-11-23T20:29:02.000Z
---

# Add Python through a native in-process indexer

## Status

**Accepted.** Rewritten for DEC-303 (a1) and accepted with the ten rulings of DEC-303 (a2) below (opum-ai/opum-doc#1932, commit 4d8cbcbf); build slices may proceed. DEC-303 ruled on
2026-11-23 that glyph 0.1.0 includes Python. Its (a1) amendment, the operator's first-party answer relayed on
opum-ai/opum-doc#1932 (commit e2ceee29), reads: "THE ROUTE CHANGES. ... 'native python support like typescript'. glyph does
NOT use a language server for Python. Items 1, 3 and 4 of DEC-303 are superseded. Item 2 (the same command contract per
language, never a silent empty) and item 5 (the release floor; the tag waits for Python) stand." This record drafts opum-doc's
design and the gate; opum-doc owns the design, so the text below keeps **what opum-doc ruled** apart from **what glyph-cli
drafted that no ruling covers**. It contains no build code and decides no library. Tracked under GCLI-68.

The earlier version of this ADR proposed pyright's language server behind an LSP adapter. It is superseded, not deleted: its
text is `test/python-lsp-measurement/lsp-design-record.md`, and its harness and results stay in `test/python-lsp-measurement/`
as the baseline this design is scored against. "Section 5" and "D1" to "D5" below refer to that file.

## Context

Glyph answers `callers`, `impact`, `diff`, `code-map` and `--stream` from a `GlyphIndex` (symbols and call sites) that
`src/indexer.ts` builds from one TypeScript program through the compiler API, resolving each call site to its declaration with the
type checker, caches under `$GLYPH_CACHE_DIR`, and can build for a commit with no checkout (`--ref`, `src/snapshot.ts`).
TypeScript publishes an `unresolvedSites` count from a syntactic enumeration of calls. Python has no compiler API in a Node
process; the operator chose to build the equivalent natively rather than run a server.

## Decision

### Ruled by opum-doc (DEC-303 (a1) and the adopted packet items)

Python is indexed by glyph's own analyzer, in process, producing the same `GlyphIndex` shape the queries already read.

1. **tree-sitter's Python grammar as a WASM build**; no Python runtime, interpreter, environment or server process.
2. **Glyph owns the semantics**: repository-local module and import resolution (absolute, relative, aliased, re-exported;
   `src/`, `lib/` and `packages/*/src` roots), scopes, class and method attribution, inheritance, constructor calls recorded
   against their class, decorators.
3. **Receivers that need inference are reported unresolved and counted, never guessed.** `self`, `cls` and known-class bindings
   are attributed. The parser sees every call, so the unresolved count is exact (see "What 'exact' covers" for its scope).
4. **The command contract is the same per language, never a silent empty** (DEC-303 item 2). Additive contract fields are
   permitted and recorded in ADR 0002 (the old D4, option A).
5. **One language per run** (the old D2, option A).
6. **Exit 7 (`indeterminate`) only when a first-party package root fails to resolve; every other unresolved first-party import
   is counted and named** (the old D5, option B).
7. **The gate** below, scored against pyright's numbers. A shortfall goes to opum-doc with the numbers; the fallback named in
   opum-doc's relay of the (a1) design (point 4; in no file this record can cite), pyright in-process as a library, is the operator's decision.
8. **ADR 0008 names DEC-303 (a1) before any build slice**, and the 0.1.0 tag waits for Python.

### Drafted by glyph-cli (the (a2) rulings below bind where they touch these)

- **Additive contract entries** (the old D4 list, carried over): a `decorator` site kind; a `language` entry in the `index`
  block; a "language not indexed" entry in the coverage line; an unresolved-first-party-import count; a `--language` global
  option declared in `help --json`; `not_found` (exit 3) answers that name the language (restored from the old list, where it
  was present); a per-answer note where a constructor call is recorded against a class. TypeScript leaves them absent or constant.
- **The source roots** are those opum-doc listed, plus the repository root itself (an `app/` directory at the top level).
  Adding the root is this draft's proposal.
- **Inheritance** uses the method resolution order over in-repository bases; a method found only in a base outside the repository
  is not attributed to a repository symbol and its bin is the one rule decision 7 requires for the case.
- **The cache key** gains the language, the analyzer version and the grammar version beside the commit. `--ref` reads the tree
  from the commit as TypeScript's does; a native analyzer has no interpreter or installed environment to differ, which removes
  the layout failure the pyright measurement found (`results/layouts.txt`: an out-of-root analysis silently lost every absolute
  import edge, 0/5 on the fixture).
- **The exit-7 trigger, natively.** A name is a *first-party package root* when it names a package directory (one holding `__init__.py`)
  anywhere in the repository tree outside excluded paths such as virtual environments; bare `.py` files do not count (decision 6). The run is `indeterminate` when an import binds such a name and glyph's resolution over its source roots finds no
  file for it: the roots are wrong or incomplete, which is the measured silent-loss mode. A name that is not first-party
  (no such directory or file) is external, recorded by import binding. Every other failed first-party import (a missing
  submodule, a generated `_pb2`, an optional extension) is counted and named. Roots and what counts as first-party are ruled in decision 6.

### What "exact" covers

The count is exact over explicit call expressions, the nodes the parser labels as calls. Dispatch that is not a call
expression is not enumerated: property access, operators and dunders (`a + b`, `a[i]`, `len(a)` reaching `__len__`), `with`,
iteration, `del`, and bare `@d` decorators (recorded as `decorator` sites, not call sites). Every call expression falls in one
bin; the draft proposes four, so `x.append(1)` on an untyped list does not mix with unknown in-repository calls:
**resolved in the repository** (an edge), **resolved external** (the callee is bound by an import of a non-first-party module
or is a builtin), **unresolved: receiver needs inference**, and **unresolved: name not statically bound** (star import,
`getattr`, a name bound only at run time). The unresolved bins are published separately, and the resolved-external share is published too: a shadowed builtin (a local
`open`, `type`, `format`) would otherwise be misbinned as external without a trace. "Exact" holds only for trees without parse
errors: tree-sitter emits `ERROR` and `MISSING` nodes and calls inside them can be dropped, so the count of `ERROR` regions and the
files holding them are published, and a run over files with errors does not claim the count exact. For comparison with TypeScript,
which publishes `unresolvedSites` as every site that did not resolve in the repository (`src/types.ts`), Python's `unresolvedSites`
is the sum of the two unresolved bins, with the resolved-external bin beside it; whether TypeScript's external calls fall in
`unresolvedSites` is checked against `src/indexer.ts` when the slice is written. For the pyright comparator the denominators must
agree: pyright's `definition` count of 1,028 is every named call and decorator (`gt_rules.md` says "986 + 43 decorator sites", which sums
to 1,029; the one-site difference is pre-existing and unexplained), whereas glyph's exact count is of call expressions with decorators separate, so the
comparison is made over call expressions plus decorator sites on both sides. This is a proposal; opum-doc rules the bins.

## The gate

The ruling (DEC-303 (a1) item 4) gives the bar: incoming-call recall of at least 0.9 with a Wilson lower bound of at least 0.8, and
precision of at least 0.95, on `psf/requests` and on a held-out, less-annotated second repository whose ground truth is committed
before any run, with pyright's numbers as the baseline. **Each repository must pass separately.** The Wilson bound attaches to
recall; precision is a point value. ("Item 4" here is point (4) of opum-doc's relayed (a1) design, which restates the gate; it is not
DEC-303's original item 4, which (a1) supersedes.) **`psf/requests` is in-sample for the native build**: its 65 sites, pyright's
misses on them and the constructor mapping designed on them are committed and have been read, so passing it shows less than passing
a repository nobody tuned on, which is the reason for the second one.

**Sample size, from `test/python-lsp-measurement/results/wilson-floor.txt` (`wilson_floor.py`, the formula of `score.py`).**
With whole hits, 54/60 = 0.9000 has Wilson lower bound 0.7985 and fails; 55/60 = 0.9167 passes (0.8193); 55/61 = 0.9016 passes
(0.8016); at 65, 59 hits give 0.8129 and 58 hits (0.8923, lower 0.7940) fail. For a recall of exactly 0.9 (a fraction of a hit,
the table's second block) the lower bound crosses 0.8 between n = 61 (0.7995) and n = 62 (0.8005). **Floor, accepted by DEC-303 (a2)
item 8: at least 62 true sites**, the smallest n at which a recall of exactly 0.9 meets the bound; a whole-number result needs 56 or
more hits at 62. For requests (65 sites) 59 or more hits are required. For precision, information only: a perfect score has a Wilson lower bound
of at least 0.95 only from 73 emitted edges (`results/wilson-floor.txt`), and precision's n is the emitted edges to the seeded
targets, not the true sites.

**Scoring conventions ruled by DEC-303 (a3)** (opum-ai/opum-doc#1932, commit e540d4ff, accepted, decided by the operator; verbatim as relayed): "Q1
Forwarding decorators (for example @contextmanager): attribution stays and the site is true. Q2 Version and platform branches: PY2 branches are evaluated
under Python 3. Platform branches (WIN, sys.platform) are all reachable, matching pythonPlatform "All". A callee defined in both arms of a platform branch is
multiply-bound. Q3 Precision: the pyright-comparable precision side excludes edges at inferred sites, for comparability with the baseline. The independent
side counts them. Q4 Polymorphic dispatch: polymorphic sites are reported separately and NOT scored. The gate measures resolution glyph claims to do, not
class-hierarchy dispatch it deliberately does not guess." Standing rule, from the same ruling: a site counts when a human with the whole repository can
attribute it without dynamic dispatch or runtime state; when it is genuinely ambiguous, it is excluded and reported; glyph-cli records each such convention
in `test/python-gate/gt_rules_click.md` with its label effect and escalates only when a convention would change whether a repository passes the gate. The
effect on the held-out batch is in that file's Addendum 4: 80 true sites, 70 of them direct.

**Baseline, from committed files only.** On `psf/requests`, pre-registered sample (46 targets, 65 true sites), pyright's incoming calls:
default platform 58/65 recall (0.892, Wilson 0.794-0.947), precision 58/58, `results/union-real-default.txt`;
`pythonPlatform: "All"` 59/65 (0.908, 0.813-0.957), precision 59/59, `results/union-real-allplat.txt`. With a constructor mapping
designed after the misses were seen (in-sample, `gt_rules_addendum.md` item 3): 64/65 default and 65/65 under `"All"`, same
files. The seven default-platform misses (six constructor calls recorded against the class, one platform-conditional function)
are the `differs:` lines of `results/union-real-default.txt`. The alias set (post hoc, 4 targets, 15 true sites, `gt4_alias.json`)
is the other baseline row: pyright's incoming calls found 2 of the 15 (`results/score-alias-default.txt`, `calls_incoming_recall`). Resolution at call sites,
as the comparator for the unresolved share: pyright's `definition` returned no location at 66 of 1,028 call sites
(`results/score-real-default.txt`, "none": 66). The harness and the scorers read pyright's raw LSP output (`score.py`, `union.py`) and nothing yet maps a `GlyphIndex` into them. **The
mapping and the scoring conventions below are fixed and committed together with the held-out ground truth, before any analyzer
run, and are not left to a build slice**: the same worker builds the analyzer, so an unfixed mapping is a way to meet the gate by
redefinition. Conventions (drafted; the ones that depart from `gt_rules.md` are decision 10, ruled in (a2)):
- **Decorators.** `gt_rules.md` R4 makes `@d` a call to `d`; this record publishes bare `@d` as a `decorator` site, not a call
  site. For scoring, decorator sites count as incoming edges to `d` (R4 unchanged), reported as their own kind.
- **Constructors.** R2 sends `Cls(...)` to `Cls.__init__`; addendum item 8 records that constructions of a subclass inheriting
  `__init__` are invisible to the requests ground truth and scorer. The held-out ground truth draws candidate sites for every
  subclass construction that inherits an `__init__` (click's `Command`, `Group`, `Parameter`, `Option` hierarchy is that case), so
  glyph's MRO-correct edges are not scored as false positives. The scorer credits an edge to the class and to the resolved
  `__init__` as decision 1 settles.
- **Files.** R5 excludes callers outside the package directory. The scorer drops glyph edges whose caller file is outside the
  scored package directory; which files glyph itself indexes (`tests/`, `scripts/`, `docs/` examples) against which it resolves over is
  decision 10, because losses outside the scored directory are invisible to both measurements.
- **Lines.** A site matches when the file and the line of the call expression's first token agree (R-kinds: "the call's line"); for
  a call whose callee spans lines, the first line of the call expression. The same convention is applied to the ground truth and
  to the mapping.
- **Controls.** Addendum item 10: an alias-only target must not be drawn as a zero-truth precision control; the held-out draw
  enumerates alias calls first (below), so a control has no calls under any name.

**What the gate must report beside recall**, so that unresolving cannot pass for accuracy: the repository-wide unresolved share
(per bin) next to the recall, per repository; the share of true sites the ground truth excluded as undecidable, with its count
(requests never committed one: `gt3_classified.json` holds only `true`, `poly` and `note`, and the rule R1 "counted" is not recorded
in any committed file); and the alias census (below).

**Pyright on the held-out repository.** The ruling's baseline is pyright, so the committed harness is run on the held-out repository
with the same ground truth once that ground truth is committed, and its numbers are reported beside glyph's. Not run here: there is
no second-repository ground truth yet.

## The held-out repository (accepted: click 7.1.2)

The gate's value comes from a repository the design was not shaped on and that stresses the unannotated case, where a syntactic
analyzer meets receivers it cannot type. **requests is not that repository.** Measured (`results/annotation-count.txt`, produced by
`annotation_count.py`; "any" = a def with any annotated parameter or a return annotation; the parameter share excludes a leading
`self` or `cls` in a class body; every run parsed every file, 0 skipped):

| tree | commit | files | defs (of which `@overload` stubs) | annotated, any | parameters annotated (of) | classes |
|---|---|---|---|---|---|---|
| **`pallets/click` 7.1.2, `src/click`** | `1784558ed7c75c65764d2a434bd9cbb206ca939d` | 17 | 474 (0) | **0 (0.000)** | **0 (810)** | 58 |
| `pallets/click` 8.1.8, `src/click` | `934813e4d421071a1b3db3973c02fe2721359a6e` | 16 | 512 (24) | 501 (0.979) | 900 (914) = 0.985 | 67 |
| `psf/requests`, `src/requests` (the gate's pinned set) | `3c7baaa05ab4aa49cc819ce3a819d260de19c157` | 19 | 268 (20) | 265 (0.989) | 399 (399) = 1.000 | 52 |

Limits of the measure, stated: `@overload` stubs count as defs (requests' 20 and click 8.1.8's 24 are all annotated, which inflates
the "any" share a little); lambdas, type comments and `.pyi` stubs are ignored; "any" is lenient (a lone `-> None` counts), which
is why the parameter share is given. The parameter share is what bears on the receiver question: at the pinned requests every
non-`self` parameter is annotated, so a native analyzer reading annotations meets almost no receiver that needs inference there.

The tags were checked with `git ls-remote --tags https://github.com/pallets/click.git`, recorded in the same file: `7.1.2` is a
lightweight tag at `1784558e…`, and `8.1.8` is an annotated tag whose peeled commit (`refs/tags/8.1.8^{}`) is `934813e4…`; both
scratch clones read that `HEAD`.

**The candidate: click at 7.1.2.** It is one real candidate; the alternatives are not measured, so this is not a ranked choice between candidates (decision 8 asks only whether to accept it). Its features for the gate: relative imports across a `src/` layout, a class hierarchy (`Command`,
`MultiCommand`, `Group`, `Parameter`, `Option`, `Argument`), a decorator-built API, and no annotations at all.

Risks, named rather than hidden:
- Under `gt_rules.md` R1 a parameter with no annotation or doc evidence is classed undecidable and excluded. In unannotated click
  most `ctx` and `param` receivers fall there, so a human applying R1 excludes exactly what the native indexer will not attribute,
  and recall is then scored on the easy sites. If the exclusions shrink the denominator below 62 true sites, or decorator-produced
  objects dominate, click 7.1.2 is unsuitable and the gate cannot be run on it as drawn.
- `@click.command` and `@click.option` replace a function with a `Command` or a modified function, so a call to the decorated name
  goes through `Command.__call__`, which R5 excludes; the "decorated name returns a different object" rule is written before its slice (decision 7).
- `_compat.py` defines names twice under `PY2` and `WIN` branches, with six-style aliases; `_winconsole.py` uses `ctypes`.
- It is a 2020 codebase; its idioms are not today's.
- The same worker would build the ground truth and the analyzer. Mitigation proposed: the ground truth is committed, with its
  exclusions pre-registered and their share, **before any analyzer runs**, and, as opum-doc decides, a second classification
  pass by an independent reader; "human-attributable" is defined (decision 2) independently of the analyzer's rules.
- **Held-out-ness is already weakened:** this worker has read click's source and its annotation counts. The ground truth is committed before
  build slice 1 and the indexer is not tuned on click; a result that is tuned on it is reported as in-sample.

Procedure if accepted, mirroring the requests set: pin the SHA; seed about 40 targets with the stratified sampler and a fixed seed
(`gt1_enumerate.py`); hand-classify candidate sites by `gt_rules.md` and its addendum, with 9 or more zero-truth targets as
precision controls. **Pre-registered fork: if the first 40 seeded targets yield fewer than 62 true sites, further targets are drawn
from the same seed sequence, in order, before any run, until 62 is reached or the candidates are exhausted; if they are exhausted
below 62, the repository is declared unsuitable and reported to opum-doc, not run.** **Candidate-finding includes aliased and
re-exported calls** (the requests sampler matched callee names only, `gt_rules_addendum.md` item 1, so it was blind to the calls the
native design claims to handle); the alias census (`alias_enum.py`) is not a gate component and stays the post hoc row it was on
requests. Commit the ground truth, the mapping and conventions above, and the provenance (a scratch repository bundle, as for
requests) before any run. **No second-repository ground truth is committed with this record.** (Alias calls are drawn into the sample rather than run as a census: the draft's choice, within the accepted procedure "as drafted".)

## Ruled by opum-doc (DEC-303 (a2))

opum-doc ruled all ten decisions this draft had listed, each arm A as recommended, recorded verbatim on opum-ai/opum-doc#1932
(commit 4d8cbcbf, read by the leader by ref). The rulings, as relayed:

1. **Constructor rule:** "record C(...) against the class AND its resolved __init__, with a per-answer note where __init__ is not what runs."
2. **Recall denominator:** "every call a human with the whole repository can attribute, defined independently of the analyzer's rules; requests is scored under both this and the pyright-comparable denominator."
3. **Known-class binding:** "conservative: a single binding to a constructor call or import, or an annotation, with Optional and Union-with-None unwrapped; return annotations are not followed; self.x.m() is unresolved and counted."
4. **Interval:** "site-level Wilson is the gate; the cluster bootstrap is reported beside it for information and does not gate."
5. **Gate timing:** "build slices proceed now; both measurements must pass before any Python slice merges toward a release."
6. **First-party roots:** "a directory with __init__.py outside excluded paths, never a bare .py file or a stray test/ directory; unusual layouts exit 7 until a root is declared."
7. **Names that cannot be bound once:** "one stated rule or an unresolved bin with a reason per case, written before the slice that handles it; keep each rule short, the purpose is the stated-limits list, not a specification."
8. **Held-out repository:** "click 7.1.2, with its risks and the pre-registered exclusions and sample fork as drafted; the floor of at least 62 true sites is accepted."
9. **Grammar and WASM packaging:** "the dependency slice measures the candidates under ADR 0007 and opum-doc rules the pick on those numbers."
10. **Indexed scope:** "every .py file outside excluded paths is indexed; the scorer counts only package-directory callers."

"Release floor unchanged." The detail those rulings refer to is in the sections above: the case list for item 7 is the one in the
draft (multiply-bound names, decorated names that return another object, `super()`, `cls(...)`, properties, star imports and
`__all__`, re-exports beyond `__init__.py`, scopes, module identity, dynamic dispatch, external-base methods, parse errors), and
each case's rule is written, short, before the slice that handles it.

**Not chosen** (the B arms, kept so the record shows what was declined): the class-only constructor record; excluding
inference-needing sites from the recall denominator under the old R1; a cluster-robust gating interval; measuring before any
build slice; auto-adding roots and treating bare modules as first-party; leaving the case rules to the slices; naming a
different held-out repository; naming the grammar package in this record; indexing only the package directory.

## Consequences

- Python adds a tree-sitter grammar and runtime as a dependency and an analyzer glyph owns and must keep correct; there is no
  server, no interpreter, no environment, and no per-run start-up wait.
- The release floor is DEC-303 item 5: Sonnet writers and an Opus review per slice (as relayed by the leader; the leader also requires
  the Opus review at the exact green head of a `package.json` change). Slices are proposed only after acceptance; none is started.
  The 0.1.0 tag waits for Python.
- What is unproven: recall on unannotated code (the held-out repository is the test), metaprogramming-heavy code, scale and
  `--ref` cost. Unresolved calls are counted in bins, so a poor result shows as a high unresolved share with numbers, not as a
  silent loss.
- The LSP measurement stays in `test/python-lsp-measurement/` and is re-scorable as the baseline.
