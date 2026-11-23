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

## Amendment, 2026-11-18 (GCLI-34)

The Decision bullet above ("The full exit-code family is mapped") says the whole
0-7 family sits "in one frozen `EXIT_CODES` map". The family is whole and frozen, but the map is not
one: `EXIT_CODES` in `src/errors.ts` is the one `GlyphErrorType`-to-code map
and covers codes 2-7 only. `EXIT_OK` (0) and `EXIT_UNCAUGHT` (1) are separate
constants beside it, and `exitCodeTaxonomy()` in `src/contract.ts` combines the
three into the published `ok`, `uncaught` and error-type taxonomy. The decision
and the code values are unchanged; the body text above is left as written.

## Amendment, 2026-11-23 (GCLI-70)

The Python indexer record (ADR 0008) permits additive contract entries under one
language-per-run (its ruled items 4 and 5) and lists the ones it drafts
("Drafted by glyph-cli"). This amendment records the subset the language seam
ships, and the shape it takes so a TypeScript-only repository's answers stay
byte-identical.

**Merge-order note.** ADR 0008 is cited here by name but is absent from this
bundle at this SHA: it lives on `docs/GCLI-68-adr-0008-native-python` and merges
after this slice. This amendment therefore links no file whose absence would
break the docs check.

- **`--language <id>` is a global option**, declared in `GLOBAL_FLAGS` and so
  published by `glyph help --json` beside `--json` and `--repo`; its summary is
  derived from the live registry, not a second hand-written list. It selects one
  language for the run; detection selects one when it is absent.
- **Only `callers`, `impact` and `diff` accept `--language`.** They are the
  commands whose answer is read from the shared index; every other command —
  `code-map` included, whose tier-3 index is a byte-parity contract and does not
  expose the seam, and `help` and `cache`, which read no index — rejects it as a
  usage error (exit 2) rather than ignoring it. The frozen manifest has no slot
  for output fields, so `help --json` publishes the flag but **not** a
  machine-readable statement of which commands accept it; that is documented here
  and in the README. (Acceptance criterion 2 is checked against that split
  surface: `--language` is declared in `help --json`; `language` and
  `notIndexed` are declared in this amendment and the README, because the
  manifest has no slot for output fields.)
- **`language` in the `index` block**: the language whose indexer produced the
  answer, present only when the answer is not the plain TypeScript default.
- **`notIndexed` in the `index` block**: the recognised languages present in
  scope with no registered indexer, each as `{language, files}`. The human
  coverage line carries the same fact as a trailing
  `; language not indexed: <id> (<n> files)`. Both are carried by the
  working-tree and the `--ref` answers alike: the `--ref` path counts recognised
  non-TypeScript files at the ref's tree with the same listing and mode filter.
  The ref count sees tracked blobs of mode `100644`/`100755` only — no untracked
  files, symlinks or gitlinks — so it can differ from a working-tree count.
- **`not_found` answers name the language** where language selection produced
  them: an explicitly requested, registered language with no files is exit 3
  naming it. An explicitly requested language that is *not* registered is a
  usage error (exit 2) naming the registered languages. A repository whose only
  recognised language has no indexer is **not_found (exit 3)**, naming the
  language and its file count — never an empty success (the "never a silent empty
  answer" rule, DEC-303 item 2 restated as ADR 0008's ruled item 4). This is the
  same answer with and without `--ref`, and it stands until the S7 slice
  registers Python indexing.
- **`--ref` and `code-map` still build TypeScript only**, through
  `indexSnapshot`; a ref's recognised non-TypeScript files are counted for the
  coverage entries but are not indexed there. S7 owns wiring Python into both.
- **On a repository with no recognised non-TypeScript source** (only `.py` counts
  today), every one of these entries is ABSENT — not `null`, not a constant — so
  that answer is byte-for-byte what it was before this amendment. A golden
  captured from the pre-seam build (`test/language-goldens.ts`) holds it.
- The non-Git discovery walk's excluded directories are **unchanged from dev**
  (its nine), so a TypeScript file under `venv/`, `.venv/` or `.tox/` is still
  indexed exactly as before. Python counting alone skips a `.py` path under a
  `.venv`, `venv`, `__pycache__` or `.tox` segment, in the working-tree and
  `--ref` listings alike (by path segment, so a tracked file under one is not
  counted either), so a nested environment or cache does not inflate the
  recognised Python count.

The remaining drafted entries — a `decorator` site kind, an
unresolved-first-party-import count and a per-answer constructor note — are
left to the slices that produce them. Declaring a union member or field no code
emits would contradict how this contract treats an absent field (omit it, do not
declare a constant).
