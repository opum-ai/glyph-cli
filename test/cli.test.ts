import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allResultKinds, globalKindOf, kindOf } from "../src/contract.ts";
import { gitRun, repoRootFor } from "../src/git.ts";
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

	test("diff reports symbols in a non-ASCII-named file", () => {
		// The header carries the C-quoted path, so this answers empty until
		// parseDiff decodes it back to the name the index holds.
		const repo = makeScratchRepo({ "src/café.ts": "export function a(): number {\n  return 1;\n}\n" });
		const cache = scratchCacheDir();
		const base = repo.commit("base");
		repo.write("src/café.ts", "export function a(): number {\n  return 2;\n}\n");
		repo.commit("tweak a non-ASCII-named file");

		const diff = runCli(repo.root, ["--json", "diff", base, "HEAD"], cache);
		expect(diff.code).toBe(0);
		const envelope = JSON.parse(diff.stdout) as {
			kind: string;
			data: { symbols: { name: string }[]; filesChanged: number };
		};
		expect(envelope.kind).toBe("diff.result");
		expect(envelope.data.symbols.map((symbol) => symbol.name)).toEqual(["a"]);
		expect(envelope.data.filesChanged).toBe(1);
	});

	test("--repo and --json agree between the pre-scan and commander on both paths", () => {
		// commander takes the token after --repo as its value even when the token
		// starts with '-', so this invocation names a directory literally called
		// `--json` and is NOT a JSON invocation. The pre-scan used to read --json
		// as the flag and wrap only the failure, so success spoke text and failure
		// spoke an envelope; one scanner makes both paths agree.
		const repo = makeScratchRepo({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
		repo.commit("base");
		const dashy = join(repo.root, "--json");
		mkdirSync(dashy, { recursive: true });
		writeFileSync(join(dashy, "a.ts"), "export function a(): number {\n  return 1;\n}\n");
		gitRun(dashy, ["init", "-q"]);
		gitRun(dashy, ["config", "user.email", "test@opum.test"]);
		gitRun(dashy, ["config", "user.name", "glyph test"]);
		gitRun(dashy, ["add", "-A"]);
		gitRun(dashy, ["commit", "-qm", "base"]);
		const cache = scratchCacheDir();

		// `--repo --json`: text on the success path...
		const ok = runCli(repo.root, ["--repo", "--json", "callers", "a"], cache);
		expect(ok.code).toBe(0);
		expect(ok.stdout.startsWith("callers of a")).toBe(true);
		expect(() => JSON.parse(ok.stdout)).toThrow();

		// ...and text on the failure path, not an envelope.
		const missing = runCli(repo.root, ["--repo", "--json", "callers", "nope"], cache);
		expect(missing.code).toBe(3);
		expect(missing.stdout).toBe("");
		expect(missing.stderr.startsWith("glyph: ")).toBe(true);
		expect(() => JSON.parse(missing.stderr)).toThrow();

		// `--repo=<dir>` is the documented form: an envelope on both paths.
		const equalsOk = runCli(repo.root, [`--repo=${dashy}`, "--json", "callers", "a"], cache);
		expect(equalsOk.code).toBe(0);
		expect((JSON.parse(equalsOk.stdout) as { kind: string }).kind).toBe("callers.result");

		const equalsMissing = runCli(repo.root, [`--repo=${dashy}`, "--json", "callers", "nope"], cache);
		expect(equalsMissing.code).toBe(3);
		expect(equalsMissing.stdout).toBe("");
		expect((JSON.parse(equalsMissing.stderr) as { error_type: string }).error_type).toBe("not_found");
	});

	test("a program-level --repo after a subcommand option still selects the repository", () => {
		// `--ref` is an impact option; commander consumes nothing for it at program
		// level, so the --repo that follows it still names the repository. A
		// scanner that skips --ref's next token analyzes the cwd instead: a wrong
		// repository and a success-path regression.
		const repo = makeScratchRepo({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
		repo.commit("base");
		const cache = scratchCacheDir();
		const elsewhere = mkdtempSync(join(tmpdir(), "glyph-elsewhere-"));
		const result = runCli(elsewhere, ["impact", "a", "--ref", "--repo", repo.root, "HEAD"], cache);
		expect(result.code).toBe(0);
		expect(result.stdout.startsWith("impact of a")).toBe(true);
	});

	test("a --json after a callers option is still a program flag", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
		repo.commit("base");
		const cache = scratchCacheDir();
		const result = runCli(repo.root, ["callers", "--file", "--json", "src", "a"], cache);
		expect(result.code).toBe(0);
		expect((JSON.parse(result.stdout) as { kind: string }).kind).toBe("callers.result");
	});

	test("--json with a -v after a subcommand option answers a version envelope", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
		repo.commit("base");
		const cache = scratchCacheDir();
		const result = runCli(repo.root, ["--json", "impact", "a", "--depth", "-v"], cache);
		expect(result.code).toBe(0);
		expect((JSON.parse(result.stdout) as { kind: string }).kind).toBe("version.info");
	});

	test("options stop at --, so a token after it is an operand rather than a flag", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
		repo.commit("base");
		const cache = scratchCacheDir();

		// `--json` is the symbol name commander sees, not the program flag.
		const asOperand = runCli(repo.root, ["callers", "--", "--json"], cache);
		expect(asOperand.code).toBe(3);
		expect(asOperand.stderr.startsWith("glyph: ")).toBe(true);

		// `-v` is the symbol name too, and --json still wraps the not-found.
		const versionAsOperand = runCli(repo.root, ["--json", "callers", "--", "-v"], cache);
		expect(versionAsOperand.code).toBe(3);
		expect(versionAsOperand.stdout).toBe("");
		expect((JSON.parse(versionAsOperand.stderr) as { error_type: string }).error_type).toBe("not_found");
	});

	test("only a cluster led by v is a version; every other cluster is unknown", () => {
		// commander registers -v but not -h as a program option, and splits a
		// cluster only while its LEADING short is known. So -vx is the version,
		// while -hv and -hh are unknown options (a usage error, exit 2).
		const repo = makeScratchRepo({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
		repo.commit("base");
		const cache = scratchCacheDir();

		const versionLed = runCli(repo.root, ["-vx", "--json"], cache);
		expect(versionLed.code).toBe(0);
		expect((JSON.parse(versionLed.stdout) as { kind: string }).kind).toBe("version.info");

		for (const cluster of ["-hv", "-hh"]) {
			const unknown = runCli(repo.root, [cluster, "--json"], cache);
			expect(unknown.code).toBe(2);
			expect(unknown.stdout).toBe("");
			expect((JSON.parse(unknown.stderr) as { error_type: string }).error_type).toBe("usage");
		}
	});

	test("combined short flags such as -vh take the version under --json", () => {
		const repo = makeScratchRepo({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
		repo.commit("base");
		const cache = scratchCacheDir();
		const result = runCli(repo.root, ["-vh", "--json"], cache);
		expect(result.code).toBe(0);
		expect((JSON.parse(result.stdout) as { kind: string }).kind).toBe("version.info");
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
			total: number;
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
		// The index holds exactly the three cross-file calls of this fixture; the
		// values are asserted, not merely their presence.
		expect(envelope.data.resolvedSites).toBe(3);
		expect(envelope.data.unresolvedSites).toBe(0);
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
		expect(text.stdout).toContain("coverage (index-wide):");
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

	test("the default depth of 5 and --all are proven on a chain deeper than the default", () => {
		const files: Record<string, string> = {};
		for (let hop = 1; hop <= 8; hop += 1) {
			const importLine = hop === 8 ? "" : `import { f${hop + 1} } from "./f${hop + 1}";\n`;
			const body = hop === 8 ? "  return 0;\n" : `  return f${hop + 1}();\n`;
			files[`src/f${hop}.ts`] = `${importLine}export function f${hop}(): number {\n${body}}\n`;
		}
		const repo = makeScratchRepo(files);
		const cache = scratchCacheDir();

		const dflt = runCli(repo.root, ["--json", "impact", "f8"], cache);
		const defaultEnvelope = JSON.parse(dflt.stdout) as ImpactEnvelope;
		expect(defaultEnvelope.data.depth).toEqual({ bound: 5, all: false });
		expect(defaultEnvelope.data.callers).toHaveLength(5);
		expect(defaultEnvelope.data.truncated).toBe(true);
		expect(defaultEnvelope.data.unexplored).toBe(2);
		expect(defaultEnvelope.data.total).toBe(7);

		const all = runCli(repo.root, ["--json", "impact", "f8", "--all"], cache);
		const allEnvelope = JSON.parse(all.stdout) as ImpactEnvelope;
		expect(allEnvelope.data.callers).toHaveLength(7);
		expect(allEnvelope.data.truncated).toBe(false);
		expect(allEnvelope.data.unexplored).toBe(0);
	});

	test("the cycle line is true for a recursive target and for a caller-only cycle", () => {
		const cache = scratchCacheDir();
		const recursive = makeScratchRepo({
			"src/d.ts": "export function d(n: number): number {\n  return n <= 0 ? 0 : d(n - 1);\n}\n",
		});
		const selfText = runCli(recursive.root, ["impact", "d"], cache);
		expect(selfText.code).toBe(0);
		expect(selfText.stdout).toContain("  (none)");
		expect(selfText.stdout).toContain(
			"at least one symbol in this closure (this symbol included) sits on a call cycle",
		);
		expect(selfText.stdout).not.toContain("reach itself through this symbol");

		const callerCycle = makeScratchRepo({
			"src/d.ts": "export function d(): number {\n  return 1;\n}\n",
			"src/a.ts": 'import { b } from "./b";\nexport function a(): number {\n  return b();\n}\n',
			"src/b.ts":
				'import { d } from "./d";\nimport { a } from "./a";\nexport function b(): number {\n  return d() + a();\n}\n',
		});
		const cycleText = runCli(callerCycle.root, ["impact", "d"], cache);
		expect(cycleText.code).toBe(0);
		expect(cycleText.stdout).toContain(
			"at least one symbol in this closure (this symbol included) sits on a call cycle",
		);
		expect(cycleText.stdout).not.toContain("reach itself through this symbol");
		expect(cycleText.stdout).toContain("coverage (index-wide):");
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
		// impact has no --file flag, so the remedy must not name a flag it lacks.
		expect(error.message).not.toContain("--file");
		expect(error.message).toContain("must be unique");
	});

	test("--ref never resolves through an in-repo node_modules the commit does not contain", () => {
		const repo = makeScratchRepo({
			"src/helper.ts": "export function helper(): number {\n  return 1;\n}\n",
			"src/app.ts": 'import { helper } from "pkg";\nexport function app(): number {\n  return helper();\n}\n',
		});
		repo.commit("base");
		// A dirty in-repo node_modules whose package redirects a bare specifier
		// into the committed sources. Reading it would resolve the call to
		// helper; the ruling says the ref answer must not.
		repo.write(
			"node_modules/pkg/package.json",
			JSON.stringify({ name: "pkg", version: "1.0.0", types: "../../src/helper.ts" }),
		);
		const cache = scratchCacheDir();

		const ref = runCli(repo.root, ["--json", "impact", "app", "--ref", "HEAD"], cache);
		expect(ref.code).toBe(0);
		const refEnvelope = JSON.parse(ref.stdout) as ImpactEnvelope;
		expect(refEnvelope.data.resolvedSites).toBe(0);
		expect(refEnvelope.data.unresolvedSites).toBe(1);

		// The same dirty tree does change the working-tree answer, which is why the
		// ref answer must not read it.
		const working = runCli(repo.root, ["--json", "impact", "app"], scratchCacheDir());
		const workingEnvelope = JSON.parse(working.stdout) as ImpactEnvelope;
		expect(workingEnvelope.data.resolvedSites).toBe(1);
		expect(workingEnvelope.data.unresolvedSites).toBe(0);
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

		// A second run against the same commit is served from the commit-addressed
		// cache, after only the tree listing that computes the key.
		const repeat = runCli(repo.root, ["--json", "impact", "d", "--ref", "HEAD"], cache);
		const repeatEnvelope = JSON.parse(repeat.stdout) as ImpactEnvelope;
		expect(repeatEnvelope.data.index.cache).toBe("hit");
		expect(JSON.stringify(withoutCache(repeatEnvelope))).toBe(JSON.stringify(withoutCache(cleanEnvelope)));

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
		// The root description names all three questions, impact included.
		// Commander wraps at 80 columns, so compare on normalized whitespace.
		expect((JSON.parse(topHelp.stdout).data.usage as string).replace(/\s+/g, " ")).toContain(
			"what its change can reach",
		);

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
