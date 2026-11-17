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

Accepted — opum-doc DEC-216 (a10), 2026-11-17, which fixed the budget at 7.0 s and
chose the in-process design (option A) for the index build, building on the
measurement rule of DEC-216 (a4)(b). Implemented under GCLI-38, slice 3 of GCLI-12,
after ADR 0002's contract and the tier 3 slice (GCLI-37).

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

Caveats, in opum-doc's own words (DEC-216 (a10)): "n=10 so p95 is the nearest rank, the
task texts are synthetic, opum-desktop's HEAD moved during its cell, and the GCLI-40
quadratic adds about 0.2–0.4 s at 20,000 characters".

glyph-cli's explanation, not part of the ruling: with ten runs the p95 equals the maximum
in every cell; the synthetic text per repository was six exported names and one source
path; the GCLI-40 cost is the producer's extractors on one long unbroken token, small
against the budget. The worst p95 is quest-cli cold, 3.365 s.

## Decision

The budget is `budget = round-up(2 x the worst p95)` to the next 0.5 s, which is
2 x 3.365 = 6.73, so **7.0 s**, held as the single constant
`CODE_MAP_TIME_BUDGET_MS`. Changing it needs a new measurement and a new record,
never an edit alone; a test pins the value so an edit alone fails.

Past the budget, `code-map` stops gathering and returns what it has. The deadline is
checked between units of work: each named path, the branch diff, the symbol index
load, each identifier's grep, and each pointer's range reads. Every git read is capped
at the time left, and a read the budget cuts off is a stop, not an error. The result
carries one omission, source `code-map#time-budget`, whose reason starts
`time-budget:` and names the stage the budget was spent in, the elapsed time when
the run stopped, and how many pointers lack line ranges. A pointer emitted after the deadline skips the git reads that give
its ranges and says so in its reason (`line ranges not read (time-budget)`), because
an empty range list otherwise means the whole file. A run that spends its budget
before gathering anything returns no pointers and that one omission: it never
returns nothing silently.

An answer that finishes inside the budget is unchanged by it. A run that hits the
budget is the one case where the output depends on elapsed time, and the omission
says so.

## Consequences

- One gap is named. The cold index build is synchronous in-process and cannot be
  interrupted, so a repository far larger than the five measured can overrun the
  budget inside that one step. The overrun is never silent: the run stops at the next
  check, the answer built so far is returned, and the omission names `symbol index`
  and carries the elapsed time, which then exceeds the budget.
- Reopen condition for option B (a killable subprocess build): a real repository whose
  cold build alone exceeds the budget. Until one is shown, the in-process design stands.
- The budget bounds a single run, not a caller's total: a consumer that calls
  `code-map` repeatedly owns its own aggregate budget.
- The measurement is a snapshot. If the five repositories grow or the machine class
  changes, the number is re-measured and the constant and this ADR move together.
- The proof has three parts, each a test: a unit-boundary check stops after a slow
  fake unit and reports `time-budget` (P1); a forced slow index build overruns and is
  reported with its elapsed time (P2); a warm run on a real repository stays well
  under the budget (P3). A pin test holds the constant. The clock is injected and a
  slow-git shim is used, so none depends on machine speed except P3's wide margin.

## Addendum, 2026-11-17: warm runs on the five repositories, on the final build

DEC-216 (a10)'s proof clause is "Warm runs on the five repositories stay well under
budget". The table above was taken before the budget code existed, so the warm cells
were measured again, read-only, on the final build: Apple M4, macOS 27.0.1, glyph
a8c992a6768ee9bb76cd0c3e802a7ec209bcebd6, `glyph code-map --source-ref HEAD` after one
uncounted priming run, 10 timed runs per repository. The run aborts if any run carries a
`code-map#time-budget` omission; none did, on any of the 50 runs. Seconds, p50 / p95 / max:

| repository (HEAD) | warm |
|---|---|
| opum-cli (8b901ae) | 0.339 / 0.368 / 0.368 |
| lore-cli (f3398b05) | 0.349 / 0.359 / 0.359 |
| quest-cli (78492f2f) | 1.831 / 1.979 / 1.979 |
| glyph-cli (a8c992a) | 0.213 / 0.215 / 0.215 |
| opum-desktop (2d87cf8) | 0.257 / 0.261 / 0.261 |

The worst warm p95 is quest-cli at 1.979 s, 28% of the 7.0 s budget. The same caveats
apply: n=10, synthetic task texts, and opum-desktop's HEAD moved again since the first
measurement (it read 2d87cf8 for this one). The glyph-cli task text differs from the
first measurement because that repository's own symbols changed.
