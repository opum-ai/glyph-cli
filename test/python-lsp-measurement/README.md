# Python language-server measurement (GCLI-66, DEC-303, ADR 0008)

A recorded artifact, not part of the test suite and not shipped: the evidence behind `docs/adr/0008-...`, so the
numbers can be checked, re-scored without the language server, and re-derived when pyright is upgraded.

Pins: pyright 1.1.414 (`npm install pyright@1.1.414 --ignore-scripts`; registry integrity
`sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==`),
psf/requests at `3c7baaa05ab4aa49cc819ce3a819d260de19c157` (`src/requests`), Node v24.22.2, git 2.56.0, host Python 3.15.2.

## What is here

| path | what |
|---|---|
| `gt_rules.md`, `gt3_classified.json`, `fixtures/expected.json` | the ground truth, byte-identical to what was committed before pyright ran (`results/ground-truth-provenance.txt` has the scratch log and blob ids) |
| `gt_rules_addendum.md`, `gt4_alias.json` | what was learned or decided after the first results, including the post-hoc alias set and the post-hoc constructor mapping; read it before quoting any number |
| `gt1_enumerate.py`, `gt2_listing.py`, `alias_enum.py`, `fx_enum.py` | enumerate definitions and call sites with Python's `ast`, draw the seeded sample, print candidates, build the alias set |
| `harness.mjs` | the LSP client (JSON-RPC over `pyright-langserver --stdio`); exits non-zero if no request is answered, any request errors, or every `prepareCallHierarchy` is null |
| `score.py`, `union.py`, `strata.py`, `compare_runs.py` | scoring (per site and per target, recall and precision, Wilson intervals), determinism, open-mode and timing |
| `derived/` | the deterministic inputs the scorers read: `symbols.json`, `targets.json`, `allcalls.json`, `listing.txt`, `alias_targets.json`, `targets_combined.json`, `cls_targets.json`, the `fx_*` files |
| `fixtures/pkg/` | the fixture package |
| `results/` | scored output of every run the ADR quotes; `results/raw/` the gzipped raw harness output |

Every script takes its paths as arguments (nothing is hard-coded to a machine).

## Re-scoring without the language server (needs `python3` and `gunzip`)

```sh
mkdir /tmp/py-raw && for f in results/raw/*.gz; do gunzip -c "$f" > /tmp/py-raw/$(basename "$f" .gz); done
python3 -I score.py /tmp/py-raw/real-allplat-out.json gt3_classified.json derived/symbols.json /nonexistent --verbose
python3 -I union.py /tmp/py-raw/real-default-out.json gt3_classified.json derived/targets_combined.json derived/symbols.json gt4_alias.json
python3 -I union.py /tmp/py-raw/fx-default-out.json fixtures/expected.json derived/fx_targets.json derived/fx_symbols.json
python3 -I compare_runs.py /tmp/py-raw derived/symbols.json
python3 -I strata.py /tmp/py-raw/real-default-out.json gt3_classified.json derived/targets.json
python3 -I score.py /tmp/py-raw/real-default-out.json gt3_classified.json derived/symbols.json <requests>/src/requests --verbose   # results/score-real-default.txt
python3 -I score.py /tmp/py-raw/fx-default-out.json fixtures/expected.json derived/fx_symbols.json fixtures --verbose   # results/score-fx-default.txt (and -allplat)
python3 -I score.py /tmp/py-raw/real-default-out.json gt4_alias.json derived/symbols.json <requests>/src/requests --verbose   # results/score-alias-default.txt
python3 -I union.py /tmp/py-raw/real-allplat-out.json gt3_classified.json derived/targets_combined.json derived/symbols.json gt4_alias.json   # results/union-real-allplat.txt
python3 -I union.py /tmp/py-raw/fx-allplat-out.json fixtures/expected.json derived/fx_targets.json derived/fx_symbols.json                       # results/union-fx-allplat.txt
```

`results/no-python-on-path.txt` and `results/platform-channels.txt` are written by hand from the runs named in them
(`real-nopython-1`, `platform-channel-e1|e4|e5` in `results/raw/`; the experiments are `PATH` stripped to `node`, and the
harness environment variables `CONFIG_RESPONSE` and `INIT_OPTIONS` plus a generated `pyrightconfig.json`). The
648 + 2 split of definitions that land outside the package is printed by `score.py` ("external (typeshed or stdlib)",
"external (installed package)"). `results/ground-truth.bundle` is a `git bundle` of the scratch repository that held the
ground truth before pyright ran: `git bundle verify results/ground-truth.bundle` and `git clone` it to check the blob ids in
`results/ground-truth-provenance.txt`.

The output reproduces `results/*.txt` apart from timings, provided the `--verbose` commands are given the real source root
(`<requests>` is a checkout of the pinned commit, `fixtures` is the directory here): the committed `score-*.txt` files contain a
"-- per target" section with source text. With `/nonexistent` as the source root only that source text is blanked. `score.py` refuses (exit 2) to score a run with no answered request, with request errors, or with a
missing target record.

## Re-running the language server

Needs `node`, the pinned pyright, and a checkout of the pinned requests commit; set `PYRIGHT_LANGSERVER` to
`.../node_modules/.bin/pyright-langserver`.

```sh
python3 -I gt1_enumerate.py <requests>/src/requests <out>        # seed 303 regenerates derived/targets.json and symbols.json
python3 -I alias_enum.py <requests>/src/requests derived/symbols.json <out>
node harness.mjs <requests> <targets> derived/allcalls.json derived/symbols.json all <out.json> src/requests   # OUT_ALL=1 adds outgoingCalls
```

`all` opens every file before any query; `none` opens each file only for its own query. `pythonPlatform: "All"` is set by a
`pyrightconfig.json` containing `{"pythonPlatform":"All"}` in the analysis root (the harness answers the server's
`workspace/configuration` request with empty settings, so the config file is the only source of it). The fixtures' analysis
root is the `fixtures` directory itself (`harness.mjs fixtures <targets> ... all out.json`).

## Layout, channel and absolute-import runs

`results/layouts.txt` and `results/union-layout-*.txt`, `results/union-abs-*.txt` record the analysis-root layouts of ADR 0008
section 5 (raw: `results/raw/lay-real-*`, `abs-*`); `fixtures-abs/` is the absolute-import fixture with its
`expected.json`, and `derived-abs/` its derived inputs. The generated configs were
`{"pythonPlatform":"All","include":[<package dir>],"extraPaths":[<src dir>]}` (and without `extraPaths`) in a directory outside
the repository, and no config for the in-root run.

`results/import-detector.txt` (raw `results/raw/imp-*`, `derived-abs/imports.json`, `import_probe.py`) records the fail-closed first-party import
signal over seven layouts.
