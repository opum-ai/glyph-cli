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
  (`results/ground-truth-provenance.txt`), which match the files here byte for byte, not on a long gap; the commit dates and
  file times are **self-asserted**, not independent timestamps.
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
  target record. `pythonPlatform: "All"` is set by a `pyrightconfig.json` in the analysis root. Channels tried (`results/platform-channels.txt`):
  answering the server's `workspace/configuration` request with the setting (two shapes) and sending it in
  `initializationOptions` did **not** change pyright 1.1.414's behaviour; a config file did, including one in a directory
  outside the repository whose `include` is the absolute package path.

### Results

Intervals are 95% Wilson unless a table says otherwise. A site is one call; a line holding two true sites needs two found
sites. Sites cluster by target, so a target-level figure is given beside each site-level one, over the 37 targets that have a
true site (a target is fully correct when every true site is found and nothing else is listed; the 9 zero-truth targets are
precision controls and would inflate a target-level recall), and the bar section adds a cluster bootstrap over those 37. `incoming` is the target's `incomingCalls`; `outgoing` is any function's `outgoingCalls` whose callee
item is at the target's definition (matched by location, because an aliased import names the callee by its alias);
`union` is the distinct sites of both; `+ ctor map` adds, for an `__init__` target, the union sites of its class and of
subclasses with no `__init__` (a constructor call runs `C.__init__`). `union.py` computes all of them
(`results/union-*.txt`).

**Pre-registered sample, `psf/requests`, 46 targets, 65 true sites.**

| set | platform | site recall | site precision | targets fully correct (of the 37 with a true site) |
|---|---|---|---|---|
| incoming | default (macOS) | 58/65 = 0.892 (0.794-0.947) | 58/58 = 1.000 (0.938-1.000) | 33/37 = 0.892 (0.753-0.957) |
| incoming | `"All"` | 59/65 = 0.908 (0.813-0.957) | 59/59 = 1.000 (0.939-1.000) | 34/37 = 0.919 (0.787-0.972) |
| outgoing | default | 56/65 = 0.862 (0.757-0.925) | 56/56 = 1.000 | 31/37 = 0.838 (0.689-0.923) |
| outgoing | `"All"` | 57/65 = 0.877 (0.775-0.936) | 57/57 = 1.000 | 32/37 = 0.865 (0.720-0.941) |
| union | default / `"All"` | equal to incoming on both | equal to incoming on both | equal to incoming on both |
| union + ctor map | default | 64/65 = 0.985 (0.918-0.997) | 64/64 = 1.000 (0.943-1.000) | 36/37 = 0.973 (0.862-0.995) |
| union + ctor map | `"All"` | 65/65 = 1.000 (0.944-1.000) | 65/65 = 1.000 (0.944-1.000) | 37/37 = 1.000 (0.906-1.000) |

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

**Alias set, added after the first results (post hoc), 4 targets, 15 true sites, a census, not a sample.** The pre-registered sample could not
contain an aliased call (`gt2_listing.py` matches callee names only), so it could not show how pyright treats
`from m import f as g`. `alias_enum.py` lists every in-package relative aliased import of a definition in its defining
module and every call through the alias (13 sites on 3 targets), plus the direct calls of those targets (2 more) so
precision is scored against a complete truth. The fourth target, `SupportsItems` (`_types.py:38`), is aliased only in an
annotation and has no call at all: a zero-truth precision control.

| set | site recall | site precision | targets fully correct |
|---|---|---|---|
| incoming | 2/15 | 2/2 | 1/4 |
| outgoing | 15/15 | 15/15 | 4/4 |
| union | 15/15 | 15/15 | 4/4 |

