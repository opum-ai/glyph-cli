#!/usr/bin/env python3
"""Gate scorer for the held-out Python gate (GCLI-72, ADR 0008, DEC-303 (a3)).

Scores a GlyphIndex JSON (the shape in ``src/types.ts``) for a repository checkout
against the committed held-out ground truth: click 7.1.2 in ``click-7.1.2/`` and
requests at 3c7baaa in ``requests-3c7baaa/`` (with
``../python-lsp-measurement/gt3_classified.json`` as the requests pyright baseline).

Standard library only; run with ``python3 -I``.

Mapping (ADR 0008, "The gate", conventions; fixed before any analyzer run)
--------------------------------------------------------------------------
A ground-truth target is identified by file + def/class keyword line + qualname
(``targets.json``; Addendum 5 of ``gt_rules_click.md`` fixes the line as the
``def``/``class`` keyword line, which is ``ast``'s ``lineno`` under Python 3.8+).
``SymbolEntry`` in ``src/types.ts`` carries no ``qualname`` field, so the reading
used here is: the symbol's qualified name is ``name`` when ``container`` is null
and ``container + "." + name`` otherwise. A target maps to the one index symbol
with the same package-relative ``file``, the same ``line`` and that reconstructed
qualified name. A nested function therefore needs its ``container`` to be the
enclosing qualified name (for ``Parameter.type_cast_value._convert``,
``container = "Parameter.type_cast_value"``), not merely the nearest class; a
target with no such symbol is reported and the run fails (exit 6) rather than
being scored as a miss.

A ground-truth site matches a glyph edge when the file and the first line of the
call expression (``call_start_line`` in ``classified-batch0.json``) agree; sites
of one target on one line match by multiplicity. Only edges whose caller (the
``SiteEntry.file``) is under the scored package directory are scored.

Conventions (each ruling cited where it is implemented)
-------------------------------------------------------
* True / poly / excluded / other-definition: ``gt_rules_click.md`` R1'-R5' with
  Addenda 1-4. A ``poly`` site is reported separately and is NOT scored (Addendum
  3 option A, ruled by Addendum 4 Q4): it is neither a recall miss nor a false
  positive. An ``excluded`` site is ignored by recall and precision and counted by
  reason. Any other candidate of the target is ``other-definition``; an emitted
  edge there is a false positive, and so is an emitted edge at a site that is not
  a candidate of that target at all.
* Recall has two denominators (DEC-303 (a2) item 2, Addendum 4 Q3):
  ALL-ATTRIBUTABLE = every true site; PYRIGHT-COMPARABLE = true sites with
  ``receiver_evidence = direct``. The site-level 95% Wilson interval (z = 1.96)
  is the gating figure (DEC-303 (a2) item 4); the target-level figure and the
  cluster bootstrap are information only.
* Precision has two sides (Addendum 4 Q3): INDEPENDENT counts every emitted edge
  to a seeded target inside the scored files, excluding poly and excluded sites;
  COMPARABLE drops emitted edges at sites whose evidence is ``inferred`` (a true
  site with ``receiver_evidence = inferred``, or a non-true site flagged
  ``inferred`` in ``non-true-site-evidence-batch0.json``). Precision is a point
  value gated at >= 0.95; its Wilson interval is printed as information only.
* Gate per denominator: recall >= 0.9 AND Wilson lower bound >= 0.8 AND precision
  >= 0.95 on the matching precision side.
* Requests denominators (Addendum 5 item 1): the pyright-comparable recall
  denominator is ``gt3_classified.json``'s 65 (the set pyright's baseline was
  scored on, kept byte-identical); the independent denominator is
  ``classified-requests-independent.json``'s 65. They coincide today; the
  direct-only count (64) is printed as information. The comparable precision side
  drops emitted edges at inferred sites exactly as for click.
* Overload groups (requests, Addendum 6 item 1): a target keyed to an ``@overload``
  stub is mapped to the index symbol at the implementation line in
  ``overload-groups.json``; ``targets.json`` and the classification stay keyed as
  committed. A target with no symbol at the expected line is missing (exit 6).
  Click has no overloads.

Exit codes
----------
0  the score ran (the verdict is in the output, pass or fail)
2  usage error (argparse)
6  an input is malformed, or a ground-truth target has no matching symbol
7  the index holds zero invocation edges inside the scored package (a scored run
   that read nothing must fail rather than pass: the positive-control rule)

The ``mutations`` keyword argument to :func:`score_click` / :func:`score_requests`
is a test-only hook used to prove that flipping a convention changes the output;
the command-line interface never sets it and the defaults are the ruled ones.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import os
import random
import sys

# --- the gate's constants ---------------------------------------------------

Z = 1.96                      # score.py / union.py / wilson_floor.py (ADR 0008)
BOOTSTRAP_RESAMPLES = 10000   # union.py convention
BOOTSTRAP_SEED = 20261123     # union.py convention
RECALL_FLOOR = 0.9
WILSON_FLOOR = 0.8
PRECISION_FLOOR = 0.95

DEFAULT_CLICK_PACKAGE_DIR = "src/click"
DEFAULT_REQUESTS_PACKAGE_DIR = "src/requests"
CLICK_TRUTH_SUBDIR = "click-7.1.2"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_MALFORMED = 6
EXIT_INDETERMINATE = 7

# "call" and "new" are the invocation kinds in src/types.ts (CALL_KINDS). The
# "decorator" kind is the additive contract entry ADR 0008 proposes, and the ADR
# says a decorator application is scored as an incoming edge to the decorated
# name, so it is scored here too. Batch 0 has no decorator sites.
INVOCATION_KINDS = ("call", "new", "decorator")
VALID_SITE_KINDS = ("call", "new", "decorator", "import", "extends", "implements")
UNRESOLVED_BINS = ("call", "import", "extends", "implements", "dynamic")

# Test-only mutation names (never set by the CLI). See score_click().
MUTATIONS = (
    "comparable-includes-inferred",  # denominator choice
    "poly-counts-as-fp",             # poly handling
    "excluded-counts-as-fp",         # excluded handling (companion to poly)
    "comparable-keeps-inferred",     # comparable-side exclusion
    "no-directory-filter",           # directory filter
    "match-ignore-line",             # line match
    "no-overload-map",               # overload -> implementation mapping (requests)
    "comparable-direct-only-denominator",  # gt3 denominator -> direct-only (requests)
)


class GateError(Exception):
    """A failure carrying the process exit code the CLI should return."""

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = list(details or [])


# --- small helpers ----------------------------------------------------------

def wilson(k, n, z=Z):
    """The 95% Wilson score interval, copied from score.py / union.py (z = 1.96)."""
    if n <= 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    a = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - a) / d), min(1.0, (c + a) / d))


def fmt_frac(k, n):
    """Format ``k/n`` with the Wilson interval, the printed format of score.py."""
    if n <= 0:
        return f"{k}/{n} = n/a (n=0)"
    lo, hi = wilson(k, n)
    return f"{k}/{n} = {k / n:.4f} (95% Wilson {lo:.4f}-{hi:.4f})"


def fmt_rate(rate):
    return "n/a" if rate is None else f"{rate:.4f}"


def sha256_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def read_json(path, what):
    """Read a JSON file, returning (object, raw bytes). A read/parse error is exit 6."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        raise GateError(EXIT_MALFORMED, f"cannot read {what} {path!r}: {exc}")
    try:
        return json.loads(raw.decode("utf-8")), raw
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GateError(EXIT_MALFORMED, f"{what} {path!r} is not valid JSON: {exc}")


