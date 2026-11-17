---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Adopt the Opum command contract
tags:
  - cli-contract
  - conformance
summary: "Glyph conforms to the frozen Opum command contract: principal on both envelopes, the shared error shape, a dotted kind registry published by glyph help --json, and the full exit-code family."
generated:
  by: lore/0.13.0
  at: 2026-10-20T23:21:03.152Z
---

# Adopt the Opum command contract

## Status

Accepted — opum-doc DEC-216 (2026-10-20, accepted) directs Glyph to conform to
the frozen contract now, before any consumer depends on its output, and records
the decision in the same change that corrects the stale sentence in
`opum-doc`'s `docs/standards/cli-contract.md`. Implemented under GCLI-9, slice 1
of the four DEC-216 slices.

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
  "uncaught"` and exit 1, never a classified type, and one mapper
  (`exitCodeFor`) decides every code.
- **Kinds are dotted `command.payload`** (`callers.result`, `diff.result`,
  `cache.path`, `cache.clear`, `help.manifest`) plus the global result kinds
  `version.info` and `help.usage`. The live `COMMANDS` and `GLOBAL_FLAGS`
  registries in `src/contract.ts` are the only source: every handler takes its
  kind from them by lookup, and `glyph help --json` publishes them as
  `help.manifest`, built from the registry rather than hand-listed beside it.
- **Help and version are result-bearing under `--json`.** Their kinds are
  dotted per the frozen contract's §4 rule 1, and opum-doc ruled A on
  2026-10-20: Glyph keeps `version.info` and `help.usage` rather than
  mirroring lore's undotted `version`/`help`, because consumers tolerate
  unknown kinds. Help with a topic, or `--help` after a command, narrows the
  manifest to that command. No successful `--json` invocation prints plain
  text.
- **The full exit-code family is mapped**: 0 ok, 1 uncaught, 2 usage,
  3 not_found, 4 denied, 5 conflict, 6 validation/drift, 7 indeterminate, in
  one frozen `EXIT_CODES` map. A failed `git diff` over already-resolved refs
  and a Git repository Git refuses to describe are `indeterminate` (7), not
  usage.

What this record deliberately does not decide: how a principal is
*established* or *enforced*, and `PrincipalRef`'s concrete shape. The contract
reserves the slot and defers the mechanism; Glyph does not populate it.

The same slice replaces the fixed directory list in source discovery with
Git's own file selection. In a repository that is exactly `git ls-files`
(tracked files plus untracked files Git does not ignore), so `.gitignore`,
nested ignore files and negation patterns are honoured. A directory outside Git
keeps a filesystem walk; Git refusing a repository it can see is indeterminate
rather than a silent walk.

## Consequences

- The local obligation the contract's Adoption section requires is recorded
  here: Glyph's result envelope, exit codes, `kind` registry and diagnostics
  conform to the frozen pattern, including the reserved `principal` field.
- The conformance test is `test/contract.test.ts`. It enumerates the live
  `COMMANDS`/`GLOBAL_FLAGS` registries and `exitCodeTaxonomy()` and compares
  them against a golden set by exact equality, asserts neither side is vacuous,
  and is itself proven against deliberate violations on both sides: an empty
  golden map, a corrupted golden kind, a corrupted live kind, a malformed live
  kind, a mutated dotted-kind check, a missing command, an undocumented
  collision and an out-of-band code. A program-walk test asserts every
  commander command has a registry entry (and every entry a command), and an
  end-to-end test asserts every invocation's emitted kind equals its registry
  entry.
- `glyph callers` and `glyph diff` gain the dotted kinds and the `principal`
  key; no consumer depends on the v0 shape, which is why this lands now.
- **Discovery changes what can enter the index.** A tracked `dist/`, `vendor/`
  or `build/`, or an unignored `node_modules/`, is now indexed because Git
  reports it; the old fixed directory list hid it. `callers` and `diff` answers
  therefore change in exactly those repositories, and this is the decided
  behavior rather than an unstated regression. Submodules and nested
  repositories are not traversed, because `git ls-files` does not descend into
  them; symlinks that resolve to files are followed.
- Glyph produces `usage`, `not_found` and `uncaught` from its commands, and
  `indeterminate` when Git refuses; `denied`, `conflict`, `validation` and
  `drift` are mapped and published so the first command that needs one uses the
  fleet vocabulary rather than inventing a second.
- Publishing the package, and any population of `principal` with a real value,
  remain outside this record. The latter requires an amendment to the shared
  contract first.
