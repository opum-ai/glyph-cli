import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSources } from "../src/discover.ts";
import { GlyphError } from "../src/errors.ts";
import { gitRun } from "../src/git.ts";
import { makeScratchRepo, scratchCacheDir } from "./helpers.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function runCli(cwd: string, args: string[], cacheDir: string): { code: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
		cwd,
		env: { ...process.env, GLYPH_CACHE_DIR: cacheDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("source discovery", () => {
	test("honours root and nested .gitignore files, negation, and untracked non-ignored sources", () => {
		const repo = makeScratchRepo({
			".gitignore": "*.tmp.ts\n!keep.tmp.ts\n",
			"drop.tmp.ts": "export const drop = 1;\n",
			"keep.tmp.ts": "export const keep = 1;\n",
			"nested/.gitignore": "hidden.ts\n",
			"nested/hidden.ts": "export const hidden = 1;\n",
			"nested/public.ts": "export const visible = 1;\n",
			"src/app.ts": "export const app = 1;\n",
		});
		repo.commit("base");
		repo.write("src/fresh.ts", "export const fresh = 1;\n");

		expect(discoverSources(repo.root)).toEqual(["keep.tmp.ts", "nested/public.ts", "src/app.ts", "src/fresh.ts"]);
	});

	test("keeps a tracked source even after an ignore pattern matches it", () => {
		const repo = makeScratchRepo({ "src/tracked.ts": "export const tracked = 1;\n" });
		repo.commit("base");
		repo.write(".gitignore", "src/tracked.ts\n");

		expect(discoverSources(repo.root)).toContain("src/tracked.ts");
	});

	test("a POSIX file name containing a backslash is preserved", () => {
		const repo = makeScratchRepo({ "a\\b.ts": "export const odd = 1;\n" });
		repo.commit("base");
		expect(discoverSources(repo.root)).toContain("a\\b.ts");
	});

	test("a directory outside Git falls back to the walk", () => {
		const root = mkdtempSync(join(tmpdir(), "glyph-nongit-"));
		writeFileSync(join(root, "loose.ts"), "export const loose = 1;\n");
		expect(discoverSources(root)).toEqual(["loose.ts"]);
	});

	test("git refusing a repository is indeterminate, not a silent walk", () => {
		const repo = makeScratchRepo({ "src/app.ts": "export const app = 1;\n" });
		repo.commit("base");
		// A corrupt index makes `git ls-files` fail while the directory is still
		// unmistakably a repository. Walking instead would index ignored sources.
		repo.write(".git/index", "garbage");

		expect(() => discoverSources(repo.root)).toThrow(GlyphError);
		try {
			discoverSources(repo.root);
		} catch (error) {
			expect(error).toBeInstanceOf(GlyphError);
			expect((error as GlyphError).errorType).toBe("indeterminate");
			expect((error as GlyphError).code).toBe(7);
		}

		const result = runCli(repo.root, ["--json", "cache", "path"], scratchCacheDir());
		// `cache path` does not index, so it still answers; the indexing command
		// is the one that must refuse.
		expect(result.code).toBe(0);
		const indexing = runCli(repo.root, ["--json", "callers", "app"], scratchCacheDir());
		expect(indexing.code).toBe(7);
		expect(indexing.stdout).toBe("");
		expect(JSON.parse(indexing.stderr).error_type).toBe("indeterminate");
	});

	test("a refused git marker at rev-parse is indeterminate before any listing", () => {
		const root = mkdtempSync(join(tmpdir(), "glyph-broken-git-"));
		writeFileSync(join(root, ".git"), "garbage");
		writeFileSync(join(root, "src.ts"), "export const src = 1;\n");

		// The refusal happens at rev-parse, not at ls-files. Its message is a
		// broken-gitfile error, not "not a git repository", so the fallback that
		// is right for a plain directory must not fire here.
		const probe = gitRun(root, ["rev-parse", "--is-inside-work-tree"]);
		expect(probe.code).not.toBe(0);
		expect(probe.stderr).toContain("gitfile");
		expect(probe.stderr).not.toContain("not a git repository");

		try {
			discoverSources(root);
			throw new Error("expected discoverSources to refuse");
		} catch (error) {
			expect(error).toBeInstanceOf(GlyphError);
			expect((error as GlyphError).errorType).toBe("indeterminate");
			expect((error as GlyphError).code).toBe(7);
		}
	});

	test("an ignored source never enters the index, while an untracked non-ignored source does", () => {
		const repo = makeScratchRepo({
			".gitignore": "ignored.ts\n",
			"ignored.ts": "export function hidden(): number {\n  return 1;\n}\n",
			"src/main.ts": "export function main(): number {\n  return 1;\n}\n",
		});
		repo.commit("base");
		repo.write("src/fresh.ts", "export function fresh(): number {\n  return 2;\n}\n");
		const cache = scratchCacheDir();

		const ignored = runCli(repo.root, ["--json", "callers", "hidden"], cache);
		expect(ignored.code).toBe(3);
		expect(ignored.stdout).toBe("");

		const untracked = runCli(repo.root, ["--json", "callers", "fresh"], cache);
		expect(untracked.code).toBe(0);
		expect(JSON.parse(untracked.stdout).data.symbol.name).toBe("fresh");
	});
});