def package_relative(path, package_dir):
    """The path relative to the scored package dir, or None when outside it.

    ``package_dir`` of "" means the index already names files relative to the
    package (the package directory was the index's root).
    """
    if not isinstance(path, str):
        return None
    if package_dir in ("", None):
        return path
    prefix = package_dir.rstrip("/") + "/"
    if path.startswith(prefix):
        return path[len(prefix):]
    return None


def symbol_qualname(symbol):
    """Reconstruct a symbol's qualified name from ``container`` and ``name``."""
    name = symbol.get("name")
    container = symbol.get("container")
    if name is None:
        return None
    return f"{container}.{name}" if container else name


def make_key(file, line, qualname):
    return f"{file}:{line} {qualname}"


# --- index validation -------------------------------------------------------

def validate_index_shape(index):
    """Validate the GlyphIndex structure; raise GateError(6) on anything malformed."""
    if not isinstance(index, dict):
        raise GateError(EXIT_MALFORMED, "index is not a JSON object")
    for key in ("symbols", "sites", "unresolvedByKind"):
        if key not in index:
            raise GateError(EXIT_MALFORMED, f"index is missing required key {key!r}")
    if not isinstance(index["symbols"], list):
        raise GateError(EXIT_MALFORMED, "index.symbols is not a list")
    if not isinstance(index["sites"], list):
        raise GateError(EXIT_MALFORMED, "index.sites is not a list")
    unresolved = index["unresolvedByKind"]
    if not isinstance(unresolved, dict):
        raise GateError(EXIT_MALFORMED, "index.unresolvedByKind is not an object")
    for bin_name in UNRESOLVED_BINS:
        if bin_name not in unresolved:
            raise GateError(EXIT_MALFORMED, f"index.unresolvedByKind is missing {bin_name!r}")
        if not isinstance(unresolved[bin_name], int) or isinstance(unresolved[bin_name], bool):
            raise GateError(EXIT_MALFORMED, f"index.unresolvedByKind.{bin_name} is not an integer")
    for i, symbol in enumerate(index["symbols"]):
        if not isinstance(symbol, dict):
            raise GateError(EXIT_MALFORMED, f"index.symbols[{i}] is not an object")
        for field in ("id", "name", "file", "line"):
            if field not in symbol:
                raise GateError(EXIT_MALFORMED, f"index.symbols[{i}] is missing {field!r}")
        if not isinstance(symbol["line"], int) or isinstance(symbol["line"], bool):
            raise GateError(EXIT_MALFORMED, f"index.symbols[{i}].line is not an integer")
    for i, site in enumerate(index["sites"]):
        if not isinstance(site, dict):
            raise GateError(EXIT_MALFORMED, f"index.sites[{i}] is not an object")
        for field in ("file", "line", "kind"):
            if field not in site:
                raise GateError(EXIT_MALFORMED, f"index.sites[{i}] is missing {field!r}")
        if not isinstance(site["line"], int) or isinstance(site["line"], bool):
            raise GateError(EXIT_MALFORMED, f"index.sites[{i}].line is not an integer")
        if site["kind"] not in VALID_SITE_KINDS:
            raise GateError(
                EXIT_MALFORMED,
                f"index.sites[{i}].kind {site['kind']!r} is not a known SiteKind",
                [f"known kinds: {', '.join(VALID_SITE_KINDS)}"],
            )


def index_symbols_by_id(index):
    by_id = {}
    for symbol in index["symbols"]:
        sid = symbol["id"]
        if sid in by_id:
            raise GateError(EXIT_MALFORMED, f"index has two symbols with id {sid!r}")
        by_id[sid] = symbol
    return by_id


def count_invocation_edges(index, package_dir, mutations=frozenset()):
    """Invocation edges whose caller file is inside the scored package."""
    n = 0
    for site in index["sites"]:
        if site["kind"] not in INVOCATION_KINDS:
            continue
        if package_relative(site["file"], package_dir) is not None:
            n += 1
        elif "no-directory-filter" in mutations:
            n += 1
    return n


# --- ground truth: click ----------------------------------------------------

def _require(condition, message, details=None):
    if not condition:
        raise GateError(EXIT_MALFORMED, message, details)


def _site_string(candidate):
    return f"{candidate['file']}:{candidate['line']}:{candidate['col']}"


