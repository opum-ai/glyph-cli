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

**Proposed.** It awaits opum-doc's acceptance of the measurement below (DEC-303 item 4: "opum-doc
accepts the measurement before the build slices start"). It names DEC-303, which ruled on
2026-11-23 on the operator's first-party instruction ("Python in 0.1.0") that glyph 0.1.0 adds Python
through pyright's language server behind a language-neutral LSP adapter, and that glyph-cli measures
first. This record is a measurement and a design; it contains no build code. Tracked under GCLI-66.

The ADR number 0008 is the next free one at the time of writing; the release-scripts ADR planned
as S5 takes the next number after it.

## Context

Glyph answers `callers`, `impact`, `diff`, `code-map` and `--stream` from a `GlyphIndex` (symbols
and call sites) that `src/indexer.ts` builds from one TypeScript program through the compiler API,
caches under `$GLYPH_CACHE_DIR`, and can build for a commit with no checkout (`--ref`,
`src/snapshot.ts`). DEC-303 keeps that indexer and adds Python through pyright's public interface,
`pyright-langserver --stdio`, using `documentSymbol` and `workspace/symbol` for the symbol table and
call hierarchy and `references` for the call graph. It asks for a measurement of call-hierarchy
completeness against a hand-checked set of call sites, and for the ADR to propose the alternative
(pyright references, or tree-sitter plus pyright) if recall is poor.

### What was measured, and how

Everything below is reproducible from the files in `test/python-lsp-measurement/` (the ground
truth, the rules, the fixtures, the harness and the scorer); that directory is a recorded
artifact and is not shipped (`package.json` `files` is `dist`, `README.md`, `LICENSE`).

- **Server.** pyright 1.1.414, installed with `npm install pyright@1.1.414 --ignore-scripts`; the
  registry's integrity for that version is
  `sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==`
  (`npm view pyright@1.1.414 dist.integrity`). Node v24.22.2, macOS (Apple silicon, 10 cores),
  git 2.56.0. The server found the host's Homebrew Python 3.15.2 for its stdlib path, so the host
  Python environment is an input to the results (third-party packages installed there, such as
  certifi, resolve; packages not installed there, such as urllib3 and idna, do not).
- **Real repository.** psf/requests at `3c7baaa05ab4aa49cc819ce3a819d260de19c157` (commit date
  2026-10-26), `src/requests`: 19 files, 6,394 lines, 320 definitions. Chosen by criteria stated
  before looking at any result: pure Python with a small dependency surface, small enough to hand
  check, and containing real `self.` methods, inheritance and `super()`, classmethods and
  staticmethods, decorators, overloads, callbacks, aliased imports and a platform-conditional
  branch. It is not a claim that requests is typical; see Limits.
