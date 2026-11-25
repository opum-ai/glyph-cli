#!/usr/bin/env bun
/**
 * Report Python call resolution (S5, GCLI-81) over the two gate repositories.
 *
 * It runs `analyzePythonCalls` over the click 7.1.2 `src/click` and requests
 * `src/requests` packages from scratch checkouts of the pinned commits
 * (click 1784558e, requests 3c7baaa) and prints the four call bins, the
 * unresolved reasons, the polymorphic and multiply-bound counts, and the files
 * with ERROR regions.
 *
 * If `python3` is available it also emits a `GlyphIndex` JSON and runs
 * `test/python-gate/gate_score.py` on it. That is NOT the gate run: the gate is
 * owned by S8 and this script changes no ground truth, scorer or data file. Its
 * numbers are informational and are printed under a NOT-the-gate-run label.
 *
 * Usage:
 *   bun test/python-gate/check_call_sites.ts <click-checkout> <requests-checkout>
 *
 * A repository that produced zero files, zero symbols or zero call expressions
 * fails: a check that read nothing must fail rather than pass.
 */

import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { INDEX_FORMAT } from "../../src/types.ts";
import { analyzePythonCalls, type PythonCallsResult, type ReasonCount } from "../../src/python/calls.ts";
import type { PythonModuleInput } from "../../src/python/modules.ts";

const HERE = import.meta.dir;
const SCORER = join(HERE, "gate_score.py");

interface RepoCheck {
	name: string;
	/** Repository-relative directory holding the package. */
	packageDir: string;
}

const REPOS: RepoCheck[] = [
	{ name: "click 7.1.2", packageDir: "src/click" },
	{ name: "requests 3c7baaa", packageDir: "src/requests" },
];

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function pyFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (statSync(path).isDirectory()) out.push(...pyFiles(path));
		else if (entry.endsWith(".py")) out.push(path);
	}
	return out.sort();
}

function loadInputs(root: string, packageDir: string): PythonModuleInput[] {
	const packageRoot = join(root, packageDir);
	let files: string[];
	try {
		files = pyFiles(packageRoot);
	} catch {
		fail(`package directory not found: ${packageRoot}`);
	}
	return files.map((file) => ({
		path: relative(root, file).split(sep).join("/"),
		bytes: readFileSync(file),
	}));
}

function printResult(name: string, packageDir: string, result: PythonCallsResult): void {
	console.log(`== ${name} (${packageDir}) ==`);
	console.log(
		`  files ${result.counts.files}; call expressions ${result.callExpressionCount}; emitted edges ${result.sites.length} (${result.counts.decoratorSites} decorator sites)`,
	);
	console.log("  call bins:");
	console.log(`    resolvedInRepo         ${result.callBins.resolvedInRepo}`);
	console.log(`    resolvedExternal       ${result.callBins.resolvedExternal}`);
	console.log(`    receiverNeedsInference ${result.callBins.receiverNeedsInference}`);
	console.log(`    nameNotBound           ${result.callBins.nameNotBound}`);
	console.log(`  polymorphic sites  ${result.polymorphicCount}`);
	console.log(`  multiply-bound sites ${result.multiplyBoundCount}`);
	console.log(`  constructor notes  ${result.constructorNotes.length}`);
	console.log(
		`  files with ERROR regions  ${result.errorFiles.length}${result.errorFiles.length > 0 ? `: ${result.errorFiles.join(", ")}` : ""}`,
	);
	console.log(`  dropped calls (inside ERROR) ${result.droppedCalls}`);
	console.log(`  S3 exit7 triggers ${result.exit7.length}; exact ${result.exact}`);
	const reasons = (label: string, entries: ReasonCount[]) => {
		if (entries.length === 0) {
			console.log(`  ${label}: none`);
			return;
		}
		console.log(`  ${label}:`);
		for (const entry of entries) {
			const named = entry.firstSites
				.slice(0, 3)
				.map((site) => `${site.file}:${site.line}:${site.column}`)
				.join(", ");
			console.log(`    ${entry.reason} ${entry.count}${named === "" ? "" : `  e.g. ${named}`}`);
		}
	};
	reasons("UNRESOLVED_NAME reasons", result.unresolvedNameReasons);
	reasons("UNRESOLVED_RECEIVER reasons", result.unresolvedReceiverReasons);
	console.log("");
}

function buildIndex(name: string, inputs: PythonModuleInput[], result: PythonCallsResult): unknown {
	const unresolvedSites =
		result.unresolvedByKind.call +
		result.unresolvedByKind.import +
		result.unresolvedByKind.extends +
		result.unresolvedByKind.implements +
		result.unresolvedByKind.dynamic;
	return {
		schemaVersion: INDEX_FORMAT,
		repo: name,
		createdAt: "1970-01-01T00:00:00.000Z",
		files: inputs.map((input) => input.path),
		symbols: result.symbols,
		sites: result.sites,
		unresolvedSites,
		unresolvedByKind: result.unresolvedByKind,
	};
}

function pythonAvailable(): boolean {
	const probe = Bun.spawnSync(["python3", "--version"], { stdout: "ignore", stderr: "ignore" });
	return probe.exitCode === 0;
}

function scoreIndex(mode: "click" | "requests", indexPath: string): void {
	const run = Bun.spawnSync(["python3", "-I", SCORER, mode, indexPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(run.stdout);
	const stderr = new TextDecoder().decode(run.stderr);
	if (stdout !== "") console.log(stdout.trimEnd());
	if (stderr !== "") console.log(stderr.trimEnd());
	console.log(`  gate_score.py exit ${run.exitCode}`);
}

async function checkRepo(repo: RepoCheck, root: string, outDir: string, score: boolean): Promise<void> {
	const inputs = loadInputs(root, repo.packageDir);
	if (inputs.length === 0) fail(`${repo.name}: read zero .py files under ${repo.packageDir}`);
	const result = await analyzePythonCalls(inputs);
	if (result.callExpressionCount === 0)
		fail(`${repo.name}: resolved zero call expressions (a run that read nothing must fail)`);
	if (result.symbols.length === 0) fail(`${repo.name}: collected zero symbols`);
	printResult(repo.name, repo.packageDir, result);

	if (!score) return;
	const indexPath = join(outDir, `${repo.packageDir.replace(/\//g, "_")}.index.json`);
	await Bun.write(indexPath, `${JSON.stringify(buildIndex(repo.name, inputs, result), null, 2)}\n`);
	console.log("NOT the gate run (S8 owns the gate); emitting a GlyphIndex and scoring it for information only.");
	console.log(`  index: ${indexPath}`);
	scoreIndex(repo.packageDir.endsWith("click") ? "click" : "requests", indexPath);
	console.log("");
}

async function main(): Promise<void> {
	const [clickRoot, requestsRoot] = process.argv.slice(2);
	if (clickRoot === undefined || requestsRoot === undefined) {
		console.error("usage: bun test/python-gate/check_call_sites.ts <click-checkout> <requests-checkout>");
		process.exit(2);
	}
	const outDir = mkdtempSync(join(tmpdir(), "glyph-call-sites-"));
	const score = pythonAvailable();
	if (!score) console.log("python3 unavailable: GlyphIndex scoring skipped (NOT the gate run).\n");
	await checkRepo(REPOS[0] as RepoCheck, clickRoot, outDir, score);
	await checkRepo(REPOS[1] as RepoCheck, requestsRoot, outDir, score);
	console.log("OK: call resolution ran over both gate repositories (NOT the gate run; S8 owns the gate)");
}

await main();
