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
command whose answer is a long list, so a consumer can act on early items as
they are produced. Glyph has exactly three such answers — a symbol's call
sites, a symbol's transitive callers, and a task's code pointers — and the
amendment is additive: a command's non-stream query output is byte-for-byte
unchanged. `glyph help --json` and each streaming command's `--help` text do
change, because the flag is declared there; that is the point of declaring it.

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
`code-map` the result line also carries `truncated` beside the batch
`omissions`, which stay. `truncated` is true only when ADR 0005's **wall-time
budget** stopped the run: a cut by the file cap, the token cap, a read bound or
symbol displacement is named in `omissions` and leaves it false. That is the
narrow reading section 1a's code-map clause and DEC-299 use, and the field keeps
that name rather than claiming general completeness. Item kinds are derived as
`<command>.item`, and `glyph help --json` publishes each streaming command's
`itemKind` beside its result `kind`.

**Completeness and failure.** Exit 0 happens only after the command issued the
result line to stdout. A consumer treats a stream with no result line, or a
non-zero exit, as incomplete, whatever items arrived — including when the
consumer itself stops reading early (`… --stream | head -1`), where the producer
can legitimately exit 0 after issuing the answer and the consumer naturally
never sees the result line. A failure mid-stream stops stdout at the throw;
`run()`'s single handler writes the section 5 error envelope to stderr and
returns the mapped exit code. The fault-injection and pause hooks are installed
only by `test/support/stream-entry.ts`, a test entry point that reads the
environment and then calls `run()`. The shipped `src/cli.ts` installs no hook, so
no environment variable in a consumer shell can make a production run pause,
overspend the code-map budget, or fail.

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

**Non-stream query output is unchanged.** The batch code paths are untouched;
the test suite compares all three commands on a fixed fixture against a golden
captured from the pre-stream commit `a0aecda` with `test/goldens/gen-goldens.ts`.
Regenerating that file from `a0aecda` reproduces the committed goldens with an
empty diff. The one deliberate exception above is help text, which gains the
declared flag.

## Consequences

- The kind set grows by three `<command>.item` values. They are dotted
  `command.payload` names and additive, so a consumer that tolerates unknown
  kinds is unaffected. `glyph help --json` publishes each one as `itemKind` on
  its command; `allResultKinds()` stays the result-kind set, because an item
  kind is emitted inside a stream rather than as a command's result.
- `glyph help --json` gains a `stream` flag and an `itemKind` on the three
  streaming commands, and no global flag; a command's declared flags remain the
  one place "does this command stream?" is answered.
- `code-map`'s stream result line carries a `truncated` boolean that its batch
  answer does not. It means only "ADR 0005's wall-time budget stopped the run";
  file-cap, token-cap, read-bound and displacement cuts stay in `omissions` and
  do not set it. The batch `{pointers, omissions}` shape is unchanged.
- Every stream still performs the index build (or the code-map ref read) before
  its first item, so a cold cache sees the same time-to-first-item as the batch
  form. Streaming changes when the answer's items become readable, not when the
  index becomes available.
- The flush guarantee rests on one `process.stdout.write` per line; the proof
  reads a pipe incrementally while the test entry holds the child open.
- The fault-injection and pause hooks live behind `setStreamFaultHook` in
  `src/stream.ts` and `setCodeMapTimeBudgetForTests` in `src/codemap.ts`. They
  are module-level setters with no environment read and no default behavior;
  only `test/support/stream-entry.ts` installs them, so the shipped CLI is
  unaffected even if the environment variables are present.
