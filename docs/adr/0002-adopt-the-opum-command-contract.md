---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Adopt the Opum command contract
tags:
  - cli-contract
  - conformance
summary: "Glyph conforms to the frozen Opum command contract: principal on both envelopes, the shared error shape, a dotted kind registry published by glyph help --json, and the full exit-code family."
generated:
  by: lore/0.14.1
  at: 2026-10-20T23:06:39.076Z
---

# Adopt the Opum command contract

## Status

Accepted — opum-doc DEC-216 (2026-10-20, accepted) directs Glyph to conform to
the frozen contract now, before any consumer depends on its output, and records
the decision in the same change that corrects the stale sentence in
`opum-doc`'s `docs/standards/cli-contract.md`. Implemented under GCLI-9.

## Context

The frozen
[Opum command contract](https://github.com/opum-ai/opum-doc/blob/dev/docs/specs/opum-command-contract.md)
names `glyph-cli` as one of the components that must implement the shared
result envelope, exit-code taxonomy and `kind` registry. The envelope shape "is
not revisable once components depend on it", and the `CodeMapProducer` seam
means a consumer is about to depend on Glyph output.

Glyph v0 emitted `{schemaVersion, kind, data}` with kinds like `callers`,
`errorType`/`internal` errors, and exit codes 0-3. That is one parser and one
exit-code vocabulary short of the contract, and the fleet standard correctly
listed Glyph as non-conformant — except for one stale sentence: it said Glyph
had "no JSON envelope at all", which was never true. The real gaps were the
missing `principal` slot, the non-conforming error shape, the absent manifest
and the partial exit-code family.

## Decision

Glyph implements the frozen contract directly, rather than through a shared
package that does not exist yet:

- **Both envelopes carry `principal` as the last top-level key**, always
  `null` until an identity is populated. Omitting the key is non-conformance,
  not a variant. `SuccessEnvelope` and `ErrorEnvelope` are constructed in one
  place, `src/contract.ts`.
- **The error envelope is `{error_type, message, principal}`**, written to
  stderr with stdout empty. A non-`GlyphError` throw is `error_type:
  "uncaught"` and exit 1, never a classified type.
- **Kinds are dotted `command.payload`** (`callers.result`, `diff.result`,
  `cache.path`, `cache.clear`, `help.manifest`), declared in the live
  `COMMANDS` registry. `glyph help --json` publishes that registry and the
  exit-code taxonomy as `help.manifest`; the manifest is built from the
  registry, never hand-listed beside it.
- **The full exit-code family is mapped**: 0 ok, 1 uncaught, 2 usage,
  3 not_found, 4 denied, 5 conflict, 6 validation/drift, 7 indeterminate, in
  one frozen `EXIT_CODES` map.

What this record deliberately does not decide: how a principal is
*established* or *enforced*, and `PrincipalRef`'s concrete shape. The contract
reserves the slot and defers the mechanism; Glyph does not populate it.

The same slice replaces the fixed directory list in source discovery with
Git's own file selection, so `.gitignore`, nested ignore files and negation
patterns are honoured. That is a DEC-216 clause, recorded here because it
changes what the index can contain.

## Consequences

- The local obligation the contract's Adoption section requires is recorded
  here: Glyph's result envelope, exit codes, `kind` registry and diagnostics
  conform to the frozen pattern, including the reserved `principal` field.
- The conformance test is `test/contract.test.ts`. It enumerates the live
  `COMMANDS` registry and `exitCodeTaxonomy()` and compares them against a
  golden set by exact equality, asserts neither side is vacuous, and is itself
  proven against deliberate violations: an empty golden map, a corrupted kind,
  a missing command, an undocumented collision and an out-of-band code.
- `glyph callers` and `glyph diff` gain the dotted kinds and the `principal`
  key; no consumer depends on the v0 shape, which is why this lands now.
- Glyph still produces only `usage` and `not_found`; `denied`, `conflict`,
  `validation`, `drift` and `indeterminate` are mapped and published so the
  first command that needs one uses the fleet vocabulary rather than inventing
  a second.
- Publishing the package, and any population of `principal` with a real value,
  remain outside this record. The latter requires an amendment to the shared
  contract first.
