---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Add Python through a native in-process indexer
tags:
  - python
  - tree-sitter
  - indexer
  - measurement
summary: Python in glyph 0.1.0 is a native in-process tree-sitter indexer with glyph-owned semantics and no language server (DEC-303 (a1)); proposes the gate and a held-out repository.
generated:
  by: lore/0.14.1
  at: 2026-11-23T21:00:00.000Z
---

# Add Python through a native in-process indexer

## Status

**Proposed, rewritten for DEC-303 (a1).** It awaits opum-doc's acceptance before any build slice starts. DEC-303 ruled on
2026-11-23 that glyph 0.1.0 includes Python. Its (a1) amendment, the operator's first-party answer relayed on
opum-ai/opum-doc#1932 (commit e2ceee29), reads: "THE ROUTE CHANGES. ... 'native python support like typescript'. glyph does
NOT use a language server for Python. Items 1, 3 and 4 of DEC-303 are superseded. Item 2 (the same command contract per
language, never a silent empty) and item 5 (the release floor; the tag waits for Python) stand." This record drafts that design
and the gate; opum-doc owns the design. It contains no build code and decides no library. Tracked under GCLI-68.

The earlier version of this ADR proposed pyright's language server behind an LSP adapter. It is superseded, not deleted: its
text is `test/python-lsp-measurement/lsp-design-record.md`, and its harness and results stay in
`test/python-lsp-measurement/` as the baseline this design is scored against.

## Context

Glyph answers `callers`, `impact`, `diff`, `code-map` and `--stream` from a `GlyphIndex` (symbols and call sites) that
`src/indexer.ts` builds from one TypeScript program through the compiler API, resolving each call site to its declaration with the
type checker, caches under `$GLYPH_CACHE_DIR`, and can build for a commit with no checkout (`--ref`, `src/snapshot.ts`).
TypeScript publishes an exact `unresolvedSites` count because the compiler enumerates every call. Python has no compiler API
in a Node process; the operator chose to build the equivalent natively rather than run a server.

## Decision

Python is indexed by glyph's own analyzer, in process, producing the same `GlyphIndex` shape the queries already read.

1. **Parse with tree-sitter's Python grammar, as a WASM build.** No Python runtime, interpreter, environment or server process
   is needed; the parser sees every call expression, so the count of calls is exact by construction. (Which WASM package
   supplies the grammar and runtime is a build detail left to opum-doc; it is a `package.json` change and needs the Opus review at
   the exact green head, DEC-303 item 5.)
2. **Glyph owns the semantics.** The parser yields syntax only; resolution is glyph's:
   - repository-local module and import resolution: absolute, relative, aliased (`import a.b as c`, `from m import f as g`) and
     re-exported names (`__init__.py` re-exports), over the source roots `src/`, `lib/` and `packages/*/src` besides the
     repository root;
   - scopes (module, class, function, comprehension, nested function), so a name resolves to the binding it sees;
   - class and method attribution, with inheritance (the method resolution order over in-repository bases);
   - constructor calls recorded against their class (`C(...)` is a call to `C`; whether it is also a call to `C.__init__` is the
     one rule given in "Decisions the design still needs", item 1);
   - decorators, recorded as call sites of the decorator.
