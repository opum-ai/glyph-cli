"""Build stub GlyphIndex JSON objects from the committed ground truth (test-only).

No analyzer runs here: the stubs are assembled from the ground-truth files so
``test_gate_score`` can drive the gate scorer with inputs whose expected output is
known. The builder reads the ground truth directly (it does not import the
scorer), so the expected values in the tests do not come from the code under test.

A symbol's qualified name is reconstructed by the scorer as ``container + "." +
name`` (or ``name`` when ``container`` is null). ``_symbol`` therefore splits the
target's qualname at its last dot: the last segment is ``name`` and the rest is
``container``. A nested function such as ``Parameter.type_cast_value._convert``
gets ``container = "Parameter.type_cast_value"``.

For requests, a target keyed to an ``@overload`` stub gets its symbol at the
implementation line from ``overload-groups.json`` (Addendum 6 item 1); the
classification and ``targets.json`` stay keyed at the stub line.
"""

from __future__ import annotations

import collections
import json
import os


CLICK_SUBDIR = "click-7.1.2"
REQUESTS_SUBDIR = "requests-3c7baaa"


def load_ground_truth(truth_dir):
    """Return (targets list, classified-batch0 dict) for click."""
    base = os.path.join(truth_dir, CLICK_SUBDIR)
    with open(os.path.join(base, "targets.json"), encoding="utf-8") as fh:
        targets = json.load(fh)
    with open(os.path.join(base, "classified-batch0.json"), encoding="utf-8") as fh:
        classified = json.load(fh)
    return targets, classified


def load_requests_ground_truth(truth_dir):
    """Return (targets, classified-requests-independent, overload-line map)."""
    base = os.path.join(truth_dir, REQUESTS_SUBDIR)
    with open(os.path.join(base, "targets.json"), encoding="utf-8") as fh:
        targets = json.load(fh)
    with open(
        os.path.join(base, "classified-requests-independent.json"), encoding="utf-8"
    ) as fh:
        classified = json.load(fh)
    with open(os.path.join(base, "overload-groups.json"), encoding="utf-8") as fh:
        raw = json.load(fh)
    overloads = {
        key: value["implementation_line"]
        for key, value in raw.items()
        if key != "_note"
    }
    return targets, classified, overloads


def target_key(target):
    return f"{target['file']}:{target['line']} {target['qualname']}"


def _symbol(target, package_dir, kind="function", line=None):
    qualname = target["qualname"]
    if "." in qualname:
        container, name = qualname.rsplit(".", 1)
    else:
        container, name = None, qualname
    if line is None:
        line = target["line"]
    file = f"{package_dir}/{target['file']}" if package_dir else target["file"]
    column = 1
    return {
        "id": f"{file}:{line}:{column}",
        "name": name,
        "container": container,
        "kind": kind,
        "file": file,
        "startLine": line,
        "line": line,
        "column": column,
        "endLine": line,
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


class _StubBase:
    """Shared mutable index over a classification's targets and candidates."""

    def __init__(self, package_dir, targets, classified, symbol_line):
        self.package_dir = package_dir
        self.targets = targets
        self.classified = classified
        self.symbols = []
        self.sites = []
        self.ids = {}
        self._site_records = {}
        self._targets_by_key = {target_key(t): t for t in targets}
        for target in targets:
            key = target_key(target)
            if key not in classified["targets"]:
                continue
            self._site_records[key] = {
                f"{c['file']}:{c['line']}:{c['col']}": c
                for c in target["candidates"]
            }
            self._add_symbol(key, symbol_line(key, target))

    # -- symbols -------------------------------------------------------------

    def _add_symbol(self, key, line):
        symbol = _symbol(self._targets_by_key[key], self.package_dir, line=line)
        self.symbols.append(symbol)
        if key not in self.ids:
            self.ids[key] = symbol["id"]
        return symbol

    def add_symbol_at(self, key, line):
        """Add an extra symbol for ``key`` at ``line`` without changing its edge target."""
        return self._add_symbol(key, line)

    def remove_symbol(self, key):
        symbol_id = self.ids.pop(key)
        self.symbols = [s for s in self.symbols if s["id"] != symbol_id]
        self.sites = [s for s in self.sites if s["calleeId"] != symbol_id]
        return self

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

    # -- conveniences --------------------------------------------------------

    def perfect(self):
        """Add one edge at every true site of every seeded target, nothing else."""
        for key, classification in self.classified["targets"].items():
            for entry in classification["true"]:
                self.add_at(key, entry["site"])
        return self

    def index(self):
        return {
            "schemaVersion": 2,
            "repo": "stub",
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


class Stub(_StubBase):
    """A mutable stub index over the click batch-0 ground truth."""

    def __init__(self, truth_dir, package_dir="src/click"):
        targets, classified = load_ground_truth(truth_dir)
        super().__init__(package_dir, targets, classified, lambda _key, target: target["line"])


class RequestsStub(_StubBase):
    """A mutable stub index over the requests classification (overload-aware)."""

    def __init__(self, truth_dir, package_dir="src/requests"):
        targets, classified, overloads = load_requests_ground_truth(truth_dir)
        self.overloads = overloads
        super().__init__(
            package_dir, targets, classified,
            lambda key, target: overloads.get(key, target["line"]),
        )


def first_n_direct_true_sites(truth_dir, n):
    """The first ``n`` click true sites whose receiver_evidence is direct."""
    _, classified = load_ground_truth(truth_dir)
    picked = []
    for key, entry in classified["targets"].items():
        for site in entry["true"]:
            if site["receiver_evidence"] == "direct":
                picked.append((key, site["site"]))
                if len(picked) == n:
                    return picked
    raise ValueError(f"only {len(picked)} direct true sites, wanted {n}")


def first_n_requests_direct_true_sites(truth_dir, n):
    """The first ``n`` requests true sites whose receiver_evidence is direct."""
    _, classified, _ = load_requests_ground_truth(truth_dir)
    picked = []
    for key, entry in classified["targets"].items():
        for site in entry["true"]:
            if site["receiver_evidence"] == "direct":
                picked.append((key, site["site"]))
                if len(picked) == n:
                    return picked
    raise ValueError(f"only {len(picked)} direct true sites, wanted {n}")


def requests_stub(truth_dir, package_dir="src/requests"):
    """A perfect requests stub as (index, {target key: symbol id})."""
    stub = RequestsStub(truth_dir, package_dir).perfect()
    return stub.index(), dict(stub.ids)
