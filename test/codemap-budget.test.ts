import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produceCodeMap } from "../src/codemap.ts";
import { CODE_MAP_TIME_BUDGET_MS, TIME_BUDGET_SOURCE } from "../src/codemap-text.ts";
import { loadRefIndex } from "../src/codemap-tier3.ts";
import { makeFixtureRepo } from "./parity/fixtures.ts";

/**
 * The time budget (GCLI-38, DEC-216 (a4)(b)): past it the run returns what it has,
 * with an omission whose reason is `time-budget`, and never returns nothing silently.
 * The clock is injected so no test depends on how fast the machine is.
 */

beforeAll(() => {
	process.env.GLYPH_CACHE_DIR = mkdtempSync(join(tmpdir(), "glyph-budget-cache-"));
});

function repoWith(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "glyph-budget-"));
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	for (const [path, content] of Object.entries(files)) repo.write(path, content);
	repo.commit("base");
	return root;
}

const FILES = {
	"src/a.ts": "export function buildReport() {\n  return 1;\n}\n",
	"src/barrel.ts": 'export { buildReport as makeReport } from "./a";\n',
	"src/c.ts": 'import { makeReport } from "./barrel";\nexport function run() {\n  return makeReport();\n}\n',
	"src/0-note.ts": "// mentions buildReport in a comment\nexport const note = 1;\n",
};
const TEXT = "fix `buildReport` in src/a.ts";

const budgetRows = (output: { omissions: { source: string; reason: string }[] }) =>
	output.omissions.filter((row) => row.source === TIME_BUDGET_SOURCE);

describe("the time budget", () => {
	test("the budget is one named constant, and a run inside it carries no time-budget row", () => {
		expect(CODE_MAP_TIME_BUDGET_MS).toBeGreaterThan(0);
		const root = repoWith(FILES);
		const output = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT });
		expect(budgetRows(output)).toEqual([]);
		expect(output.pointers.map((pointer) => pointer.path)).toContain("src/0-note.ts");
	});

	test("an index build that spends the budget stops later stages, names the stage, and keeps what it has", () => {
		const root = repoWith(FILES);
		let clock = 0;
		const output = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: TEXT,
			timeBudgetMs: 1_000,
			now: () => clock,
			loadIndex: (path, commit) => {
				const index = loadRefIndex(path, commit);
				clock += 5_000; // the build took five times the budget
				return index;
			},
		});
		const rows = budgetRows(output);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toContain("time-budget");
		expect(rows[0]?.reason).toContain("symbol index");
		const paths = output.pointers.map((pointer) => pointer.path);
		// What was gathered before the stop is returned: the named path and tier 3's files.
		expect(paths).toEqual(["src/a.ts", "src/barrel.ts", "src/c.ts"]);
		// Tier 4 never ran, so the grep-only file is absent.
		expect(paths).not.toContain("src/0-note.ts");
		// A pointer whose line ranges were not read says so, rather than reading as a whole file.
		for (const pointer of output.pointers) expect(pointer.reason).toContain("line ranges not read (time-budget)");
		expect(rows[0]?.reason).toContain("3 without line ranges");
	});

	test("a budget already spent returns no pointers but never nothing silently", () => {
		const root = repoWith(FILES);
		const output = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, timeBudgetMs: 0 });
		expect(output.pointers).toEqual([]);
		expect(output.omissions).toHaveLength(1);
		expect(output.omissions[0]?.source).toBe(TIME_BUDGET_SOURCE);
		expect(output.omissions[0]?.reason).toStartWith("time-budget:");
	});

	test("a clock that runs out mid-run returns a subset of the full answer plus the row", () => {
		const root = repoWith(FILES);
		const full = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT });
		let calls = 0;
		const partial = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: TEXT,
			timeBudgetMs: 12,
			now: () => {
				calls += 1;
				return calls;
			},
		});
		expect(budgetRows(partial)).toHaveLength(1);
		const fullPaths = new Set(full.pointers.map((pointer) => pointer.path));
		for (const pointer of partial.pointers) expect(fullPaths.has(pointer.path)).toBe(true);
		expect(partial.pointers.length).toBeLessThan(full.pointers.length);
	});

	test("a git read cannot outlive the budget: a slow grep is cut off at the time left, and the stage is named", () => {
		const root = repoWith(FILES);
		// A git that sleeps five seconds on `grep` and is the real git otherwise.
		const realGit = Bun.which("git");
		expect(realGit).not.toBeNull();
		const shim = mkdtempSync(join(tmpdir(), "glyph-slow-git-"));
		writeFileSync(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" grep "*) sleep 5;; esac\nexec "${realGit}" "$@"\n`);
		chmodSync(join(shim, "git"), 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${shim}:${savedPath}`;
		try {
			const started = performance.now();
			const output = produceCodeMap({
				repositoryPath: root,
				sourceRef: "base",
				taskText: TEXT,
				symbols: false,
				timeBudgetMs: 1_000,
			});
			const elapsed = performance.now() - started;
			expect(elapsed).toBeLessThan(4_000);
			const rows = budgetRows(output);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.reason).toContain("identifier grep");
			// The named path found before the stop is still returned.
			expect(output.pointers.map((pointer) => pointer.path)).toContain("src/a.ts");
		} finally {
			process.env.PATH = savedPath;
		}
	});

	test("the budget never changes an answer that finishes inside it", () => {
		const root = repoWith(FILES);
		const unlimited = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, timeBudgetMs: 1e12 });
		const defaulted = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT });
		expect(JSON.stringify(defaulted)).toBe(JSON.stringify(unlimited));
	});
});
