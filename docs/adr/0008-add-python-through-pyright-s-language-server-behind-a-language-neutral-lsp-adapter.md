---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Add Python through pyright's language server behind a language-neutral LSP adapter
tags:
  - python
  - lsp
  - pyright
  - measurement
summary: Proposed design and decide-before-build measurement for Python in glyph 0.1.0 (DEC-303), pyright-langserver behind an LSP client, pyright 1.1.414 measured on psf/requests and fixtures.
generated:
  by: lore/0.14.1
  at: 2026-11-23T15:20:51.191Z
---

# Add Python through pyright's language server behind a language-neutral LSP adapter

## Status

**Proposed.** It awaits opum-doc's acceptance of the measurement below (DEC-303 item 4: "opum-doc accepts the
measurement before the build slices start"). It names DEC-303, which ruled on 2026-11-23 on the operator's first-party
instruction ("Python in 0.1.0") that glyph 0.1.0 adds Python through pyright's language server behind a language-neutral
LSP adapter, and that glyph-cli measures first. This record is a measurement and a design; it contains no build code.
Tracked under GCLI-66. ADR number 0008 was the next free one when this was written; the release-scripts ADR planned as
S5 takes the next number after it.

## Context

Glyph answers `callers`, `impact`, `diff`, `code-map` and `--stream` from a `GlyphIndex` (symbols and call sites) that
`src/indexer.ts` builds from one TypeScript program through the compiler API, caches under `$GLYPH_CACHE_DIR`, and can
build for a commit with no checkout (`--ref`, `src/snapshot.ts`). DEC-303 keeps that indexer and adds Python through
pyright's public interface, `pyright-langserver --stdio`: `documentSymbol` and `workspace/symbol` for the symbol table,
call hierarchy and `references` for the call graph. It asks for a measurement of call-hierarchy completeness against a
hand-checked set of call sites, and for the ADR to propose the alternative (pyright references, or tree-sitter plus
pyright) if recall is poor.

### How it was measured

Everything below is reproducible from `test/python-lsp-measurement/` (ground truth, rules, fixtures, harness, scorers,
the deterministic inputs and the gzipped raw output); its README says how to re-score with only `python3` and `gunzip`.
That directory is a recorded artifact and is not shipped (`package.json` `files` is `dist`, `README.md`, `LICENSE`).

- **Server.** pyright 1.1.414, `npm install pyright@1.1.414`; registry integrity
  `sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==`. Node v24.22.2,
  macOS on Apple silicon (10 cores, idle), git 2.56.0. The host's Homebrew Python 3.15.2 was on PATH, so the host
  environment is an input: installed third-party packages (certifi) resolved, uninstalled ones (urllib3, idna) did not.
  A run with no Python on PATH gave identical call answers and two more unresolved call sites
  (`results/no-python-on-path.txt`).
- **Real repository.** psf/requests at `3c7baaa05ab4aa49cc819ce3a819d260de19c157`, `src/requests`: 19 files, 6,394 lines,
  320 definitions. Chosen by criteria stated before any result: pure Python, small dependency surface, small enough to
  hand-check, with real `self.` methods, inheritance and `super()`, static methods, decorators, overloads, callbacks,
  aliased imports and a platform-conditional branch. It is one repository and is not claimed to be typical.
- **Ground truth fixed before pyright ran.** Python's `ast` enumerated every definition and every syntactic call (986
  calls and 43 decorator applications). Targets were a seeded stratified sample (seed 303, regenerating the same 46
  targets byte-identically when re-run): 46 definitions in eight strata (10 functions, 12 methods, 2 static methods, 8
  classes, 2 nested functions, 6 methods whose name is defined more than once, 3 `__init__`, 3 definitions with no call
  by name; a ninth stratum, classmethod, was requested and requests defines none). Every candidate site was classified by
  hand under written rules (`gt_rules.md`: the static receiver type decides; `Cls(...)` is a call to the class and to
  `__init__`; `super().m()` is a call to the base `m`; a decorator application is a call; a function passed or stored is a
  reference; calls through a variable are excluded). Result: 65 true call sites across 37 targets that have at least one,
  and 9 targets with none. The rules and the classification were committed in a scratch repository at 09:15:32 -06:00 and
  the fixtures' expected truth at 09:16:23, before the first server output (09:17:17 for fixtures, 09:18:20 for the real
  repository: one to three minutes later). The claim rests on the recorded commit hashes and blob ids
  (`results/ground-truth-provenance.txt`), which match the files here byte for byte, not on a long gap.
