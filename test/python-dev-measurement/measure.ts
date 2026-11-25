/**
 * Development measurement helper (GCLI-86, DEC-303 (a23) item 5; (a24) arm A).
 *
 * Runs the repository's own Python analyzer over one checked-out repository and
 * prints the call bins. Development data only: this file is not a test, no
 * workflow runs it, and no gate depends on its output. Written from scratch;
 * nothing here is derived from test/python-gate.
 *
 *   bun test/python-dev-measurement/measure.ts <repo-root>
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markerDirsFor } from "../../src/discover.ts";
import { analyzePythonCalls, type PythonCallsResult } from "../../src/python/calls.ts";

const EXCLUDED_SEGMENTS = new Set([".venv", "venv", "__pycache__", ".tox"]);

/** The git-tracked .py files of a clone, minus virtualenv and cache segments. */
export function trackedPythonFiles(root: string): string[] {
	const listed = execFileSync("git", ["-C", root, "ls-files", "*.py"], { encoding: "utf8" });
	return listed.split("\n").filter(
		(path) =>
			path !== "" &&
			!path
				.split("/")
				.slice(0, -1)
				.some((segment) => EXCLUDED_SEGMENTS.has(segment)),
	);
}

export async function analyzeRepository(root: string): Promise<PythonCallsResult> {
	const inputs = trackedPythonFiles(root).map((path) => ({
		path,
		bytes: new Uint8Array(readFileSync(join(root, path))),
	}));
	return analyzePythonCalls(inputs, { markerDirs: markerDirsFor(root) });
}

if (import.meta.main) {
	const root = process.argv[2];
	if (root === undefined) throw new Error("usage: bun test/python-dev-measurement/measure.ts <repo-root>");
	const result = await analyzeRepository(root);
	console.log(
		JSON.stringify({
			files: result.counts.files,
			callExpressions: result.callExpressionCount,
			bins: result.callBins,
			exact: result.exact,
			unresolvedNameReasons: result.unresolvedNameReasons.map((r) => [r.reason, r.count]),
			unresolvedReceiverReasons: result.unresolvedReceiverReasons.map((r) => [r.reason, r.count]),
		}),
	);
}
