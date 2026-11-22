---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Stream the long answers as NDJSON
tags:
  - streaming
  - command-contract
summary: callers, impact and code-map accept --stream, an opt-in NDJSON variant of --json declared per command, with item lines then one result line and a mid-stream failure leaving no result.
decisions:
  - opum-doc:DEC-299
generated:
  by: lore/0.14.1
  at: 2026-11-22T21:57:34.449Z
---

# Stream the long answers as NDJSON

## Status

Accepted — opum-doc DEC-299 (2026-11-22), the amendment that adds section 1a,
"Stream mode", to the frozen Opum command contract and names `glyph-cli` its
first implementer; the operator's decision label is verbatim **"Streaming in
0.1.0"**. Implemented under GCLI-45 (Slice S) for `callers`, `impact` and
`code-map`. `diff` is deliberately out of scope, and this slice is independent
of Slice P (packaging, GCLI-46). The stream design below is what GCLI-45
implemented; the design authority is DEC-299, not this record.

## Context

The contract's section 1a makes `--stream` an opt-in framing of `--json` for a
command whose answer is a long list, so a consumer can act on early items
before the whole answer exists. Glyph has exactly three such answers — a
symbol's call sites, a symbol's transitive callers, and a task's code pointers —
and the amendment is additive: every invocation without `--stream` is
byte-for-byte unchanged, so no existing consumer is affected.

Glyph has two output modes, human text and `--json`; it does not implement
`--plain`. The contract names `--plain` as a mode, so the §1a rule that
`--stream` and `--plain` are exclusive is enforced even though `--plain` alone
is not a Glyph flag: the combination is a usage error either way.

## Decision

**Declared per command, from the live registry.** The `stream` flag is a
`FlagSpec` on `callers`, `impact` and `code-map` in `COMMANDS`
(`src/contract.ts`), so `glyph help --json` publishes it and `STREAMING_COMMANDS`
is derived from the same entries rather than listed a second time. Passing
`--stream` to any other command — `diff` included, and the global help/version
shortcuts — is a usage error (exit 2), never ignored.

**Framing resolved once.** `--stream` implies `--json`; `--stream --plain` is a
usage error (exit 2). `scanArgv` resolves both in one place, so the success path
and the failure path speak the same framing, exactly as `--json` already does.

**The wire.** stdout carries one compact success envelope per line, each
terminated by `\n`, no blank lines, with `principal` last by construction
(`successEnvelope`). Item lines carry `<command>.item`, and each one's `data` is
one element of the list the batch answer returns. Exactly one
`<command>.result` line ends the stream; its `data` is the batch `data` with the
item list replaced by `itemCount`, so items are never sent twice. For
`code-map` the result line also carries `truncated` (whether ADR 0005's
wall-time budget stopped the run) beside the batch `omissions`, which stay.
Item kinds are derived as `<command>.item` and are additive to the kind
registry.

**Completeness and failure.** Exit 0 happens only after the result line is
written. A failure mid-stream stops stdout at the throw; `run()`'s single
handler writes the section 5 error envelope to stderr and returns the mapped
exit code. `src/stream.ts` carries two test-only environment seams, read only
when a stream writer is created: `GLYPH_TEST_STREAM_FAIL_AFTER` throws a
classified `indeterminate` failure after N item lines (proving the failure
clause for each command), and `GLYPH_TEST_STREAM_PAUSE_AFTER_MS` holds the
process open after the first item (proving the per-line flush by reading the
pipe while the child is provably alive).

**Same answer, order may differ.** For the same inputs the multiset of item
`data` values equals the batch answer's list, and the result line agrees with
it on every non-item field. Order is not promised, because items are emitted as
found. The batch form stays canonical for order.

**What each algorithm can actually stream, named honestly.**

- `callers` emits each matching call site as the site scan visits it
  (`callerSites` in `src/queries.ts`), accumulating the file set and count for
  the result line. This is genuine incremental emission over the scan.
- `code-map` emits each pointer through an `onPointer` seam as the pointer loop
  chooses it — after the candidate ranking, while the per-pointer range reads
  are still running — then writes the result line once the run finalizes and
  the closing omissions are known. This is incremental over the expensive
  per-pointer phase, not over the ranking.
- `impact` cannot emit as found. A caller's `cycle` flag is decided by strongly
  connected components over the discovered closure after the breadth-first
  search completes, and every item must be a complete element of the batch
  answer. Its items are therefore written once the walk finalizes. The stream
  still ends in bounded time, but it does not shorten time-to-first-item for
  `impact`, and this record says so rather than faking incrementality.

**Non-stream output is unchanged.** The batch code paths are untouched; a
golden capture taken from the pre-stream commit for all three commands on a
fixed fixture is compared byte-for-byte by the test suite.

## Consequences

- The kind set grows by three `<command>.item` values. They are dotted
  `command.payload` names and additive, so a consumer that tolerates unknown
  kinds is unaffected.
- `glyph help --json` gains a `stream` flag on three commands and no global
  flag; a command's declared flags remain the one place "does this command
  stream?" is answered.
- `code-map`'s stream result line carries a `truncated` boolean that its batch
  answer does not. That is the §1a allowance for truncation fields, and ADR
  0005's budget remains the bound; the batch `{pointers, omissions}` shape is
  unchanged.
- Every stream still performs the index build (or the code-map ref read) before
  its first item, so a cold cache sees the same time-to-first-item as the batch
  form. Streaming changes when the answer's items become readable, not when the
  index becomes available.
- The flush guarantee rests on one `process.stdout.write` per line; the proof
  reads a pipe incrementally while a test-only seam holds the child open.
- Two test-only environment variables now exist in `src/stream.ts`. They are
  read only when a stream writer is created, so they cannot affect a
  non-streaming invocation, and the tests are the only callers.
