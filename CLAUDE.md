<!-- quest:agent-instructions:begin -->
# Quest agent instructions

This project uses Quest CLI 0.11.0 for tracker operations. Run `quest manifest --json` to discover the supported command contract.

Read the matching guide before tracker work: `quest instructions overview` for the command set and machine contract, `quest instructions task-creation` before creating or splitting tasks, `quest instructions task-execution` before claiming, planning, or recording progress, `quest instructions task-finalization` before checking acceptance criteria or closing a task, and `quest instructions workspace` for initialization, managed instructions, and Backlog.md migration. `quest instructions --list` lists every guide. Search for an existing record with `quest search "<query>" --json` before creating one, and run `quest help <command>` for a command's options and examples.

Quest writes require an explicit actor declaration: `--actor <id> --actor-kind human` for a person, or `--actor <id> --actor-kind delegated-agent --accountable-human <id>` for an agent acting on a person's behalf. Do not edit Quest-authored records directly. CI should run `quest agents --check --require-installed --target claude`: current instructions, and a version-only difference (only the pinned Quest CLI version number is stale) both exit 0; missing, drifted, or malformed managed instructions exit 6. Quest does not retry write conflicts automatically; callers should read the latest task state and perform their own bounded retry when a command returns conflict/exit 5.
<!-- quest:agent-instructions:end -->

<!-- lore:agents:begin -->
This repo uses **lore** — an OKF-native documentation CLI — for the docs bundle under `docs/`.
Drive docs work through `lore` (not a plain editor or `grep`) so Story <-> Task coupling, managed
blocks, and cross-links stay coherent.

- **Find and read docs:** `lore query "<words>" --limit 5`, then `lore read <id>` for the best hit.
- **Skill:** installed from the `opum-lore` Claude Code plugin, not this repository — how to drive lore.
- **Just-in-time detail:** run `lore instructions` for the canonical agent loop, then
  `lore instructions <topic>` (`retrieval`, `linking`, `sync`, `check`, `validation`, `types`, `workspace`, `agents`).
<!-- lore:agents:end -->

## What this repository is

Glyph (`glyph`): Opum's software-intelligence CLI — the primitive that answers
*how does the system work?* about source code within and across repositories.
Admitted as the third peer product primitive alongside Lore and Quest by
opum-doc's ADR "Admit Glyph as the third Opum product primitive" (2026-08-09),
which sets the family convention this repository follows: repository
`opum-ai/glyph-cli`, package `@opum-ai/glyph`, binary `glyph`, domain
`glyphgraph.dev`, with `glyph-doc` and `glyph-web` siblings to follow.

Glyph's scope, implementation language and first task were still open operator
design questions when this repository was onboarded on 2026-09-29. Nothing in
this file decides them, and neither should a session working here.

@~/.claude/opum-fleet-operating.md

<!-- opum:repo-profile:begin -->
## glyph-cli — repository profile

Facts true of this repository only. The operating model above is byte-identical
fleet-wide; this block is where repositories legitimately differ. Keep these
headings, in this order, and write "None known." rather than deleting one that
has no entries yet.

### Role

Owns the Glyph CLI and the design record its implementation answers to. Adopted
into the fleet on 2026-09-29 under opum-agent OPAG-835, on the operator's
instruction relayed through opum-doc (seq 50). Tracker prefix `GCLI`.

**Private until first release** — the operator's choice at onboarding, recorded
verbatim in OPAG-835. Flipping to public is a separate tier-3 step at release and
goes to the operator, never to a relay.

The repository was net-new at admission: the ADR's own words are "no source,
package, or domain exists yet. Admitting it creates delivery obligation, not
delivered capability." Scope, language and first task are the operator's design
questions, routed through the orchestrator to opum-doc rather than settled here.

### Retirement machinery carried here