- **What was added or decided after the first results** (`gt_rules_addendum.md`; the original files are unchanged):
  the alias set (4 targets, 15 sites, section "Results"), the constructor mapping (a design choice measured on the data
  that suggested it), and the recall bar (proposed after the results were seen; no threshold was fixed in advance).
- **Fixtures.** 22 definitions and 37 calls, written to exercise what one real repository cannot guarantee: inheritance and
  overrides, `super()`, classmethod and staticmethod, a property, a decorator, aliased imports (`from m import f as g`),
  `cls(...)`, calls through a variable and a callback, comprehensions, async. Expected truth was written before the run. They
  are adversarial by design: they show which cases fail, not a rate.
- **Harness.** A Node client speaking JSON-RPC over `pyright-langserver --stdio` with `Content-Length` framing: `initialize`,
  `documentSymbol` per file, `workspace/symbol` per name, `prepareCallHierarchy` then `incomingCalls` and `outgoingCalls`,
  `references` (includeDeclaration false), and `definition` at the callee of every syntactic call. It exits non-zero if no
  request is answered, any request errors, or every `prepareCallHierarchy` is null; `score.py` refuses a run with a missing
  target record. `pythonPlatform: "All"` is set by a `pyrightconfig.json` in the analysis root (the harness answers
  `workspace/configuration` with empty settings, so that file is the only source of it).

### Results

Intervals are 95% Wilson. A site is one call; a line holding two true sites needs two found sites. Sites cluster by target,
so a target-level figure is given beside each site-level one (a target is fully correct when every true site is found and
nothing else is listed). `incoming` is the target's `incomingCalls`; `outgoing` is any function's `outgoingCalls` whose callee
item is at the target's definition (matched by location, because an aliased import names the callee by its alias);
`union` is the distinct sites of both; `+ ctor map` adds, for an `__init__` target, the union sites of its class and of
subclasses with no `__init__` (a constructor call runs `C.__init__`). `union.py` computes all of them
(`results/union-*.txt`).

**Pre-registered sample, `psf/requests`, 46 targets, 65 true sites.**

| set | platform | site recall | site precision | targets fully correct |
|---|---|---|---|---|
| incoming | default (macOS) | 58/65 = 0.892 (0.794-0.947) | 58/58 = 1.000 (0.938-1.000) | 42/46 = 0.913 (0.797-0.966) |
| incoming | `"All"` | 59/65 = 0.908 (0.813-0.957) | 59/59 = 1.000 (0.939-1.000) | 43/46 = 0.935 (0.825-0.978) |
| outgoing | default | 56/65 = 0.862 (0.757-0.925) | 56/56 = 1.000 | 40/46 = 0.870 (0.743-0.939) |
| outgoing | `"All"` | 57/65 = 0.877 (0.775-0.936) | 57/57 = 1.000 | 41/46 = 0.891 (0.770-0.953) |
| union | default / `"All"` | equal to incoming on both | equal to incoming on both | equal to incoming on both |
| union + ctor map | default | 64/65 = 0.985 (0.918-0.997) | 64/64 = 1.000 (0.943-1.000) | 45/46 = 0.978 (0.887-0.996) |
| union + ctor map | `"All"` | 65/65 = 1.000 (0.944-1.000) | 65/65 = 1.000 (0.944-1.000) | 46/46 = 1.000 (0.923-1.000) |

