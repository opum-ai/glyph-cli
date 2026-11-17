import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeMapPointerLine, produceCodeMap } from "../src/codemap.ts";
import { CODE_MAP_MAX_FILES, CODE_MAP_MAX_TOKENS, estimateTokens } from "../src/codemap-text.ts";
import { GlyphError } from "../src/errors.ts";
import { FIXTURES, makeFixtureRepo } from "./parity/fixtures.ts";

/**
 * Behaviour of the tier 1, 2 and 4 producer beyond byte parity (GCLI-41): the
 * ranking, the caps and what the omissions name. Byte parity with opum-cli is in
 * parity.test.ts.
 */

beforeAll(() => {
	// Tier 3 builds an index cache; keep it out of the user's ~/.cache/glyph.
	process.env.GLYPH_CACHE_DIR = mkdtempSync(join(tmpdir(), "glyph-codemap-cache-"));
});

function produce(name: string) {
	const fixture = FIXTURES.find((candidate) => candidate.name === name);
	if (fixture === undefined) throw new Error(`no fixture ${name}`);
	const root = join(mkdtempSync(join(tmpdir(), "glyph-codemap-")), name);
	mkdirSync(root, { recursive: true });
	fixture.build(makeFixtureRepo(root));
	return {
		root,
		fixture,
		output: produceCodeMap({ repositoryPath: root, sourceRef: fixture.sourceRef, taskText: fixture.taskText }),
	};
}

describe("ranking", () => {
	test("named paths come first, then changed files, then identifier matches, and each path appears once", () => {
		const { output } = produce("clean");
		const paths = output.pointers.map((pointer) => pointer.path);
		expect(paths).toEqual(["docs/guide.md", "src/ledger.ts", "src/report.ts", "src/fresh.ts"]);
		expect(new Set(paths).size).toBe(paths.length);
		// docs/guide.md is named in the text AND found by an identifier: it keeps the best tier
		// and carries both reasons.
		expect(output.pointers[0]?.reason).toBe("path named in the task text; matches identifier `buildReport`");
		// A path named in the text that is absent at the source ref is not a pointer.
		expect(paths).not.toContain("docs/missing.md");
	});

	test("a file changed on the branch carries its diff ranges alone, and a rename is a delete plus an add", () => {
		const { output } = produce("rename");
		const renamed = output.pointers.find((pointer) => pointer.path === "src/new-name.ts");
		expect(renamed?.reason).toContain("changed on this branch against base");
		expect(output.pointers.some((pointer) => pointer.path === "src/old-name.ts")).toBe(true);
	});

	test("product storage and VCS metadata are never pointers", () => {
		const { output } = produce("special-paths");
		for (const pointer of output.pointers) {
			expect(pointer.path.startsWith(".quest/")).toBe(false);
			expect(pointer.path.startsWith(".lore/")).toBe(false);
			expect(pointer.path.startsWith("node_modules/")).toBe(false);
		}
	});
});

describe("caps and omissions", () => {
	test("the file cap holds at 20 and the rest are counted in one summary row", () => {
		const { output } = produce("file-cap");
		expect(output.pointers).toHaveLength(CODE_MAP_MAX_FILES);
		const summary = output.omissions.filter((row) => row.source === "code-map#file-cap");
		expect(summary).toHaveLength(1);
		expect(summary[0]?.reason).toBe(`10 more over the code-map file cap of ${CODE_MAP_MAX_FILES}`);
	});

	test("a read bound that was hit is named, with what it left out", () => {
		const { output } = produce("file-cap");
		const bounds = output.omissions.filter((row) => row.source === "code-map#read-bounds");
		expect(bounds.length).toBeGreaterThan(0);
		expect(bounds[0]?.reason).toContain("matched 12 files; the read bound records 10");
	});

	test("the token cap holds, an over-budget pointer is skipped and named, and the list is not ended", () => {
		const { output } = produce("token-cap");
		const tokens = output.pointers.reduce((sum, pointer) => sum + estimateTokens(codeMapPointerLine(pointer)), 0);
		expect(tokens).toBeLessThanOrEqual(CODE_MAP_MAX_TOKENS);
		const skipped = output.omissions.filter((row) => row.reason.startsWith("over the code-map token cap"));
		expect(skipped.length).toBeGreaterThan(0);
		for (const row of skipped) expect(row.source.startsWith("code-map:")).toBe(true);
		// Skipped, not fatal: the list kept going past the first over-budget pointer would be
		// visible as pointers AFTER a skipped path in ranking order; here every skipped path is
		// absent and the rest are present.
		const pointed = new Set(output.pointers.map((pointer) => pointer.path));
		for (const row of skipped) expect(pointed.has(row.source.slice("code-map:".length))).toBe(false);
	});

	test("at most five ranges per pointer, then a summary of the rest", () => {
		const { output } = produce("ranges");
		for (const pointer of output.pointers) expect(pointer.lineRanges.length).toBeLessThanOrEqual(6);
		const many = output.pointers.find((pointer) => pointer.lineRanges.length === 6);
		expect(many?.lineRanges[5]).toMatch(/^\+\d+ more ranges$/);
	});

	test("a pointer is a path, ranges and one line of reason, never a file body", () => {
		const { output } = produce("clean");
		for (const pointer of output.pointers) {
			expect(Object.keys(pointer)).toEqual(["path", "lineRanges", "reason"]);
			expect(pointer.reason).not.toContain("\n");
			expect(pointer.reason).not.toContain("export function");
		}
	});
});

describe("the reads", () => {
	test("a source ref that does not resolve is not_found, and a ref starting with a dash is data", () => {
		const { root } = produce("clean");
		for (const ref of ["no-such-ref", "--all"]) {
			try {
				produceCodeMap({ repositoryPath: root, sourceRef: ref, taskText: "x" });
				throw new Error("expected a throw");
			} catch (error) {
				expect(error).toBeInstanceOf(GlyphError);
				expect((error as GlyphError).errorType).toBe("not_found");
			}
		}
	});

	test("task text over 20,000 UTF-16 code units is a usage error, never a silent truncation", () => {
		const { root } = produce("clean");
		const attempt = (taskText: string) => () => produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText });
		expect(attempt("x".repeat(20_000))).not.toThrow();
		expect(attempt("x".repeat(20_001))).toThrow(/20001 UTF-16 code units/);
		try {
			attempt("x".repeat(20_001))();
		} catch (error) {
			expect(error).toBeInstanceOf(GlyphError);
			expect((error as GlyphError).errorType).toBe("usage");
		}
	});

	test("the bound counts code units, as the producer does: 20,000 \u00e9 pass, an astral character counts as two", () => {
		const { root } = produce("clean");
		const attempt = (taskText: string) => () => produceCodeMap({ repositoryPath: root, sourceRef: "base", taskText });
		// \u00e9 is one code unit but two UTF-8 bytes: 20,000 of them are within the bound.
		expect(attempt("\u00e9".repeat(20_000))).not.toThrow();
		// An emoji is two code units: 19,998 + 2 = 20,000 passes, 19,999 + 2 = 20,001 does not.
		expect(attempt(`${"x".repeat(19_998)}\u{1F600}`)).not.toThrow();
		expect(attempt(`${"x".repeat(19_999)}\u{1F600}`)).toThrow(/20001 UTF-16 code units/);
	});
});
