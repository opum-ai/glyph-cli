"""Build stub GlyphIndex JSON objects from the committed ground truth (test-only).

No analyzer runs here: the stubs are assembled from ``targets.json`` and
``classified-batch0.json`` so ``test_gate_score`` can drive the gate scorer with
inputs whose expected output is known. The builder reads the ground truth directly
(it does not import the scorer), so the expected values in the tests do not come
from the code under test.

A symbol's qualified name is reconstructed by the scorer as ``container + "." +
name`` (or ``name`` when ``container`` is null). ``_symbol`` therefore splits the
target's qualname at its last dot: the last segment is ``name`` and the rest is
``container``. A nested function such as ``Parameter.type_cast_value._convert``
gets ``container = "Parameter.type_cast_value"``.
"""

from __future__ import annotations

import collections
import json
import os


def _truth_base(truth_dir):
    return os.path.join(truth_dir, "click-7.1.2")


def load_ground_truth(truth_dir):
    """Return (targets list, classified-batch0 dict)."""
    base = _truth_base(truth_dir)
    with open(os.path.join(base, "targets.json"), encoding="utf-8") as fh:
        targets = json.load(fh)
    with open(os.path.join(base, "classified-batch0.json"), encoding="utf-8") as fh:
        classified = json.load(fh)
    return targets, classified


def target_key(target):
    return f"{target['file']}:{target['line']} {target['qualname']}"


def _symbol(target, package_dir, kind="function"):
    qualname = target["qualname"]
    if "." in qualname:
        container, name = qualname.rsplit(".", 1)
    else:
        container, name = None, qualname
    file = f"{package_dir}/{target['file']}" if package_dir else target["file"]
    column = 1
    return {
        "id": f"{file}:{target['line']}:{column}",
        "name": name,
        "container": container,
        "kind": kind,
        "file": file,
        "startLine": target["line"],
        "line": target["line"],
        "column": column,
        "endLine": target["line"],
        "exported": True,
    }


def minimal_index():
    """A structurally valid GlyphIndex with no symbols and no sites."""
    return {
        "schemaVersion": 2,
        "repo": "stub",
        "createdAt": "stub",
        "files": [],
        "symbols": [],
        "sites": [],
        "unresolvedSites": 0,
        "unresolvedByKind": {
            "call": 0,
            "import": 0,
            "extends": 0,
            "implements": 0,
            "dynamic": 0,
        },
    }