The alias set is every in-package relative `from .m import a as b` of a definition in `m` (the narrow rule is its limit), so
it is a census of what that rule finds and carries counts, not intervals.

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
Windows-only names); with `"All"`: 314 in the package, 655 to typeshed or the stdlib plus 2 to an installed package, and 57 to nothing. At the 65 ground-truth call sites the definition resolves to the target's
own definition (the exact line spans of its definitions, no line window; for an `__init__` target the class's spans also
count) in 64 (default) and 65 (`"All"`) cases; the same check on the fixtures gives 18/18 of the 18 (call, callee) pairs
checkable by name; 8 (target, line) pairs on 6 distinct lines cannot be matched by name: the aliased call `h(1)` at
`use.py:44`, the constructor calls `Cat("tom")`, `Cat("x")`, `Doggo("rex")` and `cls(name)` (for `Animal.__init__`, `Dog.__init__`
and the classes `Animal` and `Dog`), and the bare `@traced` decorator, which is not in the call list. That catches a same-named wrong target, which the 13 name
mismatches (all import aliases) alone would not. The 22 results that land on a variable or alias were not individually checked.

**Determinism, ordering and the open-file requirement.** Six runs with every file opened before any query returned
byte-identical results (excluding timings). Two runs that opened each file only for its own query were identical to each
other but differed from the all-open runs in 11 of 52 targets (`results/compare-runs.txt`); an earlier pair of such runs on a
smaller target list differed from each other as well, but its raw output was not kept, so only the recorded 2-of-2 is
claimed. Either way an answer depends on which files the server has open, and `workspace/symbol` finds 13% of symbols
when files are not open. Pyright returned some incoming sites twice (20 duplicates in the real run, 7 in the fixtures); the
client dedupes by (file, line, column). Whether pyright needs a readiness wait on a larger repository is not measured:
the 6-of-6 determinism is on 19 files.

**Time, 19-file repository, cold server start each run.** The measured start-up (`initialize` plus all `documentSymbol`
answers) is about 0.26 s; the 3.6-3.9 s below is the whole measurement run of 1,496 requests, not a cold start. `initialize` 78-82 ms; the 19 `documentSymbol` answers together
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
  conditional imports, notebooks, namespace packages, `.pyi`-only stub packages, real `src`-layout repositories and monorepo roots (a `src` layout was measured only on one 3-file
  fixture, for import resolution), virtual
  environments and `pythonPath`, `pythonVersion` host dependence, and uninstalled third-party packages are not measured.
- **Scale and environment.** Memory use and first-analysis time on thousands of files are not measured; the host Python
  environment changes what resolves (measured only for the two certifi calls).
- **Subclass constructors.** A call to a subclass that inherits `__init__` is invisible to the ground truth and to the scorer
  unless the subclass is sampled (`gt_rules_addendum.md` item 8).
- **Machine.** One idle machine; nothing here is measured under load.

## Decision

Recall on the call kinds that matter is high enough that the alternative DEC-303 item 4 reserves (`references`-only, or
tree-sitter plus pyright) is **not** proposed. Whether the numbers are "poor" is opum-doc's reading to make.

### The bar, what it scores, and whether it is met

The bar is proposed here, **after** the results were seen (no threshold was fixed in advance; the ground-truth rules say
"not decided here"): *recall over all true call sites of at least 0.9, with a 95% lower bound above 0.8, on the
pre-registered sample.* Sites cluster by target, so a site-level Wilson interval is optimistic; the table gives it beside a
cluster bootstrap (10,000 resamples of the 37 targets that have a true site, fixed seed, `union.py`) and the target-level
figure. A bootstrap of a perfect score has no variance (1.000-1.000), so the shipped row is judged on the target-level Wilson.

| quantity (65 true sites, 37 targets with a site) | site recall, Wilson | recall, cluster bootstrap | targets fully correct (Wilson) | meets the bar: site-level / cluster-robust |
|---|---|---|---|---|
| incoming calls, default platform | 58/65 = 0.892 (0.794-0.947) | 0.768-0.985 | 33/37 = 0.892 (0.753-0.957) | no / no |
| incoming calls, `"All"` | 59/65 = 0.908 (0.813-0.957) | 0.788-1.000 | 34/37 = 0.919 (0.787-0.972) | yes / **no** (0.788 and 0.787 are below 0.8) |
| union, `"All"` | 59/65 = 0.908 (0.813-0.957) | 0.788-1.000 | 34/37 = 0.919 (0.787-0.972) | yes / **no** (equals incoming on this sample) |
| union + constructor mapping, default | 64/65 = 0.985 (0.918-0.997) | 0.946-1.000 | 36/37 = 0.973 (0.862-0.995) | yes / yes |
| union + constructor mapping, `"All"`, scored with the scorer's rule, not the shipped MRO rule; **in-sample fit** | 65/65 = 1.000 (0.944-1.000) | 1.000-1.000 (no variance) | 37/37 = 1.000 (0.906-1.000) | yes / yes, on target-level Wilson 0.906 |

