---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Bound the code map by a wall-time budget
tags:
  - code-map
  - time-budget
summary: glyph code-map stops at a fixed wall-time budget and returns what it has, naming the stage and a time-budget omission; the number is measured, not guessed.
generated:
  by: lore/0.14.1
  at: 2026-11-17T17:11:42.014Z
---

# Bound the code map by a wall-time budget

## Status

Proposed. It cites opum-doc DEC-216 (a4)(b), which requires a measured budget that
opum-doc then fixes in the GCLI-12 record. The number below, 7.0 s, is glyph-cli's
**proposal** from that measurement; this ADR is accepted, and the constant
`CODE_MAP_TIME_BUDGET_MS` confirmed or changed, when opum-doc's fixed number is
recorded here. Implemented under GCLI-38, slice 3 of GCLI-12, after ADR 0002's
contract and the tier 3 slice (GCLI-37).

## Context

`glyph code-map` is called inside another tool's context compile, so it must answer
in bounded time. Its cost is dominated by the ref index's cold build (a TypeScript
program over the commit's tree), the `git grep` reads, and per-pointer range reads.
DEC-216 (a4)(b) ruled: measure first, then fix the budget, rather than guess one.

Measured 2026-11-17 on an Apple M4 (macOS 27.0.1) at glyph d97958f, running
`glyph code-map --source-ref HEAD` read-only against five checkouts, 10 runs per
cell, cold (empty cache per run) and warm (one primed cache). Seconds, p50 / p95 / max:

| repository | cold | warm |
|---|---|---|
| opum-cli | 1.429 / 1.636 / 1.636 | 0.357 / 0.382 / 0.382 |
| lore-cli | 2.085 / 2.439 / 2.439 | 0.390 / 0.563 / 0.563 |
| quest-cli | 2.914 / 3.365 / 3.365 | 1.889 / 2.041 / 2.041 |
| glyph-cli | 0.485 / 0.531 / 0.531 | 0.231 / 0.252 / 0.252 |
| opum-desktop | 0.919 / 1.273 / 1.273 | 0.273 / 0.357 / 0.357 |

With ten runs the p95 is the nearest rank and equals the maximum. The task text per
repository was synthetic (six exported names and one source path). The worst p95 is
quest-cli cold, 3.365 s. The producer's extractors are quadratic in one long unbroken
token (GCLI-40): about 0.2 to 0.4 s at the 20,000-unit task-text cap, small against the
budget.

## Decision

The budget is `budget = round-up(2 x the worst p95)` to the next 0.5 s, which is
2 x 3.365 = 6.73, so **7.0 s** (proposed), held as the single constant
`CODE_MAP_TIME_BUDGET_MS`.

Past the budget, `code-map` stops gathering and returns what it has. The deadline is
checked between units of work: each named path, the branch diff, the symbol index
load, each identifier's grep, and each pointer's range reads. Every git read is capped
at the time left, and a read the budget cuts off is a stop, not an error. The result
carries one omission, source `code-map#time-budget`, whose reason starts
`time-budget:` and names the stage the budget was spent in and how many pointers
lack line ranges. A pointer emitted after the deadline skips the git reads that give
its ranges and says so in its reason (`line ranges not read (time-budget)`), because
an empty range list otherwise means the whole file. A run that spends its budget
before gathering anything returns no pointers and that one omission: it never
returns nothing silently.

An answer that finishes inside the budget is unchanged by it. A run that hits the
budget is the one case where the output depends on elapsed time, and the omission
says so.

## Consequences

- One gap remains. The cold index build is synchronous in-process and cannot be
  interrupted, so a repository far larger than the five measured can overrun the
  budget inside that one step; the run then stops at the next check and the omission
  names `symbol index`. Bounding the build itself would need a subprocess or worker,
  which is not built here.
- The budget bounds a single run, not a caller's total: a consumer that calls
  `code-map` repeatedly owns its own aggregate budget.
- The measurement is a snapshot. If the five repositories grow or the machine class
  changes, the number is re-measured and the constant and this ADR move together.
- The tests inject the clock and use a slow-git shim, so none depends on machine speed.
