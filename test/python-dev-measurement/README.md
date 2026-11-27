# Python development measurement (GCLI-86)

Development data for DEC-303 (a21) to (a25), recorded under (a24) arm A. Nothing here is a test: no `*.test.ts` file and no workflow runs it, and no gate depends on its output. It is checked for hygiene only (typecheck, lint, format). Written from scratch; none of it was derived from or copied out of `test/python-gate`, which was never opened. Held-out material (click 7.1.2, requests 3c7baaa) is not used.

## What it measures

The share of human-attributable, in-package call sites that the analyzer resolves to the right symbol, on development repositories. Targets are every `def` and `class` in the package directory (tests excluded), ordered by `sha256(seed + file + ":" + qualname)`. `census.py` drops dunder names (`census.py:24`) and every target with no call-form occurrence or more than 14 occurrences across the package (`census.py:41`) before the first `max-targets` survivors are taken. For each target `census.py` enumerates, by regex and independent of glyph, every call-form and reference-form occurrence of the name across the package (the alias census). A human then labels each hit: a true site of that target, false (docstring, another object, a definition line), or excluded as ambiguous, polymorphic or value-dependent (DEC-303 (a3) Q4 and the standing rule). The labels are one labeller's (the glyph-cli worker; development data).

| sample | repository | commit | seed | package | targets | true sites | excluded |
|---|---|---|---|---|---|---|---|
| tqdm (low annotation) | tqdm/tqdm | 9cf5a12b1f955468a17f0ba3c59092b23e4258ac | `gcli86-dev-tqdm-1` | `tqdm` | 110 enumerated, first 75 labelled | 89 | 10 |
| flask (exploratory, below the (a2) floor of 62) | pallets/flask | 49943b5a94413a530761350f04e896f76e8d620e | `gcli86-dev-flask-1` | `src/flask` | 40 | 29 | 6 |
| rich (development, step 5; GCLI-142) | Textualize/rich | 3a109ccdffe5b2d0e30684a304fbd388e99ce57b | `gcli142-dev-rich-1` | `rich` | 200 enumerated, first 36 labelled | 66 | 1 |

Label categories: D direct name, import or module attribute; N nested local def; C `Class.method()`; S `self`, `cls` or inherited method; K known-class local; Q2 `self.attr.m()`; ALIAS a local bound to `Cls.attr`; TS a local bound to `type(self)`; X excluded (not scored).

## Files

- `census.py`: `python3 -I census.py <repo> <package-dir> <seed> <max-targets>`; reads a clone at `corpus/<repo>` relative to the working directory and writes `enum-<repo>.json`. Each target records its declaration site: the def's file, line and the 1-based column of its name (GCLI-168; the column is absent from enums generated before that change).
- `enum-tqdm.json` (110 targets, the first 75 labelled), `enum-flask.json` (40 targets), `enum-rich.json` (200 targets, the first 36 labelled): the enumerations (target, then candidate sites). The label files index into them as `<target index>.<site index>`.
- `labels-tqdm.json`, `labels-flask.json`, `labels-rich.json`: the hand labels by category. As in the other samples, only call-form sites are labelled; reference-form occurrences (annotations, imports, `except` clauses, bare name bindings) are enumerated but not labelled.
- `measure.ts`: `bun test/python-dev-measurement/measure.ts <repo-root>` prints the call bins for a checkout.
- `score-dev.ts`: `bun test/python-dev-measurement/score-dev.ts <repo-root> <enum.json> <labels.json>` scores the labels against the repository's own analyzer (an edge from the site's file and line to the target symbol). A target is matched to an analyzer symbol by DECLARATION SITE — file, def line and the 1-based column of the name — never by qualname, a suffix or a fuzzy match (DEC-303 (a93) item 4). An enum without a column is matched on the declaration line only when exactly one symbol sits there; a line with more symbols stays unresolved rather than guessed.
- `score-dev-selftest.ts`: `bun test/python-dev-measurement/score-dev-selftest.ts` checks the matcher on in-memory fixtures, including two same-named nested classes at different declaration sites (same qualname), where an edge to the wrong one must be refused. Not a `*.test.ts`, so no workflow runs it.

