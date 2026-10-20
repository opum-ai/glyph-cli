import { describe, expect, test } from "bun:test";
import { discoverSources } from "../src/discover.ts";
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
