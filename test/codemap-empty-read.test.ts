import { beforeAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitSpawn, produceCodeMap, produceCodeMapWithSpawn } from "../src/codemap.ts";
import { EXIT_CODES, GlyphError } from "../src/errors.ts";
import { type SpawnOptions, spawnResult } from "../src/spawn.ts";
import { type FixtureRepo, makeFixtureRepo } from "./parity/fixtures.ts";

/**
 * GCLI-56, DEC-299 (a5): a git read whose empty result contradicts a precondition
 * glyph already holds is retried once and then fails indeterminate; a read whose
 * empty is a legitimate answer is unchanged. Both ways for every read class, plus
 * the injection seam: the fake spawn is reached only through
 * `produceCodeMapWithSpawn`, never from the CLI.
 */

beforeAll(() => {
	// Tier 3 builds an index cache; keep it out of the user's ~/.cache/glyph.
	process.env.GLYPH_CACHE_DIR = mkdtempSync(join(tmpdir(), "glyph-empty-read-cache-"));
});

/** The reads a code map issues, each matched on the argv the spawn receives. */
const READS = {
	revParse: { name: "rev-parse", match: (args: readonly string[]) => args.includes("rev-parse") },
	catFile: { name: "cat-file", match: (args: readonly string[]) => args.includes("cat-file") },
	mergeBase: { name: "merge-base", match: (args: readonly string[]) => args.includes("merge-base") },
	nameOnly: { name: "diff --name-only", match: (args: readonly string[]) => args.includes("--name-only") },
	numstat: { name: "diff --numstat", match: (args: readonly string[]) => args.includes("--numstat") },
	diffRanges: { name: "diff --unified=0", match: (args: readonly string[]) => args.includes("--unified=0") },
	grepFiles: {
		name: "grep -l",
		// `-l` is an exact argv token; a diff's `--name-only` is not `-l`.
		match: (args: readonly string[]) => args.includes("grep") && args.includes("-l"),
	},
	grepLines: {
		name: "grep -n",
		match: (args: readonly string[]) => args.includes("grep") && args.includes("-n"),
	},
} as const;

type Read = (typeof READS)[keyof typeof READS];

interface Recorder {
	spawn: GitSpawn;
	/** Total calls that matched `read`. */
	count: (read: Read) => number;
	/** Calls that matched `read` and were replaced with the forced empty. */
	forced: (read: Read) => number;
}

/**
 * A spawn that runs the real one, counts calls per read, and optionally replaces
 * one read's matching calls with an empty result. `emptyOn` receives the 1-based
 * index among that read's matching calls, so `() => true` forces every attempt
 * empty and `(n) => n === 1` forces only the first.
 */
function recorder(force?: {
	read: Read;
	emptyOn: (matchingCall: number) => boolean;
	status?: number;
	/** The status of the forced empty on a given matching call; overrides `status`. */
	statusOn?: (matchingCall: number) => number;
}): Recorder {
	const counts = new Map<string, number>();
	const forcedCounts = new Map<string, number>();
	const spawn: GitSpawn = (command: string, args: readonly string[], options: SpawnOptions = {}) => {
		const read = Object.values(READS).find((candidate) => candidate.match(args));
		if (read !== undefined) {
			const next = (counts.get(read.name) ?? 0) + 1;
			counts.set(read.name, next);
			if (force !== undefined && force.read.name === read.name && force.emptyOn(next)) {
				forcedCounts.set(read.name, (forcedCounts.get(read.name) ?? 0) + 1);
				return {
					status: force.statusOn?.(next) ?? force.status ?? 0,
					stdout: Buffer.alloc(0),
					stderr: Buffer.alloc(0),
					signal: null,
					timedOut: false,
				};
			}
		}
		return spawnResult(command, args, options);
	};
	return {
		spawn,
		count: (read) => counts.get(read.name) ?? 0,
		forced: (read) => forcedCounts.get(read.name) ?? 0,
	};
}

function scratchRoot(): string {
	return mkdtempSync(join(tmpdir(), "glyph-empty-read-"));
}

/**
 * A one-branch repo with one identifier in two files: `buildReport`. The source
 * ref is the branch itself, so the branch diff is a legitimate empty.
 */
function identifierRepo(root: string): FixtureRepo {
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	repo.write("src/a.ts", "export function buildReport() {\n  return 1;\n}\n");
	repo.write("src/use.ts", 'import { buildReport } from "./a";\nexport const x = buildReport();\n');
	repo.commit("base");
	return repo;
}

