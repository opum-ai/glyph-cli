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
	test("the budget is the one named constant DEC-216 (a10) fixed, and a run inside it carries no time-budget row", () => {
		// 7.0 s = round-up(2 x quest-cli cold p95 3.365 s). Changing it needs a new measurement
		// and a new record, never an edit alone: this pin is what makes an edit alone fail.
		expect(CODE_MAP_TIME_BUDGET_MS).toBe(7_000);
		const root = repoWith(FILES);
		const output = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT });
		expect(budgetRows(output)).toEqual([]);
		expect(output.pointers.map((pointer) => pointer.path)).toContain("src/0-note.ts");
	});

	test("P1: the unit-boundary check stops after a slow unit, reports time-budget, and keeps what it has", () => {
		const root = repoWith(FILES);
		let clock = 0;
		const output = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: TEXT,
			timeBudgetMs: 1_000,
			now: () => clock,
			// A slow fake unit: the index load takes five budgets and then finds no index.
			loadIndex: () => {
				clock += 5_000;
				return null;
			},
		});
		const rows = budgetRows(output);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toStartWith("time-budget:");
		expect(rows[0]?.reason).toContain("symbol index");
		const paths = output.pointers.map((pointer) => pointer.path);
		// The named path found before the slow unit is returned; the later grep stage never ran.
		expect(paths).toEqual(["src/a.ts"]);
		expect(output.pointers[0]?.reason).toContain("line ranges not read (time-budget)");
		expect(rows[0]?.reason).toContain("1 without line ranges");
	});

	test("P2: a forced slow index build overruns, and the overrun IS reported with the elapsed time", () => {
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
				clock += 5_000; // the build took five times the budget and could not be interrupted
				return index;
			},
		});
		const rows = budgetRows(output);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toContain("symbol index");
		expect(rows[0]?.reason).toContain("5000 ms elapsed");
		// The overrun build's answer is kept: tier 3's files are returned, tier 4 never ran.
		const paths = output.pointers.map((pointer) => pointer.path);
		expect(paths).toEqual(["src/a.ts", "src/barrel.ts", "src/c.ts"]);
		expect(paths).not.toContain("src/0-note.ts");
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
		const full = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, symbols: false });
		// Every clock read advances a whole second, so the budget runs out after a fixed number
		// of checks, and no git read is ever left less than a second: nothing here is a race.
		let calls = 0;
		const partial = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: TEXT,
			symbols: false,
			timeBudgetMs: 8_000,
			now: () => {
				calls += 1;
				return calls * 1_000;
			},
		});
		expect(budgetRows(partial)).toHaveLength(1);
		const fullPaths = new Set(full.pointers.map((pointer) => pointer.path));
		for (const pointer of partial.pointers) expect(fullPaths.has(pointer.path)).toBe(true);
		expect(partial.omissions.some((row) => row.reason.includes("time-budget"))).toBe(true);
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

	test("P3: a warm run on a real repository (this one) stays well under the budget", () => {
		const repoRoot = new URL("..", import.meta.url).pathname;
		const input = { repositoryPath: repoRoot, sourceRef: "HEAD", taskText: "see `produceCodeMap` in src/codemap.ts" };
		produceCodeMap(input); // primes the index cache
		const started = performance.now();
		const output = produceCodeMap(input);
		const elapsed = performance.now() - started;
		expect(budgetRows(output)).toEqual([]);
		expect(output.pointers.length).toBeGreaterThan(0);
		// Warm glyph-cli measured 0.25 s against 7.0 s; "well under" is half the budget.
		expect(elapsed).toBeLessThan(CODE_MAP_TIME_BUDGET_MS / 2);
	});

	test("the budget never changes an answer that finishes inside it", () => {
		const root = repoWith(FILES);
		const unlimited = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, timeBudgetMs: 1e12 });
		const defaulted = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT });
		expect(JSON.stringify(defaulted)).toBe(JSON.stringify(unlimited));
	});
});
