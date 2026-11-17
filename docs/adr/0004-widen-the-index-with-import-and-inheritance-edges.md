---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Widen the index with import and inheritance edges
summary: "The index records import, re-export, extends and implements edges beside calls, and impact walks all five kinds as one search; unresolved edges are counted by kind."
tags:
  - impact
  - call-graph
  - import-edges
generated:
  by: lore/0.14.1
  at: 2026-11-17T14:20:20.515Z
---

# Widen the index with import and inheritance edges

## Status

Accepted — opum-doc DEC-216 (a3), 2026-11-17 14:10Z, option A refined, which
settled the query semantics DEC-216 Q3 left open ("the query semantics for the
added edges are not yet named by a design record"), as refined by DEC-216 (a5),
2026-11-17, which ruled the five cases (a3) left undecided. Implemented under GCLI-11,
slice 3 of the four DEC-216 slices. It builds on ADR 0003's impact walk and
changes no existing call or `new` answer. DEC-216 Q3's scope stands:
read/write reference edges stay out.

## Context

Until this slice the index recorded only call and `new` sites, so a type, a
constant or an export used without being called was invisible to `glyph impact`:
changing an interface reached nobody, and changing a function that is only
re-exported or passed by reference reached only its direct callers. The
questions "who imports this?" and "who implements or extends this?" are
structural facts the type checker already resolves.

## Decision

**Scope.** Read/write reference edges remain out of scope (DEC-216 Q3). That is
why an import's dependent is the importing **module**, not the declarations that
use the binding.

**Import edges.**

- An import is an edge whose target is a **symbol**: the declaration the imported
  binding resolves to, following alias and re-export chains through the checker
  (`getAliasedSymbol`) to the original declaration. Default imports resolve like
  named imports.
- Its dependent is the importing module: `callerId` is null, at the import
  declaration's site. It is a module-scope terminal, exactly as DEC-216 (a1) and
  (a2) treat module-scope call sites. Changing `A` puts every module importing
  `A`, directly or through a barrel, in `A`'s blast radius at depth 1, and the
  walk does not continue from a module terminal.
- A re-export (`export { x } from`, `export * from`) is also an import edge, with
  the barrel module as the dependent. The barrel's own importers already resolve
  to the original declaration, so they appear at depth 1; there is no extra
  transitive hop.
- `import type` and type-only specifiers **are** recorded, because a type change
  breaks them. Each carries `typeOnly: true`; every other import carries
  `typeOnly: false`.
- Namespace imports (`import * as x`) and side-effect imports (`import "./m"`)
  bind no single symbol. They are **module edges**: `calleeId` is null and
  `moduleTarget` names the target file. Per DEC-216 (a5), when the walk reaches
  an **exported** symbol declared in module `M` at depth `k` (the start symbol
  included, at `k = 0`), every namespace or side-effect importer of `M` is a
  terminal at depth `k + 1`, each importer once at its shortest depth.
  Non-exported symbols do not trigger it, because a namespace binding can only
  reach exports. If `M.f` calls the changed `g`, then `ns.f()` in another module
  is affected. `export * from "./m"` and `export * as ns from "./m"` bind no
  single symbol either and are recorded the same way, so they follow the same
  rule; importers through the barrel by name already resolve to the original
  declarations.
- `import x = require("m")` is resolved statically like an import (DEC-216
  (a5)): through the checker to the declaration it aliases (an `export =`
  target) as a symbol edge, or, when it aliases the whole module, as a module
  edge. Dynamic `require()` and `import()` calls stay counted and unfollowed.

**Inheritance edges.**

- `class B extends A` is an edge from `B`'s declaration (`callerId` = `B`) to
  `A`, kind `extends`. `class C implements I` is an edge from `C` to `I`, kind
  `implements`, and an interface that extends an interface is kind `extends`.
- A changed class or interface reaches its subclasses and implementers at
  depth + 1; the walk then continues from them over every edge kind, so callers
  of `B` and `C` come in.
- A changed **method** does not fan out to overriding or inheriting methods in
  v1. Calls through a subclass to an inherited method already resolve to the base
  declaration as call sites. Override propagation is a named limitation, pinned
  by a test, not a silent gap.

**One walk.** `impact` stays one breadth-first walk over the union of `call`,
`new`, `import`, `extends` and `implements`, with shortest depth and the existing
total-order tie-break. Every hop in a path carries its edge kind. Depth 1 stays a
superset of `callers`, and `callers` still lists call and `new` sites only.

**Unresolved.** Nothing is dropped. All of these count:

- a specifier that does not resolve to an in-repo file (an external package, a
  missing file, or anything through in-repo `node_modules` under DEC-216 (a2));
- a heritage clause whose target does not resolve in-repo;
- dynamic `import()` and `require()`, which are out of scope for resolution but
  still counted.

`unresolvedSites` stays the total, and `unresolvedByKind`
(`{call, import, extends, implements, dynamic}`) says which kind is blind. A
`new` expression counts under `call`.

**Contract.** `SiteKind` is `"call" | "new" | "import" | "extends" |
"implements"`. Import sites carry `typeOnly`; namespace, side-effect and
`export *` edges carry `moduleTarget` instead of a `calleeId`. `impact.result`
path hops carry `kind` (and `typeOnly` or `moduleTarget` where they apply).
`INDEX_FORMAT` is bumped to 2; the format is monotonic and never shared between
two shapes, so a later slice that changes the index bumps it again.

## Consequences

- **Precision caveat.** Import and heritage edges are recorded where the checker
  resolves them to an in-repo declaration, and are reported as found. A module
  edge is deliberately coarse: it names every namespace importer of a module for
  a symbol in it, including importers that never touch that symbol. An import
  whose binding the checker resolves to a declaration the symbol table does not
  carry (an anonymous default export, a re-exported namespace) is counted as an
  unresolved import. An empty or shallow `impact` answer is still never proof
  that nothing is affected.
- **A module importer is a terminal.** Because the dependent of an import is the
  module and not the declarations using the binding, impact does not say which
  function in the importing module is affected; reading that is a reference edge,
  which stays out of scope.
- **Module edges are coarse, and flood to the bound.** A namespace or side-effect
  importer is reported for every exported symbol the walk reaches in its module,
  including importers that never touch that symbol. The flooding is bounded by
  the depth bound and the exact truncation counts, and limited to exports, so
  barrels stay readable (DEC-216 (a5), item 1).
- **An anonymous or otherwise unindexed declaration is an unresolved import.**
  A binding the checker resolves to a declaration the symbol table does not
  carry, for example an anonymous `export default function () {}`, is counted
  under `unresolvedByKind.import` and no module edge is guessed for it. Indexing
  anonymous default exports as symbols is not part of this decision; it becomes
  its own task only if it shows up on a real repository (DEC-216 (a5), item 4).
- **Class-expression heritage.** For `const C = class extends A {}` the
  dependent is the enclosing declaration (the variable symbol `C`), and module
  scope when there is none (DEC-216 (a5), item 5).
- **Override propagation is not in v1.** A changed method does not reach the
  methods that override it; the class does reach its subclasses.
- **Existing call and `new` answers are unchanged, but the envelope's other
  fields move.** The call and `new` entries over the same repository are the ones
  ADR 0003 produced, and `callers` still lists call and `new` sites only. Impact
  answers now also list the import and heritage terminals beside them, so the
  consumer-visible fields that change are:
  - `total`, `unexplored` and the per-depth counts, by exactly those entries;
  - `resolvedSites` in the impact envelope and `index.sites`, which now count
    import and heritage sites as well as calls (the three-hop chain fixture goes
    from 3 to 6);
  - `truncated`, which can flip at the same depth bound, because the added
    terminals count toward what lies beyond it;
  - for a class or interface start, heritage edges add callers that can shorten a
    caller's depth and change the path chosen for it.
  A consumer that pins this contract must read these as the new baseline.
- **A namespace importer of a barrel is not a terminal of the original symbol.**
  `import * as b from "./barrel"`, where the barrel re-exports `m`'s `a`, never
  becomes a terminal of `a`, because the module-edge trigger keys on the file
  that declares the exported symbol. That is a gap in the (a5) rule, not a bug in
  the walk; it is routed to opum-doc and not decided here.
- **`import {} from "./m"` is not recorded.** An import with an empty named list
  binds nothing and is not a module edge today; whether it should be one is
  routed to opum-doc, and its current behaviour is left as is.
- **`import x = require("m")` of an unindexed `export =` target is unresolved.**
  `export = { k: 1 }`, or an anonymous function or class, is counted under
  `unresolvedByKind.import`; only an alias of the whole module is a module edge.
