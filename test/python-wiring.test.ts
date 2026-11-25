import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDir, computeKey, computeRefKey, readCachedIndex } from "../src/cache.ts";
import { buildIndex } from "../src/indexer.ts";
import { cacheScopeOf, indexWith, isDefaultLanguage, registeredLanguages, selectLanguage } from "../src/language.ts";
import { analyzePythonCalls } from "../src/python/calls.ts";
import { PYTHON_ANALYZER_VERSION } from "../src/python/indexer.ts";
import { grammarVersion } from "../src/python/parse.ts";
import { display, callersOf } from "../src/queries.ts";
import { impactOf } from "../src/impact.ts";
import { CALL_KINDS, INDEX_FORMAT, type GlyphIndex, type SiteEntry, type SymbolEntry } from "../src/types.ts";
import { makeScratchRepo, type ScratchRepo } from "./helpers.ts";

/**
 * S7: the native Python indexer behind the language seam (GCLI-82).
 *
 * The rule-per-case list is the two rules commits on this branch: `e21fcb9`
 * (part 1, rules 1-12) and `bc62148` (part 2, rules 13-18, DEC-303 (a14)).
 * Every test names the rule it pins. Fixtures are small repositories built
 * here; the held-out gate corpora under `test/python-gate/` are never read.
 */

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[], cacheDirOverride?: string, stdin?: string): CliResult {
	const proc = Bun.spawnSync(["bun", "run", CLI, "--repo", cwd, ...args], {
		env: {
			...process.env,
			GLYPH_CACHE_DIR: cacheDirOverride ?? mkdtempSync(join(tmpdir(), "glyph-py-wire-cache-")),
		},
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function jsonOf(result: CliResult): { kind: string; data: Record<string, unknown> } {
	return JSON.parse(result.stdout) as { kind: string; data: Record<string, unknown> };
}

/** The package the Python fixtures use: two modules, a decorated def and a caller. */
const PY_FILES: Record<string, string> = {
	"pkg/__init__.py": "",
	"pkg/core.py":
		"def helper(x):\n    return x + 1\n\ndef wrap(f):\n    return f\n\n@wrap\ndef decorated():\n    return 1\n",
	"pkg/use.py": "from .core import helper\n\ndef caller():\n    return helper(1)\n",
};

const TS_FILES: Record<string, string> = {
	"src/util.ts": "export function helper(n: number): number {\n  return n + 1;\n}\n",
	"src/main.ts": 'import { helper } from "./util";\nexport function main(): number {\n  return helper(1);\n}\n',
};

function pythonRepo(extra: Record<string, string> = {}): ScratchRepo {
	const repo = makeScratchRepo({ ...PY_FILES, ...extra });
	repo.commit("base");
	return repo;
}

function tsRepo(): ScratchRepo {
	const repo = makeScratchRepo(TS_FILES);
	repo.commit("base");
	return repo;
}

function symbolNamed(index: GlyphIndex, name: string): SymbolEntry {
	const found = index.symbols.find((symbol) => symbol.name === name);
	if (found === undefined) throw new Error(`no symbol named ${name}`);
	return found;
}

function sitesTo(sites: readonly SiteEntry[], calleeId: string): SiteEntry[] {
	return sites.filter((site) => site.calleeId === calleeId);
}

// --- rule 1 ---------------------------------------------------------------

describe("rule 1 — registration and the seam", () => {
	test("rule 1: python is registered and a Python-only working tree is indexed", () => {
		expect(registeredLanguages()).toEqual(["python", "typescript"]);
		const repo = pythonRepo();
		const result = runCli(repo.root, ["--json", "callers", "helper"]);
		expect(result.code).toBe(0);
		const data = jsonOf(result).data;
		expect((data.index as { language?: string }).language).toBe("python");
		expect((data.callers as unknown[]).length).toBe(1);
	});

	test("rule 1: the TypeScript indexer stays synchronous; the Python one is awaited", async () => {
		const repo = pythonRepo();
		const selection = selectLanguage(repo.root, undefined);
		expect(buildIndex(repo.root, selection.files) instanceof Promise).toBe(false);
		const python = await indexWith("python", repo.root, selection.files);
		expect(python.schemaVersion).toBe(INDEX_FORMAT);
	});

	test("rule 1: a mixed tree selects TypeScript and names Python not indexed; --language python overrides", () => {
		const repo = makeScratchRepo({ ...TS_FILES, ...PY_FILES });
		repo.commit("mixed");

		const mixed = selectLanguage(repo.root, undefined);
		expect(mixed.id).toBe("typescript");
		expect(isDefaultLanguage(mixed)).toBe(false);
		expect(mixed.notIndexed).toEqual([{ language: "python", files: 3 }]);

		const ts = runCli(repo.root, ["--json", "callers", "helper"]);
		expect(ts.code).toBe(0);
		const tsIndex = jsonOf(ts).data.index as { language?: string; notIndexed?: unknown };
		expect(tsIndex.language).toBe("typescript");
		expect(tsIndex.notIndexed).toEqual([{ language: "python", files: 3 }]);

		const python = runCli(repo.root, ["--json", "--language", "python", "callers", "helper"]);
		expect(python.code).toBe(0);
		const pythonIndex = jsonOf(python).data.index as { language?: string; notIndexed?: unknown };
		expect(pythonIndex.language).toBe("python");
		expect(pythonIndex.notIndexed).toEqual([{ language: "typescript", files: 2 }]);

		const overridden = selectLanguage(repo.root, "python");
		expect(overridden.id).toBe("python");
		expect(overridden.notIndexed).toEqual([{ language: "typescript", files: 2 }]);
	});
});

// --- rule 2 ---------------------------------------------------------------

describe("rule 2 — inputs and paths", () => {
	test("rule 2: the adapter uses the repository-relative path, not the basename", async () => {
		const repo = pythonRepo();
		// A `./`-prefixed path is normalised before the analyzer, so the index and
		// every site name the repository-relative POSIX path.
		const index = await indexWith("python", repo.root, ["./pkg/__init__.py", "./pkg/core.py", "./pkg/use.py"]);
		expect(index.files).toEqual(["pkg/__init__.py", "pkg/core.py", "pkg/use.py"]);
		expect(index.symbols.every((symbol) => symbol.file.startsWith("pkg/"))).toBe(true);
		const helper = symbolNamed(index, "helper");
		expect(sitesTo(index.sites, helper.id)).toEqual([
			{ calleeId: helper.id, callerId: "pkg/use.py:3:5", file: "pkg/use.py", line: 4, column: 12, kind: "call" },
		]);
	});

	test("rule 2: the bytes path accepts a source that is not valid UTF-8", () => {
		const repo = pythonRepo();
		// Written as bytes: the analyzer decodes them, counts the replacement and
		// still yields the symbol. A pre-decoded string would lose that count.
		writeFileSync(join(repo.root, "pkg/raw.py"), Buffer.from("def raw():\n    # \xff\n    return 1\n", "latin1"));
		const result = runCli(repo.root, ["--json", "callers", "raw"]);
		expect(result.code).toBe(0);
		expect((jsonOf(result).data.symbol as { name: string }).name).toBe("raw");
	});
});

// --- rule 3 ---------------------------------------------------------------

describe("rule 3 — mapping S5 onto the index", () => {
	test("rule 3: every site maps one-to-one and the symbol table keeps qualname", async () => {
		const repo = pythonRepo();
		const selection = selectLanguage(repo.root, undefined);
		const files = selection.files.map((path) => ({
			path,
			bytes: new Uint8Array(readFileSync(join(repo.root, path))),
		}));
		const analyzed = await analyzePythonCalls(files);
		const index = await indexWith("python", repo.root, selection.files);

		expect(index.files).toEqual(selection.files);
		expect(index.symbols).toEqual(analyzed.symbols as unknown as SymbolEntry[]);
		expect(index.symbols.every((symbol) => typeof symbol.qualname === "string")).toBe(true);
		expect(
			index.sites.map((site) => [site.calleeId, site.callerId, site.file, site.line, site.column, site.kind]),
		).toEqual(
			analyzed.sites.map((site) => [site.calleeId, site.callerId, site.file, site.line, site.column, site.kind]),
		);
		expect(index.unresolvedByKind).toEqual(analyzed.unresolvedByKind);
		expect(index.unresolvedSites).toBe(
			index.unresolvedByKind.call +
				index.unresolvedByKind.import +
				index.unresolvedByKind.extends +
				index.unresolvedByKind.implements +
				index.unresolvedByKind.dynamic,
		);
		expect(index.unresolvedSites).toBe(
			analyzed.unresolvedByKind.call +
				analyzed.unresolvedByKind.import +
				analyzed.unresolvedByKind.extends +
				analyzed.unresolvedByKind.implements +
				analyzed.unresolvedByKind.dynamic,
		);
	});
});

// --- rule 4 ---------------------------------------------------------------

describe("rule 4 — indeterminate", () => {
	test("rule 4: a non-empty exit7 list is exit 7 naming the first trigger and the count", () => {
		const repo = makeScratchRepo({
			"app/main.py": "import tools.helpers\ntools.helpers.h()\n",
			"backend/tools/__init__.py": "",
			"backend/tools/helpers.py": "def h():\n    return 1\n",
		});
		repo.commit("exit7");
		const result = runCli(repo.root, ["--json", "callers", "h"]);
		expect(result.code).toBe(7);
		expect(result.stdout).toBe("");
		const error = JSON.parse(result.stderr) as { error_type: string; message: string };
		expect(error.error_type).toBe("indeterminate");
		expect(error.message).toContain("first-party package root");
		expect(error.message).toContain("first: 'tools.helpers' at app/main.py:1 names 'tools'");
	});

	test("rule 4: a file with a parse error is not exit 7 by itself", () => {
		const repo = pythonRepo({ "pkg/broken.py": "def f():\n    x = g() ]\n" });
		const result = runCli(repo.root, ["--json", "callers", "helper"]);
		expect(result.code).toBe(0);
		expect((jsonOf(result).data.callers as unknown[]).length).toBe(1);
	});
});

// --- rule 5 ---------------------------------------------------------------

describe("rule 5 — display", () => {
	test("rule 5: a symbol with a qualname displays it; TypeScript display is unchanged", () => {
		const repo = makeScratchRepo({
			"app.py": "def outer():\n    def inner():\n        return 1\n    return inner()\n",
		});
		repo.commit("nested");
		const result = runCli(repo.root, ["callers", "inner"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("callers of outer.inner (function)");

		const nested = runCli(repo.root, ["--json", "callers", "inner"]);
		expect((jsonOf(nested).data.symbol as { qualname: string }).qualname).toBe("outer.inner");

		const ts = tsRepo();
		const tsResult = runCli(ts.root, ["--json", "callers", "helper"]);
		expect(Object.hasOwn(jsonOf(tsResult).data.symbol as object, "qualname")).toBe(false);
		expect(
			display({
				id: "x",
				name: "m",
				container: "C",
				kind: "method",
				file: "x",
				startLine: 1,
				line: 1,
				column: 1,
				endLine: 1,
				exported: true,
			}),
		).toBe("C.m");
	});
});

// --- rule 6 ---------------------------------------------------------------

describe("rule 6 — cache keys", () => {
	test("rule 6: each Python key part is load-bearing, and TypeScript's key is unchanged", () => {
		const repo = pythonRepo();
		const files = selectLanguage(repo.root, undefined).files;
		const scope = cacheScopeOf("python");
		expect(scope).toEqual({
			language: "python",
			analyzerVersion: PYTHON_ANALYZER_VERSION,
			grammarVersion: grammarVersion(),
		});
		expect(cacheScopeOf("typescript")).toBeUndefined();
		if (scope === undefined) throw new Error("python scope missing");

		const base = computeKey(repo.root, files, scope);
		// Mutation-style: if any one part were dropped from the hash, these would
		// be equal to `base` and the assertion would fail.
		expect(computeKey(repo.root, files, { ...scope, language: "python2" })).not.toBe(base);
		expect(computeKey(repo.root, files, { ...scope, analyzerVersion: `${scope.analyzerVersion}-next` })).not.toBe(base);
		expect(computeKey(repo.root, files, { ...scope, grammarVersion: `${scope.grammarVersion}-next` })).not.toBe(base);

		// A TypeScript key is exactly the scope-less key.
		expect(computeKey(repo.root, files)).toBe(computeKey(repo.root, files, undefined));

		// Working-tree and --ref keys never share a preimage.
		const sha = "a".repeat(40);
		const refScope = cacheScopeOf("python") as NonNullable<ReturnType<typeof cacheScopeOf>>;
		expect(computeKey(repo.root, files, scope)).not.toBe(computeRefKey(sha, files, refScope));
		expect(computeRefKey(sha, files, refScope)).not.toBe(
			computeRefKey(sha, files, { ...refScope, grammarVersion: "x" }),
		);
	});
});

// --- rule 7 ---------------------------------------------------------------

describe("rule 7 — --ref", () => {
	test("rule 7: Python --ref answers from the commit, not the dirty working tree", () => {
		const repo = pythonRepo();
		const cache = mkdtempSync(join(tmpdir(), "glyph-py-ref-cache-"));

		const atRef = runCli(repo.root, ["--json", "impact", "helper", "--ref", "HEAD"], cache);
		expect(atRef.code).toBe(0);
		const refData = jsonOf(atRef).data;
		expect((refData.index as { language?: string }).language).toBe("python");
		expect((refData.callers as unknown[]).length).toBe(1);

		// Remove the committed call from the working tree.
		repo.write("pkg/use.py", "from .core import helper\n\ndef caller():\n    return 0\n");
		const working = runCli(repo.root, ["--json", "callers", "helper"]);
		expect(working.code).toBe(0);
		expect((jsonOf(working).data.callers as unknown[]).length).toBe(0);

		// The same ref still answers from the commit, and its key did not move with
		// the checkout: the second run is a cache hit.
		const again = runCli(repo.root, ["--json", "impact", "helper", "--ref", "HEAD"], cache);
		expect(again.code).toBe(0);
		const againData = jsonOf(again).data;
		expect((againData.callers as unknown[]).length).toBe(1);
		expect((againData.index as { cache: string }).cache).toBe("hit");
	});
});

// --- rule 8 ---------------------------------------------------------------

describe("rule 8 — code-map", () => {
	test("rule 8: code-map's symbol tier reads the Python index at the source ref", () => {
		const repo = pythonRepo();
		const result = runCli(
			repo.root,
			["--json", "code-map", "--source-ref", "HEAD"],
			undefined,
			"fix `helper` in pkg/core.py",
		);
		expect(result.code).toBe(0);
		const pointers = jsonOf(result).data.pointers as { path: string; reason: string }[];
		const declaring = pointers.find((pointer) => pointer.path === "pkg/core.py");
		const referencing = pointers.find((pointer) => pointer.path === "pkg/use.py");
		// These reasons can only come from tier 3, so the Python index was used.
		expect(declaring?.reason).toContain("declares symbol `helper` (function)");
		expect(referencing?.reason).toContain("calls symbol `helper` (depth 1)");
	});
});

// --- rule 9 ---------------------------------------------------------------

describe("rule 9 — diff and touched symbols", () => {
	test("rule 9: a decorated def's span starts at its decorator, and a change outside a symbol touches none", () => {
		const repo = makeScratchRepo({
			"pkg/__init__.py": "",
			"pkg/core.py":
				"def helper(x):\n    return x + 1\n\n@wrap\ndef decorated():\n    return 1\n\ndef wrap(f):\n    return f\n",
		});
		const base = repo.commit("base");
		repo.write(
			"pkg/core.py",
			"def helper(x):\n    return x + 1\n\n@wrap\ndef decorated():\n    return 2\n\ndef wrap(f):\n    return f\n",
		);
		repo.commit("change decorated body");

		const changed = runCli(repo.root, ["--json", "diff", base, "HEAD"]);
		expect(changed.code).toBe(0);
		const symbols = jsonOf(changed).data.symbols as { name: string; startLine: number; line: number }[];
		const decorated = symbols.find((symbol) => symbol.name === "decorated");
		expect(decorated).toBeDefined();
		expect(decorated?.startLine).toBe(4); // the @wrap line
		expect(decorated?.line).toBe(5); // the def line

		// A module-level assignment is inside no symbol. Add it in one commit, then
		// change only it in the next.
		const withValue =
			"def helper(x):\n    return x + 1\n\n@wrap\ndef decorated():\n    return 2\n\ndef wrap(f):\n    return f\n\nVALUE = 1\n";
		repo.write("pkg/core.py", withValue);
		const second = repo.commit("add a module-level value");
		repo.write("pkg/core.py", withValue.replace("VALUE = 1", "VALUE = 2"));
		repo.commit("change a module-level value");
		const outside = runCli(repo.root, ["--json", "diff", second, "HEAD"]);
		expect(outside.code).toBe(0);
		expect((jsonOf(outside).data.symbols as unknown[]).length).toBe(0);
	});
});

// --- rule 10 --------------------------------------------------------------

function streamEnvelopes(stdout: string): { kind: string; data: Record<string, unknown> }[] {
	return stdout
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { kind: string; data: Record<string, unknown> });
}

describe("rule 10 — --stream", () => {
	test("rule 10: callers stream rows equal the batch rows, and the result line carries the batch data", () => {
		const repo = pythonRepo();
		const batch = jsonOf(runCli(repo.root, ["--json", "callers", "helper"])).data;
		const streamed = streamEnvelopes(runCli(repo.root, ["callers", "helper", "--stream"]).stdout);
		const items = streamed.filter((line) => line.kind === "callers.item").map((line) => line.data);
		const result = streamed.find((line) => line.kind === "callers.result")?.data;
		const sortRows = (rows: unknown[]): string[] => rows.map((row) => JSON.stringify(row)).sort();
		expect(sortRows(items)).toEqual(sortRows(batch.callers as unknown[]));
		const { callers: _callers, ...withoutItems } = batch;
		expect(result).toEqual({ ...withoutItems, itemCount: items.length });
	});

	test("rule 10: impact stream rows equal the batch rows, and the result line carries the batch data", () => {
		const repo = pythonRepo();
		const batch = jsonOf(runCli(repo.root, ["--json", "impact", "helper"])).data;
		const streamed = streamEnvelopes(runCli(repo.root, ["impact", "helper", "--stream"]).stdout);
		const items = streamed.filter((line) => line.kind === "impact.item").map((line) => line.data);
		const result = streamed.find((line) => line.kind === "impact.result")?.data;
		const sortRows = (rows: unknown[]): string[] => rows.map((row) => JSON.stringify(row)).sort();
		expect(sortRows(items)).toEqual(sortRows(batch.callers as unknown[]));
		const { callers: _callers, ...withoutItems } = batch;
		expect(result).toEqual({ ...withoutItems, itemCount: items.length });
	});
});

// --- rule 11 --------------------------------------------------------------

describe("rule 11 — TypeScript parity", () => {
	test("rule 11: a TypeScript-only answer carries no Python field and no language entry", () => {
		const repo = tsRepo();
		const pythonFields = ["callBins", "unresolvedFirstPartyImports", "constructorNotes"];
		for (const [args, dataKey] of [
			[["--json", "callers", "helper"], "callers"],
			[["--json", "impact", "helper"], "callers"],
			[["--json", "diff", "HEAD~0", "HEAD"], "symbols"],
		] as const) {
			const result = runCli(repo.root, [...args]);
			expect(result.code).toBe(0);
			const data = jsonOf(result).data;
			for (const field of pythonFields) expect(Object.hasOwn(data, field)).toBe(false);
			const index = data.index as Record<string, unknown>;
			expect(Object.hasOwn(index, "language")).toBe(false);
			expect(Object.hasOwn(index, "notIndexed")).toBe(false);
			void dataKey;
		}
		// The byte-level proof is `test/language-golden.test.ts`, which stays green.
		const callers = jsonOf(runCli(repo.root, ["--json", "callers", "helper"])).data;
		expect(Object.keys(callers)).toEqual(["symbol", "callers", "totals", "index"]);
		expect(Object.keys(callers.symbol as object)).toEqual([
			"id",
			"name",
			"container",
			"kind",
			"file",
			"startLine",
			"line",
			"column",
			"endLine",
			"exported",
		]);
	});
});

// --- rule 13 --------------------------------------------------------------

describe("rule 13 — the decorator site kind", () => {
	test("rule 13: a bare @d is a decorator SiteEntry reported by callers and impact", async () => {
		expect(CALL_KINDS).toContain("decorator");
		const repo = pythonRepo();
		const selection = selectLanguage(repo.root, undefined);
		const index = await indexWith("python", repo.root, selection.files);
		const wrap = symbolNamed(index, "wrap");
		const decoratorSites = index.sites.filter((site) => site.kind === "decorator");
		expect(decoratorSites).toHaveLength(1);
		expect(decoratorSites[0]).toMatchObject({ calleeId: wrap.id, file: "pkg/core.py", line: 7, kind: "decorator" });
		// `callers` reports it only because CALL_KINDS carries "decorator".
		expect(callersOf(index, wrap).map((site) => site.kind)).toEqual(["decorator"]);
		expect(impactOf(index, wrap, 1).callers.map((caller) => caller.path[0]?.kind)).toEqual(["decorator"]);
	});
});

// --- rule 14 --------------------------------------------------------------

describe("rule 14 — index format", () => {
	test("rule 14: INDEX_FORMAT is 3 and a format-2 cache entry is not served", () => {
		expect(INDEX_FORMAT).toBe(3);
		const repo = pythonRepo();
		const saved = process.env.GLYPH_CACHE_DIR;
		const cache = mkdtempSync(join(tmpdir(), "glyph-py-format-cache-"));
		process.env.GLYPH_CACHE_DIR = cache;
		try {
			const key = "format-test";
			const dir = cacheDir(repo.root);
			mkdirSync(dir, { recursive: true });
			const index = {
				schemaVersion: 2,
				repo: repo.root,
				createdAt: "2026-01-01T00:00:00.000Z",
				files: [],
				symbols: [],
				sites: [],
				unresolvedSites: 0,
				unresolvedByKind: { call: 0, import: 0, extends: 0, implements: 0, dynamic: 0 },
			};
			writeFileSync(join(dir, `${key}.json`), JSON.stringify(index));
			expect(readCachedIndex(repo.root, key)).toBeNull();
			writeFileSync(join(dir, `${key}.json`), JSON.stringify({ ...index, schemaVersion: INDEX_FORMAT }));
			expect(readCachedIndex(repo.root, key)?.schemaVersion).toBe(INDEX_FORMAT);
		} finally {
			if (saved === undefined) delete process.env.GLYPH_CACHE_DIR;
			else process.env.GLYPH_CACHE_DIR = saved;
		}
	});
});

// --- rule 15 --------------------------------------------------------------

describe("rule 15 — additive index fields", () => {
	test("rule 15: the three fields are set for Python and ABSENT for TypeScript", async () => {
		const repo = pythonRepo();
		const selection = selectLanguage(repo.root, undefined);
		const index = await indexWith("python", repo.root, selection.files);
		const files = selection.files.map((path) => ({
			path,
			bytes: new Uint8Array(readFileSync(join(repo.root, path))),
		}));
		const analyzed = await analyzePythonCalls(files);
		expect(index.callBins).toEqual(analyzed.callBins);
		expect(index.unresolvedFirstPartyImports).toBe(analyzed.unresolvedFirstPartyImports);
		expect(index.constructorNotes).toBe(analyzed.constructorNotes.length);
		expect(index.unresolvedByKind.call).toBe(analyzed.callBins.receiverNeedsInference + analyzed.callBins.nameNotBound);
		expect(index.unresolvedByKind.dynamic).toBe(analyzed.dynamic.length);
		expect(Object.keys(index.unresolvedByKind).sort()).toEqual(["call", "dynamic", "extends", "implements", "import"]);

		const ts = tsRepo();
		const tsIndex = buildIndex(ts.root, selectLanguage(ts.root, undefined).files);
		for (const field of ["callBins", "unresolvedFirstPartyImports", "constructorNotes"]) {
			expect(Object.hasOwn(tsIndex, field)).toBe(false);
		}
	});

	test("rule 15: unresolvedFirstPartyImports and constructorNotes are non-zero when S3/S5 report them", async () => {
		const missingSubmodule = pythonRepo({ "pkg/use2.py": "from .missing import thing\n" });
		const first = await indexWith(
			"python",
			missingSubmodule.root,
			selectLanguage(missingSubmodule.root, undefined).files,
		);
		expect(first.unresolvedFirstPartyImports).toBeGreaterThan(0);

		const notes = makeScratchRepo({
			"pkg/__init__.py": "",
			"pkg/a.py": "class B:\n    def __new__(cls):\n        return super().__new__(cls)\ndef f():\n    B()\n",
		});
		notes.commit("notes");
		const second = await indexWith("python", notes.root, selectLanguage(notes.root, undefined).files);
		expect(second.constructorNotes).toBeGreaterThan(0);
	});
});

// --- rule 16 --------------------------------------------------------------

describe("rule 16 — envelopes", () => {
	test("rule 16: callers, impact and the stream result line carry the Python counts only when the index has them", () => {
		const repo = makeScratchRepo({
			"pkg/__init__.py": "",
			"pkg/a.py": "class B:\n    def __new__(cls):\n        return super().__new__(cls)\ndef f():\n    B()\n    f()\n",
		});
		repo.commit("counts");
		const callers = jsonOf(runCli(repo.root, ["--json", "callers", "f"])).data;
		// Rule 15 tests the values against the analyzer; here the envelope must
		// carry them and the stream/batch forms must not drift.
		expect(Object.keys(callers.callBins as object).sort()).toEqual([
			"nameNotBound",
			"receiverNeedsInference",
			"resolvedExternal",
			"resolvedInRepo",
		]);
		expect((callers.callBins as { resolvedInRepo: number }).resolvedInRepo).toBeGreaterThan(0);
		expect(callers.unresolvedFirstPartyImports).toBe(0);
		expect(callers.constructorNotes).toBe(1);

		const impact = jsonOf(runCli(repo.root, ["--json", "impact", "f"])).data;
		expect(impact.callBins).toEqual(callers.callBins);
		expect(impact.constructorNotes).toBe(1);

		const streamed = streamEnvelopes(runCli(repo.root, ["impact", "f", "--stream"]).stdout);
		const result = streamed.find((line) => line.kind === "impact.result")?.data;
		expect(result?.callBins).toEqual(callers.callBins);
		expect(result?.unresolvedFirstPartyImports).toBe(0);
		expect(result?.constructorNotes).toBe(1);

		const human = runCli(repo.root, ["impact", "f"]).stdout;
		expect(human).toContain("python coverage: call bins resolved in repo ");
	});
});

// --- rule 17 --------------------------------------------------------------

const FORBIDDEN_KEYS = [
	"multiplyBound",
	"polymorphic",
	"externalBaseBefore",
	"decorated",
	"decorators",
	"collapsedOverloadStubs",
];

function collectKeys(value: unknown, keys: Set<string>): void {
	if (Array.isArray(value)) {
		for (const entry of value) collectKeys(entry, keys);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, entry] of Object.entries(value)) {
		keys.add(key);
		collectKeys(entry, keys);
	}
}

/** A batch answer is one pretty-printed envelope; a streamed answer is NDJSON. */
function envelopeValues(output: string): unknown[] {
	try {
		return [JSON.parse(output)];
	} catch {
		return output
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	}
}

describe("rule 17 — flags stay internal", () => {
	test("rule 17: the cached index keeps the S5 flags and no envelope leaks them", () => {
		const repo = makeScratchRepo({
			"pkg/__init__.py": "",
			"pkg/one.py": "def fallback():\n    pass\n",
			"pkg/two.py": "def fallback():\n    pass\n",
			"pkg/core.py": "def d(x):\n    return x\n@d\ndef decorated():\n    pass\n",
			"pkg/use.py":
				"from .core import decorated\ntry:\n    from .one import fallback\nexcept ImportError:\n    from .two import fallback\ndef f():\n    fallback()\n    decorated()\n",
		});
		repo.commit("flags");
		const cache = mkdtempSync(join(tmpdir(), "glyph-py-flags-cache-"));

		const callers = runCli(repo.root, ["--json", "callers", "fallback", "--file", "pkg/one.py"], cache);
		expect(callers.code).toBe(0);
		const impact = runCli(repo.root, ["--json", "impact", "decorated"], cache);
		const diff = runCli(repo.root, ["--json", "diff", "HEAD", "HEAD"], cache);
		const stream = runCli(repo.root, ["impact", "decorated", "--stream"], cache);
		expect([impact.code, diff.code, stream.code]).toEqual([0, 0, 0]);

		// Non-vacuous positive control: the flags really are in the cached index.
		const cacheDirs = readdirSync(cache).map((name) => join(cache, name));
		expect(cacheDirs.length).toBeGreaterThan(0);
		const cacheRepoDir = cacheDirs[0] as string;
		const cacheFiles = readdirSync(cacheRepoDir).filter((name) => name.endsWith(".json"));
		expect(cacheFiles.length).toBeGreaterThan(0);
		const cached = cacheFiles
			.map((name) => JSON.parse(readFileSync(join(cacheRepoDir, name), "utf8")) as GlyphIndex)
			.find((index) => index.repo.length > 0);
		expect(cached).toBeDefined();
		const cachedSites = JSON.stringify(cached?.sites);
		expect(cachedSites).toContain("multiplyBound");
		expect(cachedSites).toContain("decorated");
		const cachedSymbols = JSON.stringify(cached?.symbols);
		expect(cachedSymbols).toContain("decorators");

		const keys = new Set<string>();
		for (const output of [callers.stdout, impact.stdout, diff.stdout, stream.stdout]) {
			for (const value of envelopeValues(output)) collectKeys(value, keys);
		}
		for (const forbidden of FORBIDDEN_KEYS) expect(keys.has(forbidden)).toBe(false);
	});
});

// --- rule 18 --------------------------------------------------------------

describe("rule 18 — declaration", () => {
	// The contract declaration is the ADR 0002 amendment and the README, checked
	// by `lore check`; `help --json` needs no new field because these are output
	// fields, not flags. This test pins the manifest's silence on them.
	test("rule 18: help --json declares no output field, and the language flag names the live registry", () => {
		const repo = tsRepo();
		const result = runCli(repo.root, ["help", "--json"]);
		expect(result.code).toBe(0);
		const manifest = jsonOf(result) as unknown as {
			data: { globalFlags: { name: string; summary: string }[]; commands: { flags: { name: string }[] }[] };
		};
		const language = manifest.data.globalFlags.find((flag) => flag.name === "language");
		expect(language?.summary).toContain("registered: python, typescript");
		const flagNames = manifest.data.commands.flatMap((command) => command.flags.map((flag) => flag.name));
		for (const outputField of ["callBins", "unresolvedFirstPartyImports", "constructorNotes"]) {
			expect(flagNames).not.toContain(outputField);
		}
	});
});
