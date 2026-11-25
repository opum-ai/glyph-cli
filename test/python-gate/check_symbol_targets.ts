#!/usr/bin/env bun
/**
 * Prove that the Python symbol builder resolves every committed ground-truth
 * target through the gate scorer's mapping (GCLI-76, ADR 0008).
 *
 * A target is identified by package-relative file + def/class line + qualname
 * (`gate_score.py`, `_match_target_symbols`). For requests, a target keyed to
 * an `@overload` stub is mapped to its implementation line through
 * `requests-3c7baaa/overload-groups.json` (Addendum 6 item 1). A miss, a
 * duplicated symbol signature, a different target count than the committed
 * files hold, or a repository that produced zero symbols is a failure: the
 * check must fail rather than pass when it read nothing.
 *
 * Usage:
 *   bun test/python-gate/check_symbol_targets.ts <click-checkout> <requests-checkout>
 *
 * The checkouts are scratch checkouts of the pinned commits (click 7.1.2 at
 * 1784558e, requests at 3c7baaa); their `src/click` and `src/requests` package
 * directories are what is read. The sources are never vendored into the repo.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildPythonSymbols, type PythonSymbol } from "../../src/python/symbols.ts";

const HERE = import.meta.dir;

interface Target {
	file: string;
	name: string;
	qualname: string;
	line: number;
	batch?: number;
}

interface OverloadGroup {
	implementation_line: number;
	stub_lines: number[];
}

interface RepoCheck {
	name: string;
	packageDir: string;
	targetsPath: string;
	overloadsPath: string | null;
	/** The committed target count; a different count means the input is not the pinned ground truth. */
	expectedTargets: number;
	/** The scored batch (batch 0) target count, reported beside the total. */
	expectedBatch0: number;
}

const REPOS: RepoCheck[] = [
	{
		name: "click",
		packageDir: "src/click",
		targetsPath: join(HERE, "click-7.1.2", "targets.json"),
		overloadsPath: null,
		expectedTargets: 133,
		expectedBatch0: 45,
	},
	{
		name: "requests",
		packageDir: "src/requests",
		targetsPath: join(HERE, "requests-3c7baaa", "targets.json"),
		overloadsPath: join(HERE, "requests-3c7baaa", "overload-groups.json"),
		expectedTargets: 46,
		expectedBatch0: 46,
	},
];

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function pyFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...pyFiles(path));
		else if (entry.endsWith(".py")) out.push(path);
	}
	return out.sort();
}

function targetKey(target: Target, line: number): string {
	return `${target.file}:${line} ${target.qualname}`;
}

async function checkRepo(repo: RepoCheck, root: string): Promise<void> {
	const packageDir = join(root, repo.packageDir);
	let files: string[];
	try {
		files = pyFiles(packageDir);
	} catch {
		fail(`${repo.name}: package directory not found: ${packageDir}`);
	}

	const targets = JSON.parse(readFileSync(repo.targetsPath, "utf8")) as Target[];
	if (targets.length !== repo.expectedTargets) {
		fail(
			`${repo.name}: targets.json holds ${targets.length} targets, expected ${repo.expectedTargets} ` +
				"(the input is not the pinned ground truth)",
		);
	}
	const batch0 = targets.filter((target) => target.batch === 0).length;
	if (batch0 !== repo.expectedBatch0) {
		fail(`${repo.name}: ${batch0} batch-0 targets, expected ${repo.expectedBatch0}`);
	}

	const overloads: Record<string, OverloadGroup> =
		repo.overloadsPath === null
			? {}
			: (JSON.parse(readFileSync(repo.overloadsPath, "utf8")) as Record<string, OverloadGroup>);
	const overloadKeys = Object.keys(overloads).filter((key) => key !== "_note");

	// Resolve each target to exactly one symbol signature.
	const bySignature = new Map<string, PythonSymbol[]>();
	let symbolCount = 0;
	for (const file of files) {
		const relativePath = relative(packageDir, file).split(sep).join("/");
		const table = await buildPythonSymbols(readFileSync(file), relativePath);
		symbolCount += table.symbols.length;
		for (const symbol of table.symbols) {
			const signature = `${symbol.file}:${symbol.line} ${symbol.qualname}`;
			const found = bySignature.get(signature);
			if (found === undefined) bySignature.set(signature, [symbol]);
			else found.push(symbol);
		}
	}
	if (files.length === 0) fail(`${repo.name}: read zero .py files under ${packageDir}`);
	if (symbolCount === 0) fail(`${repo.name}: built zero symbols under ${packageDir}`);

	let remapped = 0;
	const missing: string[] = [];
	const duplicated: string[] = [];
	for (const target of targets) {
		const overload = overloads[targetKey(target, target.line)];
		const wantedLine = overload === undefined ? target.line : overload.implementation_line;
		if (overload !== undefined) remapped++;
		const signature = targetKey(target, wantedLine);
		const found = bySignature.get(signature) ?? [];
		if (found.length === 0) missing.push(`${signature}  (target ${targetKey(target, target.line)})`);
		else if (found.length > 1) duplicated.push(`${signature}  x${found.length}`);
	}
	if (overloadKeys.length !== remapped && repo.overloadsPath !== null) {
		fail(`${repo.name}: ${overloadKeys.length} overload groups, but ${remapped} targets were remapped`);
	}
	if (duplicated.length > 0) {
		fail(
			`${repo.name}: ${duplicated.length} target signature(s) match more than one symbol:\n  ${duplicated.join("\n  ")}`,
		);
	}
	if (missing.length > 0) {
		fail(
			`${repo.name}: ${missing.length}/${targets.length} targets have no matching symbol:\n  ${missing.join("\n  ")}`,
		);
	}

	console.log(
		`${repo.name}: ${targets.length}/${targets.length} targets resolved ` +
			`(batch 0 ${batch0}/${batch0}); ${files.length} files, ${symbolCount} symbols` +
			(remapped > 0 ? `; ${remapped} overload targets mapped to implementation lines` : ""),
	);
}

async function main(): Promise<void> {
	const [clickRoot, requestsRoot] = process.argv.slice(2);
	if (clickRoot === undefined || requestsRoot === undefined) {
		console.error("usage: bun test/python-gate/check_symbol_targets.ts <click-checkout> <requests-checkout>");
		process.exit(2);
	}
	await checkRepo(REPOS[0] as RepoCheck, clickRoot);
	await checkRepo(REPOS[1] as RepoCheck, requestsRoot);
	console.log("OK: every ground-truth target resolves through the scorer mapping");
}

await main();