- **Ground truth, fixed before pyright ran.** Python's own `ast` enumerated every definition and
  every syntactic call (986 calls and 43 decorator applications). Targets were a seeded stratified
  sample (seed 303): 46 definitions across ten strata (10 functions, 12 methods, 2 staticmethods,
  the package defines no classmethod, 8 classes, 2 nested functions, 6 methods whose
  name is defined more than once, 3 `__init__`, 3 definitions with no call by name). For each,
  every candidate site was classified by hand under written rules (`gt_rules.md`; static receiver
  type decides; `Cls(...)` is a call to the class and to `__init__`; `super().m()` is a call to the
  base `m`; a decorator application is a call; a function passed or stored is a reference, not a
  call; calls through a variable are excluded and stated as the ground truth's blind spot). The
  rules and the classification were committed in a scratch git repository at 09:15:32 -06:00 and
  the fixtures' expected truth at 09:16:23, before the first pyright request was sent
  (`git log` of that repository; the files are copied unchanged into the recorded artifact).
  Result: 65 true call sites across 36 targets with at least one, and 9 targets with none.
- **Fixtures.** 22 definitions and 37 calls written to exercise what the real repository cannot
  guarantee to contain: inheritance, overrides, `super()`, classmethod and staticmethod, a
  property, a decorator, aliased imports (`from m import f as g`), `cls(...)`,
  calls through a variable and a callback, comprehensions, async. Expected truth was written
  before the run. Fixtures are adversarial by design; they show which cases fail, not a rate.
- **Harness.** A Node client speaking JSON-RPC over `pyright-langserver --stdio` with
  Content-Length framing: `initialize`, `textDocument/documentSymbol` per file,
  `workspace/symbol` per distinct name, `prepareCallHierarchy` then `incomingCalls` and
  `outgoingCalls`, `textDocument/references` (includeDeclaration false), and
  `textDocument/definition` at the callee of every syntactic call. Positive controls: the harness
  fails if no request is answered, and a fixture call pyright must find is in the target set.
  Every response that arrived was counted (1,473 of 1,473 requests answered, 0 errors).

### Results

All numbers are for the default platform (macOS) unless a row says `pythonPlatform: "All"`.
Intervals are 95% Wilson; a perfect score has a rule-of-three miss-rate bound of about 3/n.

**Call hierarchy, `psf/requests`, 46 targets, 65 true sites.**

| kind | recall | precision |
|---|---|---|
| incoming calls | 58/65 = 0.892 (0.794-0.947) | 58/58 = 1.000 (0.938-1.000) |
| incoming calls, `pythonPlatform: "All"` | 59/65 = 0.908 (0.813-0.957) | 59/59 = 1.000 (0.939-1.000) |
| references (true call sites found) | 58/65 = 0.892 | 40 extra references, all hand-classified valid |
| targets with no true site | n/a | 9/9 returned no false site |

The six sites missed with `pythonPlatform: "All"` are all constructor calls to `__init__`
(`PreparedRequest()` x3, `HTTPBasicAuth(...)`, `MockRequest(...)` x2): call hierarchy attributes a
constructor call to the **class**, not to its `__init__`, so incoming calls on an `__init__` list
only explicit `super().__init__()` sites. The class targets (8 targets, 17 sites) found 17/17. By
stratum, with `"All"`: function 20/20, method 12/12, staticmethod 3/3, class 17/17, nested 2/2,
overridden 5/5, zero-candidate 0 false extras, `__init__` 0/6. Without `"All"` one more site is
missed: `proxy_bypass_registry` is defined under `if sys.platform == "win32"`, which pyright treats
as unreachable on macOS, so `prepareCallHierarchy` returns null there and its caller is not found.
Counting the six constructor sites as a different kind, recall is 59/59 on the other kinds (rule of
three: a miss rate above about 5% on this population is unlikely; 97% and 99.9% cannot be told
apart at n = 59).

**Symbols.**

| kind | recall | precision |
|---|---|---|
| `documentSymbol` | 298/320 = 0.931 (0.898-0.954) | 298/298 = 1.000 |
| `documentSymbol`, `pythonPlatform: "All"` | 300/320 = 0.938 | 300/300 |
| `workspace/symbol`, every file open | 298/320 = 0.931 | n/a |
| `workspace/symbol`, files not open | 43/320 = 0.134 (0.101-0.176) | n/a |

The 20 `documentSymbol` misses with `"All"` are the `@overload` stub definitions: pyright reports
the implementation, not each overload signature. `references` at an overload stub also returns the
other overload declarations and the implementation's `def` line (10 of the 40 extra references).

**Fixtures, 18 targets, 28 true sites (adversarial, not a rate).** Incoming calls 17/28
(recall 0.607, precision 17/18); symbols 22/22; negatives 3/3. The failures group into four
causes: (1) calls through an **aliased import** (`helper as h`, `Dog as Doggo`) are missing from both
`incomingCalls` and `references` (4 sites), although `textDocument/definition` at each such call
resolves correctly to the aliased target; (2) a constructor call is attributed to the class and
not to `__init__` (4 sites, as in the real repository); (3) a decorator application is not a call
in call hierarchy (1 site; `references` finds it); (4) one false positive: an attribute access that
is not called (`Cat("x").speak`, later called through a variable) is listed as a call.

**Outgoing calls, and the union, which is what the design ships.** Built per function symbol with
`outgoingCalls`, a true site counts as found only if the callee is the target (same name, same file,
a line within 3 of its definition; an `__init__` target also matches its class). Scored that strict
way, per site (`union.py`; a line that holds two true sites needs two found sites):

| set | incoming | outgoing | union |
|---|---|---|---|
| real, `pythonPlatform: "All"` (65 sites) | 59/65 = 0.908 (0.813-0.957) | 57/65 = 0.877 (0.775-0.936) | 59/65 = 0.908 (0.813-0.957) |
| fixtures (28 sites) | 17/28 = 0.607 (0.424-0.764) | 20/28 = 0.714 (0.529-0.847) | 20/28 = 0.714 (0.529-0.847) |

The union is computed per true site: found if the target's `incomingCalls` lists it or any function's
`outgoingCalls` lists a range there whose callee is the target. On the real repository the union adds
nothing over incoming calls (the 2 sites incoming finds and outgoing does not are calls at module
scope, which no function symbol encloses; outgoing finds no site incoming misses), and no outgoing
edge to a target was a false site. On the fixtures the union gains the three aliased-import calls
over incoming. An earlier, looser reading of this check, "an outgoing range exists on the true
site's line, whatever its callee", gives 63/65 on the real repository and 25/28 on the fixtures; it
is not a recall figure and is not used. The five fixture calls still missed by every route are calls
through a variable, a closure variable and `cls(name)`; the six real constructor sites are missed
by both routes when asked as calls to `__init__`, and found under the class (below).

**Constructor sites, asked of the class.** Querying `incomingCalls` on the three classes that own
the six constructor sites (`PreparedRequest`, `HTTPBasicAuth`, `MockRequest`) returns all six
(6/6; `cls-1` in `results/raw/`). This is the mapping the design proposes (a constructor call is
recorded against the class and as an edge to its `__init__`); it was measured as a separate query,
not run end to end, because the mapping is a build slice.

**Resolution at every call site.** `textDocument/definition` at the callee of all 1,028 syntactic
calls and decorators in requests: 312 resolve inside the package (22 of them to a variable or
alias rather than a def), 648 to typeshed or the stdlib, 2 to an installed third-party package, and
66 resolve to nothing (third-party packages not installed on the host, such as `urllib3.parse_url`,
untyped attributes, and Windows-only names). Of the 13 in-package results whose target name
differs from the call's name, all 13 were aliases (`_is_prepared`, `RequestsSSLError`,
`RequestsJSONDecodeError`): zero wrong resolutions in the sample.

