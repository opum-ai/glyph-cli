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
  at: 2026-11-23T21:30:00.000Z
---

# Add Python through a native in-process indexer

## Status

**Proposed, rewritten for DEC-303 (a1).** It awaits opum-doc's acceptance before any build slice starts. DEC-303 ruled on
2026-11-23 that glyph 0.1.0 includes Python. Its (a1) amendment, the operator's first-party answer relayed on
opum-ai/opum-doc#1932 (commit e2ceee29), reads: "THE ROUTE CHANGES. ... 'native python support like typescript'. glyph does
NOT use a language server for Python. Items 1, 3 and 4 of DEC-303 are superseded. Item 2 (the same command contract per
language, never a silent empty) and item 5 (the release floor; the tag waits for Python) stand." This record drafts opum-doc's
design and the gate; opum-doc owns the design, so the text below keeps **what opum-doc ruled** apart from **what this draft
proposes** and from **what is open**. It contains no build code and decides no library. Tracked under GCLI-68.

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
   (a1), pyright in-process as a library, is the operator's decision.
8. **ADR 0008 names DEC-303 (a1) before any build slice**, and the 0.1.0 tag waits for Python.

### Proposed by this draft (opum-doc may change any of these)

- **Additive contract entries** (the old D4 list, carried over): a `decorator` site kind; a `language` entry in the `index`
  block; a "language not indexed" entry in the coverage line; an unresolved-first-party-import count; a `--language` global
  option declared in `help --json`; `not_found` (exit 3) answers that name the language (restored from the old list, where it
  was present); a per-answer note where a constructor call is recorded against a class. TypeScript leaves them absent or constant.
- **The source roots** are those opum-doc listed, plus the repository root itself (an `app/` directory at the top level).
  Adding the root is this draft's proposal.
- **Inheritance** uses the method resolution order over in-repository bases; a base outside the repository ends the chain and
  the call is recorded as resolved to the last known class or unresolved (decision 7).
- **The cache key** gains the language, the analyzer version and the grammar version beside the commit. `--ref` reads the tree
  from the commit as TypeScript's does; a native analyzer has no interpreter or installed environment to differ, which removes
  the layout failure the pyright measurement found (`results/layouts.txt`: an out-of-root analysis silently lost every absolute
  import edge, 0/5 on the fixture).
- **The exit-7 trigger, natively.** A name is a *first-party package root* when it is the top-level name of a directory or module
  in the repository tree (a directory holding `.py` files, or a `.py` file) outside excluded paths such as virtual
  environments. The run is `indeterminate` when an import binds such a name and glyph's resolution over its source roots finds no
  file for it: the roots are wrong or incomplete, which is the measured silent-loss mode. A name that is not first-party
  (no such directory or file) is external, recorded by import binding. Every other failed first-party import (a missing
  submodule, a generated `_pb2`, an optional extension) is counted and named. How roots are discovered is open (decision 6).

### What "exact" covers

The count is exact over explicit call expressions, the nodes the parser labels as calls. Dispatch that is not a call
expression is not enumerated: property access, operators and dunders (`a + b`, `a[i]`, `len(a)` reaching `__len__`), `with`,
iteration, `del`, and bare `@d` decorators (recorded as `decorator` sites, not call sites). Every call expression falls in one
bin; the draft proposes four, so `x.append(1)` on an untyped list does not mix with unknown in-repository calls:
**resolved in the repository** (an edge), **resolved external** (the callee is bound by an import of a non-first-party module
or is a builtin), **unresolved: receiver needs inference**, and **unresolved: name not statically bound** (star import,
`getattr`, a name bound only at run time). The unresolved bins are published separately. This is a proposal; opum-doc rules the bins.

## The gate

The ruling (DEC-303 (a1) item 4) gives the bar: incoming-call recall of at least 0.9 with a Wilson lower bound of at least 0.8, and
precision of at least 0.95, on `psf/requests` and on a held-out, less-annotated second repository whose ground truth is committed
before any run, with pyright's numbers as the baseline. The Wilson bound attaches to recall; precision is a point value.

**Sample size, from `test/python-lsp-measurement/results/wilson-floor.txt` (`wilson_floor.py`, the formula of `score.py`).**
With whole hits, 54/60 = 0.9000 has Wilson lower bound 0.7985 and fails; 55/60 = 0.9167 passes (0.8193). At 61 true sites 55
hits (0.9016) give 0.8016; at 62, 56 hits (0.9032) give 0.8045; at 65, 59 hits give 0.8129 and 58 hits (0.8923, lower 0.7940) fail.
So a held-out set needs at least **62 true sites**, which leaves a one-hit margin and lets an observed 0.9 meet the bound by itself. For
requests (65 sites) the required hits are 59 or more. For precision, information only: a perfect score has a Wilson lower bound
of at least 0.95 only from 73 emitted edges (`results/wilson-floor.txt`), and precision's n is the emitted edges to the seeded
targets, not the true sites.

