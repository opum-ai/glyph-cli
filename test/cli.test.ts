import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allResultKinds, globalKindOf, kindOf } from "../src/contract.ts";
import { repoRootFor } from "../src/git.ts";
import { makeScratchRepo, scratchCacheDir } from "./helpers.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[], cacheDir: string): CliResult {
	const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
		cwd,
		env: { ...process.env, GLYPH_CACHE_DIR: cacheDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const FILES = {
	"src/util.ts": "export function helper(n: number): number {\n  return n + 1;\n}\n",
	"src/main.ts": 'import { helper } from "./util";\nexport function main(): number {\n  return helper(1);\n}\n',
};

describe("cli", () => {
	test("callers emits a JSON envelope on stdout, then serves the same query from cache", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();

		const first = runCli(repo.root, ["--json", "callers", "helper"], cache);
		expect(first.code).toBe(0);
		const envelope = JSON.parse(first.stdout) as {
			schemaVersion: number;
			kind: string;
			data: { symbol: { name: string }; totals: { callers: number }; index: { cache: string } };
			principal: null;
		};
		expect(Object.keys(envelope)).toEqual(["schemaVersion", "kind", "data", "principal"]);
		expect(envelope.schemaVersion).toBe(1);
		expect(envelope.kind).toBe("callers.result");
		expect(envelope.principal).toBeNull();
		expect(envelope.data.symbol.name).toBe("helper");
		expect(envelope.data.totals.callers).toBe(1);
		expect(envelope.data.index.cache).toBe("miss");

		const second = runCli(repo.root, ["--json", "callers", "helper"], cache);
		const secondEnvelope = JSON.parse(second.stdout) as { data: { index: { cache: string } } };
		expect(secondEnvelope.data.index.cache).toBe("hit");
	});

	test("help --json publishes the live manifest, and every JSON result carries principal last", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();

		const result = runCli(repo.root, ["help", "--json"], cache);
		expect(result.code).toBe(0);
		const envelope = JSON.parse(result.stdout) as {
			kind: string;
			data: { exitCodes: Record<string, number>; commands: { name: string; kind: string }[] };
			principal: null;
		};
		expect(Object.keys(envelope)).toEqual(["schemaVersion", "kind", "data", "principal"]);
		expect(envelope.kind).toBe("help.manifest");
		expect(envelope.principal).toBeNull();
		expect(envelope.data.exitCodes).toEqual({
			ok: 0,
			uncaught: 1,
			usage: 2,
			not_found: 3,
			denied: 4,
			conflict: 5,
			validation: 6,
			drift: 6,
			indeterminate: 7,
		});
		expect(envelope.data.commands.map((command) => command.name).sort()).toEqual([
			"cache clear",
			"cache path",
			"callers",
			"diff",
			"help",
			"impact",
		]);

		const cachePath = runCli(repo.root, ["--json", "cache", "path"], cache);
		expect(Object.keys(JSON.parse(cachePath.stdout))).toEqual(["schemaVersion", "kind", "data", "principal"]);
	});

	test("failures keep stdout empty and exit with the code the contract names", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();

		const missing = runCli(repo.root, ["callers", "nope"], cache);
		expect(missing.code).toBe(3);
		expect(missing.stdout).toBe("");
		expect(missing.stderr).toContain("no symbol named 'nope'");

		const missingJson = runCli(repo.root, ["--json", "callers", "nope"], cache);
		expect(missingJson.code).toBe(3);
		expect(missingJson.stdout).toBe("");
		const error = JSON.parse(missingJson.stderr) as { error_type: string; message: string; principal: null };
		expect(Object.keys(error)).toEqual(["error_type", "message", "principal"]);
		expect(error.error_type).toBe("not_found");
		expect(error.principal).toBeNull();

		const unknown = runCli(repo.root, ["frobnicate"], cache);
		expect(unknown.code).toBe(2);
	});

	test("diff answers over real history, and cache clear reports what it removed", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();
		const base = repo.commit("base");
		repo.write(
			"src/main.ts",
			'import { helper } from "./util";\nexport function main(): number {\n  const total = helper(1);\n  return total;\n}\n',
		);
		repo.commit("tweak main");

		const diff = runCli(repo.root, ["--json", "diff", base, "HEAD"], cache);
		expect(diff.code).toBe(0);
		const envelope = JSON.parse(diff.stdout) as {
			kind: string;
			data: { symbols: { name: string }[]; filesChanged: number };
		};
		expect(envelope.kind).toBe("diff.result");
		expect(envelope.data.symbols.map((symbol) => symbol.name)).toEqual(["main"]);
		expect(envelope.data.filesChanged).toBe(1);

		const cleared = runCli(repo.root, ["cache", "clear"], cache);
		expect(cleared.code).toBe(0);
		expect(cleared.stdout).toContain("cleared");
	});

	const IMPACT_FILES = {
		"src/d.ts": "export function d(): number {\n  return 1;\n}\n",
		"src/c.ts": 'import { d } from "./d";\nexport function c(): number {\n  return d();\n}\n',
		"src/b.ts": 'import { c } from "./c";\nexport function b(): number {\n  return c();\n}\n',
		"src/a.ts": 'import { b } from "./b";\nexport function a(): number {\n  return b();\n}\n',
	};

	interface ImpactEnvelope {
		kind: string;
		data: {
			symbol: { name: string };
			ref: { ref: string; sha: string } | null;
			depth: { bound: number | null; all: boolean };
			callers: { symbol: { name: string } | null; depth: number; path: { file: string; line: number }[] }[];
			cycle: boolean;
			truncated: boolean;
			unexplored: number;
			resolvedSites: number;
			unresolvedSites: number;
			index: { cache: string };
		};
	}

	function triples(envelope: ImpactEnvelope): Array<[string | null, number]> {
		return envelope.data.callers.map((caller) => [caller.symbol?.name ?? null, caller.depth]);
	}

	/** The `cache` field is the one documented difference between two runs. */
	function withoutCache(envelope: ImpactEnvelope): ImpactEnvelope {
		const copy = structuredClone(envelope);
		copy.data.index.cache = "same";
		return copy;
	}

	test("impact answers the transitive closure in text and JSON, deterministically and from cache", () => {
		const repo = makeScratchRepo(IMPACT_FILES);
		const cache = scratchCacheDir();

		const first = runCli(repo.root, ["--json", "impact", "d"], cache);
		expect(first.code).toBe(0);
		expect(first.stderr).toBe("");
		const envelope = JSON.parse(first.stdout) as ImpactEnvelope;
		expect(envelope.kind).toBe("impact.result");
		expect(envelope.data.symbol.name).toBe("d");
		expect(envelope.data.ref).toBeNull();
		expect(envelope.data.depth).toEqual({ bound: 5, all: false });
		expect(triples(envelope)).toEqual([
			["c", 1],
			["b", 2],
			["a", 3],
		]);
		expect(envelope.data.callers[2]?.path.map((edge) => edge.file)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
		expect(envelope.data.truncated).toBe(false);
		expect(envelope.data.cycle).toBe(false);
		expect(envelope.data.resolvedSites).toBeGreaterThan(0);
		expect(typeof envelope.data.unresolvedSites).toBe("number");
		expect(envelope.data.index.cache).toBe("miss");

		// Same state twice: the second run is a cache hit and the answer is
		// byte-identical once the documented cache field is set aside.
		const second = runCli(repo.root, ["--json", "impact", "d"], cache);
		const hit = JSON.parse(second.stdout) as ImpactEnvelope;
		expect(hit.data.index.cache).toBe("hit");
		expect(JSON.stringify(withoutCache(hit))).toBe(JSON.stringify(withoutCache(envelope)));

		// A different cache directory produces the same bytes too.
		const cold = runCli(repo.root, ["--json", "impact", "d"], scratchCacheDir());
		const coldEnvelope = JSON.parse(cold.stdout) as ImpactEnvelope;
		expect(coldEnvelope.data.index.cache).toBe("miss");
		expect(JSON.stringify(withoutCache(coldEnvelope))).toBe(JSON.stringify(withoutCache(envelope)));

		const text = runCli(repo.root, ["impact", "d"], cache);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("impact of d (function)");
		expect(text.stdout).toContain("depth 1  c");
		expect(text.stdout).toContain("a -> b -> c -> d");
		expect(text.stdout).toContain("unresolved:");
	});

	test("--depth bounds the answer, --all lifts the bound, and the truncation count is exact", () => {
		const repo = makeScratchRepo(IMPACT_FILES);
		const cache = scratchCacheDir();

		const bounded = runCli(repo.root, ["--json", "impact", "d", "--depth", "1"], cache);
		expect(bounded.code).toBe(0);
		const one = JSON.parse(bounded.stdout) as ImpactEnvelope;
		expect(triples(one)).toEqual([["c", 1]]);
		expect(one.data.truncated).toBe(true);
		expect(one.data.unexplored).toBe(2);

		const unbounded = runCli(repo.root, ["--json", "impact", "d", "--all"], cache);
		const all = JSON.parse(unbounded.stdout) as ImpactEnvelope;
		expect(triples(all)).toHaveLength(3);
		expect(all.data.truncated).toBe(false);
		expect(all.data.unexplored).toBe(0);
		expect(all.data.depth).toEqual({ bound: null, all: true });
	});

	test("impact refuses a bad depth, an ambiguous name, an unknown symbol and an unknown ref", () => {
		const repo = makeScratchRepo(IMPACT_FILES);
		repo.commit("base");
		const cache = scratchCacheDir();

		for (const args of [
			["--json", "impact", "d", "--depth", "0"],
			["--json", "impact", "d", "--depth", "abc"],
			["--json", "impact", "d", "--depth", "2", "--all"],
		]) {
			const result = runCli(repo.root, args, cache);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(JSON.parse(result.stderr).error_type).toBe("usage");
		}

		const missing = runCli(repo.root, ["--json", "impact", "nope"], cache);
		expect(missing.code).toBe(3);
		expect(JSON.parse(missing.stderr).error_type).toBe("not_found");

		const unknownRef = runCli(repo.root, ["--json", "impact", "d", "--ref", "no-such-ref"], cache);
		expect(unknownRef.code).toBe(3);
		expect(JSON.parse(unknownRef.stderr).error_type).toBe("not_found");

		const ambiguousRepo = makeScratchRepo({
			"src/one.ts": "export function twin(): void {}\n",
			"src/two.ts": "export function twin(): void {}\n",
		});
		const ambiguous = runCli(ambiguousRepo.root, ["--json", "impact", "twin"], scratchCacheDir());
		expect(ambiguous.code).toBe(2);
		expect(ambiguous.stdout).toBe("");
		const error = JSON.parse(ambiguous.stderr) as { error_type: string; message: string };
		expect(error.error_type).toBe("usage");
		expect(error.message).toContain("matches 2 symbols");
		expect(error.message).toContain("src/one.ts");
	});

	test("--ref answers from the commit's tree, so a dirty checkout cannot change it", () => {
		const repo = makeScratchRepo(IMPACT_FILES);
		repo.commit("base");
		const cache = scratchCacheDir();

		const clean = runCli(repo.root, ["--json", "impact", "d", "--ref", "HEAD"], cache);
		expect(clean.code).toBe(0);
		const cleanEnvelope = JSON.parse(clean.stdout) as ImpactEnvelope;
		expect(cleanEnvelope.data.ref?.ref).toBe("HEAD");
		expect(cleanEnvelope.data.ref?.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(triples(cleanEnvelope)).toEqual([
			["c", 1],
			["b", 2],
			["a", 3],
		]);

		repo.write(
			"src/a.ts",
			'import { b } from "./b";\nimport { d } from "./d";\nexport function a(): number {\n  return b() + d();\n}\n',
		);

		const dirtyRef = runCli(repo.root, ["--json", "impact", "d", "--ref", "HEAD"], scratchCacheDir());
		const dirtyEnvelope = JSON.parse(dirtyRef.stdout) as ImpactEnvelope;
		expect(JSON.stringify(withoutCache(dirtyEnvelope))).toBe(JSON.stringify(withoutCache(cleanEnvelope)));

		const working = runCli(repo.root, ["--json", "impact", "d"], scratchCacheDir());
		const workingEnvelope = JSON.parse(working.stdout) as ImpactEnvelope;
		expect(triples(workingEnvelope)).toEqual([
			["a", 1],
			["c", 1],
			["b", 2],
		]);
	});

	test("--repo points at another directory", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();
		const result = runCli("/tmp", ["--repo", repo.root, "callers", "helper"], cache);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("callers of helper");
	});

	test("every successful --json invocation emits its registry kind, never plain text", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();
		const base = repo.commit("base");
		repo.write(
			"src/main.ts",
			'import { helper } from "./util";\nexport function main(): number {\n  return helper(1) + 1;\n}\n',
		);
		repo.commit("tweak");

		const cases: Array<{ args: string[]; kind: string }> = [
			{ args: ["--json", "callers", "helper"], kind: kindOf("callers") },
			{ args: ["--json", "impact", "helper"], kind: kindOf("impact") },
			{ args: ["--json", "diff", base, "HEAD"], kind: kindOf("diff") },
			{ args: ["--json", "cache", "path"], kind: kindOf("cache path") },
			{ args: ["--json", "cache", "clear"], kind: kindOf("cache clear") },
			{ args: ["--json", "help"], kind: kindOf("help") },
			{ args: ["--json", "help", "callers"], kind: kindOf("help") },
			{ args: ["--json", "callers", "--help"], kind: kindOf("help") },
			{ args: ["--json", "--version"], kind: globalKindOf("version") },
			{ args: ["--json", "-v"], kind: globalKindOf("version") },
			{ args: ["--json", "--help"], kind: globalKindOf("help") },
			{ args: ["--json"], kind: globalKindOf("help") },
		];

		for (const { args, kind } of cases) {
			const result = runCli(repo.root, args, cache);
			expect(result.code).toBe(0);
			const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(Object.keys(envelope)).toEqual(["schemaVersion", "kind", "data", "principal"]);
			expect(envelope.kind).toBe(kind);
			expect(envelope.principal).toBeNull();
		}

		// Every kind the registry can emit is exercised by this table, so a new
		// result kind cannot be added without an end-to-end case.
		expect(new Set(cases.map((entry) => entry.kind))).toEqual(new Set(allResultKinds()));
	}, 20_000);

	test("-v is the shorthand and -V is not a version flag", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();

		const shorthand = runCli(repo.root, ["-v"], cache);
		expect(shorthand.code).toBe(0);
		expect(shorthand.stdout.trim()).toBe("0.0.0");

		const upper = runCli(repo.root, ["-V"], cache);
		expect(upper.code).toBe(2);
		expect(upper.stdout).toBe("");
		expect(upper.stderr).toContain("unknown option");

		const upperJson = runCli(repo.root, ["--json", "-V"], cache);
		expect(upperJson.code).toBe(2);
		expect(upperJson.stdout).toBe("");
		expect(JSON.parse(upperJson.stderr).error_type).toBe("usage");
	});

	test("an unknown command with --help is a usage error, not text help", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();
		const result = runCli(repo.root, ["--json", "frobnicate", "--help"], cache);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr).error_type).toBe("usage");
	});

	test("help and version answer envelopes under --json and text otherwise", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();

		const version = runCli(repo.root, ["--json", "--version"], cache);
		expect(JSON.parse(version.stdout).data.version).toBe("0.0.0");

		const topHelp = runCli(repo.root, ["--json", "--help"], cache);
		expect(JSON.parse(topHelp.stdout).data.usage).toContain("Usage: glyph");

		const commandHelp = runCli(repo.root, ["--json", "callers", "--help"], cache);
		expect(JSON.parse(commandHelp.stdout).data.commands.map((command: { name: string }) => command.name)).toEqual([
			"callers",
		]);

		const bare = runCli(repo.root, [], cache);
		expect(bare.code).toBe(0);
		expect(bare.stdout).toContain("Usage: glyph");
		expect(bare.stderr).toBe("");

		const bareJson = runCli(repo.root, ["--json"], cache);
		expect(bareJson.code).toBe(0);
		expect(JSON.parse(bareJson.stdout).kind).toBe(globalKindOf("help"));
	});

	test("a --json commander usage error writes the error envelope and exits 2", () => {
		const repo = makeScratchRepo(FILES);
		const cache = scratchCacheDir();
		const result = runCli(repo.root, ["--json", "frobnicate"], cache);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		const error = JSON.parse(result.stderr) as { error_type: string; principal: null };
		expect(error.error_type).toBe("usage");
		expect(error.principal).toBeNull();
	});

	test("an uncaught failure writes the uncaught envelope and exits 1", () => {
		const repo = makeScratchRepo(FILES);
		repo.commit("base");
		const cacheRoot = mkdtempSync(join(tmpdir(), "glyph-cache-file-"));
		// A regular file where the cache directory must go: the index write
		// throws, and a bug is `uncaught`/1 rather than a classified failure.
		// The CLI keys the cache on git's own top-level path, which on macOS may
		// resolve /var to /private/var; hash the path it will actually use.
		const hash = createHash("sha1")
			.update(repoRootFor(repo.root) ?? repo.root)
			.digest("hex")
			.slice(0, 12);
		writeFileSync(join(cacheRoot, hash), "not a directory");

		const result = runCli(repo.root, ["--json", "callers", "helper"], cacheRoot);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		const error = JSON.parse(result.stderr) as { error_type: string; message: string; principal: null };
		expect(Object.keys(error)).toEqual(["error_type", "message", "principal"]);
		expect(error.error_type).toBe("uncaught");
		expect(error.principal).toBeNull();
	});
});
