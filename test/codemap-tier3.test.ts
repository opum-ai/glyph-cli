import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produceCodeMap } from "../src/codemap.ts";
import { CODE_MAP_MAX_FILES } from "../src/codemap-text.ts";
import { makeFixtureRepo } from "./parity/fixtures.ts";

/**
 * Tier 3 (GCLI-37, DEC-216 (a4)(c) and (a6) Q2): symbols the task text names,
 * resolved through the index. Each test builds its own repository on a `base`
 * commit and reads it at `base`.
 */

beforeAll(() => {
	// The producer shares the ref-keyed index cache; keep it out of the user's.
	process.env.GLYPH_CACHE_DIR = mkdtempSync(join(tmpdir(), "glyph-tier3-cache-"));
});

function repoWith(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "glyph-tier3-"));
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	for (const [path, content] of Object.entries(files)) repo.write(path, content);
	repo.commit("base");
	return root;
}

const produce = (root: string, taskText: string, options: { symbols?: boolean } = {}) =>
	produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText, ...options });

const pathsOf = (output: { pointers: { path: string }[] }): string[] => output.pointers.map((pointer) => pointer.path);

/** `buildReport` reached from c.ts only through an alias, so c.ts never names it. */
const ALIAS = {
	"src/a.ts": "export function buildReport() {\n  return 1;\n}\n",
	"src/barrel.ts": 'export { buildReport as makeReport } from "./a";\n',
	"src/c.ts": 'import { makeReport } from "./barrel";\nexport function run() {\n  return makeReport();\n}\n',
	"src/0-note.ts": "// mentions buildReport in a comment\nexport const note = 1;\n",
};

describe("tier 3: symbols resolved through the index", () => {
	test("a symbol reached through an alias finds the file grep cannot, with the symbol's line", () => {
		const root = repoWith(ALIAS);
		const text = "fix `buildReport`";
		expect(pathsOf(produce(root, text, { symbols: false }))).not.toContain("src/c.ts");
		const output = produce(root, text);
		const found = output.pointers.find((pointer) => pointer.path === "src/c.ts");
		expect(found?.reason).toBe("imports symbol `buildReport` (depth 1); calls symbol `buildReport` (depth 1)");
		expect(found?.lineRanges).toEqual(["line 1", "line 3"]);
		expect(output.pointers.find((pointer) => pointer.path === "src/a.ts")?.reason).toContain(
			"declares symbol `buildReport` (function)",
		);
	});

	test("tier 3 ranks above git-grep, the declaring file first, and below named paths and changed files", () => {
		const root = repoWith(ALIAS);
		const paths = pathsOf(produce(root, "fix `buildReport`"));
		// 0-note.ts would lead on path order alone; it is grep-only, so it comes last.
		expect(paths).toEqual(["src/a.ts", "src/barrel.ts", "src/c.ts", "src/0-note.ts"]);
		const named = pathsOf(produce(root, "fix `buildReport` in src/0-note.ts"));
		expect(named[0]).toBe("src/0-note.ts");
	});

	test("a file found in several tiers appears once, at its highest tier, with every reason", () => {
		const root = repoWith(ALIAS);
		const paths = pathsOf(produce(root, "fix `buildReport`"));
		expect(paths.filter((path) => path === "src/a.ts")).toHaveLength(1);
		expect(new Set(paths).size).toBe(paths.length);
		const reason = produce(root, "fix `buildReport`").pointers[0]?.reason;
		expect(reason).toBe("declares symbol `buildReport` (function); matches identifier `buildReport`");
	});

	test("impact is depth 1: a caller of a caller is not a tier-3 file", () => {
		const root = repoWith({
			...ALIAS,
			"src/d.ts": 'import { run } from "./c";\nexport const again = run();\n',
		});
		const paths = pathsOf(produce(root, "fix `buildReport`"));
		expect(paths).toContain("src/c.ts");
		expect(paths).not.toContain("src/d.ts");
	});

	test("a name matching several symbols includes every one of them, each counted", () => {
		const root = repoWith({
			"src/one.ts": "export function twin() {\n  return 1;\n}\n",
			"src/two.ts": "export class Box {\n  twin() {\n    return 2;\n  }\n}\n",
		});
		const hits = produce(root, "look at `twin`").pointers.map((pointer) => pointer.reason);
		expect(hits).toHaveLength(2);
		expect(hits.join("|")).toContain("(function)");
		expect(hits.join("|")).toContain("(method)");
	});

	test("matching is by exact name: a substring or a qualified name resolves to nothing", () => {
		const root = repoWith({ "src/a.ts": "export function buildReport() {\n  return 1;\n}\n" });
		const reasons = (text: string) =>
			produce(root, text)
				.pointers.map((pointer) => pointer.reason)
				.join("|");
		expect(reasons("fix `buildRep`")).not.toContain("declares symbol");
		expect(reasons("fix `Box.buildReport`")).not.toContain("declares symbol");
		expect(reasons("fix `buildReport`")).toContain("declares symbol");
	});
});