**Baseline, from committed files only.** On `psf/requests`, pre-registered sample (46 targets, 65 true sites), pyright's incoming calls:
default platform 58/65 recall (0.892, Wilson 0.794-0.947), precision 58/58, `results/union-real-default.txt`;
`pythonPlatform: "All"` 59/65 (0.908, 0.813-0.957), precision 59/59, `results/union-real-allplat.txt`. With a constructor mapping
designed after the misses were seen (in-sample, `gt_rules_addendum.md` item 3): 64/65 default and 65/65 under `"All"`, same
files. The seven default-platform misses (six constructor calls recorded against the class, one platform-conditional function)
are the `differs:` lines of `results/union-real-default.txt`. The alias set (post hoc, 4 targets, 15 true sites, `gt4_alias.json`)
is the other baseline row: pyright's incoming calls found 2 of the 15 (`results/score-alias-default.txt`, `calls_incoming_recall`). Resolution at call sites,
as the comparator for the unresolved share: pyright's `definition` returned no location at 66 of 1,028 call sites
(`results/score-real-default.txt`, "none": 66). The harness and the scorers read pyright's raw LSP output (`score.py`, `union.py`),
and nothing yet maps a `GlyphIndex` into them; the gate needs a small adapter that writes glyph's edges in the shape the scorers
read, or a scorer that reads `GlyphIndex` directly. Which of the two, and who writes it, is part of the first build slice, not a
decision here, and the scoring rules (`gt_rules.md`, the Wilson function) are reused unchanged.

**What the gate must report beside recall**, so that unresolving cannot pass for accuracy: the repository-wide unresolved share
(per bin) next to the recall, per repository; the share of true sites the ground truth excluded as undecidable, with its count
(requests never committed one: `gt3_classified.json` holds only `true`, `poly` and `note`, and the rule R1 "counted" is not recorded
in any committed file); and the alias census (below).

**Pyright on the held-out repository.** The ruling's baseline is pyright, so the committed harness is run on the held-out repository
with the same ground truth once that ground truth is committed, and its numbers are reported beside glyph's. Not run here: there is
no second-repository ground truth yet.

## The held-out repository: a proposal for opum-doc

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

**The candidate: click at 7.1.2.** It is one real candidate; the alternatives are not measured and so not ranked, and this is not
an A/B (listed as decision 8). Its features for the gate: relative imports across a `src/` layout, a class hierarchy (`Command`,
`MultiCommand`, `Group`, `Parameter`, `Option`, `Argument`), a decorator-built API, and no annotations at all.

Risks, named rather than hidden:
- Under `gt_rules.md` R1 a parameter with no annotation or doc evidence is classed undecidable and excluded. In unannotated click
  most `ctx` and `param` receivers fall there, so a human applying R1 excludes exactly what the native indexer will not attribute,
  and recall is then scored on the easy sites. If the exclusions shrink the denominator below 62 true sites, or decorator-produced
  objects dominate, click 7.1.2 is unsuitable and the gate cannot be run on it as drawn.
- `@click.command` and `@click.option` replace a function with a `Command` or a modified function, so a call to the decorated name
  goes through `Command.__call__`, which R5 excludes; the "decorated name returns a different object" rule is open (decision 7).
- `_compat.py` defines names twice under `PY2` and `WIN` branches, with six-style aliases; `_winconsole.py` uses `ctypes`.
- It is a 2020 codebase; its idioms are not today's.
- The same worker would build the ground truth and the analyzer. Mitigation proposed: the ground truth is committed, with its
  exclusions pre-registered and their share, **before any analyzer runs**, and, as opum-doc decides, a second classification
  pass by an independent reader; "human-attributable" is defined (decision 2) independently of the analyzer's rules.
- **Held-out-ness is already weakened:** this worker has read click's source and its annotation counts. The ground truth is committed before
  build slice 1 and the indexer is not tuned on click; a result that is tuned on it is reported as in-sample.

Procedure if accepted, mirroring the requests set: pin the SHA; seed about 40 targets with the stratified sampler and a fixed seed
(`gt1_enumerate.py`); hand-classify candidate sites by `gt_rules.md` and its addendum, with 9 or more zero-truth targets as
precision controls; require at least 62 true sites; **include aliased and re-exported calls in candidate-finding** (the requests
sampler matched callee names only, `gt_rules_addendum.md` item 1, so it was blind to the calls the native design claims to
handle) or run the alias census as a gate component (`alias_enum.py`); commit the ground truth and its provenance (a scratch
repository bundle, as for requests) before any run. **No second-repository ground truth is committed with this record.**

## Open decisions for opum-doc

Each is an A/B with the recommendation first and the cost of each side. None is settled by this draft.

1. **The constructor rule.** Does `callers C.__init__` include the sites that construct `C`? (A, recommended) yes: record
   `C(...)` against the class and, for the class's resolved `__init__`, also against that `__init__`, one rule for every class,
   with a per-answer note where `__init__` is not what runs (metaclass `__call__`, `__new__`, `Enum`, dataclass-generated
   `__init__`) and what is recorded there stated; cost: wrong edges where interception is undetected, which the pyright round
   measured as untested. (B) record against the class only: no wrong `__init__` edge, but `callers C.__init__` is near-empty
   for every class, which DEC-299 (a5) forbids as a silent near-empty answer unless the note says so. The pyright measurement's
   constructor mapping was designed after the six misses were seen (in-sample), so the rule is tested only on the held-out set.
