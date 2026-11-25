# Python development measurement (GCLI-86)

Development data for DEC-303 (a21) to (a25), recorded under (a24) arm A. Nothing here is a test: no `*.test.ts` file and no workflow runs it, and no gate depends on its output. It is checked for hygiene only (typecheck, lint, format). Written from scratch; none of it was derived from or copied out of `test/python-gate`, which was never opened. Held-out material (click 7.1.2, requests 3c7baaa) is not used.

## What it measures

The share of human-attributable, in-package call sites that the analyzer resolves to the right symbol, on development repositories. Targets are every `def` and `class` in the package directory (tests excluded), ordered by `sha256(seed + file + ":" + qualname)`. `census.py` drops dunder names (`census.py:24`) and every target with no call-form occurrence or more than 14 occurrences across the package (`census.py:41`) before the first `max-targets` survivors are taken. For each target `census.py` enumerates, by regex and independent of glyph, every call-form and reference-form occurrence of the name across the package (the alias census). A human then labels each hit: a true site of that target, false (docstring, another object, a definition line), or excluded as ambiguous, polymorphic or value-dependent (DEC-303 (a3) Q4 and the standing rule). The labels are one labeller's (the glyph-cli worker; development data).

| sample | repository | commit | seed | package | targets | true sites | excluded |
|---|---|---|---|---|---|---|---|
| tqdm (low annotation) | tqdm/tqdm | 9cf5a12b1f955468a17f0ba3c59092b23e4258ac | `gcli86-dev-tqdm-1` | `tqdm` | 110 enumerated, first 75 labelled | 89 | 10 |
| flask (exploratory, below the (a2) floor of 62) | pallets/flask | 49943b5a94413a530761350f04e896f76e8d620e | `gcli86-dev-flask-1` | `src/flask` | 40 | 29 | 6 |

Label categories: D direct name, import or module attribute; N nested local def; C `Class.method()`; S `self`, `cls` or inherited method; K known-class local; Q2 `self.attr.m()`; ALIAS a local bound to `Cls.attr`; TS a local bound to `type(self)`; X excluded (not scored).

## Files

- `census.py`: `python3 -I census.py <repo> <package-dir> <seed> <max-targets>`; reads a clone at `corpus/<repo>` relative to the working directory and writes `enum-<repo>.json`.
- `enum-tqdm.json` (110 targets, the first 75 labelled), `enum-flask.json` (40 targets): the enumerations (target, then candidate sites). The label files index into them as `<target index>.<site index>`.
- `labels-tqdm.json`, `labels-flask.json`: the hand labels by category.
- `measure.ts`: `bun test/python-dev-measurement/measure.ts <repo-root>` prints the call bins for a checkout.
- `score-dev.ts`: `bun test/python-dev-measurement/score-dev.ts <repo-root> <enum.json> <labels.json>` scores the labels against the repository's own analyzer (an edge from the site's file and line to the target symbol).

Clone each repository at the commit above (`git clone`, then `git checkout <sha>`). To reproduce a row, check out the analyzer commit it names, overlay `test/python-dev-measurement/` from this tree onto that checkout (the scripts import `src/python/` relatively, so the analyzer measured is the checkout's), and run `census.py` with `max-targets` 110 for tqdm and 40 for flask.

`item3-group-sizes.tsv` (GCLI-93) holds the group sizes of the unresolved calls, in the columns pre-89, post-89 and dev, which are the analyzer at `1d2441d`, `4f313f7` and `61ec029`, over the corpus pins flask `49943b5a`, jinja `5ef70112`, httpx `7cff5f79`, rich `3a109ccd` and tqdm `9cf5a12b` (full SHAs in the GCLI-86 notes). The per-repository columns are for dev only. The classification behind it came from instrumentation that is NOT committed (see Limits), so the overlay above does NOT reproduce the TSV; it reproduces the scoring rows only.

## Rows and the commit that reproduces each

Run `score-dev.ts` from a checkout of the named commit, pointing it at the clones and at these label files. Measured with these scripts on 2026-11-25.

| row | analyzer at | tqdm (n = 89) | flask (n = 29) |
|---|---|---|---|
| (i) current rules as built | `1d2441d1603995784e05e59071b570e9c806faa6`, dev before GCLI-89 (opum-ai/glyph-cli#139) | 62/89 = 0.6966 | 21/29 = 0.7241 |
| (i') with the attribute-target defect fixed | `4f313f77d02c17d15d6e21e4b7ed49bb7d63eb0e`, GCLI-89's merge commit on dev | 79/89 = 0.8876 | 24/29 = 0.8276 |
| (i'') with GCLI-91 (resolution through a namespace directory) | `61ec0292f2e43fd5bf26db6f2796dbf30589052a`, GCLI-91's squash on dev (opum-ai/glyph-cli#143) | 79/89 = 0.8876 | 29/29 = 1.0000 |

By category on tqdm: row (i) D 40/40, N 3/3, C 3/3, S 16/33, Q2 0/5, ALIAS 0/4, TS 0/1; row (i') the same except S 33/33. Row (i'') is the same as row (i') on tqdm; on flask it is D 11/11, S 15/15, K 3/3.

Rows (ii) to (v) are the scratch-copy measurements recorded in the GCLI-86 notes and in DEC-303 (a23), not reproducible from a commit until the admitted rules are built: (ii) the (a22) item-3 groups add 0 on this sample; (iii) completed annotation reading adds 0, unexercised because tqdm has no annotations; (iv) single-assignment `self.attr` adds 5; (v) followed return annotations add 0, unexercised. The remaining 5 sites on tqdm are ALIAS (4) and TS (1), admitted by (a23).

## Limits

- One repository for the ceiling (n = 89), one labeller. Targets are drawn in seeded def order, so the mix leans to direct, `self` and module-level calls. A development ceiling, not a gate estimate.
- The flask sample is below the (a2) floor and is exploratory only. Five flask sites (inherited `self.m()` through `Flask(App)`, which landed in the resolved-external bin as `external-base`) were an open finding at the earlier rows; GCLI-91 resolves them at `61ec029` (the `sansio` fixture in `test/python-calls.test.ts`). That the five are exactly the five that moved from 24/29 to 29/29 is inferred from the counts, not proven per site: no per-site score file is committed.
- The scratch copies used for the earlier measurements carried instrumentation that labelled each unresolved site with its binding construct and raised the per-reason first-site cap. `src/python/` has neither, and none was added for these scripts; `measure.ts` therefore prints only the bins and reason counts.
- Rows (ii) to (v) and the group sizes in the GCLI-86 notes were taken before the GCLI-89 fix; the group sizes re-derived on the fixed baseline are in `item3-group-sizes.tsv`.
