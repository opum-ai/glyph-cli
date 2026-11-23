# Python language-server measurement (GCLI-66, DEC-303, ADR 0008)

A recorded artifact, not part of the test suite and not shipped: it is the evidence behind
`docs/adr/0008-...` so the numbers can be re-derived when pyright is upgraded.

Pins: pyright 1.1.414 (`npm install pyright@1.1.414 --ignore-scripts`; registry integrity
`sha512-FPZZb51jepDX4eP7TEYDeNFtmE3WgwkkEcJpvH3/QmUSsj0EAy3LXu+xB4T/FWDejtsXlCfFr/rbWFjwuwuXww==`),
psf/requests at `3c7baaa05ab4aa49cc819ce3a819d260de19c157`, Node v24.22.2, git 2.56.0, host Python 3.15.2.

Order of work, which is what makes the ground truth independent of pyright:

1. `gt1_enumerate.py` enumerates definitions and syntactic calls with Python's `ast` and draws the
   target sample (seed 303). `gt2_listing.py` prints the candidate sites for hand classification.
2. `gt_rules.md` and `gt3_classified.json` (requests) and `fixtures/expected.json` (fixtures) were
   written and committed in a scratch repository before the first pyright request.
3. `harness.mjs` drives `pyright-langserver --stdio`; `score.py` and `strata.py` compare its output
   with the ground truth. `results/` holds the scored output of the runs the ADR quotes.

The scripts keep the absolute paths of the session's scratch directory (`ROOT`, `OUT`, `BIN`, the
fixture paths in `fx_enum.py`). Edit those constants to run them; nothing here is imported by
glyph. Raw per-run JSON (about 750 KB each) is not kept; re-run the harness to regenerate it:

```sh
node harness.mjs <rootDir> targets.json allcalls.json symbols.json <all|none> out.json <srcSubdir>
python3 -I score.py out.json gt3_classified.json symbols.json <srcRoot> --verbose
```

`all` opens every file before any query (the mode the ADR recommends); `none` opens each file only
for its own query and is the mode that gave non-reproducible incoming calls. `OUT_ALL=1` adds the
per-symbol `outgoingCalls` pass.