2. **What a "human-attributable" true site is (the recall denominator).** (A, recommended) the denominator is every call a human
   with the whole repository can attribute to a definition, defined by a rule written before the analyzer's rules and not by
   them, so every unresolved call that was attributable counts as a recall miss and the unresolved count is reported beside it;
   cost: requests' ground truth, built under R1's undecidable class, would have to be reclassified for that definition, which
   breaks comparability with pyright's 65, so the held-out set carries the new definition and requests is scored under both. (B)
   keep R1 as written (undecidable excluded, with its share reported): comparable with pyright's 65, but a high recall is then only
   as informative as the excluded share, and nothing bounds it on unannotated code.
3. **Known-class binding.** "Known-class bindings are attributed" needs a definition. (A, recommended) a binding is known when
   a name is bound exactly once in its scope to a constructor call of an in-repository class or to an import of a class, or is annotated with
   a class name; anything reassigned, branch-dependent, or reached through an attribute of another value (`self.x.m()`) is
   unresolved and counted; a function return annotation `-> C` counts as an annotation for the call's result; cost: the
   conservative rule resolves less, so the unresolved share is higher. (B) also follow single assignments through `self.x = C()` in
   `__init__` and through return annotations of in-repository functions: more resolved, at the cost of the very inference the
   ruling says to count rather than guess.
4. **Site-level or cluster-robust interval.** Sites cluster by target, so a site-level Wilson interval is optimistic (the
   pyright rows give the cluster bootstrap, `results/union-real-allplat.txt`). (A, recommended) apply the bound at the site level as the
   ruling states and report the cluster-bootstrap interval beside it; cost: a result may pass the bar and not its cluster-robust
   reading. (B) judge on the cluster-robust interval: stricter and closer to the truth, but it needs a larger sample (the pyright
   round's 65 sites at 0.908 gave a cluster lower bound of 0.788, below 0.8).
5. **When the gate binds the build.** The old D3 timing is not in the adopted set. (A, recommended) the build slices proceed and
   the two gate measurements must pass before the Python slices merge toward a release; cost: slices built on a design that may then
   fall short, with the fallback the operator's call. (B) the second repository's ground truth and a first measurement come before
   any build slice: nothing is built on an unmeasured design, at the cost of a ground-truth effort of about the size of the
   requests one before slice 1.
6. **First-party root discovery.** (A, recommended) the roots are the opum-doc list plus the repository root, plus any directory
   that holds a top-level package and that the exit-7 trigger above finds unresolved, which fails the run and names the directory,
   not silently adding it; cost: a repository with an unusual layout exits 7 until a root is declared (a flag or a config file, whose name is open).
   (B) auto-add every directory holding a top-level package as a root: more repositories run, but a wrong guess (tests mirroring
   package names, vendored copies) can resolve to the wrong module silently, which is the failure the old record measured.
7. **Names that cannot be bound once.** Multiply-bound names (`if PY2` / `else`, `try/except ImportError`, `TYPE_CHECKING`,
   platform-conditional definitions, `@overload` stubs with one qualified name), decorated names that return another object
   (click `Command`, `functools.wraps`), `super().m()`, `cls(...)` in a classmethod, `@property` and `.setter`, star imports and
   `__all__`, re-exports beyond `__init__.py`, class-body scope, `global` and `nonlocal`, module identity (repository root against
   `src/`, tests mirroring package names, PEP 420 namespace packages, `.pyi` beside `.py`, self-imports), `getattr`,
   `functools.partial` and metaclass `__call__`, tree-sitter `ERROR` nodes (Python-2 syntax, non-UTF-8 files). (A, recommended)
   each is either resolved by a stated rule or counted in an unresolved bin with a reason, and a file the parser cannot read is named and
   counted, not skipped; the rules are written one per case before the slice that builds them. (B) leave them to the build slices to
   settle: faster to start, but the stated-limits list the old record carried (its section 8) is then lost and the design is not
   what is accepted.
8. **The held-out repository.** One measured candidate, click 7.1.2; no ranked alternative. (A, recommended) accept click 7.1.2
   with the risks above and the pre-registered exclusions; cost: R1 may leave fewer than 62 sites on it. (B) name a different
   unannotated class-based package of similar size, measured the same way with `annotation_count.py` before it is accepted: no
   known candidate exists yet, so this costs a search, and the same held-out-ness caveat applies to whichever is chosen.
9. **The grammar package and runtime**, and how a WASM file is packaged under ADR 0007's single Node bundle (which leaves
   TypeScript and Commander external). (A, recommended) decide it in the dependency slice against a packaged-tarball check like
   ADR 0007's (a1): the package, its licence and its size measured; cost: the bundle shape is unknown until then. (B) decide it
   here: opum-doc's call, since a library pick is design; this draft does not name one.

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
