# Blind-sample pre-registration

Status: **complete in this commit.** Do not draw from this document until opum-doc
has read the commit and given the second GO (DEC-303 (a36) item 8; (a99) item 2).

Authority: DEC-303 (a36) items 2, 3, 4, 5, 7 and 8; DEC-303 (a99), recorded in
opum-doc at `48da5625` under ODOC-640. This document carries only what (a36) item 8
and (a99) item 3 require; it settles no design question of its own.

## 1. The frozen analyzer

- Frozen head: glyph-cli `dev` at `6602d626dbdf208d42da4016cefdd3ec20803daf`.
  This commit adds test files and Quest records only; `src/` is byte-identical to
  the frozen head.
- Built artifact: `dist/glyph.js`, sha256
  `606a0411e51e4f12ab43dba9c91121add6ed669e0c24ade674e623673dc8a036`
  (322526 bytes), built with Bun 1.3.14 and Node v24.22.2. Two builds from the
  same tree produced byte-identical output.
- The scored run is the shipped path, built from this head, run once (section 8).

## 2. The three sample repositories

`attrs` is accepted by (a36) item 2. The two replacements for `werkzeug` and
`starlette` are selected by the measurement in section 3; `werkzeug` and
`starlette` are vetoed there because pallets owns a development-corpus repository
and encode owns `httpx`. The 15,000-60,000 line range is a criterion for choosing
the two replacements, not a floor on `attrs` (DEC-303 (a101) item 2). What binds
every sample repository, `attrs` included, is (a36) item 3: at least 62 sites
labelled true. `attrs`'s in-package call-site census is measured by script, with
no glyph, before this document is complete; if it cannot plausibly reach 62 true
sites, a replacement is proposed from the candidates through opum-doc.

The veto rule applies to every candidate: **no sample repository may have a
current or former GitHub owner that owns a development-corpus or held-out
repository** (development corpus: flask, jinja, httpx, rich, tqdm; held out:
click, requests) — DEC-303 (a36) item 2.

| repository | commit | package | lines | class share | annotation density | in-package star imports | census call sites |
|---|---|---|---|---|---|---|---|
| attrs | `af29c2a4a6f6a874a7b9c5873f5222d131a1f8d2` | `src/attr` | 4,882 | 0.204 | 0.197 | 0 | 273 |
| pydantic | `6449f80db0214a95178b6b80a3613451b924a4f1` | `pydantic` | 22,584 | 0.285 | 0.988 | 4 (TYPE_CHECKING) | 1,630 |
| luigi | `d552607b037e4cb6cd303562fd222fd389fd524a` | `luigi` | 21,546 | 0.200 | 0.028 | 0 | 2,085 |

The pins are the commits in `pins.tsv`, written by the operator's clone script;
each checkout's `HEAD` was read back and matches its row. `census call sites` is
the blind census's site count at the draw seed, section 5.

The 62-site reach, first for `attrs` (a101 item 2): 273 candidate call sites hold
128 eligible targets, so 62 true sites need a true share of 0.23. The development
samples' true share among labelled candidate sites runs 0.83 (flask: 29 of 35) to
0.98 (rich: 66 of 67), so `attrs` plausibly clears the reach and no replacement is
proposed. `pydantic` (1,630 sites) and `luigi` (2,085) clear it by a wider margin.

## 3. Selection measurement, by script over the text (a36 item 2)

`select-sample.py` reads the checkout's text and prints the criteria. It runs no
analyzer, starts no index, and emits no resolution. It is the only thing that
touches a sample checkout before the draw (a36 item 7).

    python3 -I test/python-blind-measurement/select-sample.py <repo-root> <package-dir>

Measured per candidate:

- **package lines**, 15k to 60k for the two replacements (not a floor on `attrs`,
  a101 item 2): non-blank, non-comment lines in the package;
- **class-heavy**: classes / (classes + defs) over non-dunder declarations;
- **annotation density**: the share of non-dunder defs declaring at least one
  annotated parameter or a return annotation;