def load_click_truth(truth_dir):
    """Load and validate the committed click ground truth (batch 0).

    Returns a dict with the per-target scoring records, the committed summary, and
    the source files (path, sha256, size) for the report.
    """
    base = os.path.join(truth_dir, CLICK_TRUTH_SUBDIR)
    paths = {
        "targets": os.path.join(base, "targets.json"),
        "classified": os.path.join(base, "classified-batch0.json"),
        "evidence": os.path.join(base, "non-true-site-evidence-batch0.json"),
    }
    targets_raw, targets_bytes = read_json(paths["targets"], "targets.json")
    classified_raw, classified_bytes = read_json(paths["classified"], "classified-batch0.json")
    evidence_raw, evidence_bytes = read_json(
        paths["evidence"], "non-true-site-evidence-batch0.json"
    )

    _require(isinstance(targets_raw, list), "targets.json is not a list")
    _require(isinstance(classified_raw, dict), "classified-batch0.json is not an object")
    _require(
        isinstance(classified_raw.get("summary"), dict)
        and isinstance(classified_raw.get("targets"), dict),
        "classified-batch0.json is missing 'summary' or 'targets'",
    )
    _require(isinstance(evidence_raw, dict), "non-true-site-evidence-batch0.json is not an object")

    tinfo = {}
    for target in targets_raw:
        _require(isinstance(target, dict), "targets.json holds a non-object entry")
        for field in ("file", "name", "qualname", "line", "batch", "candidates"):
            _require(field in target, f"a targets.json entry is missing {field!r}")
        key = make_key(target["file"], target["line"], target["qualname"])
        _require(key not in tinfo, f"targets.json repeats the target {key!r}")
        tinfo[key] = target

    # Evidence is keyed "<target key> | <site>" (Addendum 4 Q3).
    evidence_by_target = collections.defaultdict(dict)
    for raw_key, flag in evidence_raw.items():
        _require(
            isinstance(raw_key, str) and " | " in raw_key,
            "an evidence key is not '<target key> | <site>'",
            [repr(raw_key)],
        )
        target_key, site = raw_key.split(" | ", 1)
        _require(flag in ("direct", "inferred"), f"evidence {raw_key!r} is not direct/inferred")
        _require(target_key in tinfo, f"evidence names an unknown target {target_key!r}")
        _require(site not in evidence_by_target[target_key], f"evidence repeats {raw_key!r}")
        evidence_by_target[target_key][site] = flag

    seeds = {}
    totals = collections.Counter()
    excluded_reasons = collections.Counter()
    batch_seen = set()

    for key, classification in classified_raw["targets"].items():
        _require(key in tinfo, f"classified-batch0.json names an unknown target {key!r}")
        target = tinfo[key]
        _require(
            target["batch"] == 0,
            f"classified-batch0.json names {key!r} but targets.json gives batch {target['batch']}",
        )
        batch_seen.add(key)

        candidates = target["candidates"]
        _require(isinstance(candidates, list), f"target {key!r} has non-list candidates")
        cand_by_site = {}
        for candidate in candidates:
            site = _site_string(candidate)
            _require(site not in cand_by_site, f"target {key!r} repeats candidate site {site!r}")
            cand_by_site[site] = candidate

        true, poly, excluded = [], [], []
        listed = set()

        for entry in classification.get("true", []):
            _require(entry.get("site") in cand_by_site, f"{key!r}: true site {entry.get('site')!r} is not a candidate")
            candidate = cand_by_site[entry["site"]]
            _require(
                entry.get("receiver_evidence") in ("direct", "inferred"),
                f"{key!r}: true site {entry['site']!r} has no receiver_evidence",
            )
            listed.add(entry["site"])
            true.append({
                "site": entry["site"],
                "file": candidate["file"],
                "line": candidate["call_start_line"],
                "evidence": entry["receiver_evidence"],
            })

        for label, bucket in (("poly", poly), ("excluded", excluded)):
            for entry in classification.get(label, []):
                site = entry.get("site")
                _require(site in cand_by_site, f"{key!r}: {label} site {site!r} is not a candidate")
                candidate = cand_by_site[site]
                flag = evidence_by_target.get(key, {}).get(site)
                _require(flag is not None, f"{key!r}: {label} site {site!r} has no evidence flag")
                listed.add(site)
                record = {
                    "site": site,
                    "file": candidate["file"],
                    "line": candidate["call_start_line"],
                    "evidence": flag,
                }
                if label == "excluded":
                    _require("reason" in entry, f"{key!r}: excluded site {site!r} has no reason")
                    record["reason"] = entry["reason"]
                    excluded_reasons[entry["reason"]] += 1
                bucket.append(record)

        other_definition = []
        for site, candidate in cand_by_site.items():
            if site in listed:
                continue
            flag = evidence_by_target.get(key, {}).get(site)
            _require(
                flag is not None,
                f"{key!r}: other-definition candidate {site!r} has no evidence flag",
                ["every non-true candidate must carry direct/inferred (Addendum 4 Q3)"],
            )
            other_definition.append({
                "site": site,
                "file": candidate["file"],
                "line": candidate["call_start_line"],
                "evidence": flag,
            })

        _require(
            classification.get("other_definition") == len(other_definition),
            f"{key!r}: other_definition count {classification.get('other_definition')} "
            f"!= {len(other_definition)} reconstructed candidates",
        )

        # Evidence may only name non-true candidate sites.
        true_sites = {entry["site"] for entry in true}
        for site in evidence_by_target.get(key, {}):
            _require(
                site in cand_by_site and site not in true_sites,
                f"{key!r}: evidence given for {site!r}, which is not a non-true candidate",
            )

        comparable = collections.Counter()
        for entry in true:
            if entry["evidence"] == "direct":
                comparable[(entry["file"], entry["line"])] += 1
        seeds[key] = {
            "file": target["file"],
            "line": target["line"],
            "symbol_line": target["line"],
            "qualname": target["qualname"],
            "candidates": candidates,
            "true": true,
            "poly": poly,
            "excluded": excluded,
            "other_definition": other_definition,
            "comparable_lines": comparable,
        }
        totals["true"] += len(true)
        totals["true_direct"] += sum(1 for entry in true if entry["evidence"] == "direct")
        totals["true_inferred"] += sum(1 for entry in true if entry["evidence"] == "inferred")
        totals["poly"] += len(poly)
        totals["excluded"] += len(excluded)
        totals["other_definition"] += len(other_definition)

    _require(
        batch_seen == set(tinfo) or all(tinfo[key]["batch"] == 0 for key in batch_seen),
        "classified-batch0.json must name only batch-0 targets",
    )

    summary = classified_raw["summary"]
    recomputed = {
        "targets": len(seeds),
        "true": totals["true"],
        "true_direct": totals["true_direct"],
        "true_inferred": totals["true_inferred"],
        "poly": totals["poly"],
        "excluded": totals["excluded"],
        "other_definition": totals["other_definition"],
        "targets_with_a_true_site": sum(1 for s in seeds.values() if s["true"]),
        "zero_truth_targets": sum(1 for s in seeds.values() if not s["true"]),
    }
    for field, value in recomputed.items():
        _require(
            summary.get(field) == value,
            f"classified-batch0.json summary {field}={summary.get(field)!r} "
            f"does not match the recomputed {value!r}",
        )

    sources = [
        ("targets", paths["targets"], sha256_bytes(targets_bytes), len(targets_bytes)),
        ("classified", paths["classified"], sha256_bytes(classified_bytes), len(classified_bytes)),
        ("evidence", paths["evidence"], sha256_bytes(evidence_bytes), len(evidence_bytes)),
    ]
    return {
        "kind": "click",
        "seeds": seeds,
        "summary": dict(summary),
        "excluded_reasons": dict(excluded_reasons),
        "direct_only": totals["true_direct"],
        "overloads": {},
        "sources": sources,
    }


# --- target models ----------------------------------------------------------