**Determinism and ordering.** Six runs with every file opened up front returned byte-identical
results (excluding timings). Two runs that opened each file only when its target was queried
returned different results from each other and from the all-open runs in 7 of 46 targets: an
incoming-call answer depends on which files the server has open and analysed when the question is
asked. The client must therefore open every file before any query. Pyright also returned each
incoming site twice for some targets (20 duplicate sites removed before scoring), so the client
dedupes by (file, line, column).

**Time, on the 19-file repository, cold server start each run, seven runs.** `initialize` 75-108 ms;
the 19 `documentSymbol` answers together 165-217 ms; per request means: `prepareCallHierarchy`
0.1-0.3 ms (one run 2.5 ms), `incomingCalls` 15-22 ms (max 293 ms), `outgoingCalls` 2-7 ms (max
121 ms), `references` 3-7 ms (max 119 ms), `definition` 2.1-2.3 ms (max 27 ms). The whole
1,473-request run, including the 1,028 definition requests, took 3.6-4.2 s. Building a full edge set with `outgoingCalls` and `incomingCalls` for each of the 320
symbols is 640 requests, under 4 s here. The machine was otherwise idle; none of this was measured
under load.

### What the sample can and cannot show

- It is **one** repository of 19 files and 65 true call sites, plus 28 fixture sites. A perfect
  result on 59 sites cannot distinguish 97% from 99.9% recall, and says nothing about other code
  styles (heavy metaprogramming, dynamic attribute dispatch, large generated modules, untyped
  code with no annotations at all, namespace packages, Django-style magic).
- requests is annotated (it ships `py.typed` and type comments); pyright resolves more in typed
  code. Unannotated Python is the case most likely to lose sites and is not measured.
- The ground truth is blind to calls through a variable, `getattr`, and anything outside
  `src/requests`; those sites are neither counted as misses nor as hits.
