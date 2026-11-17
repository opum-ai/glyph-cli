# Glyph

Software intelligence about source code: **what calls this symbol**, **what a
symbol's change can reach**, and **which symbols a diff touches** — one
language, one repository at a time.

Glyph is Opum's software-intelligence primitive, the third peer product
alongside Lore and Quest. v0 is deliberately narrow; its scope is the operator
decision recorded in [ADR 0001](docs/adr/0001-scope-glyph-v0-to-a-one-language-symbol-and-call-graph.md).

## Scope

- **TypeScript and JavaScript**, as one language target (operator decision
  DEC-66, recorded in ADR 0001).
- **One repository at a time.** There is no cross-repository graph.
- **A local cache, and nothing else.** Glyph writes nothing into the
  repository it analyzes.
- **No UI.** stdout carries either human text or one JSON envelope.

## Run it

Not published yet — the package is private until first release. From a
checkout, with [Bun](https://bun.sh) matching `.bun-version`:

```sh
bun install
bun run glyph callers buildReport --repo /path/to/repo
bun run glyph impact buildReport --repo /path/to/repo
bun run glyph diff main --repo /path/to/repo
```

`--repo <dir>` points at the repository to analyze (default: the current
directory). `--json` switches any command to the machine envelope.

## Commands

### `glyph callers <name>`

Every call site that invokes the one symbol named `<name>`. `--file <pattern>`
narrows the name to symbols whose repository-relative path contains the
pattern; a name that stays ambiguous is a usage error listing the candidates
rather than a guess.

```console
$ bun run glyph callers buildIndex
callers of buildIndex (function) at src/indexer.ts:206:17 — 3 call site(s) in 3 file(s)
  src/cli.ts:66:16  call  in loadIndex
  test/indexer.test.ts:9:9  call  in indexOf
  test/queries.test.ts:12:9  call  in indexOf
index: 13 files, 81 symbols, 139 sites (cache miss)
```

### `glyph impact <name>`

Every caller a change to this symbol can reach — the transitive reverse closure
over call, `new`, import, `extends` and `implements` edges (ADR 0004). Each caller appears once, at its shortest depth (direct
callers are depth 1), with one shortest path to the target and the call sites
on that path. When several shortest paths exist, a total order — the path
string, then the call site's file, line and column — picks one, so the answer
is deterministic. The `module scope` rows at each depth are the import
terminals (see below): the importing module, not a function in it.

```console
$ bun run glyph impact d
impact of d (function) at src/d.ts:1:17 in the working tree — 6 caller(s) within depth 5 (6 found, cache hit)
  depth 1  module scope  src/c.ts:1:10  module scope -> d
  depth 1  c  src/c.ts:3:10  c -> d
  depth 2  module scope  src/b.ts:1:10  module scope -> c -> d
  depth 2  b  src/b.ts:3:10  b -> c -> d
  depth 3  module scope  src/a.ts:1:10  module scope -> b -> c -> d
  depth 3  a  src/a.ts:3:10  a -> b -> c -> d
  coverage (index-wide): 6 resolved site(s); 0 did not resolve (call 0, import 0, extends 0, implements 0, dynamic 0); an empty answer is not proof of no impact
index: 4 files, 4 symbols, 6 sites (cache hit)
```

- The default depth is 5. `--depth <n>` reports fewer hops and `--all` runs the
  full closure; the two are mutually exclusive. A depth-bounded answer still
  traverses the whole closure, so `truncated: true` comes with the **exact**
  number of callers left unexplored rather than a frontier estimate. A cycle
  terminates, and the callers on it are marked `cycle: true`.
- A call site at module scope has no enclosing declaration. It is reported as a
  terminal caller with `symbol: null` and is never expanded, so the depth-1
  answer is a superset of `callers` (DEC-216 (a1)).
- An import is an edge to the symbol the binding resolves to, through alias and
  re-export chains, and its dependent is the importing **module**: a
  module-scope terminal at depth 1 with `symbol: null`, never expanded. A
  re-export is an import edge with the barrel as the dependent. `import type`
  is recorded with `typeOnly: true`. A namespace import, a side-effect import or
  `export *` binds no single symbol: it is a depth-1 terminal of any symbol
  impact starts from in the imported module, carrying `moduleTarget`.
- `class B extends A`, `class C implements I` and `interface J extends I` are
  edges from the subclass or implementer, so a changed class or interface
  reaches them at depth + 1 and the walk continues over every edge kind. A
  changed **method** does not reach an overriding method in v1 (a named limit,
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

### `glyph cache path` | `glyph cache clear`

Show or clear this repository's local cache directory.

### `glyph help --json`

Emit the live command manifest — every command's dotted `kind`, its flags and
exit codes, and the frozen exit-code taxonomy. The manifest is built from the
same registry the commands use, so it cannot drift from the handlers.

## The machine contract

Glyph implements the frozen
[Opum command contract](https://github.com/opum-ai/opum-doc/blob/dev/docs/specs/opum-command-contract.md)
and records that obligation in [ADR 0002](docs/adr/0002-adopt-the-opum-command-contract.md).
stdout carries exactly one success envelope — JSON under `--json`, human text
otherwise. On failure stdout stays **empty**, and stderr carries the error
envelope:

```json
{ "schemaVersion": 1, "kind": "callers.result", "data": { }, "principal": null }
{ "error_type": "not_found", "message": "…", "principal": null }
```

- **`principal` is reserved and always present**, as the last top-level key on
  both envelopes. It is `null` until an identity is populated; omitting it is
  non-conformance, not an equivalent variant.
- **Kinds are dotted `command.payload`** (`callers.result`, `impact.result`,
  `diff.result`, `cache.path`, `cache.clear`, `help.manifest`), plus
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
  frozen contract's §4 rule 1, per opum-doc ruling A (2026-10-20), rather than
  lore's undotted `version`/`help`; consumers tolerate unknown kinds.

Callers branch on the exit code, never on the message. The family is the full
frozen taxonomy:

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

v0's commands produce `usage` and `not_found`, `indeterminate` when Git
refuses to describe a repository, and `uncaught` for a bug; `denied`,
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
  the DEC-216 behavior and it is stated here because `callers` and `diff`
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
`node_modules` is not read from disk either** (DEC-216 (a2)), apart from the
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

`diff` and the code-map seam will require `--ref` (DEC-216 Q4). Making an
existing command's surface change is out of this slice, so that requirement is
recorded in ADR 0003 and deferred to the seam's own slice.

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

MIT. Glyph is private until first release.