Reading the table: the six sites missed by incoming and by the union on `"All"` are constructor calls to `__init__`
(`PreparedRequest()` x3, `HTTPBasicAuth(...)`, `MockRequest(...)` x2); call hierarchy attributes a constructor call to the
**class**, and with the constructor mapping all six are found (the one remaining default-platform miss is
`proxy_bypass_registry`, defined under `sys.platform == "win32"`, which pyright treats as unreachable on macOS, so
`prepareCallHierarchy` returns null). On the non-constructor call kinds alone (59 sites) incoming recall is 59/59 = 1.000
(0.939-1.000) on `"All"` and 58/59 = 0.983 (0.910-0.997) on the default platform; at n = 59 a perfect score bounds the miss
rate at about 5% (rule of three) and cannot separate 97% from 99.9%. Outgoing misses 8 sites on `"All"`: incoming finds 2 of them
(calls at module scope, which no function symbol encloses) and neither finds the six constructor sites. The union adds nothing over incoming
on this sample, because no sampled target had an aliased call; the alias set below is where it matters. Every outgoing
and union edge to a sampled target was a true site (precision 1.000); the nine targets with no true site returned no false
site. By stratum (incoming, default): function 19/20, method 12/12, static method 3/3, class 17/17, nested 2/2, overridden
5/5, zero-candidate 0 false sites, `__init__` 0/6.

**Alias set, added after the first results (post hoc), 4 targets, 15 true sites.** The pre-registered sample could not
contain an aliased call (`gt2_listing.py` matches callee names only), so it could not show how pyright treats
`from m import f as g`. `alias_enum.py` lists every in-package relative aliased import of a definition in its defining
module and every call through the alias (13 sites on 3 targets), plus the direct calls of those targets (2 more) so
precision is scored against a complete truth.

| set | site recall | site precision | targets fully correct |
|---|---|---|---|
| incoming | 2/15 = 0.133 (0.037-0.379) | 2/2 | 1/4 |
| outgoing | 15/15 = 1.000 (0.796-1.000) | 15/15 = 1.000 (0.796-1.000) | 4/4 (0.510-1.000) |
| union | 15/15 | 15/15 | 4/4 |

Incoming calls and `references` miss every aliased call; outgoing calls find all of them. This is the one measured failure
kind that incoming-only scoring on the pre-registered sample is structurally blind to.

**Fixtures, 18 targets, 28 true sites (adversarial, not a rate; identical on both platforms).**

| set | site recall | site precision | targets fully correct |
|---|---|---|---|
| incoming | 17/28 = 0.607 (0.424-0.764) | 17/18 = 0.944 (0.742-0.990) | 11/18 = 0.611 |
| outgoing | 21/28 = 0.750 (0.566-0.873) | 21/21 = 1.000 (0.845-1.000) | 14/18 = 0.778 |
| union | 21/28 = 0.750 | 21/22 = 0.955 (0.782-0.992) | 13/18 = 0.722 |
| union + ctor map | 25/28 = 0.893 (0.728-0.963) | 25/26 = 0.962 (0.811-0.993) | 14/18 = 0.778 (0.548-0.910) |

The 11 sites incoming misses are: aliased-import calls (5: `h(3)`, `h(i)`, `h(1)` for `helper`, and `Doggo("rex")` for both
`Dog` and `Dog.__init__`); constructor calls attributed to the class (4, for `Animal.__init__`: `cls(name)`, `Cat("tom")`,
`base.Animal("aliased")`, `Cat("x")`); a decorator application (1: `@traced`, which call hierarchy does not report, though
`references` finds it); and `cls(name)` as a call to the class `Animal` (1). After the union and the constructor mapping,
three remain: the decorator and `cls(name)` twice (once as a call to `Animal`, once to `Animal.__init__`); calls through a
variable or a closure variable were excluded from the truth by rule and are not counted. The one false positive in every
fixture set is an attribute access that is not called (`Cat("x").speak`, called later through a variable) listed as a call.

**Symbols.**

| kind | recall | precision |
|---|---|---|
| `documentSymbol`, default | 298/320 = 0.931 (0.898-0.954) | 298/298 = 1.000 |
| `documentSymbol`, `"All"` | 300/320 = 0.938 (0.905-0.959) | 300/300 |
| `workspace/symbol`, every file open | 298/320 = 0.931 | n/a |
| `workspace/symbol`, files not open | 43/320 = 0.134 (0.101-0.176) | n/a |