/** Exactly one file matches `soloMarker`, so grep -l and grep -n are each one call. */
function soloRepo(root: string): FixtureRepo {
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	repo.write("src/solo.ts", "export function soloMarker() {\n  return 1;\n}\n");
	repo.write("src/other.ts", "export const x = 2;\n");
	repo.commit("base");
	return repo;
}

/** A path named in the text that exists at the source ref, so `cat-file -t` runs once. */
function namedRepo(root: string): FixtureRepo {
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	repo.write("src/named.ts", "export const named = 1;\n");
	repo.commit("base");
	return repo;
}

/** A branch change against `base`, so `diffRanges` runs for the changed file. */
function branchRepo(root: string): FixtureRepo {
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	repo.write("src/changed.ts", "export const alpha = 1;\n");
	repo.commit("base");
	repo.git("checkout", "-q", "-b", "work");
	repo.write("src/changed.ts", "export const alpha = 2;\nexport const gamma = 3;\n");
	repo.commit("work");
	return repo;
}

/** A non-ASCII path, whose grep -l match comes back quoted and whose grep -n exits 1. */
function cafeRepo(root: string): FixtureRepo {
	const repo = makeFixtureRepo(root);
	repo.git("init", "-q", "-b", "base");
	repo.write("src/café.ts", "export const specialIdent = 1;\n");
	repo.commit("base");
	return repo;
}

function mapWith(root: string, sourceRef: string, taskText: string, injected: Recorder) {
	return produceCodeMapWithSpawn({ repositoryPath: root, sourceRef, taskText, symbols: false }, injected.spawn);
}

function capturedError(run: () => unknown): GlyphError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(GlyphError);
		return error as GlyphError;
	}
	throw new Error("expected the run to throw a GlyphError");
}

function expectIndeterminate(error: GlyphError, namesTheRead: string): void {
	expect(error.errorType).toBe("indeterminate");
	expect(error.code).toBe(EXIT_CODES.indeterminate);
	expect(error.code).toBe(7);
	expect(error.message).toContain(namesTheRead);
}

describe("a contradicting empty read is retried once, then indeterminate", () => {
	const cases: Array<{
		name: string;
		read: Read;
		repo: (root: string) => FixtureRepo;
		sourceRef: string;
		taskText: string;
		names: string;
	}> = [
		{
			name: "rev-parse (the ref resolved, so a commit must print)",
			read: READS.revParse,
			repo: identifierRepo,
			sourceRef: "base",
			taskText: "fix `buildReport`",
			names: "git rev-parse returned no output",
		},
		{
			name: "cat-file -t (exit 0 must print a type)",
			read: READS.catFile,
			repo: namedRepo,
			sourceRef: "base",
			taskText: "open src/named.ts",
			names: "git cat-file -t returned no output",
		},
		{
			name: "merge-base (exit 0 must print a base commit)",
			read: READS.mergeBase,
			repo: identifierRepo,
			sourceRef: "base",
			taskText: "fix `buildReport`",
			names: "git merge-base returned no output",
		},
		{
			name: "diff --unified=0 (the path is known changed)",
			read: READS.diffRanges,
			repo: branchRepo,
			sourceRef: "base",
			taskText: "fix src/changed.ts",
			names: "git diff returned no output for src/changed.ts",
		},
		{
			name: "grep -l (exit 0 means a match was found)",
			read: READS.grepFiles,
			repo: soloRepo,
			sourceRef: "base",
			taskText: "fix `soloMarker`",
			names: "git grep -l returned no output",
		},
		{
			name: "grep -n (the path was already matched)",
			read: READS.grepLines,
			repo: soloRepo,
			sourceRef: "base",
			taskText: "fix `soloMarker`",
			names: "git grep -n returned no output",
		},
	];

	for (const testCase of cases) {
		test(`${testCase.name}: forced empty twice -> exit 7, retried exactly once`, () => {
			const root = scratchRoot();
			testCase.repo(root);
			const injected = recorder({ read: testCase.read, emptyOn: () => true });
			const error = capturedError(() => mapWith(root, testCase.sourceRef, testCase.taskText, injected));
			expectIndeterminate(error, testCase.names);
			expect(injected.count(testCase.read)).toBe(2);
			expect(injected.forced(testCase.read)).toBe(2);
		});
	}
});

