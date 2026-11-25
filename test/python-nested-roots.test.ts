import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeKey, computeRefKey } from "../src/cache.ts";
import { markerDirsFor } from "../src/discover.ts";
import { gitRun } from "../src/git.ts";
import { cacheScopeOf, indexRefWith, indexWith, selectLanguage } from "../src/language.ts";
import { type ModuleGraph, type PythonModuleInput, buildModuleGraph } from "../src/python/modules.ts";
import { languageFilesAtRef, markerDirsAtRef, sourceBytesAtRef } from "../src/snapshot.ts";
import { makeScratchRepo, type ScratchRepo } from "./helpers.ts";

/**
 * S8a: nested project roots discovered by their marker (GCLI-85, DEC-303 (a18)).
 *
 * The rule-per-case list is the rules commit `af4d895`. Rules 1-4 and 9 are
 * ruled by (a18); rules 5-8 are this repository's implementation readings, named
 * as such there. Fixtures are built here in memory or in throwaway temp
 * repositories; the held-out gate corpora are never read.
 */

const encoder = new TextEncoder();

function py(path: string, source: string): PythonModuleInput {
	return { path, bytes: encoder.encode(source) };
}

function bindingIn(graph: ModuleGraph, path: string, original: string) {
	const found = graph.bindings.find((binding) => binding.path === path && binding.original === original);
	if (found === undefined) throw new Error(`no binding ${original} in ${path}`);
	return found;
}

/**
 * The click shape the gate failed on, without downloading click: a standalone
 * project under `examples/complex/` with its own `setup.py`, holding a package
 * `complex` imported as `complex.cli` from a file inside it.
 */
const CLICK_SHAPE: Record<string, string> = {
	"examples/complex/setup.py": "",
	"examples/complex/complex/__init__.py": "",
	"examples/complex/complex/cli.py": "def main():\n    return 1\n",
	"examples/complex/complex/commands/__init__.py": "",
	"examples/complex/complex/commands/main.py": "from complex.cli import main\n\ndef run():\n    return main()\n",
};