class TargetModel:
    """Per-line ground-truth buckets for one target."""

    __slots__ = (
        "key", "true_lines", "true_direct_lines", "true_inferred_lines",
        "poly_lines", "excluded_lines", "other_definition_lines", "line_evidence",
        "comparable_lines", "true_total", "true_direct_total", "comparable_total",
    )

    def __init__(self, key, seed):
        self.key = key
        self.true_lines = collections.Counter()
        self.true_direct_lines = collections.Counter()
        self.true_inferred_lines = collections.Counter()
        self.poly_lines = collections.Counter()
        self.excluded_lines = collections.Counter()
        self.other_definition_lines = collections.Counter()
        self.line_evidence = collections.defaultdict(set)

        for entry in seed["true"]:
            where = (entry["file"], entry["line"])
            self.true_lines[where] += 1
            if entry["evidence"] == "direct":
                self.true_direct_lines[where] += 1
            else:
                self.true_inferred_lines[where] += 1
            self.line_evidence[where].add(entry["evidence"])
        for entry in seed["poly"]:
            where = (entry["file"], entry["line"])
            self.poly_lines[where] += 1
            self.line_evidence[where].add(entry["evidence"])
        for entry in seed["excluded"]:
            where = (entry["file"], entry["line"])
            self.excluded_lines[where] += 1
            self.line_evidence[where].add(entry["evidence"])
        for entry in seed["other_definition"]:
            where = (entry["file"], entry["line"])
            self.other_definition_lines[where] += 1
            self.line_evidence[where].add(entry["evidence"])

        # The comparable recall denominator: direct true sites for click, the
        # gt3 baseline set for requests. Both are "true sites" tallied per line.
        comparable = seed.get("comparable_lines")
        if comparable is None:
            comparable = collections.Counter(self.true_direct_lines)
        self.comparable_lines = collections.Counter(comparable)

        self.true_total = sum(self.true_lines.values())
        self.true_direct_total = sum(self.true_direct_lines.values())
        self.comparable_total = sum(self.comparable_lines.values())

    def collapsed_by_file(self):
        """The same model with the line component removed, for the line-match mutation."""
        clone = TargetModel.__new__(TargetModel)
        clone.key = self.key
        clone.true_lines = _collapse_counter(self.true_lines)
        clone.true_direct_lines = _collapse_counter(self.true_direct_lines)
        clone.true_inferred_lines = _collapse_counter(self.true_inferred_lines)
        clone.poly_lines = _collapse_counter(self.poly_lines)
        clone.excluded_lines = _collapse_counter(self.excluded_lines)
        clone.other_definition_lines = _collapse_counter(self.other_definition_lines)
        clone.comparable_lines = _collapse_counter(self.comparable_lines)
        merged = collections.defaultdict(set)
        for (file, _line), flags in self.line_evidence.items():
            merged[(file, 0)] |= flags
        clone.line_evidence = merged
        clone.true_total = self.true_total
        clone.true_direct_total = self.true_direct_total
        clone.comparable_total = self.comparable_total
        return clone


def _collapse_counter(counter):
    out = collections.Counter()
    for (file, _line), count in counter.items():
        out[(file, 0)] += count
    return out


# --- segment mapping --------------------------------------------------------

def _target_symbol_line(seed, mutations):
    """The def line the index must carry for this target (overload-aware).

    A target keyed to an @overload stub maps to the implementation line
    (Addendum 6 item 1). The ``no-overload-map`` mutation uses the committed
    stub line instead, to prove the mapping is load-bearing.
    """
    if "no-overload-map" in mutations:
        return seed["line"]
    return seed.get("symbol_line", seed["line"])


def _match_target_symbols(index, truth, package_dir, mutations=frozenset()):
    """Return {target key: symbol} or raise exit 6 for every unmatched target."""
    by_signature = collections.defaultdict(list)
    for symbol in index["symbols"]:
        relative = package_relative(symbol["file"], package_dir)
        if relative is None:
            continue
        by_signature[(relative, symbol["line"], symbol_qualname(symbol))].append(symbol)

    matched, missing = {}, []
    for key, seed in truth["seeds"].items():
        wanted_line = _target_symbol_line(seed, mutations)
        found = by_signature.get((seed["file"], wanted_line, seed["qualname"]), [])
        if not found:
            missing.append(
                f"{key}  (expected a symbol at {seed['file']}:{wanted_line} with "
                f"qualified name {seed['qualname']!r})"
            )
        elif len(found) > 1:
            raise GateError(
                EXIT_MALFORMED,
                f"target {key!r} matches {len(found)} symbols in the index",
                [f"ids: {', '.join(str(s['id']) for s in found)}"],
            )
        else:
            matched[key] = found[0]
    if missing:
        raise GateError(
            EXIT_MALFORMED,
            f"{len(missing)} ground-truth target(s) have no matching symbol in the index; "
            "refusing to score them as misses (ADR 0008, mapping)",
            missing,
        )
    return matched


def _map_emitted_edges(index, truth, package_dir, mutations):
    """Map emitted invocation edges to seeded targets, keyed by (site file, line)."""
    symbols_by_id = index_symbols_by_id(index)
    signature_to_key = {
        (seed["file"], _target_symbol_line(seed, mutations), seed["qualname"]): key
        for key, seed in truth["seeds"].items()
    }
    emitted = collections.defaultdict(collections.Counter)
    stats = collections.Counter()
    for site in index["sites"]:
        if site["kind"] not in INVOCATION_KINDS:
            continue
        relative_site = package_relative(site["file"], package_dir)
        if relative_site is None:
            if "no-directory-filter" in mutations:
                relative_site = site["file"]
            else:
                stats["outside_package"] += 1
                continue
        stats["in_scope_edges"] += 1
        callee_id = site.get("calleeId")
        if callee_id is None:
            stats["null_callee"] += 1
            continue
        symbol = symbols_by_id.get(callee_id)
        if symbol is None:
            raise GateError(
                EXIT_MALFORMED,
                f"site at {site['file']}:{site['line']} references unknown calleeId {callee_id!r}",
            )
        relative_def = package_relative(symbol["file"], package_dir)
        key = signature_to_key.get(
            (relative_def, symbol["line"], symbol_qualname(symbol))
        )
        if key is None:
            stats["not_seeded"] += 1
            continue
        emitted[key][(relative_site, site["line"])] += 1
        stats["to_seeded"] += 1
    return emitted, stats


# --- scoring ----------------------------------------------------------------

def _score_target(model, emitted, mutations):
    """Score one target; return independent and comparable recall/precision pieces."""
    tp_independent = fp_independent = 0
    tp_comparable = fp_comparable = 0
    found_comparable = 0
    for where, emitted_count in emitted.items():
        true_count = model.true_lines.get(where, 0)
        direct_count = model.true_direct_lines.get(where, 0)
        poly_count = model.poly_lines.get(where, 0)
        excluded_count = model.excluded_lines.get(where, 0)

        tp_line = min(emitted_count, true_count)
        remaining = emitted_count - tp_line

        # Poly and excluded sites are ignored (Addendum 4 Q4 / R5').
        ignore_capacity = 0
        if "poly-counts-as-fp" not in mutations:
            ignore_capacity += poly_count
        if "excluded-counts-as-fp" not in mutations:
            ignore_capacity += excluded_count
        ignored_line = min(remaining, ignore_capacity)
        fp_line = remaining - ignored_line

        tp_independent += tp_line
        fp_independent += fp_line
        # Comparable RECALL numerator: true sites found against that denominator's
        # own true set (direct-only for click; gt3 for requests).
        found_comparable += min(emitted_count, model.comparable_lines.get(where, 0))

        # Comparable PRECISION side drops emitted edges at inferred sites (Addendum 4 Q3).
        evidence = model.line_evidence.get(where, set())
        line_is_inferred = bool(evidence) and evidence <= {"inferred"}
        if "comparable-keeps-inferred" in mutations:
            line_is_inferred = False
        if not line_is_inferred:
            tp_comparable += min(emitted_count, direct_count)
            fp_comparable += fp_line

    return {
        "tp_independent": tp_independent,
        "fp_independent": fp_independent,
        "fn_independent": model.true_total - tp_independent,
        "found_comparable": found_comparable,
        "comparable_total": model.comparable_total,
        "fn_comparable": model.comparable_total - found_comparable,
        "tp_comparable": tp_comparable,
        "fp_comparable": fp_comparable,
        "true_total": model.true_total,
        "true_direct_total": model.true_direct_total,
    }


