---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Ship one Node bundle with TypeScript, Commander and the tree-sitter wasm external
tags:
  - packaging
  - release
  - node
summary: glyph ships one bundled dist/glyph.js for Node >=24 with typescript, commander and the tree-sitter wasm external as runtime dependencies.
generated:
  by: lore/0.14.1
  at: 2026-11-22T22:10:28.000Z
---

# Ship one Node bundle with TypeScript, Commander and the tree-sitter wasm external

## Status

Accepted — opum-doc DEC-299 items 2 and 3 and DEC-299 (a1): glyph 0.1.0 targets
Node >= 24 like lore and quest (one bundled `dist/glyph.js` with a Node
shebang), and external TypeScript is accepted only on (a1)'s condition — the
packed tarball, installed into a clean directory, runs every command under node
with TypeScript's library resolution working. Implemented under GCLI-46. This
slice keeps `private: true` and version `0.0.0`; the release change that flips
them is separate.

## Context

Glyph is developed and tested on Bun, first for its TypeScript loader and then
because the fleet's other CLIs use it. Its consumers do not: the family
convention set by lore-cli and quest-cli is a package installed from npm and run
with `node`, and DEC-299 item 2 targets Node >= 24 for glyph for the same
reason. A source-only package that expects Bun would not run for a consumer who
has only Node, and `Bun.spawnSync` — used by the git reader and the code map —
does not exist there.

## Decision

- One build artifact: `dist/glyph.js`, bundled from `src/cli.ts` with
  `bun build --target node`, its first line rewritten to `#!/usr/bin/env node`
  and made executable. `package.json` exposes it as `bin.glyph`, ships
  `files: ["dist", "README.md", "LICENSE"]`, and targets `engines.node >= 24`.
  Development and tests stay on Bun.
- `typescript`, `commander` and `@vscode/tree-sitter-wasm` (the third external,
  added with the Python indexer, ADR 0008 and DEC-303) are marked `--external`
  and remain runtime `dependencies`, installed with the package. Everything else
  is bundled.
- `prepack` runs the build, so `npm pack` cannot produce a tarball without the
  bundle.
- The shipped source has no `Bun.*` global: `src/git.ts` and `src/codemap.ts`
  spawn git through one helper (`src/spawn.ts`) over
  `node:child_process.spawnSync`, preserving stdout bytes, exit codes, stdin,
  the timeout, and the max-buffer limit, and rethrowing spawn failures (ENOENT,
  EACCES, E2BIG, EMFILE and any other exec-level error) while reporting a
  timeout or buffer overflow as a result for the caller to classify.

## Why the externals

`typescript` is external for the library-path reason below. `commander` is a
simplification. `@vscode/tree-sitter-wasm` is external because the Python parser
resolves its `.wasm` grammar files from the installed package at run time, so
the wasm must be resolvable from the INSTALLED tarball's dependency tree, not
from the building checkout. The packaging gate imports it as a bare specifier and
runs `--language python callers pygreet` from the installed tarball under node
(measured 2026-11-25, GCLI-83: exit 0 with a JSON envelope).

`src/snapshot.ts` serves the running TypeScript package's own library directory
from disk (`ts.getDefaultLibFilePath({})`), and `src/indexer.ts` builds every
program with `ts.createProgram`, whose default host resolves `lib.*.d.ts` from
that same package location. Bundling `typescript` moves that location into
`dist/glyph.js`'s directory, where no library exists: the compiler loses its
built-in types, and the `--ref` snapshot host serves no library at all.

Measured 2026-11-22 under node 24.22.2, built with Bun 1.4.2 (the
`.bun-version` pin). The probe compiles a small source that uses `Array`,
`Promise` and `.map`, and reports `ts.getDefaultLibFilePath({})`, whether that
file exists, the `lib.*.d.ts` files loaded, and `getPreEmitDiagnostics`:

| build | `lib.d.ts` path present | lib files | diagnostics |
|---|---|---|---|
| all inlined, on the build machine | yes | 86 | 0 |
| all inlined, build-time path absent (consumer shape) | no | 0 | 12 |
| TypeScript external, installed as a dependency | yes | 86 | 0 |

The all-inlined bundle carries the building checkout's absolute path into the
output (`var __dirname = "<build checkout>/node_modules/typescript/lib"`). That
makes it green on the machine that built it and broken where the package is
installed, because the path does not exist there. On a small fixture the call
graph still answered identically in both shapes — local symbols do not need lib
types — which is exactly the false green a build-machine test would report; the
lib probe is what distinguishes them. The packed-tarball gate
(`scripts/check-package.mjs`) installs the tarball into an empty directory and
runs every command under node, so it measures the consumer shape for the chosen
route.

