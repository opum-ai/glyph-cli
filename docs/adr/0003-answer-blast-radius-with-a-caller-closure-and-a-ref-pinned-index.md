---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Answer blast radius with a caller closure and a ref-pinned index
summary: "glyph impact answers the call graph's transitive reverse closure with deterministic shortest paths, exact truncation counts and SCC-marked cycles; --ref indexes a commit's tree without a checkout."
tags:
  - impact
  - call-graph
  - ref-pinned-index
generated:
  by: lore/0.13.0
  at: 2026-10-21T16:39:15.515Z
---

# Answer blast radius with a caller closure and a ref-pinned index

## Status

Accepted — opum-doc DEC-216 (2026-10-20, accepted), Q2 and Q4, to the six
acceptance criteria in the design-readiness review's section 3
(`opum-doc` `docs/research/market/evidence/2026-10-20-glyph-cli/design-readiness.md`).
Module-scope call sites were ruled option A, recorded as DEC-216 (a1)
(`opum-ai/opum-doc#1173`), and DEC-216 (a2) amends it: a module-scope caller is
terminal at its true depth, with its full path, and depth 1 stays a superset of
`callers`. DEC-216 (a2) also rules the `--ref` disk question: in-repo
`node_modules` is never read from disk, and a resolution that would go through
it counts as unresolved. Implemented under GCLI-10, slice 2 of the four
DEC-216 slices; it builds on slice 1's command contract (ADR 0002) and changes
no existing command's answer.

## Context

Glyph v0 answers two questions: what calls this symbol (one hop), and which
symbols a diff touches. The consumers that name Glyph ask for more: the harness
lists "Symbols, call graph, blast radius" and compiles "blast radius from
Glyph"; the product catalog names impact. One hop is not a blast radius a merge
gate can use.

Two structural gaps forced this slice's shape. First, the index describes the
working tree, while `diff` resolves commits — so the two coordinate systems can
disagree, and no answer was reproducible against a named revision. Second, an
empty answer has no way to say it is empty because the call graph is blind:
calls that resolve outside the repository, dynamic dispatch and reflection are
never guessed at, and the index keeps only their count. An impact answer must
therefore carry that count beside the callers, so nobody reads "nothing calls
this" out of "Glyph could not see".

## Decision

**`glyph impact <symbol> [--depth N] [--all] [--ref <ref>] [--json]`** answers
a transitive reverse closure over the existing call graph, under one dotted
kind, `impact.result`, with the exit-code family every Glyph command shares.

- **The closure.** The walk is breadth-first from the selected symbol over the
  reverse of the indexed `call`/`new` sites, so each caller is discovered once,
  at its shortest depth; direct callers are depth 1. Each caller carries one
  shortest path to the target, and that path's call sites (file, line, column,
  kind, and both endpoints' ids). When several shortest paths exist, one is
  chosen by a total order — the path string first, then the call site's file,
  line and column — so the answer is deterministic rather than dependent on
  index order.
- **The bound.** The default depth is 5; `--depth N` bounds what is reported
  and `--all` asks for the full closure. The two are mutually exclusive, and a
  depth that is not a positive integer is a usage error (exit 2). The full
  closure is traversed even when the answer is depth-bounded, because the
  acceptance criterion's number is *the number of callers left unexplored*:
  `truncated` is true when any caller sits beyond the bound, and `unexplored`
  counts exactly those callers. A depth-bounded answer costs a full closure
  walk; it never reports a frontier estimate as a count.
- **Cycles terminate and are marked.** A symbol cannot be discovered twice, so
  the walk terminates on any graph. Membership is decided by strongly connected
  components over the discovered subgraph (the selected symbol included), so a
  caller carries `cycle: true` when it lies on a call cycle inside the closure,
  and the envelope carries `cycle: true` when any such cycle exists — a
  recursive target is reported as a cycle with no caller entry of its own,
  because the selected symbol is never its own impact.
- **Module scope (DEC-216 (a1), amended by (a2)).** A call site outside any
  declaration has no caller symbol. Each is reported as a terminal caller with
  `symbol: null`, its true depth and a path of the edges down to the target,
  and it is never expanded. `impact`'s depth-1 set is therefore a superset of
  what `callers` reports for the same symbol.
