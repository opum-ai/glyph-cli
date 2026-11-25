import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produceCodeMap } from "../src/codemap.ts";
import { GlyphError } from "../src/errors.ts";
import { CODE_MAP_TIME_BUDGET_MS, TIME_BUDGET_SOURCE } from "../src/codemap-text.ts";
import { loadRefIndex } from "../src/codemap-tier3.ts";
import { produceCodeMapWithPrebuild } from "../src/codemap.ts";
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

/**
 * A repo on a `work` branch that changed one file against `base`, so tier 2 has
 * an answer beside the named-path tier. `sourceRef: "base"` reads the base tree.
 */
function repoWithBranchChange(): string {
	const root = mkdtempSync(join(tmpdir(), "glyph-budget-"));
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	repo.write("src/named.ts", "export function buildReport() {\n  return 1;\n}\n");
	repo.write("src/changed.ts", "export const value = 1;\n");
	repo.commit("base");
	repo.git("checkout", "-q", "-b", "work");
	repo.write("src/changed.ts", "export const value = 2;\n");
	repo.commit("change");
	return root;
}

const FILES = {
	"src/a.ts": "export function buildReport() {\n  return 1;\n}\n",
	"src/barrel.ts": 'export { buildReport as makeReport } from "./a";\n',
	"src/c.ts": 'import { makeReport } from "./barrel";\nexport function run() {\n  return makeReport();\n}\n',
	"src/0-note.ts": "// mentions buildReport in a comment\nexport const note = 1;\n",
};
const TEXT = "fix `buildReport` in src/a.ts";

