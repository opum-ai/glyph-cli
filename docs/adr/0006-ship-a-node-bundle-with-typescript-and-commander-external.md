---
# yaml-language-server: $schema=../../.lore/schemas/adr.schema.json
type: ADR
title: Ship one Node bundle with TypeScript and Commander external
tags:
  - packaging
  - release
  - node
summary: glyph ships as one bundled dist/glyph.js for Node >=24, with typescript and commander left external as runtime dependencies because the indexer reads TypeScript's own library files from disk.
generated:
  by: lore/0.14.1
  at: 2026-11-22T22:10:28.000Z
---

# Ship one Node bundle with TypeScript and Commander external

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
- `typescript` and `commander` are marked `--external` and remain runtime
  `dependencies`, installed with the package. Everything else is bundled.
- `prepack` runs the build, so `npm pack` cannot produce a tarball without the
  bundle.
- The shipped source has no `Bun.*` global: `src/git.ts` and `src/codemap.ts`
  spawn git through one helper (`src/spawn.ts`) over
  `node:child_process.spawnSync`, preserving stdout bytes, exit codes, stdin,
  the timeout, and the max-buffer limit, and rethrowing spawn failures (ENOENT,
  EACCES, E2BIG, EMFILE and any other exec-level error) while reporting a
  timeout or buffer overflow as a result for the caller to classify.

## Why the two externals

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

- The published tarball requires `typescript` and `commander` from the registry;
  `npm install` supplies them.
- (a1)'s condition is enforced, not assumed. `scripts/check-package.mjs` packs
  the tarball, installs it into a clean directory with `--ignore-scripts`, and
  copies `scripts/lib-probe.mjs` into that install so the probe's
  `import "typescript"` resolves to the INSTALLED dependency. The probe requires
  the default lib file to exist, a non-zero count of `lib.*.d.ts` files, and zero
  `getPreEmitDiagnostics`; the gate also runs every manifest command under node,
  including `impact --ref` (the git cat-file/stdin path). It rejects an installed
  `dist/glyph.js` containing a baked absolute `__dirname`/`__filename`, the
  signature of an inlined dependency, and requires the installed bundle to
  import `typescript` and `commander` as BARE SPECIFIERS (`from "x"` or
  `require("x")`), which catches inlining regardless of how the bundler spells
  its shim. Measured 2026-11-22: dropping `--external typescript` fails the
  typescript bare-specifier check; dropping `--external commander` fails the
  commander one (commander bundles with no baked path at all).
- Both release-workflow jobs run on GitHub-hosted `ubuntu-24.04`, so the tarball
  is built, verified and published on the same runner class. npm provenance
  attests the PUBLISH step and the published bytes, not the build; ci.yml's jobs
  stay on the existing `[self-hosted, Linux, ARM64]` group.
- `test/spawn.test.ts` runs under Bun's `node:child_process`; the Node
  implementation is checked by `scripts/node-spawn-check.mjs`, which the
  packaging gate runs with the `node` binary (timeout, maxBuffer, E2BIG).
- A real tarball with `dist` removed is re-packed, installed, and asserted to
  fail that same gate — the negative control is the gate rejecting it for naming
  `dist/glyph.js`, not a missing file.
- The build reads `bun` from `.bun-version`; consumers only need Node >= 24.

## Release route

The publish route follows lore-cli's working OIDC job and quest-cli's
dispatch/OIDC shape: `workflow_dispatch` against a `v*` tag, a `publish` input
defaulting to false, npm OIDC Trusted Publishing with `environment: release` and
a job-scoped `id-token: write`, an exact npm pin above the asserted 11.5.1
floor, and both release jobs on GitHub-hosted `ubuntu-24.04` — the tarball is
built and verified on the same runner class that publishes it, while provenance
itself attests the publish step and the published bytes, not the build.
quest-cli's own release.yml
had never succeeded and its working publish was a local script, so the workflow
keeps a dry-run rehearsal path and treats a real publish as an operator step. A
dry run may skip the attestation and does not prove provenance; only a recorded
`publish: true` dispatch shows it. actionlint checks the workflow locally and in
ci.yml when the runner carries it, not as a guaranteed CI gate.