- **`--ref <ref>` indexes a commit's tree without a checkout.** The ref is
  resolved to a commit (unresolvable is `not_found`, exit 3); its regular blobs
  are listed with one `git ls-tree -r -z` and read with one
  `git cat-file --batch`; the TypeScript program is built on an in-memory
  compiler host over that map. The commit's own `tsconfig.json` (and whatever
  it extends) supplies compiler options, so the answer cannot move because a
  checkout changed. Paths inside the repository that the tree does not contain
  are invisible to a `--ref` program, and **in-repo `node_modules` is not read
  from disk** (DEC-216 (a2)): a module that would resolve through the
  checkout's installed dependencies is not resolved through that install, and
  its call sites are counted in `unresolvedSites`. That makes what the commit
  carries authoritative and consistent with a cache key that cannot see
  node_modules content. A tracked `node_modules` is part of the tree and is
  served from the tree like any other committed path. `ts.sys` is the fallback
  for any path outside the repository root — a hoisted dependency tree or a
  parent-directory tsconfig reached through `extends`, for example — and for
  the running TypeScript package's own library directory, wherever it sits.
  Those host reads are not hashed, so they can still move a cold answer — see
  Consequences. Symlink entries and submodule gitlinks are not source files
  and are skipped. The working tree remains the default for interactive use.
- **The cache is addressed by the commit under `--ref`.** The key is the index
  format plus the commit SHA plus the tree's file list — not file stats — so a
  dirty working tree can neither serve nor overwrite a `--ref` answer. The
  cache stays disposable, in the same per-repository directory, and reports
  `hit`/`miss` exactly as the other commands do.
- **The envelope is honest about coverage.** `resolvedSites` is the index's
  call-site count and `unresolvedSites` is its count of call sites that
  resolved nowhere in the repository; both are index-wide, because the index
  retains no identity for an unresolved callee. Every human answer restates the
  caveat: an empty or shallow impact is not proof that nothing is affected.

Q4 also says `diff` requires `--ref`. That would change an existing command's
surface, which this slice's acceptance criteria forbid, so it is deferred to
the slice that takes over the code-map seam; `callers` and `diff` answer
exactly as before.

## Consequences

- The envelope is deterministic: the same repository state and ref yield
  byte-identical JSON apart from the `cache` field, which reports `hit` or
  `miss`. Callers are ordered by depth, then path string, then call site.
- A depth-bounded answer costs a full closure walk, and a `--ref` answer builds
  a TypeScript program from memory. Both are bounded by one repository's call
  graph; neither is a streaming query.
- A dirty checkout can no longer influence a `--ref` answer, at the cost of
  ignoring uncommitted files (including a locally added source file that is not
  in the commit) under `--ref`.
- In-repo `node_modules` is never read in `--ref` mode, apart from the running
  TypeScript package's own library directory (DEC-216 (a2)).
  Dependencies installed in the checkout are not part of the commit, so a
  resolution that would go through them is reported as unresolved instead, and
  a cache entry cannot be influenced by them. The cost is recall: a call whose
  resolution needed a dependency's types is counted, not resolved. A tracked
  `node_modules` is read from the tree like any committed path.
- **The identity claim is scoped to what the commit carries.** `computeRefKey`
  hashes `INDEX_FORMAT`, the commit SHA and the tree's file list, and nothing
  else. Three kinds of input can therefore move a cold answer without moving the
  key: host files the commit does not carry, such as a hoisted dependency tree
  above the root, a parent-directory tsconfig reached through `extends`, or any
  other path outside the root, and the running TypeScript package's own library
  directory, wherever it sits, inside the root included; the running TypeScript
  compiler's version, whose checker behaviour reaches beyond its `.d.ts` files;
  and Glyph's own indexer logic beyond `INDEX_FORMAT`, so a code change without
  a format bump can also serve a stale warm entry. Two hosts whose such inputs
  or tool versions differ can answer the same commit differently on a cold
  cache, and a warm entry keeps the answer it was built with. What the commit does carry — its tree and its own
  tsconfig — determines the rest.
- An empty answer never reads as "no impact": `unresolvedSites` is always
  reported, and the precision caveat is stated in the README and in every human
  answer.
- The tests are `test/impact.test.ts` (traversal, determinism, truncation
  count, cycles, module scope, ref snapshots and commit-sourced compiler
  options) and the `impact` cases in `test/cli.test.ts` (text and JSON,
  `--depth`, `--all`, ref-versus-dirty-tree, ambiguous and unknown symbols,
  invalid depth, byte identity across runs).

*Corrected 2026-11-17 (GCLI-19).* Earlier versions of this record promised that
"two machines with different installs answer the same `--ref` identically", and
stated that in-repo `node_modules` is not read from disk without excepting the
running TypeScript package's own library directory. Both were too strong: an
input the commit does not carry — a hoisted dependency tree, a parent tsconfig
reached through `extends`, the TypeScript package wherever it sits, or a
different compiler version — can move a cold answer, and only what the commit
carries is authoritative. The scoped wording above replaces the earlier
sentences; the DEC-216 (a2) design ruling they described is unchanged.