Clone each repository at the commit above (`git clone`, then `git checkout <sha>`). To reproduce a row, check out the analyzer commit it names, overlay `test/python-dev-measurement/` from this tree onto that checkout (the scripts import `src/python/` relatively, so the analyzer measured is the checkout's), and run `census.py` with `max-targets` 110 for tqdm and 40 for flask. For rich, run `census.py` with package `rich`, seed `gcli142-dev-rich-1` and `max-targets` 200, label the first 36 targets (66 attributable call sites), and score against dev `dce9e90`.

`item3-group-sizes.tsv` (GCLI-93) holds the group sizes of the unresolved calls, in the columns pre-89, post-89 and dev, which are the analyzer at `1d2441d`, `4f313f7` and `61ec029`, over the corpus pins flask `49943b5a`, jinja `5ef70112`, httpx `7cff5f79`, rich `3a109ccd` and tqdm `9cf5a12b` (full SHAs in the GCLI-86 notes). The per-repository columns are for dev only. The classification behind it came from instrumentation that is NOT committed (see the GCLI-93 line under Limits), so the overlay above does NOT reproduce the TSV; it reproduces the scoring rows only.

## Rows and the commit that reproduces each

Run `score-dev.ts` from a checkout of the named commit, pointing it at the clones and at these label files. Measured with these scripts on 2026-11-25.

| row | analyzer at | tqdm (n = 89) | flask (n = 29) |
|---|---|---|---|
| (i) current rules as built | `1d2441d1603995784e05e59071b570e9c806faa6`, dev before GCLI-89 (opum-ai/glyph-cli#139) | 62/89 = 0.6966 | 21/29 = 0.7241 |
| (i') with the attribute-target defect fixed | `4f313f77d02c17d15d6e21e4b7ed49bb7d63eb0e`, GCLI-89's merge commit on dev | 79/89 = 0.8876 | 24/29 = 0.8276 |
| (i'') with GCLI-91 (resolution through a namespace directory) | `61ec0292f2e43fd5bf26db6f2796dbf30589052a`, GCLI-91's squash on dev (opum-ai/glyph-cli#143) | 79/89 = 0.8876 | 29/29 = 1.0000 |

By category on tqdm: row (i) D 40/40, N 3/3, C 3/3, S 16/33, Q2 0/5, ALIAS 0/4, TS 0/1; row (i') the same except S 33/33. Row (i'') is the same as row (i') on tqdm; on flask it is D 11/11, S 15/15, K 3/3.

### rich (GCLI-142, DEC-303 (a23) step 5)

Measured 2026-11-27 against dev `dce9e90d263f83112d2b6946b61e8d15d118ed22` (analyzer at that commit; rich cloned at `3a109ccdffe5b2d0e30684a304fbd388e99ce57b`), first 36 of 200 enumerated targets, 66 attributable call sites: **60/66 = 0.9091** under the qualname-matched scorer. After GCLI-168's declaration-site matching (DEC-303 (a93) item 4) the same labels at dev `3062aa9f` (analyzer unchanged since `0e72f09`) score **61/66 = 0.9242**: only 22.0 changes, because `RichFormatter()` resolves to the class's own declaration at `rich/pretty.py:214` and the qualname key was what disagreed. By category: D 39/39, N 1/2, C 4/4, S 7/7, K 9/12, Q2 0/1, ALIAS 0/1, TS 0/0. The remaining five misses are 5.1 `Console.render_str` through a local bound to the bound method (ALIAS), 5.5 `Console.render_str` on `self.console` (Q2), 5.7 and 5.8 `Console.render_str` on an annotated `console` local and 6.0 `Text.highlight_words` on a `Text` local (K). For reference, the analyzer's bins over the whole clone: 212 files, 9844 call expressions, resolvedInRepo 5613, resolvedExternal 2512, receiverNeedsInference 1409, nameNotBound 310.

Rows (ii) to (v) are the scratch-copy measurements recorded in the GCLI-86 notes and in DEC-303 (a23), not reproducible from a commit until the admitted rules are built: (ii) the (a22) item-3 groups add 0 on this sample; (iii) completed annotation reading adds 0, unexercised because tqdm has no annotations; (iv) single-assignment `self.attr` adds 5; (v) followed return annotations add 0, unexercised. The remaining 5 sites on tqdm are ALIAS (4) and TS (1), admitted by (a23).

## Limits

- `enum-tqdm.json` and `enum-flask.json` predate the recorded column: the scorer matches them on the declaration line only when exactly one symbol sits there, and leaves an ambiguous line unresolved. Re-generating them with the current `census.py` supplies the column.
- Two development repositories carry the ceiling (tqdm n = 89, rich n = 66), one labeller. Targets are drawn in seeded def order, so the mix leans to direct, `self` and module-level calls. A development ceiling, not a gate estimate. On rich, 164 of the 200 enumerated targets were not labelled, and reference-form occurrences were not labelled (call-form only, as in the other samples).
- The flask sample is below the (a2) floor and is exploratory only. Five flask sites (inherited `self.m()` through `Flask(App)`, which landed in the resolved-external bin as `external-base`) were an open finding at the earlier rows; GCLI-91 resolves them at `61ec029` (the `sansio` fixture in `test/python-calls.test.ts`). That the five are exactly the five that moved from 24/29 to 29/29 is inferred from the counts, not proven per site: no per-site score file is committed.
- The scratch copies used for the earlier measurements carried instrumentation that labelled each unresolved site with its binding construct and raised the per-reason first-site cap. `src/python/` has neither, and none was added for these scripts; `measure.ts` therefore prints only the bins and reason counts.
- `item3-group-sizes.tsv` (GCLI-93) was produced by a classification census over per-site diagnostics: the instrumentation was patched onto the analyzer at `1d2441d`, `4f313f7` and `61ec029` in scratch copies, labelled each unresolved call with its binding construct, and was not committed. The census was run with `markerDirs` as the product does (`src/program.ts`), so its callBins are the product's. The per-repository columns in the TSV are for dev only.
- Rows (ii) to (v) and the group sizes in the GCLI-86 notes were taken before the GCLI-89 fix; the group sizes re-derived on the fixed baseline are in `item3-group-sizes.tsv`.