function clickInputs(): PythonModuleInput[] {
	return Object.entries(CLICK_SHAPE).map(([path, source]) => py(path, source));
}

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[], cacheDirOverride?: string): CliResult {
	const proc = Bun.spawnSync(
		["bun", "run", new URL("../src/cli.ts", import.meta.url).pathname, "--repo", cwd, ...args],
		{
			env: {
				...process.env,
				GLYPH_CACHE_DIR: cacheDirOverride ?? mkdtempSync(join(tmpdir(), "glyph-nested-cache-")),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function jsonData(result: CliResult): Record<string, unknown> {
	return (JSON.parse(result.stdout) as { data: Record<string, unknown> }).data;
}

function nestedRepo(): ScratchRepo {
	const repo = makeScratchRepo(CLICK_SHAPE);
	repo.commit("nested");
	return repo;
}

// --- rules 1, 2 and 4: marker resolves, no marker exits 7 -------------------

describe("rules 1, 2 and 4 — the click shape and its no-marker twin", () => {
	test("rule 2: a nested marker resolves the import, and the same layout without it still exits 7", async () => {
		const withMarker = await buildModuleGraph(clickInputs(), { markerDirs: ["examples/complex"] });
		const commands = "examples/complex/complex/commands/main.py";
		const resolved = bindingIn(withMarker, commands, "main");
		expect(resolved.outcome).toBe("resolved");
		expect(resolved.target).toBe("examples/complex/complex/cli.py");
		expect(withMarker.exit7).toEqual([]);
		// Rule 7: the nested file takes its module name from the nested root, not
		// from the repository root it would otherwise sit under.
		const module = withMarker.modules.find((entry) => entry.path === commands);
		expect(module?.root).toBe("examples/complex");
		expect(module?.module).toBe("complex.commands.main");

		// Rule 4: the identical layout with no marker keeps today's exit-7 trigger.
		const withoutMarker = await buildModuleGraph(clickInputs());
		expect(withoutMarker.exit7).toEqual([
			{
				path: commands,
				line: 1,
				name: "complex",
				original: "main",
				directories: ["examples/complex/complex"],
			},
		]);
		expect(bindingIn(withoutMarker, commands, "main").reason).toBe("unresolved-package-root");
	});

	test("rules 1, 2 and 4: the CLI indexes with the marker and exits 7 once the marker is gone", () => {
		const repo = nestedRepo();
		const withMarker = runCli(repo.root, ["--json", "callers", "main"]);
		expect(withMarker.code).toBe(0);
		expect((jsonData(withMarker).callers as unknown[]).length).toBe(1);

		// The same layout, every file unchanged, with the marker removed.
		rmSync(join(repo.root, "examples/complex/setup.py"));
		const withoutMarker = runCli(
			repo.root,
			["--json", "callers", "main"],
			mkdtempSync(join(tmpdir(), "glyph-nested-rm-cache-")),
		);
		expect(withoutMarker.code).toBe(7);
		expect(withoutMarker.stdout).toBe("");
		const error = JSON.parse(withoutMarker.stderr) as { error_type: string; message: string };
		expect(error.error_type).toBe("indeterminate");
		expect(error.message).toContain("first-party package root");
	});
});

// --- rule 5: nearest enclosing marker wins ---------------------------------

describe("rule 5 — the nearest enclosing marker wins and outer roots are not chained", () => {
	const OUTER = "examples/outer";

	test("rule 5: nested-in-nested resolves against the innermost root, not the outer one", async () => {
		const graph = await buildModuleGraph(
			[
				py(`${OUTER}/setup.py`, ""),
				py(`${OUTER}/inner/pyproject.toml`, ""),
				// Both roots provide the same top-level name with different targets.
				py(`${OUTER}/pkg/__init__.py`, ""),
				py(`${OUTER}/pkg/thing.py`, "def thing():\n    return 'outer'\n"),
				py(`${OUTER}/inner/pkg/__init__.py`, ""),
				py(`${OUTER}/inner/pkg/thing.py`, "def thing():\n    return 'inner'\n"),
				py(`${OUTER}/inner/pkg/use.py`, "from pkg.thing import thing\n"),
			],
			{ markerDirs: [OUTER, `${OUTER}/inner`] },
		);
		const binding = bindingIn(graph, `${OUTER}/inner/pkg/use.py`, "thing");
		expect(binding.outcome).toBe("resolved");
		expect(binding.target).toBe(`${OUTER}/inner/pkg/thing.py`);
		const useModule = graph.modules.find((entry) => entry.path === `${OUTER}/inner/pkg/use.py`);
		expect(useModule?.root).toBe(`${OUTER}/inner`);
		expect(useModule?.module).toBe("pkg.use");
	});

	test("rule 5: an outer nested root is not chained to a file under the inner one", async () => {
		const graph = await buildModuleGraph(
			[
				py(`${OUTER}/setup.py`, ""),
				py(`${OUTER}/inner/pyproject.toml`, ""),
				py(`${OUTER}/outpkg/__init__.py`, ""),
				py(`${OUTER}/inner/pkg/__init__.py`, ""),
				py(`${OUTER}/inner/pkg/uses_outer.py`, "import outpkg\n"),
			],
			{ markerDirs: [OUTER, `${OUTER}/inner`] },
		);
		expect(graph.exit7).toEqual([
			{
				path: `${OUTER}/inner/pkg/uses_outer.py`,
				line: 1,
				name: "outpkg",
				original: "outpkg",
				directories: [`${OUTER}/outpkg`],
			},
		]);
		expect(bindingIn(graph, `${OUTER}/inner/pkg/uses_outer.py`, "outpkg").reason).toBe("unresolved-package-root");
	});
});

// --- rule 6: an excluded-path marker creates no nested root ----------------

describe("rule 6 — a marker in an excluded path creates no nested root", () => {
	test("rule 6: a marker under an excluded directory is ignored and resolves nothing", async () => {
		const graph = await buildModuleGraph(
			[
				py(".venv/lib/pyproject.toml", ""),
				py(".venv/lib/pkg/__init__.py", ""),
				py("src/app/__init__.py", ""),
				py("src/a.py", "import pkg\n"),
			],
			{ markerDirs: [".venv/lib"] },
		);
		// The same exclusion rule removes every file beneath the marker, so the
		// marker can create no root and the import stays external.
		expect(graph.ignored).toContainEqual({ path: ".venv/lib/pkg/__init__.py", reason: "excluded-path" });
		expect(graph.exit7).toEqual([]);
		expect(bindingIn(graph, "src/a.py", "pkg").outcome).toBe("external");
	});

	test("rule 6: the same marker outside an excluded path does create a root (positive control)", async () => {
		const graph = await buildModuleGraph(
			[
				py("examples/lib/setup.cfg", ""),
				py("examples/lib/pkg/__init__.py", ""),
				py("examples/lib/pkg/thing.py", "def thing():\n    return 1\n"),
				py("examples/lib/use.py", "from pkg.thing import thing\n"),
			],
			{ markerDirs: ["examples/lib"] },
		);
		expect(bindingIn(graph, "examples/lib/use.py", "thing").target).toBe("examples/lib/pkg/thing.py");
		expect(graph.exit7).toEqual([]);
	});
});

// --- rule 1: a repository-root marker is not nested -------------------------

describe("rule 1 — a marker at the repository root is not a nested root", () => {
	const files = [py("app/__init__.py", ""), py("app/thing.py", ""), py("lib/a.py", "import app\n")];

	test("rule 1: a root marker is ignored, so declared roots still do not resolve it", async () => {
		const withRootMarker = await buildModuleGraph(files, { markerDirs: [""], roots: ["lib"] });
		expect(withRootMarker.exit7).toEqual([
			{ path: "lib/a.py", line: 1, name: "app", original: "app", directories: ["app"] },
		]);
		// Treating "" as nested would have added "" and src back beside the declared
		// root and resolved `app`; the two graphs are identical instead.
		const withoutMarker = await buildModuleGraph(files, { roots: ["lib"] });
		expect(JSON.stringify(withRootMarker)).toBe(JSON.stringify(withoutMarker));
	});
});

// --- rule 2: a nested root is not consulted for files outside it -----------

describe("rule 2 — a nested root is consulted only for files beneath it", () => {
	test("rule 2: an outside file importing a nested package still exits 7", async () => {
		const graph = await buildModuleGraph([...clickInputs(), py("src/other.py", "import complex\n")], {
			markerDirs: ["examples/complex"],
		});
		// The file inside resolves, the file outside does not: the nested root is
		// not global.
		expect(bindingIn(graph, "examples/complex/complex/commands/main.py", "main").outcome).toBe("resolved");
		expect(graph.exit7).toEqual([
			{
				path: "src/other.py",
				line: 1,
				name: "complex",
				original: "complex",
				directories: ["examples/complex/complex"],
			},
		]);
		expect(bindingIn(graph, "src/other.py", "complex").reason).toBe("unresolved-package-root");
	});
});

// --- rule 7: module naming under the nested source roots -------------------

describe("rule 7 — a nested file's module name comes from its nested source root", () => {
	test("rule 7: the deepest of the nested root's own '', src and lib roots names the file", async () => {
		const graph = await buildModuleGraph(
			[
				py("examples/proj/pyproject.toml", ""),
				py("examples/proj/top.py", ""),
				py("examples/proj/src/foopkg/__init__.py", ""),
				py("examples/proj/src/foopkg/mod.py", ""),
			],
			{ markerDirs: ["examples/proj"] },
		);
		const byPath = new Map(graph.modules.map((entry) => [entry.path, entry]));
		expect(byPath.get("examples/proj/top.py")?.root).toBe("examples/proj");
		expect(byPath.get("examples/proj/top.py")?.module).toBe("top");
		expect(byPath.get("examples/proj/src/foopkg/mod.py")?.root).toBe("examples/proj/src");
		expect(byPath.get("examples/proj/src/foopkg/mod.py")?.module).toBe("foopkg.mod");
	});
});

// --- rule 8: the working tree and --ref agree ------------------------------

describe("rule 8 — working-tree and --ref listings agree on the nested roots", () => {
	test("rule 8: marker lists and the graphs they produce are identical for both sources", async () => {
		const repo = nestedRepo();
		const sha = gitRun(repo.root, ["rev-parse", "HEAD"]).stdout.trim();
		const working = markerDirsFor(repo.root);
		const atRef = markerDirsAtRef(repo.root, sha);
		expect(atRef).toEqual(working);
		expect(working).toEqual(["examples/complex"]);

		const selection = selectLanguage(repo.root, "python");
		const workingInputs = selection.files.map((path) => ({
			path,
			bytes: new Uint8Array(readFileSync(join(repo.root, path))),
		}));
		const refPresence = languageFilesAtRef(repo.root, sha).find((entry) => entry.id === "python");
		const refFiles = refPresence?.files ?? [];
		const refInputs = sourceBytesAtRef(repo.root, sha, refFiles);
		const workingGraph = await buildModuleGraph(workingInputs, { markerDirs: working });
		const refGraph = await buildModuleGraph(refInputs, { markerDirs: atRef });
		expect(JSON.stringify(refGraph)).toBe(JSON.stringify(workingGraph));

		// And through the seam, both index the same symbols and sites.
		const workingIndex = await indexWith("python", repo.root, selection.files, working);
		const refIndex = await indexRefWith("python", repo.root, sha, refFiles, atRef);
		expect(refIndex.symbols).toEqual(workingIndex.symbols);
		expect(refIndex.sites).toEqual(workingIndex.sites);
	});
});

// --- cache keys ------------------------------------------------------------

describe("rule 8 — the marker set is part of the Python cache key", () => {
	test("a marker change is a miss; a markerless key and the TypeScript key are unchanged", () => {
		const repo = nestedRepo();
		const files = selectLanguage(repo.root, "python").files;
		const withMarker = cacheScopeOf("python", ["examples/complex"]);
		const otherMarker = cacheScopeOf("python", ["examples/other"]);
		expect(withMarker?.markerDirs).toEqual(["examples/complex"]);
		expect(otherMarker?.markerDirs).toEqual(["examples/other"]);
		const base = computeKey(repo.root, files, withMarker);
		expect(computeKey(repo.root, files, otherMarker)).not.toBe(base);
		expect(computeKey(repo.root, files, withMarker)).toBe(base);
		expect(computeRefKey("a".repeat(40), files, otherMarker)).not.toBe(
			computeRefKey("a".repeat(40), files, withMarker),
		);

		// No marker: the scope is exactly S7's, and an empty marker list is the same.
		expect(cacheScopeOf("python")).not.toHaveProperty("markerDirs");
		expect(cacheScopeOf("python", [])).toEqual(cacheScopeOf("python"));
		expect(computeKey(repo.root, files, cacheScopeOf("python", []))).toBe(
			computeKey(repo.root, files, cacheScopeOf("python")),
		);

		// TypeScript declares no scope, so its key cannot move.
		expect(cacheScopeOf("typescript", ["examples/complex"])).toBeUndefined();
		expect(computeKey(repo.root, files, cacheScopeOf("typescript", ["examples/complex"]))).toBe(
			computeKey(repo.root, files),
		);
	});

	test("a new marker directory misses the warm Python cache", () => {
		const repo = nestedRepo();
		const cache = mkdtempSync(join(tmpdir(), "glyph-nested-key-cache-"));
		const first = runCli(repo.root, ["--json", "callers", "main"], cache);
		expect(first.code).toBe(0);
		expect((jsonData(first).index as { cache: string }).cache).toBe("miss");
		const second = runCli(repo.root, ["--json", "callers", "main"], cache);
		expect((jsonData(second).index as { cache: string }).cache).toBe("hit");

		// A marker that changes no file and no resolution still changes resolution's
		// inputs, so the key must move and the answer must be rebuilt.
		repo.write("examples/other/pyproject.toml", "");
		const third = runCli(repo.root, ["--json", "callers", "main"], cache);
		expect(third.code).toBe(0);
		expect((jsonData(third).index as { cache: string }).cache).toBe("miss");
		const fourth = runCli(repo.root, ["--json", "callers", "main"], cache);
		expect((jsonData(fourth).index as { cache: string }).cache).toBe("hit");
	});
});

// --- rule 4: no-marker repositories are unchanged --------------------------

describe("rule 4 — a repository with no nested marker is unchanged", () => {
	test("an absent, empty or irrelevant marker list yields the identical graph", async () => {
		const files = [
			py("src/app/__init__.py", "from .b import Box\n"),
			py("src/app/b.py", "class Box:\n    pass\n"),
			py("src/a.py", "from app import Box\nimport os\n"),
		];
		const plain = await buildModuleGraph(files);
		expect(JSON.stringify(await buildModuleGraph(files, { markerDirs: [] }))).toBe(JSON.stringify(plain));
		expect(JSON.stringify(await buildModuleGraph(files, { markerDirs: ["elsewhere"] }))).toBe(JSON.stringify(plain));
	});
});