describe("a retry that is empty again is never an answer, whatever its status", () => {
	// First attempt: exit 0 with no output (the fault). Retry: exit 1 with no output, which
	// each of these reads would otherwise take as a legitimate "not found" / "unrelated" /
	// "no matches". The retry is accepted only if it printed something, so all are exit 7.
	const cases: Array<{
		name: string;
		read: Read;
		repo: (root: string) => FixtureRepo;
		taskText: string;
		names: string;
	}> = [
		{
			name: "rev-parse",
			read: READS.revParse,
			repo: identifierRepo,
			taskText: "fix `buildReport`",
			names: "git rev-parse returned no output",
		},
		{
			name: "cat-file -t",
			read: READS.catFile,
			repo: namedRepo,
			taskText: "open src/named.ts",
			names: "git cat-file -t returned no output",
		},
		{
			name: "merge-base",
			read: READS.mergeBase,
			repo: identifierRepo,
			taskText: "fix `buildReport`",
			names: "git merge-base returned no output",
		},
		{
			name: "diff --unified=0",
			read: READS.diffRanges,
			repo: branchRepo,
			taskText: "fix src/changed.ts",
			names: "git diff returned no output for src/changed.ts",
		},
		{
			name: "grep -l",
			read: READS.grepFiles,
			repo: soloRepo,
			taskText: "fix `soloMarker`",
			names: "git grep -l returned no output",
		},
		{
			name: "grep -n",
			read: READS.grepLines,
			repo: soloRepo,
			taskText: "fix `soloMarker`",
			names: "git grep -n returned no output",
		},
	];
	for (const testCase of cases) {
		test(`${testCase.name}: exit 0 empty, then exit 1 empty -> exit 7, not an answer`, () => {
			const root = scratchRoot();
			testCase.repo(root);
			const injected = recorder({ read: testCase.read, emptyOn: () => true, statusOn: (call) => (call === 1 ? 0 : 1) });
			const error = capturedError(() => mapWith(root, "base", testCase.taskText, injected));
			expectIndeterminate(error, testCase.names);
			expect(injected.count(testCase.read)).toBe(2);
		});
	}
});

describe("the name-only and numstat reads are a pair: exactly one empty is retried, then indeterminate", () => {
	test("--numstat empty while --name-only lists a file: exit 7, --numstat retried once", () => {
		const root = scratchRoot();
		branchRepo(root);
		const injected = recorder({ read: READS.numstat, emptyOn: () => true });
		const error = capturedError(() => mapWith(root, "base", "fix src/changed.ts", injected));
		expectIndeterminate(error, "git diff --numstat returned no output");
		expect(injected.count(READS.nameOnly)).toBe(1);
		expect(injected.count(READS.numstat)).toBe(2);
	});

	test("--name-only empty while --numstat has a row: exit 7, --name-only retried once", () => {
		const root = scratchRoot();
		branchRepo(root);
		const injected = recorder({ read: READS.nameOnly, emptyOn: () => true });
		const error = capturedError(() => mapWith(root, "base", "fix src/changed.ts", injected));
		expectIndeterminate(error, "git diff --name-only returned no output");
		expect(injected.count(READS.numstat)).toBe(1);
		expect(injected.count(READS.nameOnly)).toBe(2);
	});

	test("--numstat empty once then real: the churn is the real churn, not zero", () => {
		const root = scratchRoot();
		branchRepo(root);
		const clean = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: "fix src/changed.ts",
			symbols: false,
		});
		const injected = recorder({ read: READS.numstat, emptyOn: (call) => call === 1 });
		const output = mapWith(root, "base", "fix src/changed.ts", injected);
		expect(injected.count(READS.numstat)).toBe(2);
		expect(JSON.stringify(output)).toBe(JSON.stringify(clean));
	});

	test("--name-only empty once then real: tier 2 is intact", () => {
		const root = scratchRoot();
		branchRepo(root);
		const clean = produceCodeMap({
			repositoryPath: root,
			sourceRef: "base",
			taskText: "fix src/changed.ts",
			symbols: false,
		});
		const injected = recorder({ read: READS.nameOnly, emptyOn: (call) => call === 1 });
		const output = mapWith(root, "base", "fix src/changed.ts", injected);
		expect(injected.count(READS.nameOnly)).toBe(2);
		expect(JSON.stringify(output)).toBe(JSON.stringify(clean));
	});

	test("a mode-only change: git prints a numstat row for it, so the pair is not both-sides-different", () => {
		const root = scratchRoot();
		const repo = branchRepo(root);
		chmodSync(join(root, "src/changed.ts"), 0o755);
		repo.git("add", "-A");
		repo.git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "mode only");
		const injected = recorder();
		const output = mapWith(root, "base", "fix src/changed.ts", injected);
		expect(output.pointers.some((pointer) => pointer.path === "src/changed.ts")).toBe(true);
		expect(injected.count(READS.nameOnly)).toBe(1);
		expect(injected.count(READS.numstat)).toBe(1);
	});
});