/** Run `run` with a `git` first on PATH whose behaviour for one subcommand is `onSubcommand` (shell). */
function withGitShim<T>(subcommand: string, onSubcommand: string, run: () => T): T {
	const realGit = Bun.which("git");
	if (realGit === null) throw new Error("no git on PATH");
	const shim = mkdtempSync(join(tmpdir(), "glyph-git-shim-"));
	writeFileSync(
		join(shim, "git"),
		`#!/bin/sh\ncase " $* " in *" ${subcommand} "*) ${onSubcommand};; esac\nexec "${realGit}" "$@"\n`,
	);
	chmodSync(join(shim, "git"), 0o755);
	const savedPath = process.env.PATH;
	process.env.PATH = `${shim}:${savedPath}`;
	try {
		return run();
	} finally {
		process.env.PATH = savedPath;
	}
}

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

	test("P3: a budget overrun during the Python build keeps tiers 1 and 2 (DEC-303 (a16) 23-24)", async () => {
		const root = repoWithBranchChange();
		let clock = 0;
		const output = await produceCodeMapWithPrebuild(
			{
				repositoryPath: root,
				sourceRef: "base",
				taskText: "fix src/named.ts and `buildReport`",
				timeBudgetMs: 1_000,
				now: () => clock,
			},
			async (path, commit) => {
				const index = loadRefIndex(path, commit);
				clock += 5_000; // the build overran the budget and could not be interrupted
				return index ?? undefined;
			},
		);
		// The overrun stops the run at the symbol stage, naming it ...
		const rows = budgetRows(output);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toContain("symbol index");
		expect(rows[0]?.reason).toContain("5000 ms elapsed");
		// ... but the named-path (tier 1) and branch-change (tier 2) answers were
		// gathered BEFORE the build and are kept, not thrown away by the stop.
		const paths = output.pointers.map((pointer) => pointer.path);
		expect(paths).toContain("src/named.ts");
		expect(paths).toContain("src/changed.ts");
	});

	test("P4: a throwing build is a missing tier, never a failed run", async () => {
		const root = repoWith(FILES);
		const output = await produceCodeMapWithPrebuild(
			{ repositoryPath: root, sourceRef: "base", taskText: TEXT, timeBudgetMs: 1_000, now: () => 0 },
			async () => {
				throw new Error("python: a first-party package root did not resolve");
			},
		);
		// Tier 1 answers from the named path; the failed tier 3 adds nothing and does not stop the run.
		expect(output.pointers.map((pointer) => pointer.path)).toContain("src/a.ts");
		expect(budgetRows(output)).toHaveLength(0);
	});

	test("a budget already spent returns no pointers but never nothing silently", () => {
		const root = repoWith(FILES);
		const output = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, timeBudgetMs: 0 });
		expect(output.pointers).toEqual([]);
		expect(output.omissions).toHaveLength(1);
		expect(output.omissions[0]?.source).toBe(TIME_BUDGET_SOURCE);
		expect(output.omissions[0]?.reason).toStartWith("time-budget:");
	});

	test("a clock that runs out mid-run returns exactly what was gathered, plus the row", () => {
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
		// The clock is deterministic, so the stop is exact: the named path was found, the budget
		// ran out entering the identifier grep (nine reads in, 9000 ms), and no range was read.
		expect(partial.pointers).toEqual([
			{ path: "src/a.ts", lineRanges: [], reason: "path named in the task text; line ranges not read (time-budget)" },
		]);
		expect(partial.omissions).toEqual([
			{
				source: TIME_BUDGET_SOURCE,
				reason:
					"time-budget: the 8000 ms budget was spent during identifier grep, 9000 ms elapsed when the run stopped; the pointers are what was gathered by then, 1 without line ranges",
			},
		]);
		// And that is a strict subset of the full answer, which has more pointers.
		expect(full.pointers.length).toBeGreaterThan(partial.pointers.length);
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

	test("B1: the index load's own git reads are capped: a slow ls-tree is cut off, and the stage is named", () => {
		const root = repoWith(FILES);
		const started = performance.now();
		const output = withGitShim("ls-tree", "sleep 5", () =>
			produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, timeBudgetMs: 1_000 }),
		);
		expect(performance.now() - started).toBeLessThan(4_000);
		const rows = budgetRows(output);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reason).toContain("symbol index");
		// What was gathered before the index load is returned: the named path.
		expect(output.pointers.map((pointer) => pointer.path)).toContain("src/a.ts");
	});

	test("B1: the source-ref read is inside the budget too: a slow rev-parse returns no pointers and a source-ref row", () => {
		const root = repoWith(FILES);
		const started = performance.now();
		const output = withGitShim("rev-parse", "sleep 5", () =>
			produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, timeBudgetMs: 1_000 }),
		);
		expect(performance.now() - started).toBeLessThan(4_000);
		expect(output.pointers).toEqual([]);
		expect(output.omissions).toHaveLength(1);
		expect(output.omissions[0]?.source).toBe(TIME_BUDGET_SOURCE);
		expect(output.omissions[0]?.reason).toContain("source ref");
	});

	test("B2: a git that dies on a signal under an unspent budget is an indeterminate error, never a time-budget row", () => {
		const root = repoWith(FILES);
		let caught: unknown;
		withGitShim("grep", "kill -9 $$", () => {
			try {
				produceCodeMap({
					repositoryPath: root,
					sourceRef: "base",
					taskText: TEXT,
					symbols: false,
					// Under git's own 15 s ceiling, so the budget sets every read's limit (the production
					// shape), yet far from spent.
					timeBudgetMs: 10_000,
				});
			} catch (error) {
				caught = error;
			}
		});
		expect(caught).toBeInstanceOf(GlyphError);
		expect((caught as GlyphError).errorType).toBe("indeterminate");
	});

	test("N1: past the budget a branch-changed file that is also a symbol hit carries no ranges at all", () => {
		const root = mkdtempSync(join(tmpdir(), "glyph-budget-branch-"));
		const repo = makeFixtureRepo(root);
		repo.git("init", "-q", "-b", "base");
		repo.write("src/a.ts", "export function buildReport() {\n  return 1;\n}\n");
		repo.commit("base");
		repo.git("checkout", "-q", "-b", "work");
		repo.write("src/a.ts", "export function buildReport() {\n  return 2;\n}\n");
		repo.commit("work");
		let clock = 0;
		const output = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: "fix `buildReport`",
			timeBudgetMs: 1_000,
			now: () => clock,
			loadIndex: (path, commit) => {
				const index = loadRefIndex(path, commit);
				clock += 5_000;
				return index;
			},
		});
		const pointer = output.pointers.find((candidate) => candidate.path === "src/a.ts");
		expect(pointer?.reason).toContain("changed on this branch");
		expect(pointer?.reason).toContain("declares symbol");
		expect(pointer?.reason).toContain("line ranges not read (time-budget)");
		expect(pointer?.lineRanges).toEqual([]);
	});

	test("N2: the elapsed time is the time at which the run stopped, not when it returned", () => {
		const root = repoWith(FILES);
		let clock = 0;
		const output = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: TEXT,
			timeBudgetMs: 1_000,
			// Once past the deadline the clock keeps running, as a real one does.
			now: () => {
				if (clock >= 5_000) clock += 100;
				return clock;
			},
			loadIndex: () => {
				clock = 5_000;
				return null;
			},
		});
		expect(budgetRows(output)[0]?.reason).toContain("5200 ms elapsed");
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