- Sixty-five sites over 46 targets means the per-stratum numbers have n between 0 and 20; none of
  them supports a rate, only the presence or absence of the failure.
- The measured size and speed are for a small package; scaling to a monorepo (thousands of files,
  pyright's memory use and its first full analysis) is not measured, and the adapter below states
  that as a limit and bounds it with the wall-time budget.

## Decision

Recall on the call kinds that matter is high enough that the alternative DEC-303 item 4 reserves
(`references`-only, or tree-sitter plus pyright) is **not** proposed. Whether the numbers are "poor"
is opum-doc's reading to make. This ADR proposes a bar and says plainly what it does and does not
clear: *recall on non-constructor call kinds at least 0.9, with a 95% lower bound above 0.8.*

What the bar is scored against, and whether it is met, depends on the quantity:

| quantity scored (requests, 65 true sites) | recall (95% Wilson) | meets the bar |
|---|---|---|
| incoming calls, default platform (what a bare pyright run gives) | 58/65 = 0.892 (0.794-0.947) | **no** (point below 0.9, bound below 0.8) |
| incoming calls, `pythonPlatform: "All"` | 59/65 = 0.908 (0.813-0.957) | yes |
| union of outgoing and incoming, `pythonPlatform: "All"` | 59/65 = 0.908 (0.813-0.957) | yes (equal to the line above on this repository) |
| the shipped design: that union plus the constructor-to-class mapping, `"All"` | 65/65 = 1.000 (0.944-1.000), constructors measured as a separate class query | yes, with the caveat that the mapping was not run end to end |

So "met" is true of the quantity the design ships (the union under `pythonPlatform: "All"`, with
constructor calls recorded against their class) and is **not** true of incoming calls alone on the
default platform; the 0.892 figure is the one the build must not be read as having cleared. On the
fixtures the same union scores 20/28 = 0.714 (0.529-0.847), which is below the bar by design: they
contain the failure cases on purpose, and they are not a rate. If opum-doc scores the bar on the
fixtures, or on incoming calls alone, it is not met and the alternatives are back on the table.
The bar is not edited to fit the result; D3 is opum-doc's to rule.

The design follows. Names are proposals for the build slices; nothing here is implemented.

### 1. Where it sits

A `LanguageIndexer` seam produces the same `GlyphIndex` (symbols and call sites) the queries,
`impact`, `diff` and `code-map` already consume, so `callers`, `impact`, `diff`, `code-map` and
`--stream` keep their envelopes, kinds and exit codes (DEC-303 item 2). The TypeScript indexer is
unchanged and is one implementation of the seam; the Python indexer is a second one built from a
language-neutral LSP client plus a thin pyright-specific layer (server command, initialization
options, the quirks in section 5). The client contains nothing Python-specific, so gopls or
rust-analyzer can be a third implementation later without touching it.

### 2. The language-neutral LSP client

- **Spawn.** `child_process.spawn` of the server binary resolved from the package's own
  `node_modules/.bin` (pyright is a runtime dependency, section 7), `stdio` pipes, `cwd` the
  analysis root, no shell, no inherited secrets beyond the environment the CLI already passes.
- **Framing.** `Content-Length` headers parsed from a byte buffer that survives a header or body
  split across chunks, in bytes not characters, with a hard cap on one message's size; a malformed
  header or an oversized message is a protocol failure (exit 7).
- **Requests.** One id map; a request resolves on its response, rejects on a response error, on
  the per-request timeout, or on the server's exit. Server-to-client requests that pyright sends
  (`workspace/configuration`, `client/registerCapability`, `window/workDoneProgress/create`) are
  answered with an empty result; notifications are ignored.
- **Timeouts and the wall-time budget.** Every request's timeout is `min(a per-request cap, the time
  the run's budget has left)`, the same rule `src/codemap.ts` applies to its git reads. For
  `code-map`, a request the budget cuts off with the budget really spent is a stop and a
  `code-map#time-budget` omission, exactly as for the TypeScript path (ADR 0005); a request that
  dies for another reason is exit 7. `callers`, `impact` and `diff` have no budget today and keep
  none; they use the per-request cap and an overall startup cap.
- **Crash and failure handling, fail closed.** If the server exits, writes to stderr and then
  exits, never answers `initialize`, answers `initialize` without `callHierarchyProvider` or
  `documentSymbolProvider`, or returns a JSON-RPC error for a request the design depends on, the
  run fails `indeterminate` (exit 7) with a message that names the language, the server command and
  version, the request, and the first 400 characters of the server's stderr. There is no restart and
  no silent fall back to an empty graph (DEC-299 (a5)). `shutdown` and `exit` are sent on
  completion; the process is killed after two seconds if it does not exit; a child is never left
  running after the CLI returns, including on SIGINT and on an uncaught error.
- **Result hygiene.** Every location is normalised to a repository-relative path; a location
  outside the analysis root is classed `external` and never emitted as a repository file. Incoming
  and outgoing sites are deduplicated by (file, line, column) (measured: some targets returned each
  site twice).

### 3. Opening files, and what the index is built from

- **Open everything first.** Before any query the client sends `didOpen` for every Python source
  file in scope (the measurement above: files not opened gave 13% `workspace/symbol` recall and
  non-reproducible incoming calls; all-open runs were identical in 6 of 6). A file-count cap bounds
  this; over the cap the run is `indeterminate` and says so, never a partial graph presented as
  complete.
- **Symbols** from `documentSymbol` per file (hierarchical), not from `workspace/symbol`, which is
  used only for name lookup after everything is open.
- **Edges** are the union, deduplicated, of `outgoingCalls` for every function and method symbol
  and `incomingCalls` for every symbol. The union is the measured choice: `incomingCalls` alone
  misses aliased-import calls and constructor calls on `__init__`; `outgoingCalls` alone misses
  calls at module scope. A call to a class is recorded as a call to the class and, when the class
  defines or inherits `__init__`, as a constructor edge to that `__init__` (so `callers` of an
  `__init__` answers what a user expects). Decorator applications come from `references`
  (call hierarchy omits them) and are recorded as `decorator` sites, a kind the TypeScript index
  does not have and which the envelopes would need to name.
- **Overloads**: an `@overload` stub has no symbol of its own in pyright's `documentSymbol`; the
  index records the implementation and states that overload signatures are not separate symbols.

### 4. Command mapping

| glyph | pyright requests |
|---|---|
| `callers <name>` | resolve `<name>` through the symbol table; `incomingCalls` (and the union of section 3) |
| `impact <name>` | breadth-first reverse closure over the same edges; one `prepareCallHierarchy` plus one `incomingCalls` per node reached (about 15-22 ms per node measured); `--depth`, `--all`, cycles and `truncated` as for TypeScript |
| `diff <base> [head]` | git's changed line ranges (unchanged) intersected with `documentSymbol` ranges, innermost symbol only |
| `code-map` | named paths and changed files as today (git only); the symbol tier from `workspace/symbol` and one call-graph hop out from `references` and `incomingCalls`; the identifier tier is git grep and needs no server |
| `--stream` | unchanged: items as found, one result line, same kinds |

### 5. Language detection, and the override

- Detection is per repository from the files in scope: a source file's extension (`.py`, `.pyi`
  for Python; the existing set for TypeScript and JavaScript). The language with more files is
  indexed. When both are present and the minority is more than a handful of files, the coverage line
  says that the other language was not indexed; it is never silent.