The `"All"` figures above were measured with the config inside the checkout and were **reproduced under the shipped layout** (analysis
root outside the repository: 65/65 with `include` only and with `extraPaths` = [`src`] on requests, `results/layouts.txt`; the shipped
[repository root, `src`] pair itself was not run on requests, only on the fixture). requests
uses only relative intra-package imports, so that reproduction does not exercise absolute first-party imports; the separate
absolute-import fixture does (section 5). Its truth was written before the run, which is self-asserted (a `_note` in the file;
it was not committed to the provenance bundle).

So "met" is true of the quantity the design ships as scored with the scorer's simpler constructor rule (the union under
`pythonPlatform: "All"` with constructor calls recorded against their class), and only because of the constructor mapping, which
was designed on the six sites it then recovers. Whether the shipped MRO rule also gives 6/6 was not scored; by reading the three
class statements (`PreparedRequest`, `HTTPBasicAuth`, `MockRequest`: in-repository bases or none, no decorator, `metaclass` or
`__new__`) all three are plain, so it should, but that is a hand check, not a committed result.
It is **not** true of incoming calls alone or of the union without the mapping under a cluster-robust interval (lower
bound 0.788 on `"All"`, 0.768 on the default platform), and not on the default platform with incoming alone under any
interval. It is not true of the fixtures (union + constructor mapping 0.893, lower 0.728) and not true of incoming calls on
the alias set (2/15); both are adversarial or post hoc and are reported, not scored against the bar. The bar is not edited
to fit the result; D3 is opum-doc's to rule.

**The shipped 65/65 is an in-sample fit, not a held-out result.** The constructor mapping was designed after the
six constructor misses (and the fixtures' constructor misses) were seen, and is then scored on those same sites. The 6/6
and the 65/65 therefore show that the mapping can reproduce what the data showed, not that it generalises. The fixtures are
not held out either: they were run before the mapping was written. Proposed held-out tests, both with the mapping rule and the ground-truth
rules committed first and scored by the same `union.py`: (a) a **fresh seed** drawing only `__init__` and class targets
from requests that the first sample did not draw (partially held out: same repository, same author of the rules); (b) a
**second real repository**, ideally unannotated, with class hierarchies and at least 20 constructor sites (held out). A
result that repeats 0.9 / 0.8 on (b) is evidence; this sample alone is not. Whether acceptance waits on them is D3.

**Can the matching credit a wrong edge, and was precision measured?** Two matching rules could, and each was checked.
(i) The callee-location match for outgoing calls began as a window of +-3 lines around the definition; that credited
neighbouring definitions (two false matches measured, `gt_rules_addendum.md` item 5) and was replaced by the exact lines of
the target's own definitions (an overload stub and the implementation, plus decorator lines above). (ii) The
`__init__`-to-class equivalence attributes the sites of class `C` to `C.__init__`; it credits a wrong edge wherever construction
is intercepted and the interception is not detected: a metaclass `__call__` (including an inherited metaclass), `__new__`,
`Enum`, pydantic, Django and `attrs`/`dataclass` generated `__init__`. The shipped rule excludes those it detects (section 3); a
missed detection is a **wrong** edge, not an empty answer, and the sample contains none of these, so this is untested. (iii)
The `@`-line decorator rule (section 3) can credit a wrong edge for a re-exported name. Precision of the mapping was measured
with the scorer's simpler rule, not the shipped one.
Precision was measured for incoming, outgoing, the union and the mapping, per site and per target: the union adds no false
site on the pre-registered sample (58/58, 59/59), and the mapping added 10 sites (6 real, 4 fixture), all true (10/10, lower
bound 0.722); the one fixture false positive (an attribute access that is not called) comes from incoming calls, not from
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
  `window/workDoneProgress/create`) are answered with an empty result (settings sent that way do not reach pyright, measured); notifications are ignored.
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
- **Result hygiene.** Paths are canonicalised with `realpath` first (macOS `/var` and `/tmp` resolve under `/private`). A
  location is repository-internal if its canonical path is inside the **repository root** (or the `--ref` materialisation
  directory) and in the include set, and is then normalised to a repository-relative path; any other location is `external`
  and never emitted as a repository file. The analysis root is a temp directory (section 5), so "outside the analysis root"
  is not the test. Sites are deduplicated by (file, line, column).

