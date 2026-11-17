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
added edges are not yet named by a design record"). Implemented under GCLI-11,
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
  `moduleTarget` names the target file. When impact starts from any symbol
  declared in module `M`, every namespace or side-effect importer of `M` is a
  depth-1 terminal. This is conservative on purpose. `export * from "./m"` and
  `export * as ns from "./m"` bind no single symbol either and are recorded the
  same way.

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
- **The module-edge rule applies to the symbol impact starts from.** A namespace
  or side-effect importer of `M` is a depth-1 terminal of the starting symbol when
  it is declared in `M`; it is not re-attached to every symbol the walk later
  reaches inside `M`.
- **Override propagation is not in v1.** A changed method does not reach the
  methods that override it; the class does reach its subclasses.
- **`import x = require("m")` counts as dynamic.** It is a `require`, and is
  counted, not followed.
- **Existing answers are unchanged.** The call and `new` answers over the same
  repository are the ones ADR 0003 produced; impact answers now also list the
  import and heritage terminals beside them, so `total`, `unexplored` and the
  per-depth counts grow by exactly those entries.