The 20 `documentSymbol` misses that remain on `"All"` are the `@overload` stub definitions (pyright reports the
implementation); the 2 more on the default platform are the Windows-only definitions. `references` at an overload stub also
returns the other overload declarations and the implementation's `def` line (10 of the 40 extra references; all 40 extras
are valid non-call references, hand-classified from the listing in `results/score-real-default.txt`: imports, annotations,
base classes, `except` clauses, `__all__` strings and overload declarations).

**Resolution at every call site.** `textDocument/definition` at the callee of all 1,028 named calls and decorators in
requests, default platform: 312 resolve inside the package (22 of those to a variable or alias rather than a def), 648 to
typeshed or the stdlib, 2 to an installed package, 66 to nothing (uninstalled third-party packages, untyped attributes,
Windows-only names); with `"All"`: 314, 657 and 57. At the 65 ground-truth call sites the definition resolves to the target's
own definition in 64 (default) and 65 (`"All"`) cases; that check catches a same-named wrong target, which the 13 name
mismatches (all import aliases) alone would not. The 22 results that land on a variable or alias were not individually checked.

**Determinism, ordering and the open-file requirement.** Six runs with every file opened before any query returned
byte-identical results (excluding timings). Two runs that opened each file only for its own query were identical to each
other but differed from the all-open runs in 11 of 52 targets (`results/compare-runs.txt`); an earlier pair of such runs on a
smaller target list differed from each other as well, but its raw output was not kept, so only the recorded 2-of-2 is
claimed. Either way an answer depends on which files the server has open, and `workspace/symbol` finds 13% of symbols
when files are not open. Pyright returned some incoming sites twice (20 duplicates in the real run, 7 in the fixtures); the
client dedupes by (file, line, column). Whether pyright needs a readiness wait on a larger repository is not measured:
the 6-of-6 determinism is on 19 files.

**Time, 19-file repository, cold server start each run.** `initialize` 78-82 ms; the 19 `documentSymbol` answers together
167-190 ms; per-request means (six runs): `prepareCallHierarchy` 0.4 ms (0.1-1.5; max 72), `incomingCalls` 15.4 ms (12.8-18.5;
max 231), `outgoingCalls` 3.8 ms (2.0-4.8; max 106), `references` 2.9 ms, `definition` 2.1 ms. The whole 1,496-request run
(52 targets and 1,028 `definition` requests) took 3.6-3.9 s; the same run with the per-symbol `outgoingCalls` pass added
(2,031 requests) took 3.64 s, i.e. no measurable cost beyond the run-to-run spread. The full union index was not run as
one pass; **an estimate**, not a measurement, for building it (a `prepareCallHierarchy` plus `incomingCalls` plus
`outgoingCalls` for each of the 320 symbols, sequentially) is about 320 x 20 ms = 6.4 s plus start-up, which is close to
`code-map`'s 7.0 s budget (ADR 0005) on this 19-file package. Pipelining requests was not tried.

### What the sample can and cannot show

- **Size.** One repository, 19 files, 46 sampled targets, 65 true sites, 28 fixture sites. A perfect result on 59 sites
  cannot separate 97% from 99.9%. Per-stratum cells hold 0 to 20 sites: they show the presence or absence of a failure, not
  a rate. Target-level intervals are wider than site-level ones because sites cluster by target; both are given.
- **Blind spots of the ground truth.** Candidates were found by callee name, so alias calls were invisible to the
  pre-registered sample (added post hoc above); calls through a variable, `getattr`, `__call__`, `functools.partial`,
  and anything outside `src/requests` are excluded by rule.
- **Post-hoc elements.** The alias set, the constructor mapping and the recall bar were all defined after seeing results; the
  mapping is scored on the data that suggested it. The ground truth itself was fixed before the server ran.
- **Precision of outgoing and the union** is measured on the sampled targets only (1.000) and says nothing about edges to
  symbols outside the sample.