### 3. Opening files, and what the index is built from

- **Open everything first.** Before any query the client sends `didOpen` for every Python source file in scope (files not
  opened gave 13% `workspace/symbol` recall and different incoming answers in 11 of 52 targets; all-open runs were identical
  6 of 6). There is a file cap. **Over the cap the run is `indeterminate` and says so; large Python repositories are
  unsupported in 0.1.0.** The cap value is a placeholder for the first slice to set from a measurement on a larger repository
  (starting point: 2,000 files); nothing in this record supports a larger number.
- **Symbols** from `documentSymbol` per file (hierarchical); `workspace/symbol` is not used to build the index.
- **Edges** are the deduplicated union of `outgoingCalls` for every function and method symbol and `incomingCalls` for every
  symbol. **Callee-to-symbol rule, in LSP terms**, in this order: (1) the function, method or class symbol whose
  `documentSymbol` `selectionRange` equals the callee item's `selectionRange`; (2) failing that, only when the callee item's
  line is a `def` or `class` line (a lexical check of that one line, so a local binding such as `fn = partial(...)` is never
  credited to its enclosing function), the **innermost** symbol **of the callee item's own kind** (function/method, or
  class) whose range contains it; (3) failing that, for a callee on a `def` line that is an `@overload` stub (recognised
  lexically: the nearest decorator line above the `def` is `@overload` or `@typing.overload`; a stub has no `documentSymbol`
  entry, module-level stubs fall inside no range and a method's stubs fall inside its class's range), the same-named
  function/method symbol in the innermost container, **unless there is more than one candidate** (`if`/`else` version
  branches, getter and setter pairs), which is `unattributed`; (4) otherwise `unattributed` (below). The names do not enter,
  because an aliased import names the callee by its alias. The measurement matched callees against `ast` definition spans
  including stubs, which the shipped index does not have; how pyright's callee items look for overloaded methods was not
  measured, and no measured case needs rule (2) except stubs.
- **Constructor edges.** One rule. A call to class `C` is recorded as an edge to `C`; it is also recorded as an edge to the
  `__init__` found by looking `__init__` up along `C`'s method resolution order (C3 linearisation of `C` and its
  in-repository bases), provided `C` is a **plain class**: no class decorator on the lines directly above the `class`
  statement, no `metaclass=` keyword, no `__new__` in `C` or any in-repository base, and every base either in the repository
  and itself plain, or `object`. Anything else (a base from outside the repository such as `Enum`, `NamedTuple`, `TypedDict`, a
  pydantic `BaseModel` or a Django `Model`; an inherited metaclass; `@dataclass`, `attrs`) is not mapped: the edge stays on the
  class, and the answer for `callers C.__init__` carries a per-answer note that constructor calls to `C` are recorded against
  the class (D4). `documentSymbol` exposes neither bases, class decorators nor `metaclass=`: the design reads them from a
  lexical parse of the one `class` statement (and the `@` lines above it) and resolves each base name with `definition`;
  that parse is not measured here (the scorer got bases from `ast`). **The conservative direction is the rule:** a parse that fails
  (a multi-line or starred base list, `class C(make_base()):`, a base held in a variable) or a base whose `definition` does not
  land on an in-repository class symbol makes `C` not plain. **A missed detection produces a wrong edge, not an
  empty one** (it is listed under "Can the matching credit a wrong edge" and in section 8). The scorer's rule is simpler (the
  class and subclasses with no `__init__`, one level down) and is not the shipped rule.