describe("an empty read that recovers on the retry gives the correct answer", () => {
	const cases: Array<{
		name: string;
		read: Read;
		repo: (root: string) => FixtureRepo;
		sourceRef: string;
		taskText: string;
		names: string;
	}> = [
		{
			name: "rev-parse",
			read: READS.revParse,
			repo: identifierRepo,
			sourceRef: "base",
			taskText: "fix `buildReport`",
			names: "git rev-parse returned no output",
		},
		{
			name: "cat-file -t",
			read: READS.catFile,
			repo: namedRepo,
			sourceRef: "base",
			taskText: "open src/named.ts",
			names: "git cat-file -t returned no output",
		},
		{
			name: "merge-base",
			read: READS.mergeBase,
			repo: identifierRepo,
			sourceRef: "base",
			taskText: "fix `buildReport`",
			names: "git merge-base returned no output",
		},
		{
			name: "diff --unified=0",
			read: READS.diffRanges,
			repo: branchRepo,
			sourceRef: "base",
			taskText: "fix src/changed.ts",
			names: "git diff returned no output for src/changed.ts",
		},
		{
			name: "grep -l",
			read: READS.grepFiles,
			repo: soloRepo,
			sourceRef: "base",
			taskText: "fix `soloMarker`",
			names: "git grep -l returned no output",
		},
		{
			name: "grep -n",
			read: READS.grepLines,
			repo: soloRepo,
			sourceRef: "base",
			taskText: "fix `soloMarker`",
			names: "git grep -n returned no output",
		},
	];

	for (const testCase of cases) {
		test(`${testCase.name}: first empty then real output -> answers, spawn called exactly twice`, () => {
			const root = scratchRoot();
			testCase.repo(root);
			const injected = recorder({ read: testCase.read, emptyOn: (call) => call === 1 });
			const output = mapWith(root, testCase.sourceRef, testCase.taskText, injected);
			expect(injected.count(testCase.read)).toBe(2);
			expect(injected.forced(testCase.read)).toBe(1);
			expect(output.pointers.length).toBeGreaterThan(0);
			if (testCase.read === READS.diffRanges) {
				const changed = output.pointers.find((pointer) => pointer.path === "src/changed.ts");
				expect(changed?.lineRanges.length ?? 0).toBeGreaterThan(0);
			}
			if (testCase.read === READS.grepLines) {
				const solo = output.pointers.find((pointer) => pointer.path === "src/solo.ts");
				expect(solo?.lineRanges.length ?? 0).toBeGreaterThan(0);
			}
			if (testCase.read === READS.grepFiles) {
				expect(output.pointers.some((pointer) => pointer.path === "src/solo.ts")).toBe(true);
			}
		});
	}
});

describe("a legitimate empty read is unchanged and not retried", () => {
	test("no branch changes: diff --name-only and --numstat answer empty, each read once", () => {
		const root = scratchRoot();
		identifierRepo(root);
		const injected = recorder();
		const output = mapWith(root, "base", "fix `buildReport`", injected);
		expect(output.pointers.some((pointer) => pointer.path === "src/a.ts")).toBe(true);
		// Empty diff is a legitimate "no changes", not a contradicting empty.
		expect(injected.count(READS.nameOnly)).toBe(1);
		expect(injected.count(READS.numstat)).toBe(1);
		expect(injected.count(READS.mergeBase)).toBe(1);
	});

	test("grep -l exits 1 for an identifier that is absent: an answer, read once", () => {
		const root = scratchRoot();
		soloRepo(root);
		const injected = recorder();
		const output = mapWith(root, "base", "fix `absentMarker`", injected);
		expect(output.pointers).toEqual([]);
		expect(injected.count(READS.grepFiles)).toBe(1);
		expect(injected.forced(READS.grepFiles)).toBe(0);
	});

	test("the quoted non-ASCII path: grep -n exits 1 legitimately, read once", () => {
		const root = scratchRoot();
		cafeRepo(root);
		const injected = recorder();
		const output = mapWith(root, "base", "Check `specialIdent` in src/café.ts", injected);
		// git grep -l returns the quoted path; grep -n on it exits 1 with no output.
		// That is a genuine "no lines at this exact path", so it is not retried and
		// the quoted entry stays the whole-file pointer the producer pinned.
		const quoted = output.pointers.find((pointer) => pointer.path.startsWith('"src/caf'));
		expect(quoted).toBeDefined();
		expect(quoted?.lineRanges).toEqual([]);
		expect(quoted?.reason).toContain("matches identifier `specialIdent`");
		expect(injected.count(READS.grepLines)).toBe(1);
		expect(injected.forced(READS.grepLines)).toBe(0);
	});
});