- **in-package star imports**: `from .x import *` or `from <package>.x import *`;
- **census reach**: call-form sites an eligible target contributes under the same
  eligibility `census.py` applies (non-dunder, at least one call form, at most 14
  occurrences of any form). This bounds what a draw can reach and rules out a
  repository that cannot reach 62 true sites (a36 item 3).

Across the three, one is low and one high in annotation density, and at least one
has an in-package star import.

The checkouts are made by a first-party operator step, not by this repository: the
operator's `~/.opum-operator/clone-gcli143-candidates.sh`, released under the
operator's decision `dec-0u285fx`, shallow-clones each candidate's default branch
into `/Volumes/external/archive/glyph-cli/gcli-143-selection/<name>` with no
submodules and no hooks, records name, URL, default branch, commit and time in
`pins.tsv`, and leaves the directory read-only. The recorded commits are the pins;
no release tag is chosen. The script clones and records only — it runs no
analyzer, no glyph command, no census and no labelling.

Candidates: `attrs` (`src/attr`), `pydantic` (`pydantic`), `urllib3`
(`src/urllib3`), `aiohttp` (`aiohttp`), `trio` (`src/trio`), `celery` (`celery`),
`scrapy` (`scrapy`), `tornado` (`tornado`), `luigi` (`luigi`), `paramiko`
(`paramiko`). No candidate's current or former owner owns a
development-corpus or held-out repository (a36 item 2).

### The candidates, measured

Every candidate at its `pins.tsv` commit, measured by `select-sample.py` over the
text with no glyph. `lines` is non-blank non-comment source lines in the package;
`class share` is classes / (classes + defs); `annotation` is the share of defs
declaring an annotated parameter or a return; `stars` is in-package
`from .x import *`; `sites` is the same script's call-site count, which counts a
site once per matching target name.

| candidate | pin | lines | class share | classes | annotation | stars | eligible targets | sites |
|---|---|---|---|---|---|---|---|---|
| attrs | `af29c2a4` | 4,882 | 0.204 | 39 | 0.197 | 0 | 128 | 298 |
| pydantic | `6449f80d` | 22,584 | 0.285 | 344 | 0.988 | 4 | 670 | 2,052 |
| urllib3 | `3db5970f` | 9,314 | 0.202 | 105 | 1.000 | 0 | 348 | 1,034 |
| aiohttp | `1290e699` | 21,510 | 0.211 | 332 | 1.000 | 0 | 797 | 2,473 |
| trio | `bd665af6` | 34,360 | 0.104 | 293 | 0.989 | 11 | 787 | 2,429 |
| celery | `14115f05` | 36,565 | 0.102 | 306 | 0.101 | 0 | 1,638 | 4,383 |
| scrapy | `d2052b86` | 31,399 | 0.158 | 357 | 0.990 | 0 | 1,328 | 3,739 |
| tornado | `dbaa6c5b` | 41,655 | 0.191 | 881 | 0.304 | 0 | 1,210 | 4,202 |
| luigi | `d552607b` | 21,546 | 0.200 | 445 | 0.028 | 0 | 1,152 | 3,174 |
| paramiko | `0e9ccb91` | 14,398 | 0.137 | 114 | 0.013 | 0 | 559 | 1,667 |

**The two replacements are `pydantic` and `luigi`.** `pydantic` carries the high
annotation density (0.988) and the in-package star imports (4, all in
`pydantic/__init__.py`, inside `if TYPE_CHECKING:` — the Q1 annotation-reading
path, not runtime binding). `luigi` carries the low annotation density (0.028,
the lowest measured) and is class-heavy in both senses (445 classes, 0.200
share). Both are inside the 15k-60k range and both pass the owner veto.

The candidates the criteria ruled out: `urllib3` (9,314 lines) and `paramiko`
(14,398) are below the range; `trio` and `celery` are class-light (0.104, 0.102);
`aiohttp`, `scrapy` and `tornado` are high-annotation alternatives whose pairs
would leave the low side of the density spread empty. Two measurement caveats,
both from the census's `/tests` exclusion, which matches a `tests` directory but
not `_tests` or `test`: `trio`'s 11 stars are 3 in package code and 8 under
`src/trio/_tests/`, and `tornado`'s counts include `tornado/test/`. Neither is
chosen.