describe("tier 3 and the file cap", () => {
	const GREP_ONLY: Record<string, string> = {};
	for (let number = 0; number < 25; number += 1) {
		const name = `src/g${String(number).padStart(2, "0")}.ts`;
		const token = number < 10 ? "grepAlpha" : number < 20 ? "grepBeta" : "grepGamma";
		GREP_ONLY[name] = `// ${token}\nexport const v${number} = ${number};\n`;
	}
	// decl.ts and barrel.ts name `declaredThing`, so grep finds them; zcaller.ts reaches it
	// only through the alias, so only tier 3 finds it.
	const FILES = {
		...GREP_ONLY,
		"src/decl.ts": "export function declaredThing() {\n  return 1;\n}\n",
		"src/barrel.ts": 'export { declaredThing as aliased } from "./decl";\n',
		"src/zcaller.ts": 'import { aliased } from "./barrel";\nexport const r = aliased();\n',
	};
	const TEXT = "see `grepAlpha`, `grepBeta`, `grepGamma` and `declaredThing`";

	test("a tier-3-only file displaces the last grep file at the cap, and the displaced file is named", () => {
		const root = repoWith(FILES);
		const off = produce(root, TEXT, { symbols: false });
		expect(pathsOf(off)).toHaveLength(CODE_MAP_MAX_FILES);
		expect(pathsOf(off)).toContain("src/g17.ts");
		expect(pathsOf(off)).not.toContain("src/zcaller.ts");

		const on = produce(root, TEXT);
		expect(pathsOf(on)).toHaveLength(CODE_MAP_MAX_FILES);
		expect(pathsOf(on).slice(0, 3)).toEqual(["src/decl.ts", "src/barrel.ts", "src/zcaller.ts"]);
		expect(pathsOf(on)).not.toContain("src/g17.ts");
		expect(on.omissions).toContainEqual({
			source: "code-map:src/g17.ts",
			reason: `displaced by symbol pointers at the code-map file cap of ${CODE_MAP_MAX_FILES}`,
		});
		// 28 candidates, 20 kept: g17 is named, the other seven stay in the summary row.
		const summary = on.omissions.find((row) => row.source === "code-map#file-cap");
		expect(summary?.reason).toBe(`7 more over the code-map file cap of ${CODE_MAP_MAX_FILES}`);
		expect(on.omissions.filter((row) => row.reason.startsWith("displaced"))).toHaveLength(1);
	});
});

describe("tier 3 absent or failing is the deterministic producer's output, byte for byte", () => {
	const TEXT = "fix `buildReport`";

	test("a failing index loader, and an absent one, give the output with tier 3 off", () => {
		const root = repoWith(ALIAS);
		const off = JSON.stringify(produce(root, TEXT, { symbols: false }));
		const failing = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: TEXT,
			loadIndex: () => {
				throw new Error("index exploded");
			},
		});
		const absent = produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText: TEXT, loadIndex: () => null });
		expect(JSON.stringify(failing)).toBe(off);
		expect(JSON.stringify(absent)).toBe(off);
		expect(JSON.stringify(produce(root, TEXT))).not.toBe(off);
	});

	test("a commit with no TypeScript or JavaScript source has no index, and tier 3 adds nothing", () => {
		const root = repoWith({ "docs/a.md": "buildReport\n", "src/a.py": "# buildReport\n" });
		expect(JSON.stringify(produce(root, TEXT))).toBe(JSON.stringify(produce(root, TEXT, { symbols: false })));
	});
});
