# Glyph

Software intelligence about source code: **what calls this symbol**, and
**which symbols a diff touches** — one language, one repository at a time.

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

### `glyph diff <base> [head]`

Symbols the committed diff `base..head` touches (`head` defaults to `HEAD`).
Only the innermost touched symbol is reported: a change inside a method
reports the method, not also every class containing it. Changed ranges come
from `git diff --unified=0`, and a deletion-only hunk is attributed at the
line where the deletion happened.

### `glyph cache path` | `glyph cache clear`

Show or clear this repository's local cache directory.

## The machine contract

stdout carries exactly one success envelope — JSON under `--json`, human text
otherwise. On failure stdout stays **empty** and stderr carries the message;
under `--json` that message is an object of the same shape:

```json
{ "schemaVersion": 1, "kind": "callers", "data": { } }
{ "schemaVersion": 1, "kind": "error", "errorType": "not_found", "message": "…" }
```

Callers branch on the exit code, never on the message:

| code | meaning |
|------|---------|
| 0 | ok |
| 1 | internal / unexpected |
| 2 | usage (an ambiguous symbol included) |
| 3 | not found (no such symbol, ref, or sources) |

## How the index is built

The indexer takes its own walk of every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
`.jsx`, `.mjs` and `.cjs` file under the repository — a tsconfig governs
compiler *options*, never which files are visible — and builds one TypeScript
program over them.

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

## The cache

The only state Glyph keeps, and disposable: every entry is re-derivable, so
deleting it costs time, never evidence. Location: `$GLYPH_CACHE_DIR`, else
`$XDG_CACHE_HOME/glyph`, else `~/.cache/glyph`, under a directory keyed by the
repository's absolute path. An entry's key covers the index format, `HEAD`
when there is one, and every source file's path, size and mtime — a dirty
working tree is what the index describes, so keying on `HEAD` alone would
serve a stale answer after an edit. The five most recent revisions of a
repository are retained.

## Limits (v0)

- **Calls only.** Reading a symbol without calling it is not recorded;
  `callers` answers call sites.
- **No precision promise.** A call site resolves when the checker can resolve
  it; what was found is reported as found, and anything dynamic is counted as
  unresolved rather than inferred.
- **Committed history only** for `diff`: `base` and `head` are commits, and
  uncommitted edits do not appear in the answer.
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
