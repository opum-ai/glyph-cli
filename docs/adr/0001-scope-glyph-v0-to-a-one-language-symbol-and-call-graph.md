---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Scope Glyph v0 to a one-language symbol and call graph
summary: Glyph v0 is a symbol table and call graph for one language and one repository at a time; its first language is TypeScript and JavaScript, chosen by the operator (DEC-66).
generated:
  by: lore/0.11.0
  at: 2026-09-29T23:57:05.875Z
---

# Scope Glyph v0 to a one-language symbol and call graph

## Status

Accepted — operator ruling, 2026-09-29, relayed as opum-doc seq 54
(ODOC-OP-2026-09-29-32, 2026-09-29T23:51:46Z) and recorded as DEC-65. The
operator's label, verbatim: **"Narrow increment now (Recommended)"**.

Accepted — the first-language choice, operator ruling, 2026-09-30, relayed as
opum-doc seq 56 (ODOC-OP-2026-09-30-01, 2026-09-30T01:37:43Z) and recorded as
opum-agent DEC-66. The operator's label, verbatim: **"TypeScript/JavaScript
(Recommended)"**. The last section carries the decision and the A/B it was made
on.

## Context

Glyph is Opum's software-intelligence primitive: the third peer product primitive
alongside Lore and Quest, answering *how does the system work?* about source code
within and across repositories (opum-doc, "Admit Glyph as the third Opum product
primitive", 2026-08-09). The harness consumes it as a verification oracle —
"Symbols, call graph, blast radius" — through a port whose v0 implementation is a
no-op, and holds it at an inert seam until its plan-compliance monitor needs it
(opum-doc, `docs/specs/opum-harness-architecture-and-delivery-plan.md`).

That record supports two readings about what glyph-cli should do first, and the
choice was therefore put to the operator rather than settled in this repository:
start the narrowest real increment now, or hold at the seam until the monitor
demonstrably needs the port. opum-doc put both as an A/B and DEC-65 records the
answer. This is the component decision that follows from it, so it lives here
rather than in opum-doc.

## Decision

Glyph v0 is a symbol table and a call graph for **one language, one repository at
a time**, answering two queries:

- what calls this symbol
- which symbols does this diff touch

It keeps a local cache and nothing else.

**The two exclusions are the decision, not an omission.** Glyph v0 draws no
cross-repository graph and ships no user interface. Both are plausible and neither
is here, so a later reader should treat their absence as deliberate rather than as
work someone forgot. The ADR admitting Glyph already fixes the outer boundary this
respects: Glyph answers impact-and-paths questions about source code within and
across repositories, while portfolio-scale questions belong to Atlas, and
organizational rationale belongs to Lore as a link rather than a copy.

The increment exists to be judged as a Glyph rather than as scaffolding: it is the
smallest thing that produces a real answer to the canonical question, and the
harness port can later be swapped off its no-op against something measured instead
of assumed.

## Consequences

- Nothing blocks on this. The harness's port is already a no-op, so v0 arriving
  late or changing shape costs no dependent work — the ADR admitting Glyph says so
  explicitly, and it is why this can be built ahead of its consumer.
- The local cache is disposable and machine-local. No other repository reads it,
  and deleting it must never lose evidence, only time.
- Single-language and single-repository are load-bearing limits, not phases of a
  schedule. Widening either is a new decision with its own record.
- v0 makes no promise about precision. Resolving every call in a dynamically
  dispatched target is not achievable by parsing, so the graph's recall is a
  property of the chosen language, which is the next section's subject.

## First language — decided: TypeScript and JavaScript

The operator chose candidate 1, answered first-party via `AskUserQuestion` in
opum-doc, relayed as opum-doc seq 56 (ODOC-OP-2026-09-30-01, 2026-09-30T01:37:43Z)
and recorded as opum-agent DEC-66. The chosen label, verbatim:
**"TypeScript/JavaScript (Recommended)"**. The option the operator saw is
candidate 1 as written below — one target using the TypeScript compiler's type
checker, so callers resolve through types, with the fleet itself as the test
corpus. The A/B and its counts stay below as the record the choice was made on.

**Candidate 1 (recommended): TypeScript and JavaScript, as one target.**
TypeScript's compiler API exposes a real type checker rather than only a parser, so
"what calls this symbol" resolves through types instead of name-matching — the
difference between a call graph and a guess. One parser covers both languages.

- *Quality*: highest available. Type information is what makes call resolution
  tractable; a language without it cannot reach this precision by parsing alone.
- *Speed*: fastest to a working v0. Glyph is already ruled to be written in
  Bun/TypeScript (opum-doc, "Adopt Bun as the runtime for Opum command-line
  components"), so the parser comes from the toolchain Glyph already depends on
  rather than a new one.
- *Cost*: lowest, and the only candidate whose quality can be measured inside this
  fleet rather than asserted. Every fleet repository is a dogfooding corpus whose
  behaviour the operator already knows — counted per ref on 2026-09-29 with
  `git ls-tree -r --name-only origin/dev`: lore-cli 286 TypeScript files,
  quest-cli 203, ward-cli 96, and opum-agent 141 `.mjs`. A blast-radius answer can
  be checked against a real known change.

**Candidate 2: Python.**
- *Quality*: materially lower for this purpose. Python dispatches dynamically, so
  many calls cannot be resolved without running the code, and a v0 graph would be
  more approximate than candidate 1's on the same effort.
- *Speed*: fast in isolation — CPython ships `ast`, so parsing costs no dependency
  at all.
- *Cost*: the fleet has nothing to validate it against. Counted the same way and
  the same day: 0 `.py`, `.rs` and `.go` files across lore-cli, quest-cli and
  ward-cli, and exactly one in opum-agent —
  `scratchpad/questgraph-release-claim-check.py`, a scratchpad script rather than
  shipped code. Quality would be asserted from outside the fleet rather than
  measured inside it.

*Left out deliberately*: Rust, Go and Java. Each has strong analysis tooling, and
none appears anywhere in this fleet, so any of them buys zero dogfooding — and
there is no measurement here that would order them against each other honestly.

*Recommendation: candidate 1, TypeScript and JavaScript.*

*Corrected 2026-09-29.* The first version of this section gave 316 TypeScript
files for lore-cli and 2,353 `.mjs` for opum-agent. Both were counts of a working
tree — including untracked and generated files — stated as if they were those
repositories' committed content. 2,353 against 141 is not a rounding error; it is
two different objects. Both are replaced above with per-ref counts, and the method
is named beside the numbers so a later reader can re-take them rather than trust
them. Nothing about the recommendation changes: the fleet is TypeScript and
JavaScript either way, and the alternative candidate still has no corpus here.
