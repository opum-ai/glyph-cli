import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The parity fixtures: each one builds a small git repository and names the task
 * text and source ref `glyph code-map` and opum-cli's deterministic producer are
 * both asked about (GCLI-41, DEC-216 (a7)). The golden generator and the parity
 * test share this one definition, so the goldens are about exactly these inputs.
 *
 * A fixture repository is built on a `base` branch and then a `work` branch that
 * carries the "branch change"; the source ref is `base`, so tier 2 sees what
 * `work` changed. Everything that could vary between machines (identity, dates,
 * user and system config) is pinned.
 */

export interface Fixture {
	name: string;
	taskText: string;
	sourceRef: string;
	/** Build the repository at `root`, ending checked out on `work`. */
	build(repo: FixtureRepo): void;
}

export interface FixtureRepo {
	root: string;
	write(relPath: string, content: string): void;
	remove(relPath: string): void;
	git(...args: string[]): void;
	commit(message: string): void;
}

export function gitEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "glyph fixture",
		GIT_AUTHOR_EMAIL: "fixture@opum.test",
		GIT_COMMITTER_NAME: "glyph fixture",
		GIT_COMMITTER_EMAIL: "fixture@opum.test",
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	};
}

export function makeFixtureRepo(root: string): FixtureRepo {
	const run = (...args: string[]): void => {
		execFileSync("git", ["-C", root, ...args], { env: gitEnv(), stdio: "pipe" });
	};
	return {
		root,
		write(relPath, content) {
			const absolute = join(root, relPath);
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, content);
		},
		remove(relPath) {
			run("rm", "-q", "--", relPath);
		},
		git: run,
		commit(message) {
			run("add", "-A");
			run("-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
		},
	};
}

/** `count` lines, each `line N`, with a marker word on the given 1-based lines. */
function linesWith(count: number, marker: string, markedAt: number[]): string {
	const lines: string[] = [];
	for (let line = 1; line <= count; line += 1) {
		lines.push(markedAt.includes(line) ? `// ${marker} line ${line}` : `// line ${line}`);
	}
	return `${lines.join("\n")}\n`;
}

function startBase(repo: FixtureRepo): void {
	repo.git("init", "-q", "-b", "base");
}

function startWork(repo: FixtureRepo): void {
	repo.git("checkout", "-q", "-b", "work");
}

const wide = (char: string, length: number): string => char.repeat(length);