def cluster_bootstrap(rows, resamples=BOOTSTRAP_RESAMPLES, seed=BOOTSTRAP_SEED):
    """95% percentile interval of recall by resampling targets (union.py convention)."""
    rows = [row for row in rows if row[0] + row[2] > 0]
    if not rows:
        return (None, None)
    rng = random.Random(seed)
    n = len(rows)
    samples = []
    for _ in range(resamples):
        tp = fn = 0
        for _ in range(n):
            row = rows[rng.randrange(n)]
            tp += row[0]
            fn += row[2]
        if tp + fn:
            samples.append(tp / (tp + fn))
    if not samples:
        return (None, None)
    samples.sort()

    def quantile(p):
        return samples[int(p * (len(samples) - 1))]

    return (quantile(0.025), quantile(0.975))


def unresolved_report(index):
    """Per-bin unresolved shares from index.unresolvedByKind beside recall."""
    unresolved = index["unresolvedByKind"]
    resolved = collections.Counter(site["kind"] for site in index["sites"])

    def share(bin_name, resolved_kinds):
        r = sum(resolved[kind] for kind in resolved_kinds)
        u = unresolved[bin_name]
        total = r + u
        return {"resolved": r, "unresolved": u, "share": (u / total if total else None)}

    return {
        "resolved_by_kind": dict(resolved),
        "call": share("call", ("call", "new")),
        "import": share("import", ("import",)),
        "extends": share("extends", ("extends",)),
        "implements": share("implements", ("implements",)),
        "dynamic": {"unresolved": unresolved["dynamic"], "share": None},
    }


def _verdict(recall_found, recall_denominator, precision_found, precision_denominator):
    recall = recall_found / recall_denominator if recall_denominator else None
    interval = wilson(recall_found, recall_denominator)
    precision = (
        precision_found / precision_denominator if precision_denominator else None
    )
    recall_ok = recall is not None and recall >= RECALL_FLOOR
    wilson_ok = interval[0] is not None and interval[0] >= WILSON_FLOOR
    precision_ok = precision is not None and precision >= PRECISION_FLOOR
    return {
        "recall": recall,
        "recall_found": recall_found,
        "recall_denominator": recall_denominator,
        "wilson": interval,
        "precision": precision,
        "precision_found": precision_found,
        "precision_denominator": precision_denominator,
        "recall_ok": recall_ok,
        "wilson_ok": wilson_ok,
        "precision_ok": precision_ok,
        "pass": bool(recall_ok and wilson_ok and precision_ok),
    }


def _score_classified(truth, index, package_dir, mutations=frozenset()):
    """Score a GlyphIndex against a loaded classification ground truth.

    Shared by click and requests. ``mutations`` is a test-only set of names from
    :data:`MUTATIONS`; the CLI never passes it. The default is the ruled behaviour.
    """
    mutations = frozenset(mutations)
    unknown = mutations - set(MUTATIONS)
    if unknown:
        raise ValueError(f"unknown mutation(s): {sorted(unknown)}")

    validate_index_shape(index)

    # Positive control first: a run that read no edge must fail, not pass (exit 7).
    in_scope = count_invocation_edges(index, package_dir, mutations)
    if in_scope == 0:
        raise GateError(
            EXIT_INDETERMINATE,
            "the index has zero invocation edges whose caller is under the scored "
            f"package directory {package_dir!r}; a scored run that read nothing fails "
            "rather than passes (positive control)",
            [f"index.sites: {len(index['sites'])} total, {in_scope} in scope"],
        )

    _match_target_symbols(index, truth, package_dir, mutations)
    emitted, edge_stats = _map_emitted_edges(index, truth, package_dir, mutations)

    models = {}
    for key, seed in truth["seeds"].items():
        model = TargetModel(key, seed)
        if "match-ignore-line" in mutations:
            model = model.collapsed_by_file()
        models[key] = model

    if "match-ignore-line" in mutations:
        collapsed = collections.defaultdict(collections.Counter)
        for key, counter in emitted.items():
            collapsed[key] = _collapse_counter(counter)
        emitted = collapsed

    per_target = {}
    totals = collections.Counter()
    rows_independent = []
    rows_comparable = []
    targets_fully_independent = 0
    targets_fully_comparable = 0
    targets_with_true = 0
    targets_with_direct = 0
    targets_with_comparable = 0

    for key in truth["seeds"]:
        model = models[key]
        scored = _score_target(model, emitted.get(key, collections.Counter()), mutations)
        per_target[key] = scored
        totals["tp_independent"] += scored["tp_independent"]
        totals["fp_independent"] += scored["fp_independent"]
        totals["found_comparable"] += scored["found_comparable"]
        totals["tp_comparable"] += scored["tp_comparable"]
        totals["fp_comparable"] += scored["fp_comparable"]
        totals["true"] += scored["true_total"]
        totals["true_direct"] += scored["true_direct_total"]
        totals["comparable_total"] += scored["comparable_total"]

        if model.true_total > 0:
            targets_with_true += 1
            rows_independent.append(
                (scored["tp_independent"], scored["fp_independent"], scored["fn_independent"])
            )
            if scored["tp_independent"] == model.true_total and scored["fp_independent"] == 0:
                targets_fully_independent += 1
        if model.true_direct_total > 0:
            targets_with_direct += 1
        if model.comparable_total > 0:
            targets_with_comparable += 1
            rows_comparable.append(
                (scored["found_comparable"], scored["fp_comparable"], scored["fn_comparable"])
            )
            if (
                scored["found_comparable"] == model.comparable_total
                and scored["fp_comparable"] == 0
            ):
                targets_fully_comparable += 1

    true_total = totals["true"]
    true_direct_total = totals["true_direct"]
    comparable_total = totals["comparable_total"]
    tp_independent = totals["tp_independent"]
    fp_independent = totals["fp_independent"]
    found_comparable = totals["found_comparable"]
    tp_comparable = totals["tp_comparable"]
    fp_comparable = totals["fp_comparable"]
    direct_only = truth.get("direct_only", true_direct_total)

    # Default: the comparable denominator is its own true set (the direct-only true
    # sites for click; gt3_classified.json for requests). Two mutations flip it, for
    # the mutation proof only.
    recall_comparable_found = found_comparable
    recall_comparable_denominator = comparable_total
    if "comparable-includes-inferred" in mutations:
        recall_comparable_found = tp_independent
        recall_comparable_denominator = true_total
    if "comparable-direct-only-denominator" in mutations:
        recall_comparable_found = tp_comparable
        recall_comparable_denominator = direct_only

    verdict_all = _verdict(
        tp_independent, true_total,
        tp_independent, tp_independent + fp_independent,
    )
    verdict_comparable = _verdict(
        recall_comparable_found, recall_comparable_denominator,
        tp_comparable, tp_comparable + fp_comparable,
    )

    return {
        "kind": truth.get("kind", "click"),
        "package_dir": package_dir,
        "edges": dict(edge_stats),
        "unresolved": unresolved_report(index),
        "summary": dict(truth["summary"]),
        "excluded_reasons": dict(truth["excluded_reasons"]),
        "direct_only": direct_only,
        "totals": {
            "true": true_total,
            "true_direct": true_direct_total,
            "true_inferred": true_total - true_direct_total,
            "poly": truth["summary"]["poly"],
            "excluded": truth["summary"]["excluded"],
            "tp_independent": tp_independent,
            "fp_independent": fp_independent,
            "fn_independent": true_total - tp_independent,
            "found_comparable": found_comparable,
            "comparable_total": comparable_total,
            "fn_comparable": comparable_total - found_comparable,
            "tp_comparable": tp_comparable,
            "fp_comparable": fp_comparable,
            "direct_only": direct_only,
        },
        "target_level": {
            "targets_with_true": targets_with_true,
            "targets_with_direct": targets_with_direct,
            "targets_with_comparable": targets_with_comparable,
            "fully_correct_independent": targets_fully_independent,
            "fully_correct_comparable": targets_fully_comparable,
        },
        "bootstrap": {
            "independent": cluster_bootstrap(rows_independent),
            "comparable": cluster_bootstrap(rows_comparable),
        },
        "verdict": {
            "all_attributable": verdict_all,
            "pyright_comparable": verdict_comparable,
        },
        "per_target": per_target,
    }


