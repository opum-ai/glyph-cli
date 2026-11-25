import { afterEach, describe, expect, test } from "bun:test";
import { type Dirent, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
	ensureCheckout,
	type GateConfig,
	type GateResult,
	type RepositorySpec,
	runGate,
	type Spawn,
	type SpawnResult,
} from "./run_gate.ts";

/**
 * S8 gate RUNNER proof (GCLI-83, DEC-303 (a17) 5).
 *
 * Every branch is driven by a small fixture world and an injected spawn: the
 * tests never run the real scorer, never touch the real click or requests
 * checkouts, and never run the gate. Condition 3a-3g each get a failing case
 * and the suite carries a clean positive control that reads a real index, prints
 * the record and then the scorer's output.
 */

/**
 * A throwaway fixture root. `makeWorld` registers it and `afterEach` removes it,
 * so no test can leave a process or a file behind.
 */
const worlds: string[] = [];

afterEach(() => {
	for (const dir of worlds.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NAMES = ["click", "requests"] as const;
type Name = (typeof NAMES)[number];

const PINS: Record<Name, string> = {
	click: "a".repeat(40),
	requests: "b".repeat(40),
};

interface World {
	base: string;
	glyphRepo: string;
	bundlePath: string;
	buildScript: string;
	scorerPath: string;
	checkouts: Record<Name, string>;
	caches: Record<Name, string>;
	pins: Record<Name, string>;
}

/** Three `.py` files in the scored package plus one outside it, per repository. */
function makeWorld(): World {
	const base = mkdtempSync(join(tmpdir(), "glyph-gate-world-"));
	worlds.push(base);

	const glyphRepo = join(base, "glyph");
	const bundlePath = join(glyphRepo, "dist", "glyph.js");
	mkdirSync(dirname(bundlePath), { recursive: true });
	writeFileSync(bundlePath, "// fixture bundle\n");
	const buildScript = join(glyphRepo, "scripts", "build.mjs");
	mkdirSync(dirname(buildScript), { recursive: true });
	writeFileSync(buildScript, "// fixture build\n");
	const scorerPath = join(base, "gate_score.py");
	writeFileSync(scorerPath, "# fixture scorer\n");

	const checkouts = {} as Record<Name, string>;
	const caches = {} as Record<Name, string>;
	for (const name of NAMES) {
		const checkout = join(base, "checkouts", name);
		for (const file of ["__init__.py", "core.py", "utils.py"]) {
			const path = join(checkout, "src", name, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "# fixture\n");
		}
		const docs = join(checkout, "docs", "conf.py");
		mkdirSync(dirname(docs), { recursive: true });
		writeFileSync(docs, "# fixture docs\n");
		writeFileSync(join(checkout, "README.md"), "fixture\n");
		checkouts[name] = checkout;
		const cache = join(base, "cache", name);
		mkdirSync(cache, { recursive: true });
		caches[name] = cache;
	}

	return { base, glyphRepo, bundlePath, buildScript, scorerPath, checkouts, caches, pins: PINS };
}

function makeSpec(world: World, name: Name): RepositorySpec {
	return {
		name,
		url: `https://example.test/${name}.git`,
		checkout: world.checkouts[name],
		pinnedCommit: world.pins[name],
		scoredPackage: `src/${name}`,
		symbol: "sample",
		file: `src/${name}/utils.py`,
	};
}

function makeConfig(world: World, names: readonly Name[] = ["click"]): GateConfig {
	return {
		glyphRepoRoot: world.glyphRepo,
		bundlePath: world.bundlePath,
		repositories: names.map((name) => makeSpec(world, name)),
		scorer: { command: "python3", scriptPath: world.scorerPath, flags: ["-I"] },
	};
}

function makeDeps(world: World, spawn: Spawn): { spawn: Spawn; createCacheDir: (repo: RepositorySpec) => string } {
	return { spawn, createCacheDir: (repo) => cacheFor(world, repo.name) };
}

/** The fixture cache directory for a repository name, looked up without a cast. */
function cacheFor(world: World, name: string): string {
	for (const known of NAMES) if (known === name) return world.caches[known];
	return "";
}

interface SpawnOverrides {
	build?: SpawnResult;
	glyph?: (context: { cache: string; cwd: string }) => SpawnResult;
	/** Replaces the default index written by a successful glyph run. */
	index?: unknown;
	/** Writes whatever files a test wants, for the "more than one file" case. */
	writeIndex?: (cache: string) => void;
	scorer?: (context: { repo: string; indexFile: string }) => SpawnResult;
	head?: (dir: string) => string | undefined;
	status?: (dir: string) => string | undefined;
	glyphRepoHead?: string;
	glyphRepoStatus?: string;
}

function ok(): SpawnResult {
	return { status: 0, stdout: "", stderr: "" };
}

/** A spawn that answers git, the build, glyph and the scorer from the fixture. */
function makeSpawn(world: World, overrides: SpawnOverrides = {}): Spawn {
	return (command, args, options = {}) => {
		const cwd = options.cwd ?? "";
		if (command === "git") return gitStub(world, overrides, args, cwd);
		if (command === "node") {
			const entry = args[0];
			if (entry === world.buildScript) return overrides.build ?? ok();
			if (entry === world.bundlePath) {
				const cache = options.env?.GLYPH_CACHE_DIR ?? "";
				if (overrides.glyph !== undefined) return overrides.glyph({ cache, cwd });
				if (overrides.writeIndex !== undefined) {
					overrides.writeIndex(cache);
					return ok();
				}
				writeIndexFile(cache, cwd, overrides.index);
				return ok();
			}
		}
		if (command === "python3") {
			const repo = args[args.length - 2] ?? "";
			const indexFile = args[args.length - 1] ?? "";
			if (overrides.scorer !== undefined) return overrides.scorer({ repo, indexFile });
			return { status: 0, stdout: `scorer-output:${repo}:PASS\n`, stderr: "" };
		}
		return { status: 127, stdout: "", stderr: `unexpected command ${command}` };
	};
}

function gitStub(world: World, overrides: SpawnOverrides, args: readonly string[], cwd: string): SpawnResult {
	let dir = cwd;
	let rest = [...args];
	if (args[0] === "-C" && args[1] !== undefined) {
		dir = args[1];
		rest = rest.slice(2);
	}
	const sub = rest[0];
	const tail = rest.slice(1);
	if (dir === world.glyphRepo) {
		if (sub === "rev-parse" && tail[0] === "HEAD") {
			return { status: 0, stdout: `${overrides.glyphRepoHead ?? "glyph-head-sha"}\n`, stderr: "" };
		}
		if (sub === "status") return { status: 0, stdout: overrides.glyphRepoStatus ?? "", stderr: "" };
		return ok();
	}
	if (sub === "rev-parse" && tail[0] === "HEAD") {
		const value = overrides.head?.(dir) ?? pinFor(world, dir);
		if (value === undefined) return { status: 128, stdout: "", stderr: "fatal: not a git repository" };
		return { status: 0, stdout: `${value}\n`, stderr: "" };
	}
	if (sub === "status") return { status: 0, stdout: overrides.status?.(dir) ?? "", stderr: "" };
	// ensureCheckout's fetch sequence; unit tests of it use their own spawn.
	return ok();
}

function pinFor(world: World, dir: string): string | undefined {
	for (const name of NAMES) {
		if (world.checkouts[name] === dir) return world.pins[name];
	}
	return undefined;
}

/** The default index a successful glyph run leaves behind, built from the checkout. */
function buildDefaultIndex(checkout: string): unknown {
	const files = pythonFilesUnder(checkout);
	const first = files[0] ?? "src/unknown.py";
	return {
		schemaVersion: 3,
		repo: checkout,
		createdAt: "2026-11-25T00:00:00.000Z",
		files,
		symbols: [
			{
				id: `${first}:1:1`,
				name: "sample",
				container: null,
				kind: "function",
				file: first,
				startLine: 1,
				line: 1,
				column: 1,
				endLine: 1,
				exported: true,
			},
		],
		sites: [{ calleeId: `${first}:1:1`, callerId: null, file: first, line: 1, column: 1, kind: "call" }],
		unresolvedSites: 0,
		unresolvedByKind: { call: 0, import: 0, extends: 0, implements: 0, dynamic: 0 },
	};
}

function writeIndexFile(cache: string, checkout: string, index: unknown): void {
	const dir = join(cache, "indexhash");
	mkdirSync(dir, { recursive: true });
	const value = index === undefined ? buildDefaultIndex(checkout) : index;
	writeFileSync(join(dir, "key.json"), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

function pythonFilesUnder(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) walk(absolute);
			else if (entry.isFile() && entry.name.endsWith(".py")) {
				found.push(sep === "\\" ? relative(root, absolute).split("\\").join("/") : relative(root, absolute));
			}
		}
	};
	walk(root);
	return found.sort();
}

function expectFailClosed(result: GateResult, stage: string): void {
	expect(result.ok).toBe(false);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain(`gate: fail-closed ${stage}:`);
	expect(result.stdout).not.toContain("scorer-output");
}

describe("positive control", () => {
	test("a clean two-repository run prints the record before each scorer output and exits 0", () => {
		const world = makeWorld();
		const result = runGate(makeConfig(world, ["click", "requests"]), makeDeps(world, makeSpawn(world)));

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("gate record (printed before any score)");
		expect(result.stdout).toContain("glyph commit: glyph-head-sha (tree clean)");
		expect(result.stdout).toMatch(/glyph bundle sha256: [0-9a-f]{64}/);
		expect(result.stdout).toContain(`click: commit ${world.pins.click}`);
		expect(result.stdout).toContain("index files 4, sites 1; src/click python files 3");
		expect(result.stdout).toContain(`requests: commit ${world.pins.requests}`);

		const recordAt = result.stdout.indexOf("gate record");
		const clickAt = result.stdout.indexOf("scorer-output:click:PASS");
		const requestsAt = result.stdout.indexOf("scorer-output:requests:PASS");
		expect(recordAt).toBeGreaterThanOrEqual(0);
		expect(clickAt).toBeGreaterThan(recordAt);
		expect(requestsAt).toBeGreaterThan(clickAt);
	});

	test("a FAIL verdict with a scorer exit 0 is passed through, never treated as an error", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, {
			scorer: ({ repo }) => ({ status: 0, stdout: `VERDICT FAIL ${repo}\n`, stderr: "" }),
		});
		const result = runGate(makeConfig(world), makeDeps(world, spawn));

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("VERDICT FAIL click");
	});
});