- **Code styles not covered.** Annotated code only (requests ships `py.typed`); unannotated code, metaprogramming,
  dataclass, metaclass and `__new__` constructors, `__call__` dispatch, `functools.partial`, `TYPE_CHECKING` blocks and
  conditional imports, notebooks, namespace packages, `.pyi`-only stub packages, `src`-layout and monorepo roots, virtual
  environments and `pythonPath`, `pythonVersion` host dependence, and uninstalled third-party packages are not measured.
- **Scale and environment.** Memory use and first-analysis time on thousands of files are not measured; the host Python
  environment changes what resolves (measured only for the two certifi calls).
- **Machine.** One idle machine; nothing here is measured under load.

## Decision

Recall on the call kinds that matter is high enough that the alternative DEC-303 item 4 reserves (`references`-only, or
tree-sitter plus pyright) is **not** proposed. Whether the numbers are "poor" is opum-doc's reading to make.

### The bar, what it scores, and whether it is met

The bar is proposed here, **after** the results were seen (no threshold was fixed in advance; the ground-truth rules say
"not decided here"): *recall over all true call sites of at least 0.9, with a 95% lower bound above 0.8, on the
pre-registered sample.* Applied to each quantity:

| quantity (65 true sites) | recall (95% Wilson) | meets the bar |
|---|---|---|
| incoming calls, default platform | 58/65 = 0.892 (0.794-0.947) | **no** (point below 0.9, bound below 0.8) |
| incoming calls, `"All"` | 59/65 = 0.908 (0.813-0.957) | yes |
| union, `"All"` | 59/65 = 0.908 (0.813-0.957) | yes (equals incoming on this sample) |
| union + constructor mapping, default | 64/65 = 0.985 (0.918-0.997) | yes |
| union + constructor mapping, `"All"` (the shipped design) | 65/65 = 1.000 (0.944-1.000) | yes |

Target-level (46 targets): incoming default 0.913 (0.797-0.966) does not meet a 0.8 lower bound; incoming `"All"` 0.935
(0.825-0.978) and union + constructor mapping 0.978 / 1.000 (0.887 / 0.923 lower) do. So "met" is true of the quantity the
design ships (the union under `pythonPlatform: "All"`, constructor calls recorded against their class) and is **not** true
of incoming calls alone on the default platform. It is also not true of the fixtures (union + constructor mapping 0.893,
lower 0.728) and not true of the alias set for incoming calls alone (0.133); both are adversarial or post hoc and are
reported, not scored against the bar. If opum-doc scores the bar on incoming calls alone, on the default platform, on the
fixtures, or on target-level incoming on the default platform, it is **not** met and the alternatives return. The bar is
not edited to fit the result; D3 is opum-doc's to rule.