def score_click(truth, index, package_dir=DEFAULT_CLICK_PACKAGE_DIR, mutations=frozenset()):
    """Score a GlyphIndex against the click batch-0 ground truth.

    ``mutations`` is a test-only set of names from :data:`MUTATIONS`; the CLI never
    passes it. The default behaviour is the ruled behaviour.
    """
    return _score_classified(truth, index, package_dir, mutations)


# --- ground truth: requests -------------------------------------------------

REQUESTS_TRUTH_SUBDIR = "requests-3c7baaa"
REQUESTS_GT3 = os.path.join("..", "python-lsp-measurement", "gt3_classified.json")


def _parse_gt3_true_sites(value, key):
    """Turn gt3's ``["file:line", ...]`` into a Counter of (file, line)."""
    _require(isinstance(value, dict), f"gt3 target {key!r} is not an object")
    true_sites = value.get("true", [])
    _require(isinstance(true_sites, list), f"gt3 target {key!r} has non-list true")
    counter = collections.Counter()
    for site in true_sites:
        _require(
            isinstance(site, str) and ":" in site,
            f"gt3 target {key!r} has a malformed true site {site!r}",
        )
        file, line = site.rsplit(":", 1)
        _require(line.isdigit(), f"gt3 target {key!r} has a non-numeric line in {site!r}")
        counter[(file, int(line))] += 1
    return counter


