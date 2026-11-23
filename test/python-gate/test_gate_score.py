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

    # -- mapping requirement: full enclosing qualname ------------------------

    def test_nested_function_container_must_carry_full_qualname(self):
        # A nested function needs container = the whole enclosing qualified name,
        # not merely the nearest class, or the target has no matching symbol (exit 6).
        stub = self.perfect()
        edited = None
        for symbol in stub.symbols:
            if symbol["file"].endswith("core.py") and symbol["line"] == 1563:
                symbol["container"] = "Parameter"  # nearest class only -> wrong qualname
                edited = symbol
                break
        self.assertIsNotNone(edited)
        completed = run_cli(stub.index())
        self.assertEqual(completed.returncode, 6)
        self.assertIn("core.py:1563", completed.stderr)
        self.assertIn("Parameter.type_cast_value._convert", completed.stderr)

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
        self.assertIn("GATE INDEPENDENT", completed.stdout)
        self.assertIn("GATE PYRIGHT-COMPARABLE", completed.stdout)
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


if __name__ == "__main__":
    unittest.main()
