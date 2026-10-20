import { describe, expect, test } from "bun:test";
import { GlyphError } from "../src/errors.ts";
import { gitRun, parseDiff, resolveDiffRefs } from "../src/git.ts";
import { makeScratchRepo } from "./helpers.ts";

describe("git", () => {
	test("maps a deletion-only hunk to the line the deletion happened at", () => {
		// `-U0` renders a pure deletion as `+c,0` — no new line is part of the
		// change — so the parser anchors it at git's insertion point instead of
		// reporting that nothing changed.
		const repo = makeScratchRepo({
			"src/a.ts": "export function keep(): number {\n  const x = 1;\n  return x;\n}\n",
		});
		const base = repo.commit("base");
		repo.write("src/a.ts", "export function keep(): number {\n  return x;\n}\n");
		const head = repo.commit("drop a line");
		const changes = parseDiff(repo.root, base, head);
		expect(changes).toEqual([{ file: "src/a.ts", ranges: [{ start: 1, end: 1 }], wholeFile: false }]);
	});

	test("an added file is wholeFile with no partial ranges", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export const a = 1;\n" });
		const base = repo.commit("base");
		repo.write("src/b.ts", "export const b = 2;\n");
		const head = repo.commit("add file");
		const changes = parseDiff(repo.root, base, head);
		expect(changes).toEqual([{ file: "src/b.ts", ranges: [], wholeFile: true }]);
	});

	test("a deleted file contributes no new-side ranges", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export const a = 1;\n" });
		const base = repo.commit("base");
		gitRun(repo.root, ["rm", "-q", "src/a.ts"]);
		const head = repo.commit("delete file");
		const changes = parseDiff(repo.root, base, head);
		expect(changes).toEqual([]);
	});

	test("a diff git cannot produce over resolved refs is indeterminate, not usage", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export const a = 1;\n" });
		repo.commit("base");
		let error: unknown;
		try {
			// Both ids are 40 hex characters, so they parse as commits but no
			// object exists: git exits non-zero after refs were already resolved.
			parseDiff(repo.root, "a".repeat(40), "b".repeat(40));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(GlyphError);
		expect((error as GlyphError).errorType).toBe("indeterminate");
		expect((error as GlyphError).code).toBe(7);
	});

	test("an unresolvable ref is not-found", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export const a = 1;\n" });
		repo.commit("base");
		let error: unknown;
		try {
			resolveDiffRefs(repo.root, "nope-not-a-ref", "HEAD");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(GlyphError);
		expect((error as GlyphError).code).toBe(3);
	});
});