def load_requests_truth(truth_dir):
    """Load and validate the requests classification and the gt3 baseline.

    Returns the same shape as :func:`load_click_truth`, plus the overload map. The
    classification (``classified-requests-independent.json``) is the independent
    recall set and the source of the precision categories; ``gt3_classified.json``
    is the pyright-comparable recall set (Addendum 5 item 1). The two coincide
    today; both are read and scored independently.
    """
    base = os.path.join(truth_dir, REQUESTS_TRUTH_SUBDIR)
    paths = {
        "targets": os.path.join(base, "targets.json"),
        "classified": os.path.join(base, "classified-requests-independent.json"),
        "evidence": os.path.join(base, "non-true-site-evidence.json"),
        "overloads": os.path.join(base, "overload-groups.json"),
        "gt3": os.path.normpath(os.path.join(truth_dir, REQUESTS_GT3)),
    }
    targets_raw, targets_bytes = read_json(paths["targets"], "requests targets.json")
    classified_raw, classified_bytes = read_json(
        paths["classified"], "classified-requests-independent.json"
    )
    evidence_raw, evidence_bytes = read_json(
        paths["evidence"], "requests non-true-site-evidence.json"
    )
    overloads_raw, overloads_bytes = read_json(
        paths["overloads"], "requests overload-groups.json"
    )
    gt3_raw, gt3_bytes = read_json(paths["gt3"], "gt3_classified.json")

    _require(isinstance(targets_raw, list), "requests targets.json is not a list")
    _require(
        isinstance(classified_raw, dict)
        and isinstance(classified_raw.get("summary"), dict)
        and isinstance(classified_raw.get("targets"), dict),
        "classified-requests-independent.json is missing 'summary' or 'targets'",
    )
    _require(isinstance(evidence_raw, dict), "requests non-true-site-evidence.json is not an object")
    _require(isinstance(overloads_raw, dict), "requests overload-groups.json is not an object")
    _require(isinstance(gt3_raw, dict), "gt3_classified.json is not an object")

    tinfo = {}
    for target in targets_raw:
        _require(isinstance(target, dict), "requests targets.json holds a non-object entry")
        for field in ("file", "name", "qualname", "line", "batch", "candidates"):
            _require(field in target, f"a requests targets.json entry is missing {field!r}")
        key = make_key(target["file"], target["line"], target["qualname"])
        _require(key not in tinfo, f"requests targets.json repeats the target {key!r}")
        tinfo[key] = target

    overloads = {}
    for key, value in overloads_raw.items():
        if key == "_note":
            continue
        _require(key in tinfo, f"overload-groups.json names an unknown target {key!r}")
        _require(isinstance(value, dict), f"overload group {key!r} is not an object")
        implementation = value.get("implementation_line")
        _require(
            isinstance(implementation, int) and not isinstance(implementation, bool),
            f"overload group {key!r} has no integer implementation_line",
        )
        _require(
            isinstance(value.get("stub_lines"), list),
            f"overload group {key!r} has no stub_lines list",
        )
        overloads[key] = implementation

    evidence_by_target = collections.defaultdict(dict)
    for raw_key, flag in evidence_raw.items():
        _require(
            isinstance(raw_key, str) and " | " in raw_key,
            "a requests evidence key is not '<target key> | <site>'",
            [repr(raw_key)],
        )
        target_key, site = raw_key.split(" | ", 1)
        _require(flag in ("direct", "inferred"), f"evidence {raw_key!r} is not direct/inferred")
        _require(target_key in tinfo, f"requests evidence names an unknown target {target_key!r}")
        _require(
            site not in evidence_by_target[target_key],
            f"requests evidence repeats {raw_key!r}",
        )
        evidence_by_target[target_key][site] = flag

    gt3_keys = {key for key in gt3_raw if key != "_note"}
    _require(
        gt3_keys == set(classified_raw["targets"]),
        "gt3_classified.json and classified-requests-independent.json name different targets",
        [f"only gt3: {sorted(gt3_keys - set(classified_raw['targets']))[:5]}",
         f"only classified: {sorted(set(classified_raw['targets']) - gt3_keys)[:5]}"],
    )

    seeds = {}
    totals = collections.Counter()
    excluded_reasons = collections.Counter()

    for key, classification in classified_raw["targets"].items():
        _require(key in tinfo, f"classified-requests-independent.json names an unknown target {key!r}")
        target = tinfo[key]
        candidates = target["candidates"]
        _require(isinstance(candidates, list), f"target {key!r} has non-list candidates")
        cand_by_site = {}
        for candidate in candidates:
            site = _site_string(candidate)
            _require(site not in cand_by_site, f"target {key!r} repeats candidate site {site!r}")
            cand_by_site[site] = candidate

        true, poly, excluded = [], [], []
        listed = set()
        for entry in classification.get("true", []):
            _require(entry.get("site") in cand_by_site, f"{key!r}: true site {entry.get('site')!r} is not a candidate")
            candidate = cand_by_site[entry["site"]]
            _require(
                entry.get("receiver_evidence") in ("direct", "inferred"),
                f"{key!r}: true site {entry['site']!r} has no receiver_evidence",
            )
            listed.add(entry["site"])
            true.append({
                "site": entry["site"],
                "file": candidate["file"],
                "line": candidate["call_start_line"],
                "evidence": entry["receiver_evidence"],
            })
        for label, bucket in (("poly", poly), ("excluded", excluded)):
            for entry in classification.get(label, []):
                site = entry.get("site")
                _require(site in cand_by_site, f"{key!r}: {label} site {site!r} is not a candidate")
                candidate = cand_by_site[site]
                flag = evidence_by_target.get(key, {}).get(site)
                _require(flag is not None, f"{key!r}: {label} site {site!r} has no evidence flag")
                listed.add(site)
                record = {
                    "site": site,
                    "file": candidate["file"],
                    "line": candidate["call_start_line"],
                    "evidence": flag,
                }
                if label == "excluded":
                    _require("reason" in entry, f"{key!r}: excluded site {site!r} has no reason")
                    record["reason"] = entry["reason"]
                    excluded_reasons[entry["reason"]] += 1
                bucket.append(record)

        other_definition = []
        for site, candidate in cand_by_site.items():
            if site in listed:
                continue
            flag = evidence_by_target.get(key, {}).get(site)
            _require(
                flag is not None,
                f"{key!r}: other-definition candidate {site!r} has no evidence flag",
                ["every non-true candidate must carry direct/inferred (Addendum 4 Q3)"],
            )
            other_definition.append({
                "site": site,
                "file": candidate["file"],
                "line": candidate["call_start_line"],
                "evidence": flag,
            })

        _require(
            classification.get("other_definition") == len(other_definition),
            f"{key!r}: other_definition count {classification.get('other_definition')} "
            f"!= {len(other_definition)} reconstructed candidates",
        )
        true_sites = {entry["site"] for entry in true}
        for site in evidence_by_target.get(key, {}):
            _require(
                site in cand_by_site and site not in true_sites,
                f"{key!r}: evidence given for {site!r}, which is not a non-true candidate",
            )

        comparable = _parse_gt3_true_sites(gt3_raw[key], key)

        seeds[key] = {
            "file": target["file"],
            "line": target["line"],
            # Addendum 6 item 1: a stub-keyed target maps to the implementation line.
            "symbol_line": overloads.get(key, target["line"]),
            "qualname": target["qualname"],
            "candidates": candidates,
            "true": true,
            "poly": poly,
            "excluded": excluded,
            "other_definition": other_definition,
            "comparable_lines": comparable,
        }
        totals["true"] += len(true)
        totals["true_direct"] += sum(1 for entry in true if entry["evidence"] == "direct")
        totals["true_inferred"] += sum(1 for entry in true if entry["evidence"] == "inferred")
        totals["poly"] += len(poly)
        totals["excluded"] += len(excluded)
        totals["other_definition"] += len(other_definition)

    summary = classified_raw["summary"]
    recomputed = {
        "targets": len(seeds),
        "true": totals["true"],
        "true_direct": totals["true_direct"],
        "true_inferred": totals["true_inferred"],
        "poly": totals["poly"],
        "excluded": totals["excluded"],
        "other_definition": totals["other_definition"],
        "targets_with_a_true_site": sum(1 for s in seeds.values() if s["true"]),
        "zero_truth_targets": sum(1 for s in seeds.values() if not s["true"]),
    }
    for field, value in recomputed.items():
        _require(
            summary.get(field) == value,
            f"classified-requests-independent.json summary {field}={summary.get(field)!r} "
            f"does not match the recomputed {value!r}",
        )

    sources = [
        ("targets", paths["targets"], sha256_bytes(targets_bytes), len(targets_bytes)),
        ("classified", paths["classified"], sha256_bytes(classified_bytes), len(classified_bytes)),
        ("evidence", paths["evidence"], sha256_bytes(evidence_bytes), len(evidence_bytes)),
        ("overloads", paths["overloads"], sha256_bytes(overloads_bytes), len(overloads_bytes)),
        ("gt3", paths["gt3"], sha256_bytes(gt3_bytes), len(gt3_bytes)),
    ]
    return {
        "kind": "requests",
        "seeds": seeds,
        "summary": dict(summary),
        "excluded_reasons": dict(excluded_reasons),
        "direct_only": totals["true_direct"],
        "overloads": overloads,
        "sources": sources,
    }


def score_requests(truth, index, package_dir=DEFAULT_REQUESTS_PACKAGE_DIR, mutations=frozenset()):
    """Score a GlyphIndex against the requests ground truth (both denominators).

    The independent recall set and the precision categories come from
    ``classified-requests-independent.json``; the pyright-comparable recall set is
    ``gt3_classified.json`` (Addendum 5 item 1). The comparable precision side
    drops edges at inferred sites. ``mutations`` is test-only.
    """
    return _score_classified(truth, index, package_dir, mutations)


# --- report -----------------------------------------------------------------

def _print_sources(sources, scorer_path):
    print("inputs read (path, sha256, bytes):")
    for label, path, digest, size in sources:
        print(f"  {label:12} {path}")
        print(f"  {'':12} sha256={digest} bytes={size}")
    with open(scorer_path, "rb") as fh:
        scorer_raw = fh.read()
    print(f"  scorer       {scorer_path}")
    print(f"  {'':12} sha256={sha256_bytes(scorer_raw)} bytes={len(scorer_raw)}")
    print(f"  python       {sys.version.split()[0]} ({sys.implementation.name})")


def _target_figure(fully, total):
    if not total:
        return "n/a (n=0)"
    low, high = wilson(fully, total)
    return f"{fully}/{total} = {fully / total:.4f} (95% Wilson {low:.4f}-{high:.4f})"