None known — re-checked when code landed (GCLI-2, 2026-09-30). The v0 sources
(`src/`, `test/`, `.github/workflows/`, `README.md`, `package.json`) carry no
Treehouse, Codex or OpenCode detection or sweeping; the sweep and its positive
control are recorded on GCLI-2. Re-check when new machinery lands rather than
assuming this stays true.

### What other repositories read from here

**`opum-harness` consumes Glyph as a verification oracle**: symbols, call graph
and blast radius, per the component table in opum-doc's
`docs/specs/opum-harness-architecture-and-delivery-plan.md`. Its context compiler
pins "blast radius from Glyph" alongside standards from Lore and the task from
Quest, and its sequencing holds Glyph "at an inert seam until the plan-compliance
monitor demonstrably needs it", with Glyph's first implementation in phase 4 of
that plan. Nothing blocks on Glyph existing — the harness's v0 port is a no-op
(opum-doc ADR, "Admit Glyph as the third Opum product primitive", Consequences).

That spec is the concrete contract. The implementing files, named for whoever
deletes or reads them (landed with glyph v0, GCLI-2):

- **Symbols and the call graph**: `src/indexer.ts` builds both from one
  TypeScript program, resolving each call site to its declaration through the
  type checker; `src/types.ts` is the index's shape.
- **The two query answers**: `src/queries.ts` — `callersOf` (what calls this
  symbol) and `touchedSymbols` (which symbols a diff touches, innermost only).
- **Source discovery, refs and diff ranges**: `src/discover.ts` picks the files
  in scope and the compiler options; `src/git.ts` resolves the refs and parses
  changed line ranges.
- **The command surface and machine contract**: `src/cli.ts` on commander, with
  error types and exit codes in `src/errors.ts` — stdout carries one success
  envelope, stderr the failure, exit 0/1/2/3.
- **The local cache**: `src/cache.ts`, under `$GLYPH_CACHE_DIR`, else
  `$XDG_CACHE_HOME/glyph`, else `~/.cache/glyph`; disposable by design.

The machine contract in `src/cli.ts` is the surface a consumer can pin; there is
no published package yet (private until first release), so nothing here is a
stable import.

### Constraints and couplings to respect

**Boundaries fixed by the ADR, not open to local redesign.** Glyph answers
impact-and-paths questions *about source code within and across repositories*;
Atlas — an unpromoted capability word — answers them *across products and
portfolios*, over records Lore and Quest already own. Glyph does not absorb
Atlas. Nor does Glyph become a general-purpose knowledge base: where a code fact
carries organizational rationale, the rationale is a Lore concept that links to
the Glyph entity, and the entity is not copied into Lore.

**Cross-product integration runs Lore → Glyph → Quest → Lore.** Glyph is the
middle leg, so a change here can break a loop that no check in this repository
covers.

**Documentation authority is split.** `glyph-doc` owns Glyph-wide strategy;
`glyph-cli` owns its component implementation, mirroring the Lore and Quest
split. A document that spans Glyph or another product belongs in `glyph-doc`, not
in this repository's bundle.

**The gated ref is `dev`.** Measured live on 2026-09-29 with
`gh api repos/opum-ai/glyph-cli/rules/branches/dev`: ruleset 24218126, "require
CI on dev", active, targeting `refs/heads/dev`, 0 bypass actors, requiring
`Docs` and `Tracker integrity`, each pinned to integration 15368 (GitHub
Actions), strict policy off. `main` has no rules and returns `[]`: it is
protected by the operating model's fast-forward invariant rather than by a rule,
the same shape ward-cli uses. Which ref carries the rule differs per
repository — quest-cli gates both — so check yours rather than repeating a
fleet-wide summary. A required check can only pass on a SHA that has already
been through CI, so nothing can be pushed straight to `dev`, a tracker-only
change included: every change lands through a pull request. Re-measure rather
than trust this paragraph. Renaming or removing a CI job means updating the
ruleset in the same change, or every merge blocks on a check that never reports.