export const FIXTURES: Fixture[] = [
	{
		name: "clean",
		sourceRef: "base",
		taskText:
			"Update src/ledger.ts so `buildReport` uses ledgerTotals; see docs/guide.md and docs/missing.md, but not https://example.com/docs/x.",
		build(repo) {
			startBase(repo);
			repo.write("src/report.ts", "export function buildReport() {\n  return ledgerTotals();\n}\n");
			repo.write("src/ledger.ts", "export function ledgerTotals() {\n  return 1;\n}\n");
			repo.write("docs/guide.md", "# Guide\n\nUse buildReport.\n");
			repo.write("README.md", "unrelated\n");
			repo.commit("base");
			startWork(repo);
			repo.write(
				"src/report.ts",
				"export function buildReport() {\n  const total = ledgerTotals();\n  return total + 1;\n}\n",
			);
			repo.write("src/fresh.ts", "export const fresh = 1;\n");
			repo.commit("work");
		},
	},
	{
		name: "rename",
		sourceRef: "base",
		taskText: "The `renamedThing` helper moved; check src/new-name.ts and `renamedThing`.",
		build(repo) {
			startBase(repo);
			repo.write("src/old-name.ts", `export function renamedThing() {\n  return 1;\n}\n${linesWith(30, "keep", [])}`);
			repo.write("src/stays.ts", "export const stays = 1;\n");
			repo.commit("base");
			startWork(repo);
			repo.git("mv", "src/old-name.ts", "src/new-name.ts");
			repo.write("src/new-name.ts", `export function renamedThing() {\n  return 2;\n}\n${linesWith(30, "keep", [])}`);
			repo.write("src/stays.ts", "export const stays = 2;\n");
			repo.commit("work");
		},
	},
	{
		name: "file-cap",
		sourceRef: "base",
		taskText: "Touch `alphaWidget`, `betaWidget`, `gammaWidget` and `deltaWidget`.",
		build(repo) {
			startBase(repo);
			const mark = (index: number): string => {
				const word = ["alphaWidget", "betaWidget", "gammaWidget", "deltaWidget"];
				const hits = [
					index >= 1 && index <= 12 ? word[0] : null,
					index >= 9 && index <= 20 ? word[1] : null,
					index >= 17 && index <= 28 ? word[2] : null,
					index >= 25 && index <= 30 ? word[3] : null,
				].filter((entry): entry is string => entry !== null);
				return `${hits.map((entry) => `export const ${entry}${index} = ${index}; // ${entry}`).join("\n")}\n`;
			};
			for (let index = 1; index <= 30; index += 1) {
				repo.write(`src/mod${String(index).padStart(2, "0")}.ts`, mark(index));
			}
			repo.commit("base");
			startWork(repo);
			repo.write("src/mod01.ts", `${mark(1)}// edited\n`);
			repo.commit("work");
		},
	},
	{
		name: "token-cap",
		sourceRef: "base",
		taskText: "Look at `longPathMarkerA` and `longPathMarkerB` everywhere.",
		build(repo) {
			startBase(repo);
			for (let index = 1; index <= 20; index += 1) {
				const dir = [wide("a", 100), wide("b", 100), wide("c", 100), wide("d", 90)].join("/");
				const marker = index <= 10 ? "longPathMarkerA" : "longPathMarkerB";
				repo.write(`${dir}/f${String(index).padStart(2, "0")}.ts`, `export const ${marker} = 1;\n`);
			}
			repo.commit("base");
			startWork(repo);
			repo.write("note.txt", "work\n");
			repo.commit("work");
		},
	},
	{
		name: "special-paths",
		sourceRef: "base",
		taskText: "Check `specialIdent`, in src/café.ts and b/x.ts and .quest/tasks/T.json.",
		build(repo) {
			startBase(repo);
			repo.write("src/café.ts", "export const specialIdent = 1;\n");
			repo.write("b/x.ts", "export const other = 1;\n");
			repo.write(".quest/tasks/T.json", '{"id":"specialIdent"}\n');
			repo.write(".lore/x.md", "specialIdent\n");
			repo.write("node_modules/pkg/index.js", "specialIdent\n");
			repo.commit("base");
			startWork(repo);
			repo.write("src/café.ts", "export const specialIdent = 2;\n");
			repo.write("b/x.ts", "export const other = 2;\n");
			repo.write(".quest/tasks/T.json", '{"id":"specialIdent","n":2}\n');
			repo.commit("work");
		},
	},
	{
		name: "ranges",
		sourceRef: "base",
		taskText: "Search `manyHits` and fix src/branchy.ts.",
		build(repo) {
			startBase(repo);
			repo.write("src/hits.ts", linesWith(40, "manyHits", [2, 5, 9, 14, 20, 27, 33, 38]));
			repo.write("src/branchy.ts", linesWith(60, "plain", []));
			repo.commit("base");
			startWork(repo);
			const edited = linesWith(60, "plain", [])
				.split("\n")
				.map((line, index) => ([3, 10, 17, 24, 31, 38, 45].includes(index + 1) ? `${line} // edit` : line))
				.join("\n");
			repo.write("src/branchy.ts", edited);
			repo.commit("work");
		},
	},
	{
		name: "no-branch-change",
		sourceRef: "base",
		taskText: "Find `quietName` and `quietName` again, also src/quiet.ts.",
		build(repo) {
			startBase(repo);
			repo.write("src/quiet.ts", "export const quietName = 1;\n");
			repo.write("src/other.ts", "export const quietName2 = quietName;\n");
			repo.commit("base");
			startWork(repo);
		},
	},
	{
		name: "extractor-quirks",
		sourceRef: "base",
		taskText:
			"Read ../src/a.ts, then buildReport and `ledgerTotals`; call buildReport. See https://host.com:8080/a/b and a/../b.",
		build(repo) {
			startBase(repo);
			repo.write("src/a.ts", "export function buildReport() {\n  return ledgerTotals;\n}\n");
			repo.write("8080/a/b", "ledgerTotals\n");
			repo.commit("base");
			startWork(repo);
			repo.write("src/a.ts", "export function buildReport() {\n  return ledgerTotals + 1;\n}\n");
			repo.commit("work");
		},
	},
];