3. **Receivers that need inference are reported unresolved and counted, never guessed.** `self`, `cls` and bindings to a known
   class (an assignment from a constructor call, an annotation naming a class, a name bound by `import`) are attributed;
   `obj.method()` on a value whose type would have to be inferred from flow or from a call's return is not. Because the parser
   sees every call, the unresolved count is exact, not a lower bound (opum-doc's resolution of the old D1).
4. **Command contract.** Item 2 of DEC-303 stands: the same commands, flags and envelope per language, and no silent empty
   answer. The additions Python needs are additive and optional (the old D4, option A, adopted): a `decorator` site kind; a
   `language` entry in the `index` block; a "language not indexed" entry in the coverage line; an unresolved-first-party-import
   count; a `--language` global option declared in `help --json`; and a per-answer note where a constructor call is recorded
   against a class. They are recorded in ADR 0002's contract when built, and TypeScript leaves them absent or constant.
5. **One language per run** (the old D2, option A, adopted): detection or `--language` picks the language, and every skipped
   language and its file count are named in the coverage line. Indexing both and merging is deferred past 0.1.0.
6. **Unresolved first-party imports** (the old D5, option B, adopted): a run is `indeterminate` (exit 7) only when a
   first-party package root fails to resolve; every other unresolved first-party import is counted and named in the coverage
   line. Rationale carried over: failing on any unresolved import would make healthy repositories with generated or optional
   modules (`_pb2`, `_version`, `try/except ImportError`) exit 7.

The cache key gains the language and the analyzer version beside the commit. `--ref` reads the
tree from the commit as TypeScript's does (`src/snapshot.ts`); a native analyzer has no interpreter or installed environment to
differ, which removes the layout failure the pyright measurement found (see "Baseline").

## The gate

The build slices are not merged toward a release until both measurements below are reproduced by committed scripts and pass.

**Bar (DEC-303 (a1) item 4).** Incoming-call recall of at least 0.9 with a 95% Wilson lower bound of at least 0.8, and
precision of at least 0.95, on each of two repositories:

- `psf/requests` at `3c7baaa05ab4aa49cc819ce3a819d260de19c157`, `src/requests`, scored with the committed ground truth
  (`test/python-lsp-measurement/gt_rules.md`, `gt3_classified.json`, `results/ground-truth-provenance.txt`): 46 seeded targets,
  65 hand-classified true call sites. The ground truth was fixed before any tool ran, so it is a legitimate gate for the native
  indexer, but it is no longer a clean *held-out* set for design work done after reading it, which is why the second repository
  exists.
- A held-out second repository, less annotated, whose ground truth is committed before any run (proposed below, not yet accepted).

**Sample-size arithmetic** (Wilson, 95%, computed here and reproducible with the Wilson function in
`test/python-lsp-measurement/score.py`; not a result, a constraint on the design of the sample). At an observed recall of 0.9 the
lower bound reaches 0.8 only at about 60 to 65 true sites: 54 of 60 gives 0.799 and 59 of 65 gives 0.813, so 60 true sites is the
floor for the bar to be reachable at 0.9, and the second repository's ground truth must hold at least 60, not 40. At 60 sites a
perfect score has a lower bound of 0.94, so a precision claim of 0.95 cannot be demonstrated at 60 sites even if every
found edge is right; precision is therefore judged on the point value with its interval reported, or measured over more found
edges than true sites (every edge the indexer emits for the seeded targets, hand-checked). That is a gate-definition choice for
opum-doc, listed below.

**Baseline.** Pyright's numbers are the comparison, from committed files only. On `psf/requests`, pre-registered sample,
incoming calls: default platform 58/65 recall (0.892, Wilson 0.794-0.947), precision 58/58, `results/union-real-default.txt`;
`pythonPlatform: "All"` 59/65 (0.908, 0.813-0.957), precision 59/59, `results/union-real-allplat.txt`. With a constructor
mapping designed after the misses were seen (in-sample): 64/65 default and 65/65 under `"All"`, same files. The shipped
pyright layout measurement is `results/layouts.txt`. The seven default-platform sites pyright's incoming calls miss (six constructor calls recorded against the class, one
platform-conditional function: `results/union-real-default.txt`, the `differs:` lines) are the classes this design handles by rule, so
the comparison is informative about those two classes, not about unannotated code, because requests is not unannotated (below).

## The held-out repository: a proposal for opum-doc

The gate's value comes from a repository the design was not shaped on and that stresses the unannotated case, where a
syntactic analyzer meets receivers it cannot type. **requests is not that repository:** at the pinned commit, 265 of its 268
function definitions carry an annotation (0.989; `results/annotation-count.txt`, `annotation_count.py`). That changes what the
requests gate shows. Annotations help a native analyzer too (a declared parameter type attributes `obj.method()`), so passing
requests says little about code with no annotations.

Measured, not asserted (`results/annotation-count.txt`, a def counted as annotated if any parameter or its return is annotated):

| candidate | commit | files | defs | annotated defs | classes |
|---|---|---|---|---|---|
| **`pallets/click` 7.1.2, `src/click`** | `1784558ed7c75c65764d2a434bd9cbb206ca939d` | 17 | 474 | **0 (0.000)** | 58 |
| `pallets/click` 8.1.8, `src/click` (same project, later) | `934813e4d421071a1b3db3973c02fe2721359a6e` | 16 | 512 | 501 (0.979) | 67 |
| `psf/requests`, `src/requests` (the pinned gate repository) | `3c7baaa05ab4aa49cc819ce3a819d260de19c157` | 19 | 268 | 265 (0.989) | 52 |

