"""Tests for the held-out Python gate scorer (GCLI-72).

Run from this directory with any of::

    python3 -I test_gate_score.py
    python3 -I -m unittest discover -s . -p 'test_gate_score.py'
    python3 -m unittest test_gate_score        # no -I: cwd stays on sys.path

``python3 -I -m unittest test_gate_score`` does NOT work on Python 3.11+ (this
repository's host is 3.15.2): ``-I`` implies ``-P`` (``sys.flags.safe_path`` is
true), so the current directory is not prepended to ``sys.path`` and unittest
cannot import the sibling module by name. The two invocations above are the
``-I``-compatible forms.

The stubs are built from the committed ground truth by ``stub_index`` (no
analyzer). The expected Wilson bounds below were computed with the committed
formula of ``test/python-lsp-measurement/wilson_floor.py`` (z = 1.96) before this
scorer existed, and the 72/80 lower bound is also the row ``wilson-floor.txt``
prints; they are hard-coded rather than read back from the scorer under test.
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import gate_score  # noqa: E402
import stub_index  # noqa: E402

GATE_SCORE = os.path.join(HERE, "gate_score.py")
TRUTH_DIR = HERE
PACKAGE_DIR = "src/click"
REQUESTS_PACKAGE = "src/requests"

# Concrete click sites used by the false-edge tests (from the committed
# classification and the Addendum 4 Q3 evidence file).
OTHER_DEF_DIRECT = ("types.py:409 BoolParamType.convert", "types.py:290:26")
POLY_SITE = ("exceptions.py:129 MissingParameter.format_message", "exceptions.py:73:37")
EXCLUDED_SITE = (
    "_compat.py:97 _NonClosingTextIOWrapper.isatty",
    "_compat.py:744:22",
)
OTHER_DEF_INFERRED = ("core.py:566 Context.get_help", "core.py:570:28")

# Concrete requests sites (classification + non-true-site-evidence.json).
REQ_OTHER_DEF_DIRECT = ("models.py:360 Request.prepare", "models.py:363:10")
REQ_OTHER_DEF_INFERRED = ("structures.py:127 LookupDict.get", "auth.py:164:38")
REQ_POLY = ("adapters.py:555 HTTPAdapter.close", "sessions.py:886:14")


def run_cli(index, *extra):
    """Write the index to a temp file and run the scorer's CLI; return the process."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "index.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(index, fh)
        return subprocess.run(
            [sys.executable, "-I", GATE_SCORE, path, *extra],
            capture_output=True,
            text=True,
        )