CI is `.github/workflows/ci.yml` (GCLI-1; the `Check` job landed with glyph v0
under GCLI-2), three jobs on `[self-hosted, Linux, ARM64]`. The org and
repository runner listings report 0
runners, yet jobs are picked up within seconds by the `mbpm2` group's ephemeral
`linux-arm64-*` runners — measured 2026-09-29, run 36640462475, runners
`linux-arm64-dccd7-runner-6ftkf` and `-9mjpx`. A listing is not evidence either
way; an actual job's `runner_name` is. Lore is pinned in the workflow;
the Quest version is read out of this file's own managed block rather than
pinned a second time. `Check` runs the package's own toolchain — Bun resolved
from `.bun-version` via a pinned `oven-sh/setup-bun`, then typecheck, lint,
format:check and test, one step each so a red names which assertion failed. It is
not yet a required context on `dev`: the ruleset requires `Docs` and `Tracker
integrity` only, so a red `Check` is visible but not blocking until the ruleset
changes. A conflicted pull request receives no `pull_request` workflow runs at
all: pushes and reopens on a CONFLICTING PR produce no CI, and runs resume once
a push resolves the merge (measured 2026-09-30 on opum-ai/glyph-cli#16, where
several pushes first read as dropped events).

**Read `dev` back after every promotion, not only `main`.** On 2026-09-29, during
this repository's first promotion to `main`, `refs/heads/dev` disappeared from
the remote and had to be recreated at the promoted SHA. It recurred on the second
promotion, 2026-09-30 at `4da4a2b`: `refs/heads/dev` was deleted one second after
the promotion pull request auto-marked MERGED, and was again recreated at the
promoted SHA. The pull-request timelines carry both occurrences and their
recovery — `head_ref_deleted` at 23:51:15Z on opum-ai/glyph-cli#5 and 00:12:33Z
on opum-ai/glyph-cli#11, each followed by `head_ref_restored` — and that is where
to look; the repository events feed showed the 2026-09-30 deletion as a
`DeleteEvent` for ref `dev` but not the first one, and it drops other branch
deletions, so it is not a complete record. The cause, measured 2026-09-30: this was the only one of the twelve fleet
repositories whose default branch was `main` — the other eleven default to `dev`
— and the auto-delete (`delete_branch_on_merge` is on fleet-wide) does not touch
the default branch, so only here was the promotion pull request's head `dev`
deletable. Five promotion pull requests across lore-cli, ward-cli and opum-agent
carry no `head_ref_deleted` while this repository's two both do, and those
repositories' `dev` rules are the same shape as these (required checks only). The
evidence is that comparison, not a documented carve-out: the GitHub docs page on
automatic deletion names protection rules as the blocker and does not state a
default-branch exception. On opum-agent's ruling the fix is to make `dev` the
default branch, matching the fleet; executing it from this repository's session
was declined by its permission layer, which requires the operator's own
authorization for a change of that kind. The decision is tracked as opum-doc
DEC-70 (opum-agent outbound seq 79, 2026-09-30) and was executed by the operator
on 2026-09-30: re-measured here, the default branch now reads `dev` with
`delete_branch_on_merge` still true. The first promotion under it read
`refs/heads/dev` back clean: dev went to main at `4069c19` (PR
opum-ai/glyph-cli#17, landed with `git push origin origin/dev:main`), and both
refs read at the same SHA afterwards by `git ls-remote` and the branches API,
with no recreate — OPAG-844's closing evidence. The check below stays the
standing procedure on every promotion. A promotion is the only thing that can reproduce it,
so a check is what catches it: after `git push origin origin/dev:main`, confirm
`refs/heads/dev` still exists and still points at the promoted SHA, and report it
immediately if it is gone; recreating it at the promoted SHA is the recovery both
times. Re-measure this paragraph with
`gh api repos/opum-ai/glyph-cli/branches` rather than trusting it.
<!-- opum:repo-profile:end -->