### Owner verification (DEC-303 (a101) item 3)

The veto is verified from GitHub, not asserted. For each candidate: the current
owner and default branch from `gh api repos/<owner>/<repo>`; each former path
GitHub still serves, by probing it and recording the redirect target; and the
owner's repository list from `gh api users/<owner>/repos`, scanned for the seven
development-corpus and held-out names (flask, jinja, click, httpx, rich, tqdm,
requests). GitHub exposes no general transfer-history endpoint, so a former path
that no longer redirects is recorded as "no record", not as "never transferred".

| candidate | current owner | former-path probe | owner's repos scanned | corpus-name match |
|---|---|---|---|---|
| attrs | python-attrs | `hynek/attrs` -> 404, no record | 2 | none |
| pydantic | pydantic | `samuelcolvin/pydantic` -> pydantic/pydantic | 96 | none |
| urllib3 | urllib3 | `shazow/urllib3` -> urllib3/urllib3 | 3 | none |
| aiohttp | aio-libs | `KeepSafe/aiohttp` -> aio-libs/aiohttp | 70 | none |
| trio | python-trio | no probe resolves; no record | 32 | none |
| celery | celery | no probe resolves; no record | 27 | none |
| scrapy | scrapy | no probe resolves; no record | 35 | none |
| tornado | tornadoweb | `facebook/tornado` -> tornadoweb/tornado | 2 | none |
| luigi | spotify | no probe resolves; no record | 100 (API page cap) | none |
| paramiko | paramiko | no probe resolves; no record | 1 | none |

The two chosen replacements carry this row into section 2 with their pins. None
matches the owner of a development-corpus or held-out repository: pallets, encode,
Textualize, tqdm and psf are not among the current or reported former owners.

## 4. The draw

- **Unit**: the call site, not the def or target (a36 item 3).
- **Order key**: `sha256(seed + file + ":" + line + ":" + column)`, ascending.
- **Draw seed**: `gcli143-blind-draw-1`.
- **Check seeds** (a36 item 4): `gcli143-blind-check-a-1` and
  `gcli143-blind-check-b-1`, one per independent 20% reviewer sample. All three
  seeds are fixed by this commit under DEC-303 (a100).
- **Stopping rule**: label down the seeded order on each repository and stop at
  the 62nd true site, with no larger target (DEC-303 (a100)). The rule depends on
  label counts only, never on a score.
- **Labels**: each drawn site is true, false, or excluded under the (a2) and (a3)
  conventions; polymorphic sites are excluded from the denominator (a36 item 3).
- **Second labeller**: two DEC-183 reviewer units, model `claude-opus-5-5`,
  independently label a seeded random 20% of each repository's drawn sites, given
  only the enumeration, the checkout at its pin, and the (a2)/(a3) conventions —
  never the worker's labels or any glyph output. Agreement is reported per
  repository; below 90% true-or-not agreement, the labels come back to opum-doc
  before any analyzer run (a36 item 4).

## 5. Census confirmation (a36 item 7; the fourth path, DEC-303 (a100))

`census.py` enumerates from the checkout text by regular expression, independently
of glyph: it starts no analyzer, starts no LSP, and emits no glyph resolution.

The draw uses `census.py` in this directory, and this commit shows what changed
against `test/python-dev-measurement/census.py`, which stays byte-for-byte
unchanged. Two changes, both (a36) item 3 and (a100):

1. **Draw unit and order key.** The dev census enumerates targets (defs and
   classes) and orders them by `sha256(seed + file + ":" + qual)`. The blind
   census emits the candidate call sites themselves, each keyed by
   `file:line:column` and ordered by
   `sha256(seed + file + ":" + line + ":" + column)`. A site matched by two
   targets of the same name is one entry listing both candidates, so the unit is
   the site; the labeller resolves it to the target it reaches, or to none.
2. **No `max-targets`.** The dev census takes the first N targets after ordering;
   the blind census emits every eligible site and the stopping rule governs.