describe("3a: build failed or the bundle is missing or empty", () => {
	test("a missing bundle fails closed with no score", () => {
		const world = makeWorld();
		rmSync(world.bundlePath);
		const result = runGate(makeConfig(world), makeDeps(world, makeSpawn(world)));
		expectFailClosed(result, "3a");
		expect(result.stdout).toBe("");
	});

	test("an empty bundle fails closed with no score", () => {
		const world = makeWorld();
		writeFileSync(world.bundlePath, "");
		const result = runGate(makeConfig(world), makeDeps(world, makeSpawn(world)));
		expectFailClosed(result, "3a");
	});

	test("a failed build fails closed with no score", () => {
		const world = makeWorld();
		const config: GateConfig = {
			...makeConfig(world),
			build: { command: "node", args: [world.buildScript], cwd: world.glyphRepo },
		};
		const spawn = makeSpawn(world, { build: { status: 1, stdout: "", stderr: "build boom\n" } });
		const result = runGate(config, makeDeps(world, spawn));
		expectFailClosed(result, "3a");
		expect(result.stderr).toContain("build boom");
	});
});

describe("3b: glyph failed, or the index is missing, unparsable or empty", () => {
	test("glyph exiting non-zero fails closed with no score", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, { glyph: () => ({ status: 2, stdout: "", stderr: "glyph boom\n" }) });
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3b");
	});

	test("glyph exiting 0 without writing an index fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, { glyph: () => ok() });
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3b");
	});

	test("an unparsable index fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, { index: "{ not json" });
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3b");
	});

	test("an index with zero files fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, { index: { files: [], symbols: [{}], sites: [{}] } });
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3b");
	});

	test("an index with zero symbols fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, {
			index: { files: ["src/click/core.py"], symbols: [], sites: [{}] },
		});
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3b");
	});
});