class Stub:
    """A mutable stub index over the click batch-0 ground truth."""

    def __init__(self, truth_dir, package_dir="src/click"):
        self.package_dir = package_dir
        self.targets, self.classified = load_ground_truth(truth_dir)
        self.targets_by_key = {target_key(t): t for t in self.targets}
        self.symbols = []
        self.sites = []
        self.ids = {}
        self._site_records = {}
        for target in self.targets:
            key = target_key(target)
            if key not in self.classified["targets"]:
                continue
            symbol = _symbol(target, package_dir)
            self.symbols.append(symbol)
            self.ids[key] = symbol["id"]
            records = {}
            for candidate in target["candidates"]:
                records[f"{candidate['file']}:{candidate['line']}:{candidate['col']}"] = candidate
            self._site_records[key] = records

    # -- edges ---------------------------------------------------------------

    def _index_file(self, file_rel):
        return f"{self.package_dir}/{file_rel}" if self.package_dir else file_rel

    def add_edge(self, key, file_rel, line, column=0, kind="call"):
        """Add an edge whose caller file is ``file_rel`` relative to the package dir."""
        self.sites.append({
            "calleeId": self.ids[key],
            "callerId": None,
            "file": self._index_file(file_rel),
            "line": line,
            "column": column,
            "kind": kind,
        })
        return self

    def add_at(self, key, site, kind="call"):
        """Add an edge at a classified site string ``file:line:col``."""
        candidate = self._site_records[key][site]
        return self.add_edge(
            key, candidate["file"], candidate["call_start_line"],
            column=candidate["col"], kind=kind,
        )

    def add_outside_edge(self, key, file_path, line, column=0, kind="call"):
        """Add an edge whose caller file is given verbatim (outside the package)."""
        self.sites.append({
            "calleeId": self.ids[key],
            "callerId": None,
            "file": file_path,
            "line": line,
            "column": column,
            "kind": kind,
        })
        return self

    def drop_at(self, key, site):
        """Remove the edge at a classified site string (e.g. one true site)."""
        candidate = self._site_records[key][site]
        wanted = (
            self.ids[key],
            self._index_file(candidate["file"]),
            candidate["call_start_line"],
            candidate["col"],
        )
        for i, site_entry in enumerate(self.sites):
            got = (
                site_entry["calleeId"],
                site_entry["file"],
                site_entry["line"],
                site_entry["column"],
            )
            if got == wanted:
                del self.sites[i]
                return self
        raise KeyError(f"no edge at {key} | {site}")

    def move_at(self, key, site, new_line):
        """Move the edge at a classified site to another line in the same file."""
        candidate = self._site_records[key][site]
        wanted = (
            self.ids[key],
            self._index_file(candidate["file"]),
            candidate["call_start_line"],
            candidate["col"],
        )
        for site_entry in self.sites:
            got = (
                site_entry["calleeId"],
                site_entry["file"],
                site_entry["line"],
                site_entry["column"],
            )
            if got == wanted:
                site_entry["line"] = new_line
                return self
        raise KeyError(f"no edge at {key} | {site}")

    # -- symbols -------------------------------------------------------------

    def remove_symbol(self, key):
        symbol_id = self.ids.pop(key)
        self.symbols = [s for s in self.symbols if s["id"] != symbol_id]
        self.sites = [s for s in self.sites if s["calleeId"] != symbol_id]
        return self

    # -- conveniences --------------------------------------------------------

    def perfect(self):
        """Add one edge at every true site of every batch-0 target, nothing else."""
        for key, classification in self.classified["targets"].items():
            for entry in classification["true"]:
                self.add_at(key, entry["site"])
        return self

    def index(self):
        return {
            "schemaVersion": 2,
            "repo": "click-stub",
            "createdAt": "stub",
            "files": sorted({symbol["file"] for symbol in self.symbols}),
            "symbols": list(self.symbols),
            "sites": list(self.sites),
            "unresolvedSites": 0,
            "unresolvedByKind": {
                "call": 0,
                "import": 0,
                "extends": 0,
                "implements": 0,
                "dynamic": 0,
            },
        }


def first_n_direct_true_sites(truth_dir, n):
    """The first ``n`` true sites whose receiver_evidence is direct, in file order."""
    _, classified = load_ground_truth(truth_dir)
    picked = []
    for key, entry in classified["targets"].items():
        for site in entry["true"]:
            if site["receiver_evidence"] == "direct":
                picked.append((key, site["site"]))
                if len(picked) == n:
                    return picked
    raise ValueError(f"only {len(picked)} direct true sites, wanted {n}")


def requests_stub(gt3_path, package_dir="src/requests"):
    """A stub index with one edge at every requests true site in gt3_classified.json."""
    with open(gt3_path, encoding="utf-8") as fh:
        raw = json.load(fh)
    symbols, sites, ids = [], [], {}
    for key, value in raw.items():
        if key == "_note":
            continue
        location, qualname = key.split(" ", 1)
        file, line = location.rsplit(":", 1)
        line = int(line)
        if "." in qualname:
            container, name = qualname.rsplit(".", 1)
        else:
            container, name = None, qualname
        index_file = f"{package_dir}/{file}" if package_dir else file
        symbol_id = f"{index_file}:{line}:1"
        symbols.append({
            "id": symbol_id,
            "name": name,
            "container": container,
            "kind": "function",
            "file": index_file,
            "startLine": line,
            "line": line,
            "column": 1,
            "endLine": line,
            "exported": True,
        })
        ids[key] = symbol_id
        for site in value.get("true", []):
            site_file, site_line = site.rsplit(":", 1)
            sites.append({
                "calleeId": symbol_id,
                "callerId": None,
                "file": f"{package_dir}/{site_file}" if package_dir else site_file,
                "line": int(site_line),
                "column": 0,
                "kind": "call",
            })
    index = minimal_index()
    index["repo"] = "requests-stub"
    index["files"] = sorted({symbol["file"] for symbol in symbols})
    index["symbols"] = symbols
    index["sites"] = sites
    return index, ids