Everything else is the dev census unchanged: the file walk and its test/cache
exclusions, non-dunder names, at least one call form, at most 14 occurrences of
any form, call-form-only labelling, and no glyph.

Control run, on the development sample rich (not a sample repository): 1134
candidate call sites from 497 eligible targets, 192 sites matching more than one
target, identical output for the same seed and a different order for another.

Run at the draw seed on the three chosen repositories, each at its pin, read-only
and with no glyph:

| repository | candidate call sites | eligible targets | sites matching more than one target | output sha256 (first 12) |
|---|---|---|---|---|
| attrs | 273 | 128 | 25 | `a1336b067b9d` |
| pydantic | 1,630 | 670 | 182 | `8e4aa82abd19` |
| luigi | 2,085 | 1,152 | 466 | `6c37b636a662` |

Re-running `attrs` at the same seed reproduced its file byte for byte. The
enumerations stay out of the repository: only their counts and hashes are
recorded here, so that reading this document reveals nothing about the sample
that the labels must not see.

## 6. The (a49) item 7 hold list, as amended — every item landed

Each ref below is an ancestor of `6602d626`. Any item not landed stops this
pre-registration and goes to opum-doc (a99 item 3(i)). DEC-303 (a100) fixes this
table at 28 tasks. GCLI-117's record is closed in this same commit, records-only,
on `37c4ad20` (#190) as its evidence.

| task | what | landed at |
|---|---|---|
| GCLI-116 | a resolved from-import or module-attribute call reads m's module-level bindings | `2839788d` |
| GCLI-115 | del is a scope binding; nonlocal placement (record closed) | `6f1dd895` |
| GCLI-117 | A2, module.Class.method resolves | `37c4ad20` |
| GCLI-112 | PEP 695 type parameters bind no name | `3a422ec1` |
| GCLI-118 | N3 re-export hop (and N2, folded by a50 item 4) | `b3fd5d3e` |
| GCLI-119 | TS, a local bound to type(self) or self.__class__ | `cfdcdeac` |
| GCLI-120 | C.__class__ alias with def __class__; star trust (a57 item 2) | `e1dc2fc7` |
| GCLI-122 | self.__class__ refuses on an in-repo descendant binding __class__ (a58) | `78396339` |
| GCLI-121 | Q1, completed annotation reading | `3653b12c` |
| GCLI-124 | item 9, aliased conditional hop | `3871e4d5` |
| GCLI-125 | N-6, a conditional star after an unconditional def (a62 item 6) | `2096450b` |
| GCLI-127 | two conditional stars: m.f gives both alternatives | `9d900247` |
| GCLI-136 | a skipped body's __all__ does not certify the star (a67) | `3b9662d2` |
| GCLI-140 | the attribute-write rule (a25) | `bb0c0276` |
| GCLI-141 | NB-b, re-export through a differently named module file (a28) | `d65c6d3f` |
| GCLI-142 | step 5, the rich measurement of (a23) item 7 | `0e72f09` |
| GCLI-144 | a class-body read never resolves through an enclosing function (a73) | `02043cd3` |
| GCLI-146 | a lazy class-body read refuses; N1a and N1b folded (a76) | `18b68a79` |
| GCLI-151 | attribute-write Q-B and Q-C umbrella (a79 item 3) | `5e9f4215` (closed `d0ea6bc`) |
| GCLI-154 | attribute-write binder side | `d75dc3bd` |
| GCLI-155 | attribute-write read-side one-path consumers | `88baaa91` |
| GCLI-156 | attribute-write heavy read-side shapes, #6 | `4b29ee71` |
| GCLI-159 | gated-MRO read-side machinery | `fee6946a` |
| GCLI-161 | F1, F2, F3 and the written-base counterexample | `e41c25b5` |
| GCLI-163 | N7, cross-module __class__ write | `6a5ce9d7` |
| GCLI-164 | #4 re-dispatch and N8 diamond super | `f4e8c8c6` |
| GCLI-169 | duplicate imports of one symbol are one binding (a92 item 3 rule) | `dd1781ce` |
| GCLI-171 | the #6 descendant loop walks each descendant's MRO (a94 item 5) | `21ae53ee` |

Not hold items, and why: the (a49) item 2 cross-module twin was NAMED, NOT QUEUED
(a50 item 2); N2 was folded into GCLI-118 (a50 item 4); the (a58) item 3 lone
nonlocal-moved binding has no input and is named, not queued; the (a94) item 4
narrowing was superseded by (a98) item 2, and GCLI-172 has no hold and does not
gate the freeze (a99 item 5). GCLI-147 is the test-only follow-up to GCLI-144 and
landed at `bc74515`.

## 7. Stated limits recorded by DEC-303 (a99 item 3(ii))

These are not built before the draw. Each is reported with the result.

1. **5.1, instance-bound ALIAS**: a local bound to a bound method whose class is
   known only through the instance is not modelled ((a93) item 2; GCLI-114).
2. **5.5, Q2**: `self.attr.m()` is a deferred category, not a build-order rule
   ((a93) item 2).
3. **6.0, Q3**: the same, for the Q3 receiver form.
4. **N5**: a class whose `__new__` returns a descendant that writes the method
   still resolves `x = C(); x.m()` to `C.m` ((a95) item 2; measured, pinned on
   GCLI-172, no fix ruled).
5. **The trailing star import**: two named imports bind a name and a trailing
   `from .other import *` rebinds it through `__all__`; the change resolves the
   named import ((a96) item 1).
6. **An external or opaque base in the #6 MRO walk**: `class D(C, ExtMixin)` with
   the write inside `ExtMixin` is not seen ((a98) item 3).
7. **The #6 loop's exact-class over-refusal**: it refuses paths that can only hold
   a fresh exact class; the narrowing moved to GCLI-172 and stays on dev
   ((a97) item 1, (a98) item 2, (a99) item 5).
8. **Writes from outside the analysed modules, and setattr with a non-literal
   name** ((a25) item 1, last bullet).
9. **An in-repo MRO entry that overrides `__getattribute__`** is not modelled ((a58)).
10. **Imports in a `finally`, or in a try whose try has only a `finally`**, are
    treated as alternatives, flagged multiplyBound, and the order-blind treatment
    of import alternatives can give `[m.f, o.f]` where Python gives `m.f` alone
    ((a62) item 5, named known limits).
11. **An unpositioned rebinding before a star** (`def f` / `f = None` /
    `from x import *`) gives no edge: a lost edge, not a wrong one (GCLI-118 known
    limit).
12. **A class-body alias's PEP 696 default**: every call in the default refuses
    (a superset rule, measured; restoring the edges is recall work on GCLI-148)
    ((a77) item 1).
13. **A non-enumerable alias** (`enumerableBindings === null`): named as a blind
    spot, measured on the five pins, not built ((a82); GCLI-164).
14. Named, not queued: an explicitly class-qualified call through a literal class
    name; the lone nonlocal-moved binding at `calls.ts:3433`; `del` as a
    scope-but-not-value binding ((a41) item 2).

## 8. The scored run and the pass criterion

One run, on the built `dist/glyph.js` from the frozen head, over a clean checkout
of each repository at its pin, with an empty cache, failing closed ((a17) items 1
and 2; (a36) item 7). The run records glyph's commit, the dist sha256, each
repository's commit, and the files and sites read. One run; a FAIL is reported and
spends the sample, and the next attempt uses a new seed and new repositories.

Per repository, on the independent, all-attributable denominator: recall at least
0.9, its site-level Wilson 95% lower bound at least 0.8, precision at least 0.95.
The sample passes only when every repository passes. Per-category numbers, the
excluded share, the bins, the A1 stratum and the pyright-comparable side are
reported, not gated. No threshold moves after the result ((a36) item 6).

## 9. What this document does not claim

The development reading, rich 63/66 = 0.9545 at `6602d626`, is development data:
the rules were tuned on rich, and both flips are the sites GCLI-169 was designed
from. It is not a prediction that the sample will pass. The per-repository budget
is 6 misses in 62 true sites; the known exposure is Q2 and Q3 receivers; precision
is not measured on development data ((a99) item 4).