describe("3c: the index read zero sites", () => {
	test("an index that read zero sites fails rather than passes", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, {
			index: { files: ["src/click/core.py"], symbols: [{}], sites: [] },
		});
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		// A run that read nothing must fail: the positive control above proves a
		// non-empty site list is what makes the same fixture pass.
		expectFailClosed(result, "3c");
		expect(result.exitCode).toBe(1);
	});
});

describe("3d: fewer files than the scored package holds", () => {
	test("an index missing a package file fails closed", () => {
		const world = makeWorld();
		const base = buildDefaultIndex(world.checkouts.click) as { files: string[] };
		const files = base.files.filter((file) => file !== "src/click/utils.py");
		const spawn = makeSpawn(world, { index: { ...base, files } });
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3d");
	});
});

describe("3e: the cache directory is not exactly the one index", () => {
	test("a cache directory not empty before the run fails closed", () => {
		const world = makeWorld();
		writeFileSync(join(world.caches.click, "stale.json"), "{}\n");
		const result = runGate(makeConfig(world), makeDeps(world, makeSpawn(world)));
		expectFailClosed(result, "3e");
	});

	test("more than one file in the cache after the run fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, {
			writeIndex: (cache) => {
				const dir = join(cache, "indexhash");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "a.json"), `${JSON.stringify(buildDefaultIndex(world.checkouts.click))}\n`);
				writeFileSync(join(dir, "b.json"), `${JSON.stringify(buildDefaultIndex(world.checkouts.click))}\n`);
			},
		});
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3e");
	});
});

describe("3f: the checkout is not the pinned commit or is not clean", () => {
	test("a checkout at the wrong commit fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, { head: () => "f".repeat(40) });
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3f");
	});

	test("a dirty checkout fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, { status: () => " M src/click/core.py\n" });
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3f");
	});
});

