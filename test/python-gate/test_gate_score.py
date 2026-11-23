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

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import gate_score  # noqa: E402
import stub_index  # noqa: E402

GATE_SCORE = os.path.join(HERE, "gate_score.py")
TRUTH_DIR = HERE
PACKAGE_DIR = "src/click"
REQUESTS_TRUTH = os.path.normpath(
    os.path.join(HERE, "..", "python-lsp-measurement", "gt3_classified.json")
)

# Concrete sites used by the false-edge tests (from the committed classification
# and the Addendum 4 Q3 evidence file).
OTHER_DEF_DIRECT = ("types.py:409 BoolParamType.convert", "types.py:290:26")
POLY_SITE = ("exceptions.py:129 MissingParameter.format_message", "exceptions.py:73:37")
EXCLUDED_SITE = (
    "_compat.py:97 _NonClosingTextIOWrapper.isatty",
    "_compat.py:744:22",
)
OTHER_DEF_INFERRED = ("core.py:566 Context.get_help", "core.py:570:28")


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


class GateScoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.truth = gate_score.load_click_truth(TRUTH_DIR)

    # -- helpers -------------------------------------------------------------

    def perfect(self):
        return stub_index.Stub(TRUTH_DIR, PACKAGE_DIR).perfect()

    def score(self, stub, mutations=frozenset()):
        return gate_score.score_click(
            self.truth, stub.index(), PACKAGE_DIR, mutations=mutations
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

    # -- the requests second reader -----------------------------------------

    def test_requests_reader_reports_comparable_recall_only(self):
        truth = gate_score.load_requests_truth(REQUESTS_TRUTH)
        self.assertEqual(len(truth["seeds"]), 46)
        index, _ids = stub_index.requests_stub(REQUESTS_TRUTH)
        result = gate_score.score_requests(index, truth, "src/requests")
        self.assertEqual(result["found"], 65)
        self.assertEqual(result["true"], 65)
        self.assertEqual(result["recall"], 1.0)
        self.assertEqual(result["independent"], "not scorable")
        self.assertEqual(result["precision"], "not scorable")


if __name__ == "__main__":
    unittest.main()