def run_cli_requests(index):
    """Run the requests-mode CLI (``gate_score.py requests <index>``)."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "index.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(index, fh)
        return subprocess.run(
            [sys.executable, "-I", GATE_SCORE, "requests", path],
            capture_output=True,
            text=True,
        )


def capture_stdout(function):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        function()
    return buffer.getvalue()


def copy_click_truth(tmp):
    """Copy the three click ground-truth files into ``tmp/click-7.1.2/``."""
    source = os.path.join(TRUTH_DIR, "click-7.1.2")
    destination = os.path.join(tmp, "click-7.1.2")
    os.makedirs(destination)
    for name in (
        "targets.json",
        "classified-batch0.json",
        "non-true-site-evidence-batch0.json",
    ):
        with open(os.path.join(source, name), "rb") as fh:
            data = fh.read()
        with open(os.path.join(destination, name), "wb") as fh:
            fh.write(data)
    return destination


def copy_requests_truth(tmp):
    """Copy the four requests ground-truth files into ``tmp/requests-3c7baaa/``."""
    source = os.path.join(TRUTH_DIR, "requests-3c7baaa")
    destination = os.path.join(tmp, "requests-3c7baaa")
    os.makedirs(destination)
    for name in (
        "targets.json",
        "classified-requests-independent.json",
        "non-true-site-evidence.json",
        "overload-groups.json",
    ):
        with open(os.path.join(source, name), "rb") as fh:
            data = fh.read()
        with open(os.path.join(destination, name), "wb") as fh:
            fh.write(data)
    return destination


def write_truncated_click_truth(tmp, keep=10):
    """Write a valid click truth keeping only the first ``keep`` true sites.

    Used only to exercise the 62-site floor: the loader is called with
    ``verify_hashes=False`` because the truncated files are not the committed ones.
    """
    base = copy_click_truth(tmp)
    with open(os.path.join(base, "targets.json"), encoding="utf-8") as fh:
        targets = json.load(fh)
    with open(os.path.join(base, "classified-batch0.json"), encoding="utf-8") as fh:
        classified = json.load(fh)
    with open(os.path.join(base, "non-true-site-evidence-batch0.json"), encoding="utf-8") as fh:
        evidence = json.load(fh)

    kept = 0
    removed = []
    for key, entry in classified["targets"].items():
        kept_true = []
        for item in entry["true"]:
            if kept < keep:
                kept_true.append(item)
                kept += 1
            else:
                removed.append((key, item["site"], item["receiver_evidence"]))
        entry["true"] = kept_true
    for key, site, flag in removed:
        evidence[f"{key} | {site}"] = flag

    candidates_by_key = {
        f"{t['file']}:{t['line']} {t['qualname']}": t["candidates"] for t in targets
    }
    total_true = total_direct = total_inferred = total_poly = total_excluded = 0
    total_other = 0
    with_true = 0
    for key, entry in classified["targets"].items():
        candidates = {
            f"{c['file']}:{c['line']}:{c['col']}" for c in candidates_by_key[key]
        }
        listed = (
            {e["site"] for e in entry["true"]}
            | {e["site"] for e in entry["poly"]}
            | {e["site"] for e in entry["excluded"]}
        )
        entry["other_definition"] = len(candidates) - len(listed)
        total_true += len(entry["true"])
        total_direct += sum(1 for e in entry["true"] if e["receiver_evidence"] == "direct")
        total_inferred += sum(1 for e in entry["true"] if e["receiver_evidence"] == "inferred")
        total_poly += len(entry["poly"])
        total_excluded += len(entry["excluded"])
        total_other += entry["other_definition"]
        if entry["true"]:
            with_true += 1
    classified["summary"] = {
        "targets": len(classified["targets"]),
        "true": total_true,
        "true_direct": total_direct,
        "true_inferred": total_inferred,
        "poly": total_poly,
        "excluded": total_excluded,
        "other_definition": total_other,
        "targets_with_a_true_site": with_true,
        "zero_truth_targets": len(classified["targets"]) - with_true,
    }
    for name, payload in (
        ("targets.json", targets),
        ("classified-batch0.json", classified),
        ("non-true-site-evidence-batch0.json", evidence),
    ):
        with open(os.path.join(base, name), "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    return tmp


class GateScoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.truth = gate_score.load_click_truth(TRUTH_DIR)
        cls.requests_truth = gate_score.load_requests_truth(TRUTH_DIR)

    # -- helpers -------------------------------------------------------------

    def perfect(self):
        return stub_index.Stub(TRUTH_DIR, PACKAGE_DIR).perfect()

    def score(self, stub, mutations=frozenset()):
        return gate_score.score_click(
            self.truth, stub.index(), PACKAGE_DIR, mutations=mutations
        )

    def requests_perfect(self):
        return stub_index.RequestsStub(TRUTH_DIR, REQUESTS_PACKAGE).perfect()

    def score_requests(self, stub, mutations=frozenset()):
        return gate_score.score_requests(
            self.requests_truth, stub.index(), REQUESTS_PACKAGE, mutations=mutations
        )

    def render_click(self, result):
        return capture_stdout(
            lambda: gate_score.render_click_report(
                result, self.truth, self.truth["sources"], GATE_SCORE,
            )
        )

    def render_requests(self, result):
        return capture_stdout(
            lambda: gate_score.render_requests_report(
                result, self.requests_truth, self.requests_truth["sources"], GATE_SCORE,
            )
        )

    # -- (a) a perfect index -------------------------------------------------

    def test_perfect_index_gives_full_recall_and_precision(self):
        result = self.score(self.perfect())
        totals = result["totals"]
        self.assertEqual(totals["true"], 80)
        self.assertEqual(totals["true_direct"], 70)
        self.assertEqual(totals["tp_independent"], 80)
        self.assertEqual(totals["fp_independent"], 0)
        self.assertEqual(totals["tp_comparable"], 70)
        self.assertEqual(totals["fp_comparable"], 0)

        all_side = result["verdict"]["all_attributable"]
        comparable = result["verdict"]["pyright_comparable"]
        self.assertEqual(all_side["recall"], 1.0)
        self.assertEqual(all_side["precision"], 1.0)
        self.assertEqual(comparable["recall"], 1.0)
        self.assertEqual(comparable["precision"], 1.0)
        self.assertTrue(all_side["pass"])
        self.assertTrue(comparable["pass"])

        self.assertEqual(result["target_level"]["targets_with_true"], 33)
        self.assertEqual(result["target_level"]["fully_correct_independent"], 33)
        self.assertEqual(result["summary"]["poly"], 7)
        self.assertEqual(result["summary"]["excluded"], 2)
        self.assertEqual(
            result["excluded_reasons"],
            {"ambiguous-receiver": 1, "unreachable-version-branch": 1},
        )

    # -- (b) dropping chosen true sites --------------------------------------

    def test_dropping_eight_direct_true_sites_pins_recall_and_wilson(self):
        drops = stub_index.first_n_direct_true_sites(TRUTH_DIR, 8)
        stub = self.perfect()
        for key, site in drops:
            stub.drop_at(key, site)
        result = self.score(stub)

        all_side = result["verdict"]["all_attributable"]
        comparable = result["verdict"]["pyright_comparable"]

        # ALL-ATTRIBUTABLE: 72/80, Wilson 0.8149-0.9485 (lower is the
        # wilson-floor.txt row for n=80, k=72).
        self.assertEqual(all_side["recall_found"], 72)
        self.assertEqual(all_side["recall_denominator"], 80)
        self.assertEqual(
            (round(all_side["wilson"][0], 4), round(all_side["wilson"][1], 4)),
            (0.8149, 0.9485),
        )
        # PYRIGHT-COMPARABLE: 62/70, Wilson 0.7904-0.9409.
        self.assertEqual(comparable["recall_found"], 62)
        self.assertEqual(comparable["recall_denominator"], 70)
        self.assertEqual(
            (round(comparable["wilson"][0], 4), round(comparable["wilson"][1], 4)),
            (0.7904, 0.9409),
        )

        self.assertTrue(all_side["pass"])
        self.assertFalse(comparable["pass"])  # lower bound 0.7904 < 0.8
        self.assertEqual(result["totals"]["fn_independent"], 8)
        self.assertEqual(result["totals"]["fn_comparable"], 8)

    # -- (c) false edges -----------------------------------------------------

    def test_false_edges_are_scored_by_the_ruled_conventions(self):
        cases = [
            # (label, site, fp_independent delta, fp_comparable delta)
            ("other-definition direct", OTHER_DEF_DIRECT, 1, 1),
            ("poly ignored", POLY_SITE, 0, 0),
            ("excluded ignored", EXCLUDED_SITE, 0, 0),
            ("other-definition inferred", OTHER_DEF_INFERRED, 1, 0),
        ]
        base = self.score(self.perfect())
        for label, (key, site), delta_ind, delta_comp in cases:
            with self.subTest(case=label):
                stub = self.perfect()
                stub.add_at(key, site)
                result = self.score(stub)
                self.assertEqual(
                    result["totals"]["fp_independent"],
                    base["totals"]["fp_independent"] + delta_ind,
                )
                self.assertEqual(
                    result["totals"]["fp_comparable"],
                    base["totals"]["fp_comparable"] + delta_comp,
                )
                # recall is never moved by a false edge
                self.assertEqual(
                    result["totals"]["tp_independent"],
                    base["totals"]["tp_independent"],
                )

        # All four together: independent precision 80/82, comparable 70/71.
        stub = self.perfect()
        for _label, (key, site), _a, _b in cases:
            stub.add_at(key, site)
        result = self.score(stub)
        self.assertEqual(result["totals"]["fp_independent"], 2)
        self.assertEqual(result["totals"]["fp_comparable"], 1)
        self.assertAlmostEqual(
            result["verdict"]["all_attributable"]["precision"], 80 / 82, places=12
        )
        self.assertAlmostEqual(
            result["verdict"]["pyright_comparable"]["precision"], 70 / 71, places=12
        )

    # -- (d) the directory filter -------------------------------------------

    def test_edges_outside_the_scored_directory_are_ignored(self):
        base = self.score(self.perfect())
        stub = self.perfect()
        # "core.py" is not under "src/click/": an edge there must not count.
        stub.add_outside_edge("utils.py:179 echo", "core.py", 50)
        # A prefix that merely starts with "src/click" is also outside.
        stub.add_outside_edge("utils.py:179 echo", "src/click_extra/x.py", 50)
        result = self.score(stub)
        self.assertEqual(result["totals"]["fp_independent"], base["totals"]["fp_independent"])
        self.assertEqual(
            result["verdict"]["all_attributable"]["precision"],
            base["verdict"]["all_attributable"]["precision"],
        )
        self.assertEqual(result["edges"]["outside_package"], 2)

    # -- (e) a missing target symbol -----------------------------------------

    def test_missing_target_symbol_exits_6_and_names_it(self):
        stub = self.perfect().remove_symbol("decorators.py:309 help_option")
        completed = run_cli(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn("decorators.py:309 help_option", completed.stderr)
        self.assertIn("no matching symbol", completed.stderr)

    # -- (f) an empty index --------------------------------------------------

    def test_empty_index_exits_7(self):
        completed = run_cli(stub_index.minimal_index())
        self.assertEqual(completed.returncode, 7)
        self.assertIn("zero invocation edges", completed.stderr)

    # -- malformed input -----------------------------------------------------

    def test_malformed_json_exits_6(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            completed = subprocess.run(
                [sys.executable, "-I", GATE_SCORE, path],
                capture_output=True,
                text=True,
            )
        self.assertEqual(completed.returncode, 6)

    # -- (g) mutation proofs: flipping each convention changes the output ----

    def test_mutation_denominator_choice(self):
        stub = stub_index.Stub(TRUTH_DIR, PACKAGE_DIR)
        for key, classification in stub.classified["targets"].items():
            for entry in classification["true"]:
                if entry["receiver_evidence"] == "inferred":
                    stub.add_at(key, entry["site"])
        default = self.score(stub)
        mutated = self.score(stub, mutations={"comparable-includes-inferred"})
        self.assertEqual(default["verdict"]["all_attributable"]["recall"], 10 / 80)
        self.assertEqual(default["verdict"]["pyright_comparable"]["recall"], 0.0)
        self.assertEqual(mutated["verdict"]["pyright_comparable"]["recall"], 10 / 80)
        self.assertNotEqual(
            default["verdict"]["pyright_comparable"]["recall"],
            mutated["verdict"]["pyright_comparable"]["recall"],
        )

    def test_mutation_poly_handling(self):
        stub = self.perfect().add_at(*POLY_SITE)
        default = self.score(stub)
        mutated = self.score(stub, mutations={"poly-counts-as-fp"})
        self.assertEqual(default["totals"]["fp_independent"], 0)
        self.assertEqual(mutated["totals"]["fp_independent"], 1)
        self.assertNotEqual(
            default["verdict"]["all_attributable"]["precision"],
            mutated["verdict"]["all_attributable"]["precision"],
        )

    def test_mutation_excluded_handling(self):
        stub = self.perfect().add_at(*EXCLUDED_SITE)
        default = self.score(stub)
        mutated = self.score(stub, mutations={"excluded-counts-as-fp"})
        self.assertEqual(default["totals"]["fp_independent"], 0)
        self.assertEqual(mutated["totals"]["fp_independent"], 1)

    def test_mutation_comparable_side_exclusion(self):
        stub = self.perfect().add_at(*OTHER_DEF_INFERRED)
        default = self.score(stub)
        mutated = self.score(stub, mutations={"comparable-keeps-inferred"})
        self.assertEqual(default["totals"]["fp_comparable"], 0)
        self.assertEqual(mutated["totals"]["fp_comparable"], 1)
        self.assertNotEqual(
            default["verdict"]["pyright_comparable"]["precision"],
            mutated["verdict"]["pyright_comparable"]["precision"],
        )

    def test_mutation_directory_filter(self):
        stub = self.perfect().add_outside_edge("utils.py:179 echo", "core.py", 50)
        default = self.score(stub)
        mutated = self.score(stub, mutations={"no-directory-filter"})
        self.assertEqual(default["totals"]["fp_independent"], 0)
        self.assertEqual(mutated["totals"]["fp_independent"], 1)
        self.assertNotEqual(
            default["verdict"]["all_attributable"]["precision"],
            mutated["verdict"]["all_attributable"]["precision"],
        )

    def test_mutation_line_match(self):
        stub = self.perfect().move_at(
            "_compat.py:640 _is_jupyter_kernel_output", "_compat.py:656:42", 9000
        )
        default = self.score(stub)
        mutated = self.score(stub, mutations={"match-ignore-line"})
        self.assertEqual(default["totals"]["tp_independent"], 79)
        self.assertEqual(default["totals"]["fp_independent"], 1)
        self.assertEqual(mutated["totals"]["tp_independent"], 80)
        self.assertEqual(mutated["totals"]["fp_independent"], 0)

    # -- symbol identity: the additive qualname (DEC-303 (a5) Q6) ------------

    def test_symbol_without_qualname_is_missing(self):
        # The scorer reads the additive `qualname`; a nested function whose symbol
        # carries only `container` has no matching symbol (exit 6).
        stub = self.perfect()
        symbol = next(
            s
            for s in stub.symbols
            if s["file"].endswith("core.py") and s["line"] == 1563
        )
        saved = symbol.pop("qualname")
        completed = run_cli(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn("core.py:1563", completed.stderr)
        self.assertIn("Parameter.type_cast_value._convert", completed.stderr)
        # With `qualname` restored the target scores.
        symbol["qualname"] = saved
        self.assertEqual(run_cli(stub.index()).returncode, 0)

    # -- constructor crediting (ruling 1): two edges per construction --------

    CLICK_CONSTRUCTIONS = {
        "exceptions.py:252 Exit.__init__": (
            "Exit", "exceptions.py", 243, ["core.py:558:14"]
        ),
        "exceptions.py:94 BadParameter.__init__": (
            "BadParameter", "exceptions.py", 76, ["types.py:76:14"]
        ),
    }

    def test_click_one_edge_per_construction_scores_at_most_one_hit(self):
        two_edge = self.score(self.perfect())
        self.assertEqual(two_edge["totals"]["tp_independent"], 80)
        self.assertEqual(two_edge["totals"]["found_comparable"], 70)

        stub = self.perfect()
        for key, (class_name, class_file, class_line, sites) in self.CLICK_CONSTRUCTIONS.items():
            class_id = stub.add_raw_symbol(class_file, class_line, class_name, "class")
            for site in sites:
                candidate = stub._site_records[key][site]
                stub.drop_at(key, site)
                if not stub.has_edge(class_id, candidate["file"], candidate["call_start_line"]):
                    stub.add_edge_to(
                        class_id, candidate["file"], candidate["call_start_line"],
                        column=candidate["col"],
                    )
        one_edge = self.score(stub)
        self.assertEqual(one_edge["totals"]["tp_independent"], 78)
        self.assertEqual(
            (
                round(one_edge["verdict"]["all_attributable"]["wilson"][0], 4),
                round(one_edge["verdict"]["all_attributable"]["wilson"][1], 4),
            ),
            (0.9134, 0.9931),
        )
        self.assertEqual(one_edge["totals"]["found_comparable"], 68)
        self.assertEqual(
            (
                round(one_edge["verdict"]["pyright_comparable"]["wilson"][0], 4),
                round(one_edge["verdict"]["pyright_comparable"]["wilson"][1], 4),
            ),
            (0.9017, 0.9921),
        )

    REQUESTS_CONSTRUCTIONS = {
        "models.py:407 PreparedRequest.__init__": (
            "PreparedRequest.__init__", "models.py", 378,
            ["models.py:362:12", "models.py:457:12", "sessions.py:540:12"],
        ),
        "auth.py:96 HTTPBasicAuth.__init__": (
            "HTTPBasicAuth.__init__", None, None, ["models.py:685:31"],
        ),
        "cookies.py:45 MockRequest.__init__": (
            "MockRequest.__init__", "cookies.py", 31,
            ["cookies.py:147:10", "cookies.py:159:8"],
        ),
    }

    def test_requests_one_edge_per_construction_scores_59_of_65(self):
        two_edge = self.score_requests(self.requests_perfect())
        self.assertEqual(two_edge["totals"]["tp_independent"], 65)
        self.assertEqual(two_edge["totals"]["found_comparable"], 65)

        stub = self.requests_perfect()
        class_ids = {"HTTPBasicAuth.__init__": stub.ids["auth.py:85 HTTPBasicAuth"]}
        for key, (label, class_file, class_line, _sites) in self.REQUESTS_CONSTRUCTIONS.items():
            if class_file is not None:
                class_ids[label] = stub.add_raw_symbol(class_file, class_line, label.split(".")[0], "class")
        for key, (label, _cf, _cl, sites) in self.REQUESTS_CONSTRUCTIONS.items():
            class_id = class_ids[label]
            for site in sites:
                candidate = stub._site_records[key][site]
                stub.drop_at(key, site)
                if not stub.has_edge(class_id, candidate["file"], candidate["call_start_line"]):
                    stub.add_edge_to(
                        class_id, candidate["file"], candidate["call_start_line"],
                        column=candidate["col"],
                    )
        one_edge = self.score_requests(stub)
        self.assertEqual(one_edge["totals"]["tp_independent"], 59)
        self.assertEqual(
            (
                round(one_edge["verdict"]["all_attributable"]["wilson"][0], 4),
                round(one_edge["verdict"]["all_attributable"]["wilson"][1], 4),
            ),
            (0.8129, 0.9570),
        )
        self.assertEqual(one_edge["totals"]["found_comparable"], 59)
        self.assertEqual(
            (
                round(one_edge["verdict"]["pyright_comparable"]["wilson"][0], 4),
                round(one_edge["verdict"]["pyright_comparable"]["wilson"][1], 4),
            ),
            (0.8129, 0.9570),
        )

    # -- requests: full scoring under both denominators ---------------------

    def test_requests_perfect_index_gives_full_recall_and_precision(self):
        self.assertEqual(len(self.requests_truth["seeds"]), 46)
        summary = self.requests_truth["summary"]
        self.assertEqual(summary["true"], 65)
        self.assertEqual(summary["true_direct"], 64)
        self.assertEqual(summary["true_inferred"], 1)
        self.assertEqual(summary["poly"], 1)
        self.assertEqual(summary["excluded"], 0)
        self.assertEqual(summary["other_definition"], 131)
        self.assertEqual(summary["targets_with_a_true_site"], 37)

        result = self.score_requests(self.requests_perfect())
        totals = result["totals"]
        self.assertEqual(totals["true"], 65)
        self.assertEqual(totals["true_direct"], 64)
        self.assertEqual(totals["direct_only"], 64)
        self.assertEqual(totals["tp_independent"], 65)
        self.assertEqual(totals["fp_independent"], 0)
        self.assertEqual(totals["found_comparable"], 65)
        self.assertEqual(totals["comparable_total"], 65)
        self.assertEqual(totals["tp_comparable"], 64)
        self.assertEqual(totals["fp_comparable"], 0)

        all_side = result["verdict"]["all_attributable"]
        comparable = result["verdict"]["pyright_comparable"]
        self.assertEqual((all_side["recall_found"], all_side["recall_denominator"]), (65, 65))
        self.assertEqual((comparable["recall_found"], comparable["recall_denominator"]), (65, 65))
        self.assertEqual(all_side["precision"], 1.0)
        self.assertEqual(comparable["precision"], 1.0)
        self.assertTrue(all_side["pass"])
        self.assertTrue(comparable["pass"])
        self.assertEqual(result["target_level"]["targets_with_true"], 37)
        self.assertEqual(result["target_level"]["fully_correct_independent"], 37)
        self.assertEqual(result["target_level"]["fully_correct_comparable"], 37)

    def test_requests_dropping_eight_direct_sites_pins_recall_and_wilson(self):
        drops = stub_index.first_n_requests_direct_true_sites(TRUTH_DIR, 8)
        stub = self.requests_perfect()
        for key, site in drops:
            stub.drop_at(key, site)
        result = self.score_requests(stub)

        all_side = result["verdict"]["all_attributable"]
        comparable = result["verdict"]["pyright_comparable"]
        # 57/65, Wilson 0.7755-0.9363 (computed with wilson_floor.py's formula).
        self.assertEqual((all_side["recall_found"], all_side["recall_denominator"]), (57, 65))
        self.assertEqual(
            (round(all_side["wilson"][0], 4), round(all_side["wilson"][1], 4)),
            (0.7755, 0.9363),
        )
        self.assertEqual(
            (comparable["recall_found"], comparable["recall_denominator"]), (57, 65)
        )
        self.assertEqual(
            (round(comparable["wilson"][0], 4), round(comparable["wilson"][1], 4)),
            (0.7755, 0.9363),
        )
        self.assertEqual(result["totals"]["tp_comparable"], 56)  # 64 direct - 8
        self.assertFalse(all_side["pass"])
        self.assertFalse(comparable["pass"])

    def test_requests_false_edges_are_scored_by_the_ruled_conventions(self):
        cases = [
            ("other-definition direct", REQ_OTHER_DEF_DIRECT, 1, 1),
            ("other-definition inferred", REQ_OTHER_DEF_INFERRED, 1, 0),
            ("poly ignored", REQ_POLY, 0, 0),
        ]
        base = self.score_requests(self.requests_perfect())
        for label, (key, site), delta_ind, delta_comp in cases:
            with self.subTest(case=label):
                stub = self.requests_perfect().add_at(key, site)
                result = self.score_requests(stub)
                self.assertEqual(
                    result["totals"]["fp_independent"],
                    base["totals"]["fp_independent"] + delta_ind,
                )
                self.assertEqual(
                    result["totals"]["fp_comparable"],
                    base["totals"]["fp_comparable"] + delta_comp,
                )
                self.assertEqual(
                    result["totals"]["tp_independent"], base["totals"]["tp_independent"]
                )

        stub = self.requests_perfect()
        for _label, (key, site), _a, _b in cases:
            stub.add_at(key, site)
        result = self.score_requests(stub)
        self.assertEqual(result["totals"]["fp_independent"], 2)
        self.assertEqual(result["totals"]["fp_comparable"], 1)
        self.assertAlmostEqual(
            result["verdict"]["all_attributable"]["precision"], 65 / 67, places=12
        )
        self.assertAlmostEqual(
            result["verdict"]["pyright_comparable"]["precision"], 64 / 65, places=12
        )

    def test_requests_edges_outside_the_scored_directory_are_ignored(self):
        base = self.score_requests(self.requests_perfect())
        stub = self.requests_perfect().add_outside_edge(
            "utils.py:231 get_netrc_auth", "utils.py", 330
        )
        result = self.score_requests(stub)
        self.assertEqual(result["totals"]["fp_independent"], base["totals"]["fp_independent"])
        self.assertEqual(result["edges"]["outside_package"], 1)

    def test_requests_overload_stub_maps_to_implementation_line(self):
        stub = self.requests_perfect()
        result = self.score_requests(stub)
        self.assertEqual(result["totals"]["tp_independent"], 65)
        # Add the stub-line symbols too, so the mutation has something to map to.
        for key, _implementation in stub.overloads.items():
            stub.add_symbol_at(key, stub._targets_by_key[key]["line"])
        default = self.score_requests(stub)
        mutated = self.score_requests(stub, mutations={"no-overload-map"})
        self.assertEqual(default["totals"]["tp_independent"], 65)
        self.assertEqual(mutated["totals"]["tp_independent"], 58)  # 7 sites on 3 stub targets
        self.assertNotEqual(
            default["totals"]["tp_independent"], mutated["totals"]["tp_independent"]
        )

    def test_requests_overload_symbol_only_at_stub_line_exits_6(self):
        # The symbol must be at the implementation line; at the committed stub line
        # the target is missing (exit 6).
        stub = self.requests_perfect()
        key = "utils.py:373 to_key_val_list"
        stub.remove_symbol(key)
        stub.add_symbol_at(key, stub._targets_by_key[key]["line"])
        completed = run_cli_requests(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn(key, completed.stderr)

    def test_requests_missing_symbol_exits_6(self):
        stub = self.requests_perfect()
        zero = next(k for k, v in stub.classified["targets"].items() if not v["true"])
        stub.remove_symbol(zero)
        completed = run_cli_requests(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn(zero, completed.stderr)

    def test_requests_empty_index_exits_7(self):
        completed = run_cli_requests(stub_index.minimal_index())
        self.assertEqual(completed.returncode, 7)
        self.assertIn("zero invocation edges", completed.stderr)

    def test_requests_cli_prints_full_report(self):
        completed = run_cli_requests(self.requests_perfect().index())
        self.assertEqual(completed.returncode, 0)
        self.assertIn("INDEPENDENT", completed.stdout)
        self.assertIn("BASELINE COMPARISON", completed.stdout)
        self.assertIn("REPOSITORY VERDICT: PASS", completed.stdout)
        self.assertNotIn("REPOSITORY VERDICT: FAIL", completed.stdout)
        self.assertIn("direct-only 64/65", completed.stdout)
        self.assertIn("inputs read", completed.stdout)
        self.assertIn("overloads", completed.stdout)

    def test_requests_mutation_comparable_inferred_exclusion(self):
        stub = self.requests_perfect().add_at(*REQ_OTHER_DEF_INFERRED)
        default = self.score_requests(stub)
        mutated = self.score_requests(stub, mutations={"comparable-keeps-inferred"})
        self.assertEqual(default["totals"]["fp_comparable"], 0)
        self.assertEqual(mutated["totals"]["fp_comparable"], 1)
        self.assertNotEqual(
            default["verdict"]["pyright_comparable"]["precision"],
            mutated["verdict"]["pyright_comparable"]["precision"],
        )

    def test_requests_mutation_direct_only_denominator(self):
        key, site = stub_index.first_n_requests_direct_true_sites(TRUTH_DIR, 1)[0]
        stub = self.requests_perfect().drop_at(key, site)
        default = self.score_requests(stub)
        mutated = self.score_requests(
            stub, mutations={"comparable-direct-only-denominator"}
        )
        self.assertEqual(
            (
                default["verdict"]["pyright_comparable"]["recall_found"],
                default["verdict"]["pyright_comparable"]["recall_denominator"],
            ),
            (64, 65),
        )
        self.assertEqual(
            (
                mutated["verdict"]["pyright_comparable"]["recall_found"],
                mutated["verdict"]["pyright_comparable"]["recall_denominator"],
            ),
            (63, 64),
        )

    # -- repository verdict (DEC-303 (a5) Q5 arm B: independent side only) ---

    def test_repository_verdict_click_uses_only_the_independent_side(self):
        perfect = self.score(self.perfect())
        self.assertTrue(perfect["repository_verdict"])
        self.assertTrue(perfect["suitable"])
        out = self.render_click(perfect)
        self.assertIn("REPOSITORY VERDICT: PASS", out)
        self.assertIn("BASELINE COMPARISON", out)

        # Independent FAILS while the comparable side passes: drop all 10 inferred
        # true sites (the comparable denominator is the direct-only set).
        stub = self.perfect()
        inferred = [
            (key, site["site"])
            for key, entry in stub.classified["targets"].items()
            for site in entry["true"]
            if site["receiver_evidence"] == "inferred"
        ]
        self.assertEqual(len(inferred), 10)
        for key, site in inferred:
            stub.drop_at(key, site)
        independent_fails = self.score(stub)
        self.assertFalse(independent_fails["repository_verdict"])
        self.assertTrue(independent_fails["verdict"]["pyright_comparable"]["pass"])
        out = self.render_click(independent_fails)
        self.assertIn("REPOSITORY VERDICT: FAIL", out)
        self.assertNotIn("REPOSITORY VERDICT: PASS", out)

        # Independent PASSES while the comparable side fails: drop 8 direct sites.
        stub = self.perfect()
        for key, site in stub_index.first_n_direct_true_sites(TRUTH_DIR, 8):
            stub.drop_at(key, site)
        comparable_fails = self.score(stub)
        self.assertTrue(comparable_fails["repository_verdict"])
        self.assertFalse(comparable_fails["verdict"]["pyright_comparable"]["pass"])
        self.assertIn("REPOSITORY VERDICT: PASS", self.render_click(comparable_fails))

    def test_repository_verdict_requests_uses_only_the_independent_side(self):
        perfect = self.score_requests(self.requests_perfect())
        self.assertTrue(perfect["repository_verdict"])
        out = self.render_requests(perfect)
        self.assertIn("REPOSITORY VERDICT: PASS", out)
        self.assertIn("BASELINE COMPARISON", out)

        # Independent FAILS on independent precision while the comparable side
        # passes: 4 emitted edges at inferred non-true sites, which the comparable
        # precision side drops.
        inferred_sites = [
            ("structures.py:127 LookupDict.get", "auth.py:164:38"),
            ("structures.py:127 LookupDict.get", "auth.py:165:44"),
            ("structures.py:127 LookupDict.get", "auth.py:166:41"),
            ("structures.py:127 LookupDict.get", "cookies.py:63:31"),
        ]
        stub = self.requests_perfect()
        for key, site in inferred_sites:
            stub.add_at(key, site)
        independent_fails = self.score_requests(stub)
        self.assertFalse(independent_fails["repository_verdict"])
        self.assertTrue(independent_fails["verdict"]["pyright_comparable"]["pass"])
        self.assertLess(
            independent_fails["verdict"]["all_attributable"]["precision"], 0.95
        )
        self.assertIn("REPOSITORY VERDICT: FAIL", self.render_requests(independent_fails))

        # The reverse is not realisable on requests, by integer arithmetic. The
        # precision floor 0.95 is `19 * fp <= tp`; the independent side passes only
        # when `19 * fp_i <= tp_i`, the comparable side fails only when
        # `19 * fp_c >= tp_c + 1`. With one inferred true site `tp_i <= tp_c + 1`,
        # and `fp_i >= fp_c`, so `19*fp_c <= 19*fp_i <= tp_i <= tp_c + 1` forces
        # `19*fp_c = tp_c + 1`, i.e. `tp_c` is 18 (mod 19). Independent recall needs
        # `tp_i/65 >= 0.9`, so `tp_i >= 59` and `tp_c >= 58`; the direct true sites
        # cap `tp_c` at 64. No integer in [58, 64] is 18 (mod 19) (they are 56 and
        # 75), so the comparable side cannot fail precision while independent passes.
        # A plain failing case still yields FAIL.
        stub = self.requests_perfect()
        for key, site in stub_index.first_n_requests_direct_true_sites(TRUTH_DIR, 8):
            stub.drop_at(key, site)
        both_fail = self.score_requests(stub)
        self.assertFalse(both_fail["repository_verdict"])
        self.assertFalse(both_fail["verdict"]["pyright_comparable"]["pass"])

    # -- the 62-site floor ---------------------------------------------------

    def test_below_floor_is_unsuitable_and_has_no_verdict(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_truncated_click_truth(tmp, keep=10)
            truth = gate_score.load_click_truth(tmp, verify_hashes=False)
        self.assertLess(truth["summary"]["true"], gate_score.MIN_TRUE_SITES)
        result = gate_score.score_click(truth, self.perfect().index(), PACKAGE_DIR)
        self.assertFalse(result["suitable"])
        # An unsuitable truth has no verdict: not False (a FAIL), None.
        self.assertIsNone(result["repository_verdict"])
        out = capture_stdout(
            lambda: gate_score.render_click_report(
                result, truth, truth["sources"], GATE_SCORE
            )
        )
        self.assertIn("UNSUITABLE", out)
        self.assertNotIn("REPOSITORY VERDICT", out)

    # -- truth integrity and index-integrity exit-6 cases --------------------

    def test_sha_mismatch_exits_6(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = copy_click_truth(tmp)
            with open(os.path.join(base, "classified-batch0.json"), "ab") as fh:
                fh.write(b" ")
            with self.assertRaises(gate_score.GateError) as context:
                gate_score.load_click_truth(tmp)  # verify_hashes defaults True
        self.assertEqual(context.exception.code, 6)
        self.assertIn("does not match the pinned", str(context.exception))

    def test_requests_sha_mismatch_exits_6(self):
        # Every requests input is pinned; a stray byte is exit 6 naming the file.
        for name in (
            "targets.json",
            "classified-requests-independent.json",
            "non-true-site-evidence.json",
            "overload-groups.json",
        ):
            with self.subTest(input=name), tempfile.TemporaryDirectory() as tmp:
                base = copy_requests_truth(tmp)
                with open(os.path.join(base, name), "ab") as fh:
                    fh.write(b" ")
                with self.assertRaises(gate_score.GateError) as context:
                    gate_score.load_requests_truth(tmp)  # verify_hashes defaults True
                self.assertEqual(context.exception.code, 6)
                self.assertIn("does not match the pinned", str(context.exception))

    def test_gt3_sha_mismatch_exits_6(self):
        # gt3 lives outside --truth-dir (pinned from THIS script's directory too);
        # a stray byte in it is exit 6, and the real requests files still match.
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "gt3_classified.json")
            with open(gate_score.GT3_PATH, "rb") as fh:
                data = fh.read()
            with open(bad, "wb") as fh:
                fh.write(data + b" ")
            with mock.patch.object(gate_score, "GT3_PATH", bad):
                with self.assertRaises(gate_score.GateError) as context:
                    gate_score.load_requests_truth(TRUTH_DIR)
        self.assertEqual(context.exception.code, 6)
        self.assertIn("does not match the pinned", str(context.exception))
        self.assertIn("gt3", str(context.exception))

    def test_duplicate_true_site_exits_6(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = copy_click_truth(tmp)
            path = os.path.join(base, "classified-batch0.json")
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            key = next(k for k, v in data["targets"].items() if v["true"])
            data["targets"][key]["true"].append(dict(data["targets"][key]["true"][0]))
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            with self.assertRaises(gate_score.GateError) as context:
                gate_score.load_click_truth(tmp, verify_hashes=False)
        self.assertEqual(context.exception.code, 6)
        self.assertIn("twice", str(context.exception))

    def test_true_and_poly_overlap_exits_6(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = copy_click_truth(tmp)
            path = os.path.join(base, "classified-batch0.json")
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            key = next(k for k, v in data["targets"].items() if v["true"])
            data["targets"][key]["poly"].append(
                {"site": data["targets"][key]["true"][0]["site"]}
            )
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            with self.assertRaises(gate_score.GateError) as context:
                gate_score.load_click_truth(tmp, verify_hashes=False)
        self.assertEqual(context.exception.code, 6)
        self.assertIn("twice", str(context.exception))

    def test_unknown_site_kind_exits_6(self):
        stub = self.perfect()
        stub.sites.append({
            "calleeId": next(iter(stub.ids.values())),
            "callerId": None,
            "file": "src/click/core.py",
            "line": 1,
            "column": 0,
            "kind": "bogus",
        })
        completed = run_cli(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn("not a known SiteKind", completed.stderr)

    def test_unknown_callee_id_exits_6(self):
        stub = self.perfect()
        stub.sites.append({
            "calleeId": "no-such-symbol",
            "callerId": None,
            "file": "src/click/core.py",
            "line": 1,
            "column": 0,
            "kind": "call",
        })
        completed = run_cli(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn("unknown calleeId", completed.stderr)

    def test_duplicate_symbol_id_exits_6(self):
        stub = self.perfect()
        duplicate = dict(stub.symbols[0])
        duplicate["line"] = 99999  # same id bytes, different line: not a 2-symbol match
        duplicate["startLine"] = 99999
        stub.symbols.append(duplicate)
        completed = run_cli(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn("two symbols with id", completed.stderr)

    def test_two_symbols_matching_one_target_exits_6(self):
        stub = self.perfect()
        key = "decorators.py:309 help_option"
        symbol = next(s for s in stub.symbols if s["id"] == stub.ids[key])
        duplicate = dict(symbol)
        duplicate["id"] = symbol["id"] + ":dup"
        duplicate["column"] = symbol["column"] + 1
        stub.symbols.append(duplicate)
        completed = run_cli(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn("matches 2 symbols", completed.stderr)

    def test_two_seeds_sharing_a_symbol_signature_exit_6(self):
        # A hand-built truth with two targets on one symbol signature; the scorer
        # must refuse to collapse them rather than let one shadow the other.
        truth = {
            "kind": "click",
            "seeds": {
                "a.py:1 f": {"file": "a.py", "line": 1, "symbol_line": 1, "qualname": "f"},
                "a.py:1 g": {"file": "a.py", "line": 1, "symbol_line": 1, "qualname": "f"},
            },
            "summary": {"poly": 0, "excluded": 0},
            "excluded_reasons": {},
        }
        index = stub_index.minimal_index()
        index["symbols"] = [
            {"id": "src/click/a.py:1:1", "name": "f", "qualname": "f",
             "file": "src/click/a.py", "line": 1}
        ]
        index["sites"] = [
            {"calleeId": "src/click/a.py:1:1", "callerId": None,
             "file": "src/click/a.py", "line": 2, "column": 0, "kind": "call"}
        ]
        with self.assertRaises(gate_score.GateError) as context:
            gate_score.score_click(truth, index, PACKAGE_DIR)
        self.assertEqual(context.exception.code, 6)
        self.assertIn("share the symbol signature", str(context.exception))

    def test_non_default_truth_dir_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "index.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(self.perfect().index(), fh)
            completed = subprocess.run(
                [sys.executable, "-I", GATE_SCORE, path, "--truth-dir", tmp],
                capture_output=True,
                text=True,
            )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("may not be overridden", completed.stderr)


if __name__ == "__main__":
    unittest.main()