describe("3g: the scorer is missing, python3 is missing, or the scorer exits non-zero", () => {
	test("a missing scorer fails closed and prints no scorer output", () => {
		const world = makeWorld();
		rmSync(world.scorerPath);
		const result = runGate(makeConfig(world), makeDeps(world, makeSpawn(world)));
		expectFailClosed(result, "3g");
	});

	test("python3 missing fails closed", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, {
			scorer: () => ({
				status: null,
				stdout: "",
				stderr: "",
				errorCode: "ENOENT",
				errorMessage: "spawn python3 ENOENT",
			}),
		});
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expectFailClosed(result, "3g");
	});

	test("a scorer exit 6 is passed through as a failure of the run", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, {
			scorer: () => ({ status: 6, stdout: "SHOULD-NOT-PRINT\n", stderr: "malformed\n" }),
		});
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(6);
		expect(result.stderr).toContain("gate: fail-closed 3g:");
		expect(result.stdout).not.toContain("SHOULD-NOT-PRINT");
	});

	test("a scorer exit 7 is passed through as a failure of the run", () => {
		const world = makeWorld();
		const spawn = makeSpawn(world, {
			scorer: () => ({ status: 7, stdout: "SHOULD-NOT-PRINT\n", stderr: "zero edges\n" }),
		});
		const result = runGate(makeConfig(world), makeDeps(world, spawn));
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(7);
		expect(result.stderr).toContain("gate: fail-closed 3g:");
		expect(result.stdout).not.toContain("SHOULD-NOT-PRINT");
	});
});

describe("--fetch: ensureCheckout", () => {
	const PIN = "c".repeat(40);

	test("an existing pinned checkout is accepted without a clone", () => {
		const target = join(mkdtempSync(join(tmpdir(), "glyph-fetch-")), "existing");
		worlds.push(dirname(target));
		mkdirSync(target, { recursive: true });
		const calls: string[] = [];
		const spawn: Spawn = (_command, args) => {
			calls.push(args.join(" "));
			return { status: 0, stdout: `${PIN}\n`, stderr: "" };
		};
		const result = ensureCheckout(target, { pinnedCommit: PIN, url: "https://example.test/x.git" }, spawn);
		expect(result.ok).toBe(true);
		expect(calls.length).toBe(1);
	});

	test("a non-empty directory at the wrong commit is refused, not clobbered", () => {
		const parent = mkdtempSync(join(tmpdir(), "glyph-fetch-"));
		worlds.push(parent);
		const target = join(parent, "wrong");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "keep.txt"), "do not clobber\n");
		const spawn: Spawn = (_command, args) =>
			args[0] === "-C" && args[2] === "rev-parse"
				? { status: 128, stdout: "", stderr: "fatal: not a git repository" }
				: ok();
		const result = ensureCheckout(target, { pinnedCommit: PIN, url: "https://example.test/x.git" }, spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("not the pinned commit");
	});

	test("a fresh fetch is verified by git rev-parse HEAD", () => {
		const parent = mkdtempSync(join(tmpdir(), "glyph-fetch-"));
		worlds.push(parent);
		const target = join(parent, "fresh");
		const calls: string[] = [];
		let revParses = 0;
		const spawn: Spawn = (_command, args) => {
			calls.push(args.join(" "));
			if (args[0] === "-C" && args[2] === "rev-parse") {
				revParses += 1;
				// The first probe finds no repository; the post-fetch verify reports the pin.
				return revParses === 1
					? { status: 128, stdout: "", stderr: "fatal: not a git repository" }
					: { status: 0, stdout: `${PIN}\n`, stderr: "" };
			}
			return ok();
		};
		const result = ensureCheckout(target, { pinnedCommit: PIN, url: "https://example.test/x.git" }, spawn);
		expect(result.ok).toBe(true);
		expect(calls.some((call) => call.startsWith("init -q"))).toBe(true);
		expect(calls.some((call) => call.includes("fetch"))).toBe(true);
		expect(calls.some((call) => call.includes("checkout"))).toBe(true);
	});

	test("a fetch whose HEAD does not verify is a failure", () => {
		const parent = mkdtempSync(join(tmpdir(), "glyph-fetch-"));
		worlds.push(parent);
		const target = join(parent, "mismatch");
		let revParses = 0;
		const spawn: Spawn = (_command, args) => {
			if (args[0] === "-C" && args[2] === "rev-parse") {
				revParses += 1;
				return revParses === 1
					? { status: 128, stdout: "", stderr: "fatal: not a git repository" }
					: { status: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" };
			}
			return ok();
		};
		const result = ensureCheckout(target, { pinnedCommit: PIN, url: "https://example.test/x.git" }, spawn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("did not report");
	});
});
