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
  at: 2026-11-22T21:58:30.000Z
---

# Ship one Node bundle with TypeScript and Commander external

## Status

Accepted — opum-doc DEC-299 items 2 and 3 (glyph 0.1.0 targets Node >= 24 like
lore and quest: one bundled `dist/glyph.js` with a Node shebang). Implemented
under GCLI-46. This slice keeps `private: true` and version `0.0.0`; the release
change that flips them is separate.

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
  the timeout, and the max-buffer limit.

## Why the two externals

`src/snapshot.ts` serves the running TypeScript package's own library directory
from disk (`ts.getDefaultLibFilePath({})`), and `src/indexer.ts` builds every
program with `ts.createProgram`, whose default host resolves `lib.*.d.ts` from
that same package location. Bundling `typescript` moves that location into
`dist/glyph.js`'s directory, where no library exists: the compiler loses its
built-in types, and the `--ref` snapshot host serves no library at all.

Measured 2026-11-22 under node 24.22.2, with Bun 1.3.14 building. A probe prints
`ts.getDefaultLibFilePath({})`, whether that file exists, and how many `lib.*.d.ts`
files a `ts.createProgram` over a small source loads:

| build | `lib.d.ts` path present | lib files | diagnostics |
|---|---|---|---|
| all inlined, on the build machine | yes | 50 | 0 |
| all inlined, build-time path absent (consumer shape) | no | 0 | 10 |
| TypeScript external, installed as a dependency | yes | 50 | 0 |

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
  `npm install` supplies them. `scripts/check-package.mjs` installs the tarball
  into an empty directory with `--ignore-scripts` and runs every manifest command
  under node, so a broken external or a missing bundle fails CI.
- A tarball packed without `dist` fails the same gate's negative control.
- The build reads `bun` from `.bun-version`; consumers only need Node >= 24.