Keeping `commander` external is a deliberate simplification rather than a
necessity: it is small and bundleable, but leaving both runtime dependencies
external keeps the bundle's imports exactly what the source imports and keeps
the dependency classification unchanged.

## Consequences

- The published tarball requires `typescript`, `commander` and
  `@vscode/tree-sitter-wasm` from the registry; `npm install` supplies them.
  Footprint, packed 2026-11-25 (GCLI-83, 0.1.0 tree at the S8 gate head
  5aeead3): the tarball is 68,793 bytes holding `dist/glyph.js` (242,670
  bytes), `README.md`, `LICENSE` and `package.json`; the wasm is not in the
  tarball.
- (a1)'s condition is enforced, not assumed. `scripts/check-package.mjs` packs
  the tarball, installs it into a clean directory with `--ignore-scripts`, and
  copies `scripts/lib-probe.mjs` into that install so the probe's
  `import "typescript"` resolves to the INSTALLED dependency. The probe requires
  the default lib file to exist, a non-zero count of `lib.*.d.ts` files, and zero
  `getPreEmitDiagnostics`; the gate also runs every manifest command under node,
  including `impact --ref` (the git cat-file/stdin path). It rejects an installed
  `dist/glyph.js` containing a baked absolute `__dirname`/`__filename`, the
  signature of an inlined dependency, and requires the installed bundle to
  import `typescript`, `commander` and `@vscode/tree-sitter-wasm` as BARE SPECIFIERS (`from "x"` or
  `require("x")`), which catches inlining regardless of how the bundler spells
  its shim. Measured 2026-11-22: dropping `--external typescript` fails the
  typescript bare-specifier check; dropping `--external commander` fails the
  commander one (commander bundles with no baked path at all).
- Both release-workflow jobs run on GitHub-hosted `ubuntu-24.04`: the Package
  job builds the tarball, runs `scripts/check-package.mjs` on it, and records
  its name and sha256 as job outputs; the Publish job refuses to publish unless
  the single tarball it downloads hashes to that recorded digest. The bytes npm
  receives are bound to the gate's verification by that digest, not by a sums
  file carried in the same artifact (such a file proves only transfer
  integrity). npm provenance attests the PUBLISH step and the published bytes,
  not the build; ci.yml's jobs stay on the existing
  `[self-hosted, Linux, ARM64]` group.
- `test/spawn.test.ts` runs under Bun's `node:child_process`; the Node
  implementation is checked by `scripts/node-spawn-check.mjs`, which the
  packaging gate runs with the `node` binary (timeout, maxBuffer — including the
  SIGTERM Node sends on overflow — and E2BIG). The Check job re-runs the spawn
  suite with `--rerun-each 20`: the one flaky run that slipped through was a
  single-write timing race (measured 1 completion in 100 local iterations), so a
  single pass does not reliably catch it, while the write-until-killed child in
  the current test is deterministic (50 reruns, 400/400 green locally, GCLI-47
  N6).
- A real tarball with `dist` removed is re-packed, installed, and asserted to
  fail that same gate — the negative control is the gate rejecting it for naming
  `dist/glyph.js`, not a missing file.
- The build reads `bun` from `.bun-version`; consumers only need Node >= 24.

## Release route

The publish route follows lore-cli's working OIDC job and quest-cli's
dispatch/OIDC shape: `workflow_dispatch` against a `v*` tag, a `publish` input
defaulting to false, npm OIDC Trusted Publishing with `environment: release` and
a job-scoped `id-token: write`, an exact npm pin above the asserted 11.5.1
floor, and both release jobs on GitHub-hosted `ubuntu-24.04`. The Package job
builds and verifies the tarball and exports its sha256; the Publish job compares
the single downloaded tarball against that digest before it publishes, so the
bytes it uploads are bound to the gate's verification on the same runner class.
Provenance itself attests the publish step and the published bytes, not the
build. quest-cli's own release.yml had never succeeded and its working publish
was a local script, so the workflow keeps a dry-run rehearsal path and treats a
real publish as an operator step. A dry run exercises the command and the pinned
npm version but may skip the attestation: it neither produces provenance nor
proves the OIDC exchange works, and only a recorded `publish: true` dispatch
shows it. actionlint checks the workflow locally and in ci.yml when the runner
carries it, not as a guaranteed CI gate.
