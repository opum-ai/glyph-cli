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

None known. This repository carried no code at onboarding, so there is nothing
here that detects or sweeps leftover Treehouse or Codex state. Re-check when code
lands rather than assuming this stays true.

### What other repositories read from here

**`opum-harness` consumes Glyph as a verification oracle**: symbols, call graph
and blast radius, per the component table in opum-doc's
`docs/specs/opum-harness-architecture-and-delivery-plan.md`. Its context compiler
pins "blast radius from Glyph" alongside standards from Lore and the task from
Quest, and its sequencing holds Glyph "at an inert seam until the plan-compliance
monitor demonstrably needs it", with Glyph's first implementation in phase 4 of
that plan. Nothing blocks on Glyph existing — the harness's v0 port is a no-op
(opum-doc ADR, "Admit Glyph as the third Opum product primitive", Consequences).

That spec is the concrete contract; there is no code here yet for a deleter to
find. Name the implementing files in this section once they exist.

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

**The gated ref and its required checks are not yet configured.** At onboarding
on 2026-09-29 this repository had no commits, no remote and no rulesets, so there
is nothing here to report yet. Record the measurement here — the ruleset id, the
ref it gates, the required contexts and the bypass actors — once CI has reported
green on the gated ref and the ruleset is added, the way the rest of the fleet
records it. Re-measure with
`gh api repos/opum-ai/glyph-cli/rules/branches/<ref>` rather than trusting a
remembered summary.
<!-- opum:repo-profile:end -->