describe("each guarded read's legitimate empty is read exactly once", () => {
	test("diff --unified=0 on a mode-only change: the pointer stays with no ranges, read once", () => {
		const root = scratchRoot();
		const repo = makeFixtureRepo(root);
		repo.git("init", "-q", "-b", "base");
		repo.write("src/changed.ts", "export const alpha = 1;\n");
		repo.commit("base");
		repo.git("checkout", "-q", "-b", "work");
		chmodSync(join(root, "src/changed.ts"), 0o755);
		repo.git("add", "-A");
		repo.git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "mode only");
		const injected = recorder();
		const output = mapWith(root, "base", "fix src/changed.ts", injected);
		const pointer = output.pointers.find((candidate) => candidate.path === "src/changed.ts");
		expect(pointer).toBeDefined();
		expect(pointer?.lineRanges).toEqual([]);
		expect(injected.count(READS.diffRanges)).toBe(1);
	});

	test("merge-base exit 1 on unrelated histories: no error, no branch files, read once", () => {
		const root = scratchRoot();
		const repo = identifierRepo(root);
		repo.git("checkout", "-q", "--orphan", "other");
		repo.git("rm", "-rfq", ".");
		repo.write("src/lone.ts", "export const lone = 1;\n");
		repo.commit("orphan");
		const injected = recorder();
		const output = mapWith(root, "base", "fix `buildReport`", injected);
		expect(injected.count(READS.mergeBase)).toBe(1);
		expect(injected.count(READS.nameOnly)).toBe(0);
		expect(output.pointers.some((pointer) => pointer.reason.includes("changed on this branch"))).toBe(false);
	});

	test("cat-file non-zero for a named path absent at the ref: no pointer, read once", () => {
		const root = scratchRoot();
		namedRepo(root);
		const injected = recorder();
		const output = mapWith(root, "base", "open src/missing.ts", injected);
		expect(output.pointers.some((pointer) => pointer.path === "src/missing.ts")).toBe(false);
		expect(injected.count(READS.catFile)).toBe(1);
	});

	test("rev-parse exit 1 for an unknown ref: not found (exit 3), read once", () => {
		const root = scratchRoot();
		identifierRepo(root);
		const injected = recorder();
		const error = capturedError(() => mapWith(root, "no-such-ref", "fix `buildReport`", injected));
		expect(error.errorType).toBe("not_found");
		expect(injected.count(READS.revParse)).toBe(1);
	});
});

describe("the spawn seam is not reachable from the CLI", () => {
	const srcDir = join(import.meta.dir, "..", "src");

	test("src/cli.ts and src/program.ts never name the injected spawn or the test entry point", () => {
		const cli = readFileSync(join(srcDir, "cli.ts"), "utf8");
		const program = readFileSync(join(srcDir, "program.ts"), "utf8");
		// Positive control: we read the real entry points, and program.ts is the one
		// that imports the code map.
		expect(cli.length).toBeGreaterThan(0);
		expect(program).toContain('import { produceCodeMap } from "./codemap.ts"');
		// The seam is absent from both.
		for (const source of [cli, program]) {
			expect(source).not.toContain("produceCodeMapWithSpawn");
			expect(source).not.toContain("GitSpawn");
		}
	});

	test("produceCodeMap uses the real spawnResult by default", () => {
		const root = scratchRoot();
		identifierRepo(root);
		const input = { repositoryPath: root, sourceRef: "base", taskText: "fix `buildReport`", symbols: false };
		const viaPublic = produceCodeMap(input);
		const viaInjectedReal = produceCodeMapWithSpawn(input, spawnResult);
		expect(viaPublic.pointers.length).toBeGreaterThan(0);
		expect(JSON.stringify(viaInjectedReal)).toBe(JSON.stringify(viaPublic));
	});
});