- **Decorator sites from `references`.** `references` also returns imports, annotations, base classes, `__all__` strings,
  overload declarations, `@prop.setter` and `@prop.deleter` lines and names used as arguments inside a decorator expression
  (`@register(target)`, `@pytest.mark.parametrize("x", [target])`). A reference is recorded as a decorator application only
  if it is on a line whose stripped text starts with `@` **and** the referenced name is the last dotted component of the
  decorator expression and is followed by `(` or the end of the line; `@prop.setter` (the name is the first component) and
  `@register(target)` (the name is an argument) are therefore rejected. Measured on one fixture only (`@traced`); a decorator
  continued onto a later line or an `@` inside a multi-line expression is not recognised, which is a stated limit (a miss),
  and a decorator whose last component is the target but which is not a call of it (`@mod.target` where `target` is
  re-exported) is a residual wrong-edge risk.
- **A partial index is never cached and never answered from.** The index build can be cut by the wall-time budget (the
  estimated 6-7 s build is close to `code-map`'s 7.0 s, and the `references` pass decorators need is not in that estimate). If
  the budget ends the build, no index is written to the cache, and every tier that depends on the index (`code-map`'s symbol
  and one-hop tiers) is omitted and named in `omissions`, not answered from a partial graph; `callers`, `impact` and `diff`
  have no budget and finish the build or fail.
- **Symbols in unreachable code, fail closed.** `prepareCallHierarchy` returns null, and `documentSymbol` omits the symbol, for
  code pyright treats as unreachable (measured: `proxy_bypass_registry`). `"All"` removes the platform cases but not `if
  False`, a version check or `TYPE_CHECKING`-guarded code. Left alone, `callers` would answer `not_found` or an empty list for
  a symbol that exists. Two mechanisms, the second independent of the first: (1) the client asks for pyright's unreachable-code
  hints (`publishDiagnostics` with the `Unnecessary` tag, which needs `tagSupport` in the client capabilities); the
  harness never requested or read them, so **whether they arrive is unmeasured and build slice 1 measures it first**, and
  "no hint arrived" is indistinguishable from "no unreachable code" until it has; (2) whatever (1) shows, a **qualified** query (`A.f`) whose qualified name is absent from the symbol table while a lexical scan
  of the files in scope finds `def f(` inside a `class A` block (with word boundaries: `class A\b`, `def f\b`, so `class names` does
  not match `class name`) is answered `indeterminate` (exit 7) naming the file and line, never `not_found` and never an
  empty list; a reachable `B.f` elsewhere does not satisfy an `A.f` query. A bare-name query (`callers f`) is answered
  `indeterminate` if **any** lexical `def f` or `class f` in scope has no symbol, even when a reachable `f` exists elsewhere: a
  partial list is never returned for it. If slice 1 finds the hints do
  not arrive, mechanism (2) alone is the fail-closed rule.
- **Edges whose callee lands on no symbol** (a variable, an alias binding, a re-export) are not dropped silently: they are
  counted in the coverage line as `unattributed`, with the count. The only analogue measured is the 22 of 312 in-package
  `definition` results on requests that land on a variable or alias; that is a different request from call-hierarchy edges and
  does not size this count.
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
- **How `"All"` reaches the server.** Not through LSP settings (measured: `workspace/configuration` answers and
  `initializationOptions` do nothing in 1.1.414); only through a config file. The adapter therefore never uses the repository
  as the analysis root: it creates a temporary directory under the glyph cache, writes a generated `pyrightconfig.json` there
  (`pythonPlatform: "All"` and an `include` of the repository's Python paths), and starts the server on that root, so
  nothing is written into the repository (measured: `results/platform-channels.txt`, E4). **The generated config must also
  set `extraPaths`:** with an analysis root outside the repository and only an `include`, an absolute-import fixture lost every edge
  (0/5), and nothing in the protocol said so (JSON-RPC errors 0, `prepareCallHierarchy` still answered; "no error" here means no
  JSON-RPC error); `extraPaths` = [repository root] alone also failed (0/5), `extraPaths` = [`src`] and [repository root, `src`]
  matched the in-root result (5/5). The shipped value is therefore [repository root, plus `src` if it exists]
  (`results/layouts.txt`, `results/import-detector.txt`). A package under neither root (the fixture moved to `lib/`) failed with
  that pair and with no error. Whether `extraPaths` can make a repository directory shadow a standard-library or installed module
  name is **unmeasured**. The requests numbers, which use only relative intra-package imports, were identical in the
  in-root, `include`-only and `extraPaths` = [`src`] runs (65/65 each); the shipped pair [repository root, `src`] was run only on
  the fixture, and that reproduction does not exercise absolute first-party imports.
  **First-party import check.** After indexing, the adapter probes every absolute `import X` and `from X import ...` whose
  top-level `X` is a **first-party name**, by asking `definition` at the **top-level package token** (`app` in `app.b`; this is
  what the fixture run probed, not the leaf module: an `app` that resolves while `app.sub` does not is a false negative, and
  probing every dotted component was not measured). The first-party names are fixed by this rule: a directory containing at
  least one `.py` file, or a `.py` module, directly under the repository root or under `src` if it exists, plus any package
  root (a directory with `__init__.py` whose parent has none) found at any depth outside `_vendor`, `vendor`, `typings`,
  `node_modules`, `site-packages`, `build`, `dist` and virtual-environment directories. With the first, depth-limited half
  alone, the `lib/` fixture would **not** be flagged (silent again); the any-depth half is what catches it. **False-positive
  exposure of the any-depth half, all unmeasured:** a directory named like a standard-library or installed module (`test/`,
  `scripts/logging.py`), vendored copies whose import resolves elsewhere, two same-named packages in a monorepo, repository
  stub directories, and PEP 420 namespace packages (`src/company/product` with no `__init__.py`), where `definition` may have no
  file to land on, giving a false exit 7 (unmeasured). A probe that returns no location inside the repository is
  *unresolved*. What an unresolved import does is open decision D5. Measured on one 3-file fixture over seven layouts
  (`results/import-detector.txt`, edge recall in `results/union-imp-*.txt`): `definition` returned no location at the imports
  exactly when the edges were lost (0/5) and landed inside the repository exactly when they were found (5/5). A
  `publishDiagnostics` `reportMissingImports` signal is a second candidate, unmeasured. Not tested: tests that import the
  project by its installed name, `stubPath` (the default `typings` resolves against the config directory, so repository-local
  stubs may be lost), `--ref` materialisation, and two modules of the same name under [repository root, `src`] (a root-level
  `app/` and `src/app/`, or a `tests/` tree mirroring package names): pyright picks by its own order, the check passes either
  way, and edges can land on the wrong copy with no signal.
  A repository that has its own
  `pyrightconfig.json` or `pyproject.toml [tool.pyright]` should be honoured by having the generated file `extends` it; pyright's
  `extends` was **not tested here** and is a first-slice requirement, with the fallback that the repository's config is used
  as the root and `"All"` is lost. A repository config that exists but names no platform falls back to the host default
  platform (measured, E5: the macOS-style miss), so the host operating system is part of the cache key (section 6). A config
  that names a platform reinstates the miss for platform-conditional code (`proxy_bypass_registry`); that is stated as a limit.

### 6. `--ref`, the cache and the environment

An LSP server reads the filesystem, so `--ref` materialises the commit's Python files and pyright configuration files into a
temporary directory under the glyph cache, using the same no-checkout object reads as `src/snapshot.ts`, and removes it on
exit. Consequences stated now: an untracked virtual environment (`.venv`) is not in the commit, so `--ref` always resolves
third-party packages from the host's current environment, never from the commit's; this is unmeasured as to cost and as to
how often it changes an answer. The Python index cache key is (commit, language, **pyright version, resolved interpreter path
and its version, a digest of the environment's installed distribution names and versions, the host operating system**, configuration digest), because
the measurement shows the host environment changes what resolves and a cached index must never be reused across it. With no
interpreter on PATH pyright still runs (measured: identical call answers, stdlib from its bundled typeshed), the interpreter
part of the key is then "none". The environment parts extend both cache paths: the commit-keyed index and the working-tree
index (`src/cache.ts` keys the working-tree path on file stats, so the environment parts are added to that key too). How glyph
learns which interpreter pyright resolved is **not measured**; the harness did not read it, and an LSP client has no request
for it, so the first slice must resolve it the way pyright does (the configured `pythonPath`, else `python3` and `python` on
PATH) and compare.

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
- Code under a `sys.platform` or version check, `if False` or a guard that pyright treats as unreachable is absent from the
  symbol table (and `"All"` covers only platform checks); a name found only there is answered `indeterminate`, never empty
  (section 3); a version check follows pyright's `pythonVersion`, which depends on the host.
- `diff` on a changed line inside an `@overload` stub resolves to the implementation, the class, or nothing, depending on
  the stub; this is unmeasured beyond the fact that stubs have no symbol of their own.
- Results depend on the host Python environment for third-party resolution; the interpreter pyright resolved is recorded in
  the answer's `index` block.
- **PEP 420 namespace packages** (no `__init__.py`) may give the first-party import probe no file to land on, which would
  cause a false exit 7 (or a false "unresolved" count under D5-B); unmeasured.
- **Duplicate module identity** under [repository root, `src`] (a root-level `app/` and `src/app/`, a `tests/` tree mirroring
  package names) can send edges to the wrong copy with no signal; unmeasured, as is whether `extraPaths` can shadow a stdlib
  or installed module name.
- **Not covered by the fail-closed rule:** `diff` intersects changed lines with `documentSymbol` ranges, so a changed line inside
  an unreachable `def` maps to the enclosing class or module symbol, or to none; and a call located inside unreachable code is
  absent from `callers X` for a reachable `X`. Mechanism (2) answers name queries only. If the unreachable-code hints of
  mechanism (1) arrive, those ranges are excluded and reported in the coverage line; if they do not, these two are stated
  limits.
- A changed file whose path pyright cannot open is `indeterminate`, not skipped (ADR 0002, DEC-299 (a6)).
- Large repositories are unsupported in 0.1.0 (the file cap, section 3); monorepo scale, memory and first-analysis time are
  not measured.
- `.pyi`-only packages, namespace packages, notebooks, real `src`-layout roots (one 3-file fixture only) and metaclass, `dataclass` and `__new__`
  constructors are not measured.
- **Measured false positive:** call hierarchy can list an attribute access that is never called as a call (`Cat("x").speak`,
  called later through a variable), so a Python edge can be a reference.
- **Aliased calls at module scope or in a class body** are found by neither source (incoming misses aliases; outgoing covers
  only function symbols). This follows from how the two sources work; it was not run as a separate case.
- **Absolute self-imports** (`import requests` inside the package, or a test that imports the project by its installed name)
  can resolve to an installed copy in site-packages and become `external` rather than an in-repository edge; not measured.
- **A subclass that inherits `__init__`** is constructed through the MRO rule of section 3; the measurement could not see such
  calls (`gt_rules_addendum.md` item 8).
- **A constructor-mapping detection miss** (a metaclass, `__new__`, an external base such as `Enum` or pydantic, an `attrs`
  or dataclass-like decorator not recognised) yields a wrong edge to `__init__`, not an empty answer.
- **A decorator rule miss or false match:** `@`-line recognition misses continued decorators and can credit a re-exported
  name (section 3).

### Open decisions for opum-doc

- **D1. The unresolved-site count.** TypeScript publishes `unresolvedSites` from a syntactic enumeration of every call. The LSP
  cannot enumerate calls. (A, recommended) publish for Python the counts glyph has (resolved in the package, resolved
  externally, unresolved among sites it holds a position for) and state that a call with no recorded edge is not
  enumerated, so the count is a lower bound; (B) add a syntactic pass (a tree-sitter Python grammar, or a lexical
  `identifier(` scan as an upper bound) for an exact or bounded count. B is DEC-303's alternative applied for a reason other
  than recall and adds a dependency.
- **D2. Mixed-language repositories.** (A, recommended) index one language per run (detection or `--language`), name every
  skipped language and its file count in the coverage line, and defer "index both and merge" past 0.1.0: no new envelope
  shape, cost nil beyond the coverage-line entry. (B) index both and merge by symbol id in 0.1.0: a repository with
  TypeScript and Python (a very common shape) is answered whole, but every envelope needs a `language` per item, `impact`
  and `callers` must define cross-language edges (there are none from this measurement), cache keys and budgets double, and
  it needs its own measurement; it is a second build track, not a slice.
- **D3. The bar, the quantity it applies to, and whether acceptance waits on a held-out test.** The proposed bar (recall over
  all true sites at least 0.9, lower bound above 0.8) was fixed after the results. It is met by the shipped union plus
  constructor mapping under `"All"`, which is an in-sample fit; it is not met by incoming calls or the union alone under a
  cluster-robust interval, nor on the fixtures or the alias set. Options: (A, recommended) accept the measurement for the
  shipped quantity and make the held-out tests a **gate inside build slice 1**: the fresh-seed `__init__`/class sample from
  requests and a second real repository, both with the mapping and rules committed first, must reach the bar before the
  Python slices merge toward a release; the architecture and the language-neutral client do not depend on the result, so
  building them is not blocked. (B) require the second repository's measurement before any build slice starts: nothing is
  built on an in-sample fit, at the cost of the slices waiting on a new ground-truth effort of roughly this one's size.
  Alternatively opum-doc may set a different bar or a different quantity; the alternatives in DEC-303 item 4 return if the
  bar is scored on incoming alone.
- **D4. Command-contract additions.** DEC-303 item 2 says the contract is unchanged per language. The design as written needs
  additions that TypeScript does not have, each changing a published schema or the command surface: a `decorator` site
  kind; a field saying the unresolved-site count is a lower bound (`unresolvedKnown: false`, or equivalent under D1); a
  `language` entry, the resolved interpreter and the pyright version in the `index` block; a "language not indexed" entry in
  the coverage line and an `unattributed` count (under D5-B, also an unresolved-first-party-import count); a `--language` global option declared in `help --json`; `not_found`
  (exit 3) answers that name the language; and a **per-answer note** on `callers C.__init__` (and `impact`) that constructor
  calls to an excluded class `C` are recorded against the class, because for such a class the answer is a successful,
  near-empty list. (A, recommended) accept these as additive, optional fields, one new global option and one answer note,
  which TypeScript leaves absent or constant, and record them in ADR 0002's contract. (B) keep the contract byte-identical:
  the decorator kind drops (decorators become ordinary call sites), D1 has no field to carry the lower bound so its option
  A loses its honest form, the per-answer note and `--language` have no home, and an excluded class's `callers` answer is
  silently near-empty, which is the thing DEC-299 (a5) forbids; B therefore makes D2 option A the only coherent choice and
  needs a ruling that narrows DEC-303 item 2 to "unchanged where Python can answer".

- **D5. What an unresolved first-party import does.** Measured: when first-party absolute imports do not resolve, edges are lost
  with no protocol error, and `definition` at those imports returns no location (section 5). (A) fail closed on **any**
  unresolved first-party import: the run is `indeterminate` (exit 7) naming the file and import, and no count field exists
  (an exit-7 run has no success envelope). Cost: ordinary healthy repositories exit 7 (gitignored generated modules such as
  protobuf `_pb2` or `_version`, which are always absent under `--ref`; `try/except ImportError` optional compiled extensions;
  `TYPE_CHECKING` and conditional imports probed like any other; every package under `lib/`, `python/`, `backend/` or
  `packages/*/src` is then unsupported, not merely flagged); the benefit is that no silent loss is possible by this route.
  (B, recommended) fail closed only when a **package root** (the first-party name itself) fails to resolve, which is the measured
  failure mode, and count, name and note every other unresolved first-party import in the coverage line (the D4 count field
  exists only under B). Cost: a run with an unresolved non-root import (an optional extension, a generated module) succeeds with
  a stated count, so some edges may be missing and the answer says how many imports were unresolved, which is a stated limit,
  not silence; the benefit is that healthy repositories with generated or optional modules keep working. Recommendation first
  because A makes the first release unusable on a common repository shape; opum-doc rules.

## Consequences

- Python adds one runtime dependency (pyright, from npm, 19.5 MB unpacked), a server start-up of about 0.26 s on a 19-file
  package on an idle machine, and an estimated 6-7 s to build the full union index there (not measured as one pass). ADR 0005
  measured whole cold `glyph code-map` runs (the TypeScript index build plus the other reads) at p50 0.485 s to 2.914 s across
  five repositories of other sizes (glyph-cli 0.485, opum-desktop 0.919, opum-cli 1.429, lore-cli 2.085, quest-cli 2.914):
  not a like-for-like comparison, and no claim is made that either path is faster. Warm runs rely on the same cache design, with the cache key above.
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