def _print_denominator(title, verdict, bootstrap, fully, total):
    print(f"== {title} ==")
    print(f"recall            {fmt_frac(verdict['recall_found'], verdict['recall_denominator'])}")
    print(
        f"precision         "
        f"{fmt_frac(verdict['precision_found'], verdict['precision_denominator'])}"
        "  [interval information only; precision is gated as a point value]"
    )
    print(f"targets fully correct {_target_figure(fully, total)}")
    if bootstrap[0] is not None:
        print(
            "recall cluster bootstrap 95% [info] "
            f"{bootstrap[0]:.4f}-{bootstrap[1]:.4f}"
        )
    else:
        print("recall cluster bootstrap 95% [info] n/a")
    mark = "PASS" if verdict["pass"] else "FAIL"
    print(
        f"GATE {title}: {mark}  "
        f"(recall {fmt_rate(verdict['recall'])} >= {RECALL_FLOOR}: "
        f"{'yes' if verdict['recall_ok'] else 'no'}; "
        f"Wilson lower {fmt_rate(verdict['wilson'][0])} >= {WILSON_FLOOR}: "
        f"{'yes' if verdict['wilson_ok'] else 'no'}; "
        f"precision {fmt_rate(verdict['precision'])} >= {PRECISION_FLOOR}: "
        f"{'yes' if verdict['precision_ok'] else 'no'})"
    )
    print()


def _render_header(result, sources, scorer_path, title):
    summary = result["summary"]
    print(f"gate_score: {title}, package directory {result['package_dir']!r}")
    print()
    _print_sources(sources, scorer_path)
    print()
    print(
        f"seeded targets: {summary['targets']}; "
        f"with a true site: {summary['targets_with_a_true_site']}; "
        f"zero-truth controls: {summary['zero_truth_targets']}"
    )
    edges = result["edges"]
    print(
        "edges: "
        f"{edges.get('in_scope_edges', 0)} invocation edge(s) in scope, "
        f"{edges.get('to_seeded', 0)} to a seeded target, "
        f"{edges.get('outside_package', 0)} outside the package, "
        f"{edges.get('not_seeded', 0)} not to a seeded target"
    )
    reasons = ", ".join(f"{k} {v}" for k, v in sorted(result["excluded_reasons"].items()))
    print(f"excluded sites: {summary['excluded']} ({reasons or 'none'})")
    print(f"poly sites: {summary['poly']} (reported separately, not scored; Addendum 4 Q4)")
    print()
    unresolved = result["unresolved"]
    print("unresolved by kind (index.unresolvedByKind), share = unresolved / (resolved + unresolved):")
    for bin_name in ("call", "import", "extends", "implements"):
        entry = unresolved[bin_name]
        share = "n/a" if entry["share"] is None else f"{entry['share']:.4f}"
        print(
            f"  {bin_name:11} unresolved={entry['unresolved']:<5} "
            f"resolved={entry['resolved']:<5} share={share}"
        )
    print(f"  dynamic     unresolved={unresolved['dynamic']['unresolved']} (count only)")
    print()


def render_click_report(result, truth, sources, scorer_path):
    _render_header(result, sources, scorer_path, "held-out click 7.1.2 (batch 0)")
    target_level = result["target_level"]
    _print_denominator(
        "ALL-ATTRIBUTABLE (recall = every true site)",
        result["verdict"]["all_attributable"],
        result["bootstrap"]["independent"],
        target_level["fully_correct_independent"],
        target_level["targets_with_true"],
    )
    _print_denominator(
        "PYRIGHT-COMPARABLE (recall = true sites with direct evidence)",
        result["verdict"]["pyright_comparable"],
        result["bootstrap"]["comparable"],
        target_level["fully_correct_comparable"],
        target_level["targets_with_comparable"],
    )


def render_requests_report(result, truth, sources, scorer_path):
    _render_header(result, sources, scorer_path, "held-out requests 3c7baaa (batch 0)")
    totals = result["totals"]
    print(
        f"true sites: independent {totals['true']} (classified-requests-independent.json), "
        f"pyright-comparable {totals['comparable_total']} (gt3_classified.json); "
        f"direct-only {result['direct_only']}/{totals['true']} (information)"
    )
    print()
    target_level = result["target_level"]
    _print_denominator(
        "INDEPENDENT (recall = classified-requests-independent.json)",
        result["verdict"]["all_attributable"],
        result["bootstrap"]["independent"],
        target_level["fully_correct_independent"],
        target_level["targets_with_true"],
    )
    _print_denominator(
        "PYRIGHT-COMPARABLE (recall = gt3_classified.json)",
        result["verdict"]["pyright_comparable"],
        result["bootstrap"]["comparable"],
        target_level["fully_correct_comparable"],
        target_level["targets_with_comparable"],
    )


# --- CLI --------------------------------------------------------------------

def build_parser(mode):
    parser = argparse.ArgumentParser(
        prog="gate_score.py",
        description="Score a GlyphIndex against the committed Python gate ground truth.",
    )
    parser.add_argument("index", help="GlyphIndex JSON to score")
    held = "click-7.1.2/" if mode == "click" else (
        "requests-3c7baaa/ and ../python-lsp-measurement/gt3_classified.json"
    )
    parser.add_argument(
        "--truth-dir",
        default=os.path.dirname(os.path.abspath(__file__)),
        help=f"directory holding {held} (default: this script's directory)",
    )
    default_package = (
        DEFAULT_CLICK_PACKAGE_DIR if mode == "click" else DEFAULT_REQUESTS_PACKAGE_DIR
    )
    parser.add_argument(
        "--package-dir",
        default=default_package,
        help=f"scored package directory (default: {default_package})",
    )
    return parser


def _run_click(args):
    truth = load_click_truth(args.truth_dir)
    index, index_raw = read_json(args.index, "index")
    sources = list(truth["sources"])
    sources.append(("index", args.index, sha256_bytes(index_raw), len(index_raw)))
    result = score_click(truth, index, args.package_dir)
    render_click_report(result, truth, sources, os.path.abspath(__file__))
    return EXIT_OK


def _run_requests(args):
    truth = load_requests_truth(args.truth_dir)
    index, index_raw = read_json(args.index, "index")
    sources = list(truth["sources"])
    sources.append(("index", args.index, sha256_bytes(index_raw), len(index_raw)))
    result = score_requests(truth, index, args.package_dir)
    render_requests_report(result, truth, sources, os.path.abspath(__file__))
    return EXIT_OK


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    mode = "click"
    if raw and raw[0] in ("click", "requests"):
        mode = raw.pop(0)
    parser = build_parser(mode)
    args = parser.parse_args(raw)  # argparse exits 2 on a usage error
    try:
        if mode == "click":
            return _run_click(args)
        return _run_requests(args)
    except GateError as error:
        print(f"gate_score: error: {error}", file=sys.stderr)
        for detail in error.details:
            print(f"  {detail}", file=sys.stderr)
        return error.code


if __name__ == "__main__":
    sys.exit(main())