**Recommendation: click at 7.1.2 as the held-out repository, not its current release.** The current click is as annotated as
requests and would not be a less-annotated test; the 7.1.2 tag is a pre-annotation release of the same project (0 of 474
defs), already parses under Python 3.15's `ast` (the enumeration tool requirement), and has the features the native design
must handle: relative imports across a `src/` layout, class hierarchies (`Command`, `MultiCommand`, `Group`, `Parameter`,
`Option`, `Argument`), a decorator-built API (`@click.command`, `@click.option`) and heavy use of untyped parameters. It also
supplies a natural pressure on the unresolved count: with no annotations, method calls on parameters are common, and the gate
shows whether the native analyzer attributes enough of them from `self`, `cls` and known-class bindings to meet the bar or
whether most go to the unresolved count.

Proposed procedure if opum-doc accepts it, mirroring the requests set: pin the SHA above; seed about 40 targets with the same
stratified sampler and a fixed seed (`gt1_enumerate.py`); hand-classify call sites by `gt_rules.md` (and its addendum) with a
second pass over the 9 or more zero-truth targets as precision controls; require at least 60 true sites (the arithmetic above);
commit the ground truth and its provenance (a scratch repository bundle, as for requests) **before any indexer runs**. No
second-repository ground truth is committed with this record: the repository is a proposal, and it waits on opum-doc's
acceptance. Alternatives, not measured and so not ranked: another small unannotated class-based package of similar size (an
older tag of a project that annotated later, chosen the same way); `httpx` or the current `attrs` are expected to be annotated
and would only repeat the requests case.

## Decisions the design still needs (opum-doc's; each a design gap found while drafting, not settled here)

1. **The constructor rule.** `C(...)` is recorded against the class. Does `callers C.__init__` include those sites? The pyright
   measurement's six constructor misses and its mapping were designed after seeing them (in-sample); the native design should state one
   rule, applied the same way for every class, and the held-out repository is the test of it. A class whose construction is
   intercepted (metaclass `__call__`, `__new__`, `Enum`, dataclass-generated `__init__`) needs the rule to say what is recorded.
2. **The recall denominator.** `gt_rules.md` R1 classes a call on a receiver whose type "cannot be told by reading the code" as
   undecidable and excludes it from recall and precision. The native design deliberately declares untyped-receiver calls
   unresolved. If those stay excluded, recall can be raised by declaring more sites unresolved. (A, recommended) the gate's
   denominator is every true site a human can attribute, so every honestly unresolved site is a recall miss and the unresolved
   count is reported beside it; (B) the denominator excludes sites that need inference, and the count of excluded sites is
   reported, so a high recall is only as informative as the share excluded. A is stricter and cannot be gamed; B matches the earlier ground truth.
3. **Site-level or cluster-robust.** The pyright round found a site-level Wilson interval optimistic, since sites cluster by
   target (`results/union-real-allplat.txt` has the cluster bootstrap over the 37 targets with a true site). The bar says
   "Wilson lower bound"; (A, recommended) apply it at the site level as written and report the cluster-bootstrap interval beside it;
   (B) judge on the cluster-robust interval, which a 60-site sample may be unable to satisfy.
4. **Precision at the bar's sample size.** At 60 sites a perfect score's Wilson lower bound is 0.94, so 0.95 precision is a point
   value, not a bound. State whether the gate is the point value or an interval over a larger set of emitted edges.
5. **Shortfall path.** A shortfall goes to opum-doc with the numbers. The fallback named in (a1)'s design, pyright in-process
   as a library, is the operator's decision and is not adopted or prepared here.
6. **Which grammar package and runtime**, and how the WASM build is packaged under ADR 0007's single Node bundle (the bundle
   leaves TypeScript and Commander external; a WASM file is a third kind of runtime asset).

## Consequences

- Python adds a tree-sitter grammar and runtime as a dependency and an analyzer glyph owns and must keep correct; there is no
  server, no interpreter, no environment, and no per-run start-up wait.
- The release floor is DEC-303 item 5: Sonnet writers and an Opus review per slice. Slices are proposed only after acceptance;
  none is started. The 0.1.0 tag waits for Python.
- What is unproven: recall on unannotated code (the held-out repository is the test), metaprogramming-heavy code, scale and
  `--ref` cost. Unresolved calls are counted, so a poor result shows as a high unresolved count with exact numbers, not as a
  silent loss.
- The LSP measurement stays in `test/python-lsp-measurement/` and is re-scorable as the baseline.
