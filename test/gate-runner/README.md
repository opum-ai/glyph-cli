# S8 gate runner

The runner for the S8 gate on Glyph's native Python indexer (GCLI-83,
DEC-303 (a17)). It is the RUNNER only: the gate itself is not run in this slice
and runs once, from a reviewed head, under the leader's direction.

## What it does

For each held-out repository it:

1. builds `dist/glyph.js` with `node scripts/build.mjs` (which needs `bun`), and
   hashes the built bundle;
2. checks the checkout is the pinned commit and clean (`git rev-parse HEAD`,
   `git status --porcelain`, untracked files included);
3. makes a fresh, empty `GLYPH_CACHE_DIR` and runs the BUILT bundle over the
   whole checkout:

   ```
   node dist/glyph.js --json --language python callers <symbol> [--file <path>]
   ```

4. reads the one `GlyphIndex` that run wrote into the cache, and checks it is
   non-empty and holds every `.py` file the scored package holds;
5. prints the measured object (rule 4), then feeds the index to
   `test/python-gate/gate_score.py` unchanged and passes the scorer's output and
   exit code through.

The runner re-derives no score, verdict or number: a `FAIL` verdict with a
scorer exit 0 is a result, and it is printed, never retried or tuned against.

## Usage

```sh
bun test/gate-runner/run_gate.ts <clickCheckout> <requestsCheckout>
bun test/gate-runner/run_gate.ts --fetch <directory>
```

`<clickCheckout>` and `<requestsCheckout>` must already be clean checkouts at the
pinned commits. `--fetch <directory>` clones the pinned commits into
`<directory>/click` and `<directory>/requests` and verifies each with
`git rev-parse HEAD`; it refuses to clobber a non-empty directory that is not the
pinned commit.

Exit 0 means the scorer ran for every repository (its verdict is in the printed
output). Any other exit is a fail-closed answer.

## Fail-closed conditions (DEC-303 (a17) 2)

The runner exits non-zero, prints a named message on stderr, and prints no score,
verdict or scorer output when any of these holds:

- **3a** the build failed, or `dist/glyph.js` is missing or empty;
- **3b** glyph exited non-zero, wrote no index, or the index is missing,
  unparsable or empty (zero files or zero symbols);
- **3c** the index read zero sites;
- **3d** the index holds fewer files than the scored package holds;
- **3e** the cache directory was not empty before the run, or holds other than
  exactly the one index the run wrote;
- **3f** the checkout is not the pinned commit or is not clean;
- **3g** the scorer is missing, `python3` is missing, or the scorer exits
  non-zero (its own exit 6 or 7 is passed through as a failure of the run).

The record printed before any score names the glyph commit and tree state, the
bundle's sha256, and each repository's commit, index file and site counts and
scored-package file count.

## Tests

`run_gate.test.ts` drives every branch with a small fixture world and an injected
scorer/bundle/git spawn. The tests never run the real scorer, never touch the
real click or requests checkouts and never run the gate.