**The shipped 65/65 is a fit to this sample, not a held-out result.** The constructor mapping was designed after the
six constructor misses (and the fixtures' constructor misses) were seen, and is then scored on those same sites. The 6/6
and the 65/65 therefore show that the mapping can reproduce what the data showed, not that it generalises. The fixtures are
not held out either: they were run before the mapping was written. Proposed held-out test, to run before the build slices
start: a **second real repository** (ideally unannotated, with class hierarchies and at least 20 constructor sites),
measured with the mapping rule and the ground-truth rules committed first, scored by the same `union.py`. A result that
repeats the pre-registered sample's 0.9 / 0.8 is evidence; this sample alone is not.

**Can the matching credit a wrong edge, and was precision measured?** Two matching rules could, and each was checked.
(i) The callee-location match for outgoing calls began as a window of +-3 lines around the definition; that credited
neighbouring definitions (two false matches measured, `gt_rules_addendum.md` item 5) and was replaced by the exact lines of
the target's own definitions (an overload stub and the implementation, plus decorator lines above). (ii) The
`__init__`-to-class equivalence attributes the sites of class `C` to `C.__init__`; it can credit a wrong edge where a
metaclass `__call__`, `__new__` or a generated `__init__` (dataclass) intercepts construction, none of which the sample
contains, and for a subclass that defines no `__init__` only if no nearer base defines one (the rule looks one level down).
Precision was measured for incoming, outgoing, the union and the mapping, per site and per target: the union adds no false
site on the pre-registered sample (58/58, 59/59), and the mapping added 10 sites (6 real, 4 fixture), all true (10/10, lower
bound 0.723); the one fixture false positive (an attribute access that is not called) comes from incoming calls, not from
the union or the mapping. That is precision on the sampled targets only; it does not bound the rate over edges to symbols
outside the sample.

The design follows. Names are proposals for the build slices; nothing is implemented.

### 1. Where it sits

A `LanguageIndexer` seam produces the same `GlyphIndex` (symbols and call sites) that the queries, `impact`, `diff` and
`code-map` already consume, so those commands read the Python index exactly as they read the TypeScript one and keep
their envelopes, kinds and exit codes, **except where a field needs adding (see D4)**. The TypeScript indexer is unchanged
and is one implementation of the seam. The Python indexer is a language-neutral LSP client plus a thin pyright layer
(server command, platform setting, the quirks below). Every command is answered from the built index; none issues live
LSP requests per query, which is what lets the union edges, the constructor edges and the decorator sites apply
uniformly to `callers`, `impact` and `code-map`.

### 2. The language-neutral LSP client

- **Spawn.** Resolve the language server's entry script through module resolution (`require.resolve("pyright/langserver.index.js")`
  from glyph's own install, so hoisting, pnpm and global installs all work), spawn it with `process.execPath`, `stdio`
  pipes, no shell, `cwd` the analysis root.
- **Framing.** `Content-Length` parsed from a byte buffer that survives a header or body split across chunks, in bytes,
  with a hard cap on one message's size; a malformed header or an oversized message is a protocol failure (exit 7).
- **Requests.** One id map; a request resolves on its response and rejects on a response error, on its timeout, or on the
  server's exit. Server-to-client requests pyright sends (`workspace/configuration`, `client/registerCapability`,
  `window/workDoneProgress/create`) are answered with an empty result; notifications are ignored.
- **Timeouts and the wall-time budget.** A request's timeout is the smaller of a per-request cap and the time the run's
  budget has left, the rule `src/codemap.ts` applies to its git reads. For `code-map`, a request the budget cuts off with
  the budget really spent is a stop and a `code-map#time-budget` omission (ADR 0005); a request that dies for another
  reason is exit 7. `callers`, `impact` and `diff` have no budget today and keep none. **The cap values are placeholders to
  be set from measurement in the first build slice** (starting points: 10 s per request, 30 s to `initialize`); this record
  measured none of them.
- **Crash and failure, fail closed.** If the server exits, never answers `initialize`, answers without
  `callHierarchyProvider` or `documentSymbolProvider`, or returns a JSON-RPC error for a request the design depends on, the
  run fails `indeterminate` (exit 7) with a message naming the language, the server command and version, the request, and
  the first 400 characters of the server's stderr. No restart and no silent fall back to an empty graph (DEC-299 (a5)).
  `shutdown` and `exit` are sent on completion; the process is killed after two seconds if it lingers; no child outlives the
  CLI, including on SIGINT and on an uncaught error.
- **Result hygiene.** Locations are normalised to repository-relative paths; a location outside the analysis root is
  `external` and never emitted as a repository file; sites are deduplicated by (file, line, column).

### 3. Opening files, and what the index is built from

- **Open everything first.** Before any query the client sends `didOpen` for every Python source file in scope (files not
  opened gave 13% `workspace/symbol` recall and different incoming answers in 11 of 52 targets; all-open runs were identical
  6 of 6). There is a file cap. **Over the cap the run is `indeterminate` and says so; large Python repositories are
  unsupported in 0.1.0.** The cap value is a placeholder for the first slice to set from a measurement on a larger repository
  (starting point: 2,000 files); nothing in this record supports a larger number.
- **Symbols** from `documentSymbol` per file (hierarchical); `workspace/symbol` is not used to build the index.
- **Edges** are the deduplicated union of `outgoingCalls` for every function and method symbol and `incomingCalls` for every
  symbol, with the callee identified by location (an aliased import names the callee by its alias). A call to a class is
  recorded against the class and, for the class's own or nearest inherited `__init__`, as a constructor edge to it, so
  `callers` of an `__init__` answers what a user expects. Decorator applications come from `references` (call hierarchy
  omits them). An `@overload` stub has no symbol of its own in `documentSymbol`; the index records the implementation.