- **`--language <typescript|python>`** (a global option, declared in `help --json`) overrides
  detection. An unknown value is a usage error (exit 2). A repository with no file of the chosen
  language answers `not_found` (exit 3) naming the language, never an empty graph.
- Pyright's configuration follows the repository's own (`pyrightconfig.json`,
  `pyproject.toml [tool.pyright]`) when present. Absent one, the adapter passes
  `pythonPlatform: "All"` (measured above to recover platform-conditional definitions) and
  nothing else. It records which Python interpreter pyright resolved in the answer's
  `index` block, because the measurement shows the host environment changes what resolves.

### 6. `--ref` and the cache

An LSP server reads the filesystem, so `--ref` materialises the commit's Python files (and the
pyright configuration files) into a temporary directory under the glyph cache, using the same
no-checkout object reads as `src/snapshot.ts`, points the server at it, and removes it on exit.
This is a build-slice design with no measurement behind it yet; its cost on a large repository is
the first thing the slice measures. The index cache for Python is keyed like the TypeScript one
(commit, language, server version, configuration digest) so a cached index is never reused across a
pyright upgrade.

### 7. Packaging

pyright is an npm runtime dependency of `@opum-ai/glyph`, external to the bundle like `typescript`
and `commander` (ADR 0007, DEC-299 (a1)), pinned to an exact version; the version the measurement
used is 1.1.414. The bundle check (`scripts/check-package.mjs`) and the packed-tarball install test
gain a pyright resolution check and a Python smoke test (an index of a small fixture repository
under Node, from the installed tarball). A server that cannot be resolved is `indeterminate` with
the install hint, never a skipped language.

