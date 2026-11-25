# Glyph

Software intelligence about source code: **what calls this symbol**, **what a
symbol's change can reach**, and **which symbols a diff touches** — for
TypeScript/JavaScript and Python, one repository at a time. Python is measured
below the project's own accuracy bar; see [Python gate status](#python-gate-status).

Glyph is Opum's software-intelligence primitive, the third peer product
alongside Lore and Quest. 0.1.0 is deliberately narrow; its scope is
recorded in [ADR 0001](https://github.com/opum-ai/glyph-cli/blob/main/docs/adr/0001-scope-glyph-v0-to-a-one-language-symbol-and-call-graph.md).

## Scope

- **TypeScript and JavaScript**, as one language target (recorded in ADR 0001), and **Python** through a native indexer (ADR 0008) whose measured accuracy is stated under [Python gate status](#python-gate-status).
- **One repository at a time.** There is no cross-repository graph.
- **A local cache, and nothing else.** Glyph writes nothing into the
  repository it analyzes.
- **No UI.** stdout carries either human text or JSON: one envelope per command, or
  one line per item then one result line under `--stream`.

### Python symbols

Python symbol collection lives behind the parse wrapper in `src/python/` and is
wired to the CLI by the native indexer (ADR 0008, S7). Its stated limits (the
full record is the GCLI-76 implementation notes):

- **Parse errors are named through one published field, `parseErrorFiles`.**
  A file whose parse contains an ERROR node is named in `parseErrorFiles`
  (`[{path, droppedCalls}]`, ordered by path) with the call expressions dropped
  inside its ERROR regions (DEC-303 (a15)). The field rides beside `callBins` in
  the `callers`, `impact` and `--stream` results and is present only when the
  list is non-empty — absent, never `null` and never `[]`, for TypeScript and for
  a clean Python run. The parse table's `errorCount`, `missingCount`,
  `droppedDefinitions` and `errorFiles` are internal: no envelope carries them.
  **Exactness is not published**: the index keeps its `exact` flag, but no
  envelope publishes it and no exit code derives from it. A recognised
  definition inside an ERROR region the walk enters is dropped and counted
  internally, and a definition nested inside it is counted too. Outside an ERROR
  the walk descends only through statement containers and definitions, so an
  ERROR nested inside an expression is not entered and a definition hidden there
  is neither dropped nor counted. A `def :` is broken into loose tokens by error
  recovery, so it yields no symbol and no dropped-definition entry, only the
  file-level parse error.
- **Overload groups are grouped by qualname within one file.** A group split
  across branches is not distinguished, and a group with several non-`@overload`
  definitions keeps every implementation.
- **Decorated symbols are flagged, never dropped.** Whether a decorator replaces
  the name with another object (click's `@command`) cannot be decided
  statically; every decorated symbol carries `decorated: true` and its
  decorators, and a bare `@d` is recorded as a `decorator` site (see the machine
  contract additions below).
- **`__all__` is read only as a literal list or tuple at module level.** A
  non-literal assignment or `__all__ += ...` falls back to the leading-underscore
  rule; `__all__.extend(...)` and `__all__.append(...)` are calls, not
  assignments, so they are skipped rather than read — they contribute no names,
  a literal assignment beside them still governs, and a module with only such
  calls falls back. A literal inside an `if` is not read.
- **Class-body assignments emit no symbol**, while class-body defs are members.
- **`cached_property` is collected as a method**, not a property; only
  `property`, `.setter`, `.getter` and `.deleter` are `property`.
- **The id column counts UTF-16 code units**, the same unit TypeScript uses:
  `parsePython` decodes bytes to a string before parsing, so a preceding
  non-BMP character shifts a UTF-8 byte offset but not this column.
- **`test/python-gate/check_symbol_targets.ts` is a TypeScript reproduction** of
  the gate scorer's target mapping, not a run of `gate_score.py`; the real
  end-to-end gate run is S8.

### Python call resolution

Call resolution builds on the module graph (S3) and the symbol table (S4) in
`src/python/calls.ts` and is wired to the CLI by the native indexer (S7). Every
call expression outside a parse-error region lands in exactly one of four bins —
resolved in the repository (an edge), resolved external, unresolved because the
receiver needs inference, and unresolved because the name is not statically
bound. A call resolves when Python's static binding rules fix its target without
inference; it stays unresolved when the target depends on a run-time type.

Nested project roots are discovered by their marker (`pyproject.toml`, `setup.py`
or `setup.cfg`): a first-party absolute import in a file beneath one resolves
first against that root's own `""`, `src` and `lib` roots and then against the
repository's, with the nearest enclosing marker winning (DEC-303 (a18)).
Stated limits:

- **A value's type is never inferred.** `items.append(...)` and `x.m()` on an
  unannotated parameter are unresolved-receiver, which keeps them out of unknown
  in-repository calls. Attribution follows static binding only: a receiver that is
  a method's first **plain** parameter (an identifier, possibly annotated or with
  a default, whatever its name; the class for a `@classmethod`, and for
  `__new__`/`__init_subclass__`/`__class_getitem__`), a class name, a single
  constructor or annotation binding, or a name bound directly by an import. A
  `*args`, `**kwargs`, bare `*`/`/` first parameter, or no parameters at all, is
  not a receiver: the splat is a tuple or dict value, so a call on it needs
  inference.
- **Imports bind in the scope that writes them, module-level or local.** A
  function-body import resolves exactly like a module-level one (first-party
  in-repo, external, or S3's unresolved reason) and is local for the whole body,
  wherever it appears. A **class-body** import binds only for statements after it
  (a class body runs top to bottom with `LOAD_NAME`), so a use before it takes the
  enclosing binding.
- **A method the class body rebinds or uses bare has no receiver.** `helper =
  staticmethod(helper)` (or any later non-def binding of the name) makes a call
  through a receiver unresolved-receiver rather than an edge; a def whose name is
  used bare in its own class body as a decorator or call keeps calls to it
  resolving, but its own first parameter is not a receiver. A `@staticmethod` or
  `@classmethod` that a partial or unknown star import might supply is not known to
  be the builtin, so the first parameter is not a receiver there either. Known
  limitation: a method wrapped by an opaque (external, non-`property`) decorator is
  still attributed as a method — whether that decorator replaced the function
  object with something that does not bind the first parameter cannot be known
  statically.
- **The bare-use and class-body-import readings are known limitations.** The
  bare-use set behind the no-receiver rule ignores order and scope inside the class
  body: a class-body call written before the `def`, or inside a class-body
  comprehension, still counts as a bare use. The order-aware class-body import rule
  is lost across an alias hop (`x = target; x()` before `from .mod import target`
  takes the module binding, not the import). A name that an external module
  re-exports two star hops deep comes back `star-bound`, not external.
- **A literal written directly as a receiver is external** — `"x".join(...)`,
  `[].append(...)`, `{}.keys()` — because its type is fixed by syntax. A name
  bound to a literal (`items = []`) is a value in a variable and stays
  unresolved-receiver.
- **An attribute call on a name bound directly by an external import is external**
  (`from os import path; path.join(...)`), whether the imported name is a module or
  a class; a value computed from one (`p = Path(); p.exists()`) stays
  unresolved-receiver.
- **`self.x.m()` is unresolved-receiver and counted**, and return annotations are
  not followed — only parameter and variable annotations are.
- **A multiply-bound class name constructs every in-repository alternative**: each
  gets a class edge and an edge to its resolved `__init__`, every edge flagged
  `multiplyBound`.
- **`metaclass=type` written explicitly is not a constructor note** only while
  `type` is the unshadowed builtin; a shadowed or possibly-shadowed `type` (rule
  37) keeps the note. Any other metaclass, an inherited one, or a defined
  `__new__` keeps it.
- **One shadow rule governs every builtin test** (builtin names, `classmethod`,
  `staticmethod`, `super(...)`, `type(x)(...)`, and the `type` of `metaclass=type`):
  the name is the builtin only when no binding supplies it and no star import
  could. A partial or unknown `import *` shadows it. A name in a **complete** star
  set is bound by the star target, never the builtin: it resolves to the target's
  def, class, import or re-export (a single alias is followed), is `run-time-bound`
  for any other assignment, and is `star-bound` when the target does not statically
  bind it. A complete star set that lacks the name leaves the builtin. Several
  star imports are read last to first, as Python binds them: the last complete
  exporter wins, and a later partial star leaves the name `star-bound`. A star
  lookup is bounded, so a mutual star cycle terminates and reports `import-cycle`
  instead of overflowing.
- **A method found only in an external base is resolved external**; an opaque
  base before a match is flagged `externalBaseBefore`.
- **Polymorphic dispatch is reported, never guessed.** A site whose in-repository
  subclass overrides the method is flagged and counted; the edge goes to the
  declared class's resolution only.
- **Parse errors drop calls, and the files are named in `parseErrorFiles`.** A
  call inside an ERROR region is dropped, and the file is named in
  `parseErrorFiles` with its dropped-call count (DEC-303 (a15)); exactness is not
  published. A non-empty S3 exit-7 list is raised as **indeterminate** (exit 7)
  naming the first trigger and the count; it is never an empty or partial answer
  in `callers`, `impact`, `diff` or `--stream`. In `code-map` a failing Python
  index — a non-empty exit-7 list, a grammar init failure or a git read failure —
  is a missing tier, not a failed run: tiers 1, 2 and 4 still answer with exit 0
  (DEC-303 (a15)).
- **`test/python-gate/check_call_sites.ts` reports the bins** over click and
  requests; scoring a `GlyphIndex` through `gate_score.py` there is NOT the gate
  run (S8 owns the gate).

## Run it

Glyph needs [Node.js](https://nodejs.org) 24 or newer. Install it from npm and
run `glyph`:

```sh
npm i -g @opum-ai/glyph
glyph callers buildReport --repo /path/to/repo
glyph impact buildReport --repo /path/to/repo
glyph diff main --repo /path/to/repo
```

To try it without installing, `npx @opum-ai/glyph callers buildReport --repo
/path/to/repo` runs the same commands.

Install Glyph from npm, not Homebrew: `brew install glyph` names an unrelated
formula (an ASCII-art converter), not this tool. Also, the unscoped `glyph`
package on npm is a different project; the package here is `@opum-ai/glyph`.

To work on Glyph itself, run it from a checkout with [Bun](https://bun.sh)
matching `.bun-version` (development and tests stay on Bun; the published
package runs under Node):

```sh
bun install
bun run glyph callers buildReport --repo /path/to/repo
```

`--repo <dir>` points at the repository to analyze (default: the current
directory). `--json` switches any command to the machine envelope.
`--language <id>` indexes one language instead of the one detection picks (see
[Languages](#languages)); it is accepted by `callers`, `impact` and `diff`, the
commands that read the shared index.

## Commands

### `glyph callers <name>`

Every call site that invokes the one symbol named `<name>`. `--file <pattern>`
narrows the name to symbols whose repository-relative path contains the
pattern; a name that stays ambiguous is a usage error listing the candidates
rather than a guess.

```console
$ glyph callers helper
callers of helper (function) at src/util.ts:1:17 — 2 call site(s) in 2 file(s)
  src/main.ts:3:10  call  in main
  src/other.ts:3:10  call  in other
index: 3 files, 3 symbols, 4 sites (cache miss)
```

### `glyph impact <name>`

Every caller a change to this symbol can reach — the transitive reverse closure
over call, `new`, import, `extends` and `implements` edges ([ADR 0004](https://github.com/opum-ai/glyph-cli/blob/main/docs/adr/0004-widen-the-index-with-import-and-inheritance-edges.md)). Each caller appears once, at its shortest depth (direct
callers are depth 1), with one shortest path to the target and the call sites
on that path. When several shortest paths exist, a total order — the path
string, then the call site's file, line and column — picks one, so the answer
is deterministic. The `module scope` rows at each depth are the import
terminals (see below): the importing module, not a function in it.

```console
$ glyph impact d
impact of d (function) at src/d.ts:1:17 in the working tree — 6 caller(s) within depth 5 (6 found, cache miss)
  depth 1  module scope  src/c.ts:1:10  module scope -> d
  depth 1  c  src/c.ts:3:10  c -> d
  depth 2  module scope  src/b.ts:1:10  module scope -> c -> d
  depth 2  b  src/b.ts:3:10  b -> c -> d
  depth 3  module scope  src/a.ts:1:10  module scope -> b -> c -> d
  depth 3  a  src/a.ts:3:10  a -> b -> c -> d
  coverage (index-wide): 6 resolved site(s); 0 did not resolve (call 0, import 0, extends 0, implements 0, dynamic 0); an empty answer is not proof of no impact
index: 4 files, 4 symbols, 6 sites (cache miss)
```

- The default depth is 5. `--depth <n>` reports fewer hops and `--all` runs the
  full closure; the two are mutually exclusive. A depth-bounded answer still
  traverses the whole closure, so `truncated: true` comes with the **exact**
  number of callers left unexplored rather than a frontier estimate. A cycle
  terminates, and the callers on it are marked `cycle: true`.
- A call site at module scope has no enclosing declaration. It is reported as a
  terminal caller with `symbol: null` and is never expanded, so the depth-1
  answer is a superset of `callers`.
- An import is an edge to the symbol the binding resolves to, through alias and
  re-export chains, and its dependent is the importing **module**: a
  module-scope terminal at depth 1 with `symbol: null`, never expanded. A
  re-export is an import edge with the barrel as the dependent. `import type`
  is recorded with `typeOnly: true`. A namespace import, a side-effect import or
  `export *` binds no single symbol: it carries `moduleTarget`, and is a
  terminal one hop beyond every **exported** symbol of the imported module the
  walk reaches (the start included), never beyond a non-exported one.
  `import x = require("m")` resolves like a static import.
- `class B extends A`, `class C implements I` and `interface J extends I` are
  edges from the subclass or implementer, so a changed class or interface
  reaches them at depth + 1 and the walk continues over every edge kind. A
  changed **method** does not reach an overriding method in v0 (a named limit,
  below). Each hop of a path carries its `kind`; `callers` still lists call and
  `new` sites only.
- `--ref <ref>` answers from that commit's tree instead of the working tree;
  see [Answering against a commit](#answering-against-a-commit).
- The envelope carries `resolvedSites`, `unresolvedSites` and
  `unresolvedByKind` (`call`, `import`, `extends`, `implements`, `dynamic`),
  the index's site counts, because an empty or shallow answer is not proof of
  no impact: calls, imports and heritage clauses that resolve outside the
  repository, dynamic dispatch and reflection are counted as unresolved and
  never guessed at, and `import()`/`require()` are counted as `dynamic` and not
  followed.

### `glyph diff <base> [head]`

Symbols the committed diff `base..head` touches (`head` defaults to `HEAD`).
Only the innermost touched symbol is reported: a change inside a method
reports the method, not also every class containing it. Changed ranges come
from `git diff --unified=0`, and a deletion-only hunk is attributed at the
line where the deletion happened.

### `glyph code-map --source-ref <ref>`

Pointers into the code a task concerns, in the shape an agent harness consumes
them: `{ pointers, omissions }`, emitted as `data` under the kind
`code-map.result`. The task text is read from **stdin**; `--source-ref` names the
ref every read resolves against and the ref the branch's own diff is taken
against (`--repo` and `--json` are the usual globals).

```console
$ echo 'fix `buildReport` in src/report.ts' | glyph --json code-map --source-ref origin/main
```

- Tiers, in rank order, are named paths that exist at the ref, files the branch
  changed against it, symbols the task text names (exact name, every matching
  symbol), resolved through the ref's index to the files that declare them and,
  one call-graph hop out, the files that reference them, and files `git grep`
  finds for the task text's distinctive identifiers (backticked tokens, CamelCase
  and dotted names). The symbol tier sits above `git grep`; within it a declaring
  file precedes a referencing one. A path found by more than one tier keeps its
  best; ties break by score, then path. A file the symbol tier pushes out of the
  20-file cap is named in `omissions`. With the index absent or failing the
  symbol tier is empty and the output is what the deterministic tiers alone
  (named paths, changed files, identifiers) produce. A pointer is
  a path, line ranges and one line of reason, never a file body.
- The output is bounded to 20 files and 2,000 tokens (`ceil(length / 4)`), and
  every candidate or read bound it drops is named in `omissions`. The same
  repository state, source ref and task text give byte-identical output.
- A run has a wall-time budget of 7.0 s (`CODE_MAP_TIME_BUDGET_MS`, measured and
  fixed in [ADR 0005](https://github.com/opum-ai/glyph-cli/blob/main/docs/adr/0005-bound-the-code-map-by-a-wall-time-budget.md)). Past it the run stops gathering and returns
  what it has, with one omission whose source is `code-map#time-budget` and whose
  reason starts `time-budget:` and names the stage and the elapsed time; a pointer emitted after the
  deadline says its line ranges were not read. An answer inside the budget is
  unchanged. The one step the budget cannot interrupt is the cold index build. It
  runs at tier 3's position — after the named-path and branch tiers have
  answered — so an overrun there is a `symbol index` stop that keeps those
  answers, reported the same way and never silently (DEC-303 (a16)).
- Task text over 20,000 UTF-16 code units (JavaScript's string length, so an
  emoji counts as two and `é` as one) is a **usage error**, never a silent
  truncation. A missing `--source-ref` is a usage error too.
- Exit codes are 0, 1, 2, 3 and 7: a `--source-ref` that does not resolve is
  `not_found`, and a git read that fails or exceeds git's own timeout is
  `indeterminate` (a read the 7.0 s wall-time budget cuts off is the
  `code-map#time-budget` omission above, exit 0), as is a git read that comes back empty when glyph already holds a fact that makes empty
  impossible (a path known to match, an object known to exist), after one retry.
- Its deterministic tiers are checked byte for byte against fixed goldens; the
  CLI's default output adds the symbol tier.

### `glyph cache path` | `glyph cache clear`

Show or clear this repository's local cache directory.

### `glyph help --json`

Emit the live command manifest — every command's dotted `kind`, its flags and
exit codes, and the exit-code taxonomy. The manifest is built from the
same registry the commands use, so it cannot drift from the handlers.

## Languages

Glyph indexes one language per run. Detection picks it from the file extensions
present, preferring TypeScript; `--language <id>` overrides the pick. TypeScript
(with JavaScript) and Python are both registered (ADR 0008); the Python indexer
is native and in process, and its grammar loads through wasm.

Python counting applies a directory rule: a tracked `.py` file under any `venv`,
`.venv`, `__pycache__` or `.tox` path segment is not counted — a nested
`tools/venv/x.py` or a package named `venv` is dropped — so a TypeScript
repository whose only Python sits there gets no `notIndexed` entry, and a
Python-only repository like that is `not_found` with the ordinary
"no TypeScript or JavaScript sources found" message.

- One language is indexed per run. Every other recognised language present in
  scope is named, with its file count, as not indexed in this run. The human
  coverage line ends `; language not indexed: python (2 files)`, and the JSON
  `index` block carries `language` (the indexed language) and `notIndexed`
  (`[{language, files}]`). It is never dropped silently, and the same entries
  are carried by the `--ref` answer. A mixed tree with no `--language` indexes
  TypeScript and names Python; `--language python` swaps which is named.
- A Python-only repository is indexed, so it is never `not_found` for lacking
  TypeScript. A repository whose only recognised language has **no registered
  indexer** is `not_found` (exit 3) naming the language and its file count,
  identical with and without `--ref`, and never an empty answer.
- An explicit `--language` naming an unregistered language is a usage error
  (exit 2) listing the registered languages; naming a registered language that
  has no files is `not_found` (exit 3) naming it.
- `--ref` builds the selected language's index for the commit's tree: Python
  reads the commit's blobs as **bytes** through the snapshot (no checkout), and
  the cache key is addressed by the commit and the language scope, not by
  working-tree stats. `code-map` builds the selected language's index at its
  `--source-ref` for the symbol tier; its text, diff and grep tiers are
  language-agnostic.
- When a repository has no recognised non-TypeScript source (only `.py` counts
  today), the `index` block carries neither `language` nor `notIndexed` — both
  are omitted, not `null` or a constant — so that answer is byte-for-byte the one
  earlier releases produced.

### Machine contract additions for Python

These are the output entries DEC-303 (a14) and (a15) rule and [ADR 0002](https://github.com/opum-ai/glyph-cli/blob/main/docs/adr/0002-adopt-the-opum-command-contract.md)
records. They are absent — never `null`, never zero-filled — from a
TypeScript-only index and its envelopes. They add no `help --json` declaration,
because the manifest has no slot for output fields.

- **`decorator` is a site kind.** `SiteKind` and `CALL_KINDS` include it, so a
  bare `@d` is reported by `callers` and `impact` as an incoming edge to `d`.
  Decorator sites are in no call bin and not in `unresolvedByKind`.
- **`INDEX_FORMAT` is 3.** It is in the cache key only; a cached format-2 entry
  is not served, and a TypeScript envelope is unchanged.
- **Python adds three result entries.** On `callers` and `impact` result data
  (batch and `--stream` result line alike) a Python index carries `callBins`
  (`{resolvedInRepo, resolvedExternal, receiverNeedsInference, nameNotBound}`),
  `unresolvedFirstPartyImports` and `constructorNotes` beside
  `unresolvedByKind`. The entries are absent from a TypeScript answer, and
  `unresolvedByKind` itself is unchanged (`.call` is `receiverNeedsInference +
  nameNotBound`, `.dynamic` is S3's dynamic-import count).
- **Site and symbol flags stay internal.** `multiplyBound`, `polymorphic`,
  `externalBaseBefore` and `decorated` on sites, and `decorators`, `decorated`
  and `collapsedOverloadStubs` on symbols, live in the cached index and appear in
  no envelope. `qualname` is a documented symbol field and appears when present.
- **`parseErrorFiles` names dropped-call files (DEC-303 (a15)).** A Python index
  whose parses hold ERROR nodes carries `parseErrorFiles` — `[{path,
  droppedCalls}]`, ordered by path — beside `callBins` on the `callers`, `impact`
  and `--stream` result data, present only when non-empty. It is absent for
  TypeScript and for a clean Python run. `exact` itself is not published.
  In `code-map`, a failing Python index is a missing tier, not a failed run:
  tiers 1, 2 and 4 still answer with exit 0, and a build that overruns keeps
  tiers 1 and 2 (DEC-303 (a16)).

## Streaming (`--stream`)

`callers`, `impact` and `code-map` accept `--stream`, the opt-in NDJSON variant
of `--json` (the design is
[ADR 0006](https://github.com/opum-ai/glyph-cli/blob/main/docs/adr/0006-stream-the-long-answers-as-ndjson.md)). It lets an
agent act on early items as they are produced. The index build still precedes
the first item, so a cold cache sees no earlier first line than the batch form,
and `impact` emits only once its walk completes (its `cycle` flags are decided
after the search); `callers` and `code-map` stream while they work.

- `--stream` implies `--json`. Combining it with `--plain` is a usage error
  (exit 2), and so is passing it to a command that does not declare it.
- stdout carries one compact success envelope per line, each newline-terminated
  and flushed when written, with `principal` last. Item lines carry
  `<command>.item` (published as `itemKind` in `help --json`); exactly one
  `<command>.result` line ends the stream and carries the batch data with the
  item list replaced by `itemCount`. For `code-map`, `truncated` is true only
  when ADR 0005's wall-time budget stopped the run; file-cap, token-cap,
  read-bound and displacement cuts are named in `omissions` instead.
- Exit 0 means the command issued its result line to stdout. Completeness is the
  last line plus the exit code: a consumer treats a stream with no result line,
  or a non-zero exit, as incomplete, whatever items arrived. A failure
  mid-stream leaves no result line, writes the ordinary error envelope to
  stderr and exits with the mapped non-zero code. A consumer that stops reading
  early (`… --stream | head -1`) naturally sees no result line and must treat
  what it read as incomplete.
- The item multiset equals the plain `--json` answer, and order may differ
  because items are emitted as they are found. `callers` and `code-map` emit
  each item as it is produced; `impact` emits once its walk completes, because
  a caller's `cycle` flag is decided after the breadth-first search.

```console
$ glyph callers helper --stream
{"schemaVersion":1,"kind":"callers.item","data":{"file":"src/main.ts","line":3,"column":10,"kind":"call","caller":{"id":"src/main.ts:2:17","name":"main","container":null,"kind":"function","file":"src/main.ts","line":2}},"principal":null}
{"schemaVersion":1,"kind":"callers.item","data":{"file":"src/other.ts","line":3,"column":10,"kind":"call","caller":{"id":"src/other.ts:2:17","name":"other","container":null,"kind":"function","file":"src/other.ts","line":2}},"principal":null}
{"schemaVersion":1,"kind":"callers.result","data":{"symbol":{"id":"src/util.ts:1:17","name":"helper","container":null,"kind":"function","file":"src/util.ts","startLine":1,"line":1,"column":17,"endLine":3,"exported":true},"totals":{"callers":2,"files":2},"index":{"cache":"miss","files":3,"symbols":3,"sites":4},"itemCount":2},"principal":null}
```

## The machine contract

Glyph follows a shared command contract for Opum tools
and records that obligation in [ADR 0002](https://github.com/opum-ai/glyph-cli/blob/main/docs/adr/0002-adopt-the-opum-command-contract.md).
stdout carries exactly one success envelope per command — JSON under `--json`,
human text otherwise (`--stream` instead emits one line per item, then one result
line, below). On failure stdout carries no result envelope (under `--stream`,
item lines already written stay and no result line follows), and stderr carries
the error: the envelope below under `--json` and `--stream`, a plain message
otherwise:

```json
{ "schemaVersion": 1, "kind": "callers.result", "data": { }, "principal": null }
{ "error_type": "not_found", "message": "…", "principal": null }
```

- **`principal` is reserved and always present**, as the last top-level key on
  both envelopes. It is `null` until an identity is populated; omitting it is
  non-conformance, not an equivalent variant.
- **Kinds are dotted `command.payload`** (`callers.result`, `impact.result`,
  `diff.result`, `code-map.result`, `cache.path`, `cache.clear`, `help.manifest`), plus
  `version.info` and `help.usage` for the global `--version` and `--help`
  results. They are a registry, not a convention: handlers read their kind from
  it, `glyph help --json` publishes it, a test walks the registered commander
  commands against it, and a conformance test compares the registry and the
  exit-code taxonomy against a golden set by exact equality, failing on a
  vacuous or deliberately corrupted one.
- **Help and version are result-bearing under `--json`**, so no successful
  `--json` invocation prints text: `glyph --json --version` emits
  `version.info`, and `glyph --json --help` or a bare `glyph --json` emits
  `help.usage`. Help with a topic, or `--help` after a command, emits
  `help.manifest` narrowed to that command. Their names are dotted per the
  contract's dotted-name rule; consumers tolerate unknown kinds.

Callers branch on the exit code, never on the message. The family is the full
taxonomy:

| code | `error_type` | meaning |
|------|--------------|---------|
| 0 | — | ok |
| 1 | `uncaught` | an unexpected bug, never a classified failure |
| 2 | `usage` | bad invocation, an ambiguous symbol included |
| 3 | `not_found` | no such symbol, ref, or sources |
| 4 | `denied` | the operation is not permitted |
| 5 | `conflict` | a concurrent or contradictory state |
| 6 | `validation` / `drift` | invalid input, or state that drifted from its record (two types, one code, by design) |
| 7 | `indeterminate` | a check looked and cannot judge |

v0's commands produce `usage` and `not_found`, `indeterminate` when a Git read
fails or Git refuses to describe a repository (for `code-map`, also an empty read
that contradicts a fact glyph already holds, after one retry), and `uncaught` for
a bug; `denied`,
`conflict`, `validation` and `drift` are mapped and published so a consumer
meets one vocabulary, not a later second one.

## How the index is built

Discovery takes every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and
`.cjs` file in scope — a tsconfig governs compiler *options*, never which files
are visible — and builds one TypeScript program over them. In a Git repository
the selection is Git's own (`ls-files`: tracked files plus **untracked** files
that are not ignored), so nested `.gitignore` files and negation patterns are
honoured and an **untracked ignored** source never enters the index.

Two consequences are deliberate, not accidents:

- A **tracked** file stays visible even when a pattern matches it, because Git
  ignores patterns for tracked files. A repository that commits `dist/`,
  `vendor/` or `build/`, or leaves `node_modules/` untracked and unignored,
  therefore indexes those files; the old fixed directory list hid them. This is
  deliberate and it is stated here because `callers` and `diff`
  answers change in exactly those repositories.
- `git ls-files` does not descend into submodules or nested repositories;
  their contents are not indexed. Symlinks are followed when they resolve to a
  file, and the link's own path is what enters the index.

A directory outside Git falls back to a filesystem walk with a fixed
excluded-directory list (`.git`, `node_modules`, `dist`, `build`, `out`,
`coverage`, `vendor`, `.next`, `.nuxt`), where Git has no ignore rules to
apply. Git failing for any other reason — dubious ownership, a corrupt index, a
permission error — is **indeterminate** (exit 7), never a silent walk that
would index sources Git was refusing to describe.

- **Symbols** are declarations: functions, methods (accessors included),
  properties, classes, interfaces, type aliases, enums, and variables.
  Function-local variables are deliberately not symbols (a local `const`
  would shadow the enclosing function in the diff query), and neither are
  object-literal properties.
- **Call sites** are `call` and `new` expressions whose callee the type
  checker resolves to a declaration in the repository, so
  `import { helper as h }` followed by `h()` attributes to the declaration of
  `helper`, not to the letters at the call site. A callee that resolves
  nowhere — a dynamic `x[key]()`, a function from a dependency — is counted
  in `unresolvedSites` and never guessed.
- **Import and re-export edges** bind the declaration an imported name resolves
  to, with the importing module as the dependent; namespace, side-effect and
  `export *` edges name a target file instead of a symbol. **Heritage edges**
  (`extends`, `implements`) run from the declaration carrying the clause to its
  target. A specifier or heritage target outside the repository is counted
  under its own kind in `unresolvedByKind`.

## Answering against a commit

`glyph impact --ref <ref>` indexes the tree of the commit `<ref>` names,
without a checkout. The commit's regular blobs are listed with
`git ls-tree -r` and read with one `git cat-file --batch`; the program is built
on an in-memory compiler host, and the commit's own `tsconfig.json` (with
anything it extends) supplies the compiler options. Paths inside the repository
that the tree does not contain are invisible to that program, so an edited,
added or deleted source file cannot change a `--ref` answer. **In-repo
`node_modules` is not read from disk either**, apart from the
running TypeScript package's own library directory: a module that would resolve
through the checkout's installed dependencies is not resolved through that
install, and its call sites are counted in `unresolvedSites`. A tracked
`node_modules` is part of the tree and is read from the tree.

Some inputs the commit does not carry are read from the host: a hoisted
dependency tree, a parent directory's tsconfig reached through `extends`, and
the running TypeScript package's own library directory, wherever it sits. They
are not part of the cache key, and neither is the TypeScript compiler's version
or Glyph's own indexer logic beyond its index format. So the exactness promise
is scoped to what the commit carries: its tree and its own tsconfig determine
the answer, and a dirty checkout cannot influence it, while two hosts can answer
the same commit differently when one of those inputs differs — and a warm cache
entry keeps the answer it was built with. Symlinks
and submodules are not source files at a commit and are skipped. The working
tree remains the default for interactive use.

`diff` is planned to require `--ref`; that requirement is recorded in [ADR 0003](https://github.com/opum-ai/glyph-cli/blob/main/docs/adr/0003-answer-blast-radius-with-a-caller-closure-and-a-ref-pinned-index.md)
and not yet in force. The code-map command shipped as `glyph code-map --source-ref <ref>`, which
names its ref explicitly and never reads uncommitted changes (it does read
`HEAD`, implicitly, to take the branch's own diff).

## The cache

The only state Glyph keeps, and disposable: every entry is re-derivable, so
deleting it costs time, never evidence. Location: `$GLYPH_CACHE_DIR`, else
`$XDG_CACHE_HOME/glyph`, else `~/.cache/glyph`, under a directory keyed by the
repository's absolute path. An entry's key covers the index format, `HEAD`
when there is one, and every source file's path, size and mtime — a dirty
working tree is what the index describes, so keying on `HEAD` alone would
serve a stale answer after an edit. A `--ref` entry is keyed instead by the
index format, the commit SHA and the tree's file list — never by file stats —
so a dirty checkout can neither serve nor overwrite it. The five most recent
revisions of a repository are retained.

## Limits (v0)

- **Calls, imports and heritage; no reads.** Reading a symbol without calling
  it is not recorded. `callers` answers call sites; `impact` also walks import,
  re-export, `extends` and `implements` edges (ADR 0004), and an import's
  dependent is the importing module, not the function that uses the binding.
- **No override propagation.** A changed method does not reach a method that
  overrides it; the class does reach its subclasses. Calls through a subclass
  to an inherited method already resolve to the base method.
- **No precision promise.** A call site resolves when the checker can resolve
  it; what was found is reported as found, and anything dynamic is counted as
  unresolved rather than inferred. An empty or shallow `impact` answer is never
  proof that nothing is affected — `unresolvedSites` is always reported beside
  it.
- **Committed history only** for `diff`: `base` and `head` are commits, and
  uncommitted edits do not appear in the answer. `impact` answers from the
  working tree unless `--ref` names a commit, in which case no uncommitted
  state can enter the answer.
- **One repository** per invocation, no cross-repository graph, no UI.
- **File names `code-map` cannot read.** A changed source file that reaches the
  line-range read (not filtered out as non-code, not cut by the 20-file cap) and
  whose name is not valid UTF-8, or is a Unicode name stored decomposed (NFD),
  as on macOS, makes `code-map` exit 7 in 0.1.0 rather than skip that file.

## Python gate status

Glyph 0.1.0 ships Python support (DEC-303 (a20), the operator's release-scope
decision). Its measured accuracy is **below the gate set for it** (DEC-303 (a2)
and (a5): incoming-call recall of at least 0.9 with a Wilson lower bound of at
least 0.8, and precision of at least 0.95, on each repository). The gate was
run once on 2026-11-25 (ADR 0008, "The gate result"):

| repository | recall | Wilson lower | precision | gate |
|---|---|---|---|---|
| click 7.1.2 | 68/80 = 0.8500 | 0.7559 | 68/69 = 0.9855 | FAIL |
| requests 3c7baaa | 57/65 = 0.8769 | 0.7755 | 57/57 = 1.0000 | FAIL |

Read these as stated limits of the release: precision meets the bar, recall does
not, so a Python `callers` or `impact` answer can miss real callers and must not
be read as complete. Unresolved calls stay counted in `unresolvedSites` and the
call bins, so a miss shows as a number. No later claim that Python passes the
gate stands without a fresh blind sample (GCLI-86); these two samples are spent
and are not used to tune the indexer.

## Development

```sh
bun run check   # typecheck, lint, format:check, then the tests
bun test        # tests only
bun run glyph … # the CLI from source
```

The Bun version comes from `.bun-version`. TypeScript is pinned to 5.9.3 and
should stay on 5.x until 7.x ships the programmatic compiler API this indexer
is built on (`ts.createProgram`): the 7.0.2 package contains only `lib/tsc.js`
and its helpers, no `lib/typescript.js` (probed 2026-09-30). CI runs these
checks as the `Check` job.

## License

MIT.