- **Consistency check.** Because no readiness signal was used, build slice 1 repeats the edge pass once on a larger repository
  and compares; if the design needs it at scale, a second pass whose result differs from the first is exit 7.

### 4. Command mapping (all from the built index)

| glyph | built from |
|---|---|
| `callers <name>` | the symbol table and the union edges (including constructor edges and decorator sites) |
| `impact <name>` | breadth-first reverse closure over the same union edges (constructor edges and decorator sites included); `--depth`, `--all`, cycles and `truncated` as for TypeScript |
| `diff <base> [head]` | git's changed line ranges (unchanged) intersected with the index's `documentSymbol` ranges, innermost symbol only |
| `code-map` | named paths and changed files as today (git only); the symbol tier and the one-hop reference tier from the index's union edges; the identifier tier is git grep and needs no server |
| `--stream` | unchanged: items as found, one result line, same kinds |

### 5. Language detection and the override

- Detection is per repository from the files in scope: `.py` and `.pyi` for Python, the existing extension set for
  TypeScript and JavaScript. The language with more files is indexed. **Whenever any file of another supported language is
  present in scope, the coverage line names that language as not indexed, with its file count**; there is no "handful"
  threshold below which a language is skipped silently.
- **`--language <typescript|python>`** (global, declared in `help --json`) overrides detection. An unknown value is a usage
  error (exit 2). A repository with no file of the chosen language answers `not_found` (exit 3) naming the language.
- Pyright follows the repository's own configuration (`pyrightconfig.json`, `pyproject.toml [tool.pyright]`) when present.
  Absent one, the adapter writes nothing into the repository and passes `pythonPlatform: "All"`. A repository config that
  names a platform reinstates the macOS-style miss for platform-conditional code (measured: `proxy_bypass_registry`); that is
  stated as a limit, not worked around.

### 6. `--ref`, the cache and the environment