### 8. Stated limits (documented in the README with the build)

- Calls through a variable, `getattr`, `__getattr__` or `__call__` dispatch, and decorators that
  return untyped wrappers are not guaranteed; what pyright can resolve is reported as found.
- The coverage line for Python reports sites resolved in the package, resolved externally (stdlib,
  typeshed, installed packages) and the sites `definition` could not resolve **where glyph has
  their position** (it has them for every site it records as an edge, not for a call that no edge
  records). An exact `unresolvedSites` count would need a syntactic enumeration of all calls, which
  the LSP does not offer; see open decision D1.
- A changed file whose path pyright cannot open is `indeterminate` rather than skipped, as for
  TypeScript (ADR 0002, DEC-299 (a6)).
- Results depend on the host's Python environment for third-party resolution; the interpreter
  pyright resolved is part of the answer.
- Platform-conditional code is analysed for all platforms; code under a version check follows
  pyright's `pythonVersion` default.
- Monorepo scale is bounded by the wall-time budget and the file cap, not measured.

### Open decisions for opum-doc

- **D1. The unresolved-site count.** TypeScript publishes `unresolvedSites` from a syntactic
  enumeration of every call. The LSP cannot enumerate calls. Options: (A, recommended) publish for
  Python the three counts above and state that a call with no recorded edge is not enumerated, so the
  count is a lower bound and the envelope says so with a field (`unresolvedKnown: false`); (B) add a
  small syntactic pass (a tree-sitter Python grammar, or a lexical `identifier(` scan as an
  over-approximate upper bound) to give an exact or bounded count. B is DEC-303's alternative
  applied for a different reason than recall; it is not needed for recall and adds a dependency.
- **D2. Mixed-language repositories.** Recommended: index one language per run (detection or
  `--language`), say plainly when the other was skipped, and put "index both and merge" after 0.1.0.
- **D3. The threshold, and the quantity it applies to.** The 0.9 recall / 0.8 lower-bound bar above is
  a proposal, met by the shipped union under `"All"` and not met by incoming calls alone on the default
  platform or on the fixtures. opum-doc rules on both the bar and which quantity it scores. A higher bar
  needs a second real repository, ideally one without type annotations, measured by the same method
  before the build slices start.

## Consequences

- Python adds one runtime dependency (pyright, from npm) and about 4 s of cold start for a 19-file
  package on an idle machine; the TypeScript path's measured cold build is shorter. Warm runs rely on
  the same cache design; the cache key includes the server version.
- The seam, the client and the pyright layer are separately testable: the client against a fake
  server that frames messages badly, hangs, crashes and answers errors (each a named exit-7 case
  with a both-ways test), the pyright layer against the fixtures here, with the ground truth in this
  record as the expected values, and the measurement script re-run in CI on the pinned requests
  commit only if opum-doc wants it as a standing gate.
- Release floor per DEC-303 item 5: Sonnet writers and an Opus review per slice. Slices proposed
  (not started): the LSP client and its failure tests; the Python index from symbols and edges;
  detection and `--language`; `--ref` materialisation; packaging; README limits.
- The measurement script and ground truth stay in the repository as a recorded artifact so the
  numbers here can be re-derived when pyright is upgraded; an upgrade re-runs it and records the
  new version and bytes.
- What this record does not settle: recall on unannotated or metaprogramming-heavy code, scale,
  `--ref` cost, and D1 to D3.