An LSP server reads the filesystem, so `--ref` materialises the commit's Python files and pyright configuration files into a
temporary directory under the glyph cache, using the same no-checkout object reads as `src/snapshot.ts`, and removes it on
exit. Consequences stated now: an untracked virtual environment (`.venv`) is not in the commit, so `--ref` always resolves
third-party packages from the host's current environment, never from the commit's; this is unmeasured as to cost and as to
how often it changes an answer. The Python index cache key is (commit, language, **pyright version, resolved interpreter path
and its version, a digest of the environment's installed distribution names and versions**, configuration digest), because
the measurement shows the host environment changes what resolves and a cached index must never be reused across it. With no
interpreter on PATH pyright still runs (measured: identical call answers, stdlib from its bundled typeshed), the interpreter
part of the key is then "none".

### 7. Packaging

pyright is an npm runtime dependency of `@opum-ai/glyph`, external to the bundle like `typescript` and `commander` (ADR 0007,
DEC-299 (a1)), pinned to an exact version (1.1.414 was measured). Its package is 19.5 MB unpacked in 5,423 files
(`npm view pyright@1.1.414 dist.unpackedSize dist.fileCount`), 34 MB on disk after install; it has no install scripts of its
own (its `package.json` scripts are `build`, `clean` and `webpack`), so a user install without `--ignore-scripts` is the same
bytes. The bundle check (`scripts/check-package.mjs`) and the packed-tarball install test gain a pyright resolution check
and a Python smoke test (index a small fixture repository under Node from the installed tarball). A server that cannot be
resolved is `indeterminate` with the install hint, never a skipped language.

### 8. Stated limits (to be documented in the README with the build)

- Calls through a variable, `getattr`, `__call__` dispatch, `functools.partial`, and decorators that return untyped wrappers
  are not guaranteed; what pyright resolves is reported as found.
- Code under a `sys.platform` or version check that pyright treats as unreachable is silently absent from the index unless
  `pythonPlatform: "All"` covers it; a version check follows pyright's `pythonVersion`, which depends on the host.
- `diff` on a changed line inside an `@overload` stub resolves to the implementation, the class, or nothing, depending on
  the stub; this is unmeasured beyond the fact that stubs have no symbol of their own.
- Results depend on the host Python environment for third-party resolution; the interpreter pyright resolved is recorded in
  the answer's `index` block.
- A changed file whose path pyright cannot open is `indeterminate`, not skipped (ADR 0002, DEC-299 (a6)).
- Large repositories are unsupported in 0.1.0 (the file cap, section 3); monorepo scale, memory and first-analysis time are
  not measured.
- `.pyi`-only packages, namespace packages, notebooks, `src`-layout roots and metaclass, `dataclass` and `__new__`
  constructors are not measured.

### Open decisions for opum-doc

- **D1. The unresolved-site count.** TypeScript publishes `unresolvedSites` from a syntactic enumeration of every call. The LSP
  cannot enumerate calls. (A, recommended) publish for Python the counts glyph has (resolved in the package, resolved
  externally, unresolved among sites it holds a position for) and state that a call with no recorded edge is not
  enumerated, so the count is a lower bound; (B) add a syntactic pass (a tree-sitter Python grammar, or a lexical
  `identifier(` scan as an upper bound) for an exact or bounded count. B is DEC-303's alternative applied for a reason other
  than recall and adds a dependency.
- **D2. Mixed-language repositories.** Recommended: one language per run (detection or `--language`), skipped languages named
  in the coverage line, and "index both and merge" after 0.1.0.
- **D3. The bar, and the quantity it applies to.** See "The bar, what it scores, and whether it is met". The proposed bar was
  fixed after the results; it is met by the shipped union under `"All"` and not met by incoming calls alone on the default
  platform, on the fixtures, or (for incoming alone) on the alias set. The 65/65 is an in-sample fit of the constructor mapping (see
  above). A higher or differently-scored bar, and the held-out test of the mapping, need a second real repository, ideally
  unannotated, measured by the same method (rules and mapping committed first) before the build slices start.
- **D4. Command-contract additions.** DEC-303 item 2 says the contract is unchanged per language. The design as written
  needs additions to the envelopes that TypeScript does not have: a `decorator` site kind (call hierarchy omits decorator
  applications, `references` finds them), a field saying the unresolved-site count is a lower bound (`unresolvedKnown:
  false`, or equivalent under D1), a `language` entry in the `index` block, and a "language not indexed" entry in the
  coverage line (section 5). Each changes a published schema. Recommended: accept them as additive, optional fields that
  TypeScript leaves absent or constant, and record them in ADR 0002's contract. If the contract is to stay byte-identical,
  the decorator kind drops (decorators become ordinary call sites) and D1 has no field to carry the lower bound, so D1
  option A loses its honest form.

## Consequences

- Python adds one runtime dependency (pyright, from npm, 19.5 MB unpacked) and about 4 s of cold start for a 19-file package on
  an idle machine, with an estimated 6-7 s to build the full union index there; the TypeScript path's measured cold build is
  shorter. Warm runs rely on the same cache design, with the cache key above.
- The seam, the client and the pyright layer are separately testable: the client against a fake server that frames messages
  badly, hangs, crashes and answers errors (each a named exit-7 case with a both-ways test); the pyright layer against the
  fixtures here, with the ground truth in this record as the expected values; the measurement re-run in CI on the pinned
  requests commit only if opum-doc wants it as a standing gate.
- Release floor per DEC-303 item 5: Sonnet writers and an Opus review per slice. Slices proposed (none started): the LSP client
  and its failure tests; the Python index from symbols and edges; detection and `--language`; `--ref` materialisation;
  packaging; README limits.
- The measurement artifact stays in the repository so the numbers can be re-derived when pyright is upgraded; an upgrade
  re-runs it and records the new version and bytes.
- Not settled by this record: recall on unannotated or metaprogramming-heavy code, scale, the cost of `--ref`
  materialisation, whether a readiness wait is needed at scale, and D1 to D4.
