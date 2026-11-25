import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * S8: the gate RUNNER (GCLI-83, DEC-303 (a17) 1-6).
 *
 * This runner invokes the BUILT `dist/glyph.js` over a clean checkout of each
 * held-out repository, starting from an EMPTY cache directory, then feeds the
 * GlyphIndex the shipped path wrote to `test/python-gate/gate_score.py`
 * unchanged. It passes the scorer's output and exit code through and re-derives
 * no score, verdict or number itself.
 *
 * It fails closed (DEC-303 (a17) 2): on any of conditions 3a-3g it exits
 * non-zero, prints a named message on stderr, and prints no score, verdict or
 * scorer output. It prints the measured object (rule 4) before any score.
 *
 * The runner is split into an injectable `runGate` and a thin CLI entry
 * (`cliMain`) carrying the pinned configuration. Tests drive every fail-closed
 * branch with an injected spawn, bundle and cache-dir factory; they never run
 * the real scorer, never touch the real corpora and never run the gate.
 *
 * The held-out ground truth under `test/python-gate/` is not read, listed or
 * run from this file. Only the scorer's documented command line is used.
 */

/** Conditions a fail-closed answer can name (DEC-303 (a17) 2). */
export type FailClosedStage = "3a" | "3b" | "3c" | "3d" | "3e" | "3f" | "3g" | "record" | "internal";

/** One held-out repository the gate scores. */
export interface RepositorySpec {
	/** `click` or `requests`; the scorer's first argument. */
	readonly name: string;
	/** Where `--fetch` clones from. */
	readonly url: string;
	/** The clean checkout the run indexes. */
	readonly checkout: string;
	/** The commit `git rev-parse HEAD` must report (rule 2). */
	readonly pinnedCommit: string;
	/** The scored package, repository-relative, e.g. `src/click` (rule 3d). */
	readonly scoredPackage: string;
	/** A symbol that builds the index and exits 0; chosen by reading the source. */
	readonly symbol: string;
	/** Optional `--file` narrowing, so the symbol cannot be ambiguous. */
	readonly file?: string;
}

/** One external command run to build the shipped bundle. */
export interface BuildStep {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
}

/** The held-out scorer's command line: `python3 -I <script> <repo> <index>`. */
export interface ScorerSpec {
	readonly command: string;
	readonly scriptPath: string;
	/** Interpreter flags before the script; `-I` keeps the run isolated. */
	readonly flags?: readonly string[];
}

/** Everything the pinned CLI entry hands the runner. */
export interface GateConfig {
	/** The repository holding the runner; its HEAD and cleanliness are recorded (rule 4). */
	readonly glyphRepoRoot: string;
	/** The built bundle every repository is indexed through. */
	readonly bundlePath: string;
	/** Optional build; when present a failed build is fail-closed 3a. */
	readonly build?: BuildStep;
	readonly repositories: readonly RepositorySpec[];
	readonly scorer: ScorerSpec;
}

/** The external parts a test replaces; production uses the defaults. */
export interface GateDeps {
	readonly spawn?: Spawn;
	readonly createCacheDir?: (repo: RepositorySpec) => string;
}

/** One child process run, abstracted so tests can answer without a process. */
export interface SpawnOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string | undefined>;
}

export interface SpawnResult {
	/** The exit code, or null when the child never reported one. */
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	/** Set when the child could not start (ENOENT and friends). */
	readonly errorCode?: string;
	readonly errorMessage?: string;
}

export type Spawn = (command: string, args: readonly string[], options?: SpawnOptions) => SpawnResult;

/** What a run returns: the CLI entry writes these streams and adopts the exit code. */
export interface GateResult {
	readonly ok: boolean;
	readonly exitCode: number;
	/** The record (rule 4) and, on success, the scorer's output; empty on a preflight failure. */
	readonly stdout: string;
	readonly stderr: string;
}

/** One repository that passed preflight and is ready to score. */
interface Prepared {
	readonly spec: RepositorySpec;
	readonly indexFile: string;
	readonly index: RawIndex;
	/** `.py` files under the scored package in the checkout (rule 3d). */
	readonly packageFiles: number;
}

/** One scorer run that exited 0 (its verdict is in the output, not the exit code). */
interface Scored {
	readonly spec: RepositorySpec;
	readonly stdout: string;
	readonly stderr: string;
}

/** The minimum index shape the runner reads; the scorer owns the full schema. */
interface RawIndex {
	readonly files: readonly string[];
	readonly symbols: readonly unknown[];
	readonly sites: readonly unknown[];
}

/** A fail-closed answer, carrying its stage and the exit code to adopt. */
class FailClosed extends Error {
	readonly stage: FailClosedStage;
	readonly exitCode: number;

	constructor(stage: FailClosedStage, message: string, exitCode = 1) {
		super(message);
		this.name = "FailClosed";
		this.stage = stage;
		this.exitCode = exitCode;
	}
}

/** The default spawn: Node's own spawnSync, output decoded as UTF-8. */
export const defaultSpawn: Spawn = (command, args, options = {}) => {
	const result = spawnSync(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 1024 * 1024 * 1024,
	});
	const error = result.error as (Error & { code?: string }) | undefined;
	const stdout = result.stdout === null ? "" : result.stdout.toString();
	const stderr = result.stderr === null ? "" : result.stderr.toString();
	return {
		status: result.status,
		stdout,
		stderr,
		...(error?.code === undefined ? {} : { errorCode: error.code }),
		...(error?.message === undefined ? {} : { errorMessage: error.message }),
	};
};

/** A fresh, empty cache directory per repository, verified empty before the run (3e). */
function defaultCacheDir(repo: RepositorySpec): string {
	return mkdtempSync(join(tmpdir(), `glyph-gate-${repo.name}-`));
}

/** Run the gate. Pure of process state: it returns the streams and exit code. */
export function runGate(config: GateConfig, deps: GateDeps = {}): GateResult {
	const spawn = deps.spawn ?? defaultSpawn;
	const createCacheDir = deps.createCacheDir ?? defaultCacheDir;

	let record: string;
	let prepared: Prepared[];
	try {
		if (config.build !== undefined) runBuild(config.build, spawn);
		const bundle = inspectBundle(config.bundlePath);
		const glyphRepo = inspectGlyphRepo(config.glyphRepoRoot, spawn);
		prepared = config.repositories.map((spec) =>
			preflightRepository(spec, { spawn, createCacheDir, bundlePath: config.bundlePath }),
		);
		record = renderRecord(bundle, glyphRepo, prepared);
	} catch (error) {
		return failureResult(error, "");
	}

	if (!existsSync(config.scorer.scriptPath)) {
		return failureResult(new FailClosed("3g", `the scorer is missing at ${config.scorer.scriptPath}`), record);
	}

	let scored: Scored[];
	try {
		// Buffer every scorer run, so a fail-closed answer prints no scorer output at all.
		scored = prepared.map((entry) => scoreRepository(entry, config, spawn));
	} catch (error) {
		return failureResult(error, record);
	}

	let stdout = record;
	let stderr = "";
	for (const entry of scored) {
		stdout += `\n--- ${entry.spec.name}: scorer output (verbatim) ---\n${entry.stdout}`;
		if (!entry.stdout.endsWith("\n")) stdout += "\n";
		stderr += entry.stderr;
	}
	return { ok: true, exitCode: 0, stdout, stderr };
}

/** 3a: the build failed, or the bundle is missing or empty. */
function runBuild(build: BuildStep, spawn: Spawn): void {
	const result = spawn(build.command, build.args, { cwd: build.cwd, env: { ...process.env } });
	if (result.errorCode !== undefined) {
		throw new FailClosed("3a", `the build could not start (${result.errorCode}: ${result.errorMessage ?? ""})`);
	}
	if (result.status !== 0) {
		throw new FailClosed(
			"3a",
			`the build failed (exit ${result.status === null ? "no status" : result.status}): ${firstLine(result.stderr)}`,
		);
	}
}

/** 3a: the built bundle exists and is a non-empty file; its sha256 is recorded. */
function inspectBundle(bundlePath: string): { path: string; sha256: string } {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(bundlePath);
	} catch {
		throw new FailClosed("3a", `dist/glyph.js is missing at ${bundlePath}`);
	}
	if (!stats.isFile()) throw new FailClosed("3a", `dist/glyph.js at ${bundlePath} is not a regular file`);
	if (stats.size === 0) throw new FailClosed("3a", `dist/glyph.js at ${bundlePath} is empty (0 bytes)`);
	const sha256 = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
	return { path: bundlePath, sha256 };
}

/** Rule 4: the glyph commit and its tree state, read from the repository holding the runner. */
function inspectGlyphRepo(root: string, spawn: Spawn): { commit: string; clean: boolean } {
	const head = spawn("git", ["rev-parse", "HEAD"], { cwd: root });
	if (head.status !== 0) {
		throw new FailClosed("record", `cannot read the glyph repository commit at ${root}: ${firstLine(head.stderr)}`);
	}
	const status = spawn("git", ["status", "--porcelain"], { cwd: root });
	if (status.status !== 0) {
		throw new FailClosed("record", `cannot read the glyph repository status at ${root}: ${firstLine(status.stderr)}`);
	}
	return { commit: head.stdout.trim(), clean: status.stdout.trim() === "" };
}

/** 3f (rule 2), 3e, 3b, 3c and 3d for one repository, all before any score is printed. */
function preflightRepository(
	spec: RepositorySpec,
	context: { spawn: Spawn; createCacheDir: (repo: RepositorySpec) => string; bundlePath: string },
): Prepared {
	// 3f: the pinned commit and a clean tree, untracked files included.
	const head = context.spawn("git", ["rev-parse", "HEAD"], { cwd: spec.checkout });
	if (head.status !== 0) {
		throw new FailClosed("3f", `cannot read HEAD of the checkout at ${spec.checkout}: ${firstLine(head.stderr)}`);
	}
	const actual = head.stdout.trim();
	if (actual !== spec.pinnedCommit) {
		throw new FailClosed(
			"3f",
			`checkout at ${spec.checkout} is not the pinned commit ${spec.pinnedCommit} (HEAD is ${actual === "" ? "unreadable" : actual})`,
		);
	}
	const status = context.spawn("git", ["status", "--porcelain"], { cwd: spec.checkout });
	if (status.status !== 0) {
		throw new FailClosed("3f", `cannot read the worktree status at ${spec.checkout}: ${firstLine(status.stderr)}`);
	}
	if (status.stdout.trim() !== "") {
		throw new FailClosed("3f", `checkout at ${spec.checkout} is not clean: ${firstLine(status.stdout)}`);
	}

	// 3e: the cache directory starts empty.
	const cacheDir = context.createCacheDir(spec);
	mkdirSync(cacheDir, { recursive: true });
	const before = readdirSync(cacheDir);
	if (before.length !== 0) {
		throw new FailClosed(
			"3e",
			`cache directory ${cacheDir} was not empty before the run (${before.length} entr${before.length === 1 ? "y" : "ies"})`,
		);
	}

	// 3b: glyph builds the index through the shipped path and exits 0.
	const args = [context.bundlePath, "--json", "--language", "python", "callers", spec.symbol];
	if (spec.file !== undefined) args.push("--file", spec.file);
	const run = context.spawn("node", args, {
		cwd: spec.checkout,
		env: { ...process.env, GLYPH_CACHE_DIR: cacheDir },
	});
	if (run.errorCode !== undefined) {
		throw new FailClosed("3b", `glyph could not start (${run.errorCode}: ${run.errorMessage ?? ""})`);
	}
	if (run.status !== 0) {
		throw new FailClosed(
			"3b",
			`glyph exited ${run.status === null ? "without a status" : run.status} for ${spec.name}: ${firstLine(run.stderr)}`,
		);
	}

	// 3b/3e: the run wrote exactly the one index, and it parses.
	const files = listFilesRecursive(cacheDir);
	const jsonFiles = files.filter((path) => path.endsWith(".json"));
	if (jsonFiles.length === 0) {
		throw new FailClosed("3b", `glyph exited 0 but wrote no index into ${cacheDir}`);
	}
	if (files.length !== 1 || jsonFiles.length !== 1) {
		throw new FailClosed(
			"3e",
			`cache directory ${cacheDir} holds ${files.length} file(s) after the run; expected exactly the one index glyph wrote`,
		);
	}
	const indexFile = jsonFiles[0];
	if (indexFile === undefined) throw new FailClosed("3b", `glyph wrote no index into ${cacheDir}`);

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(indexFile, "utf8"));
	} catch (error) {
		throw new FailClosed("3b", `the index at ${indexFile} is unparsable: ${messageOf(error)}`);
	}
	if (!isIndexShape(parsed)) {
		throw new FailClosed("3b", `the index at ${indexFile} is missing its files, symbols or sites arrays`);
	}
	if (parsed.files.length === 0) throw new FailClosed("3b", `the index at ${indexFile} holds zero files`);
	if (parsed.symbols.length === 0) throw new FailClosed("3b", `the index at ${indexFile} holds zero symbols`);

	// 3c: a Python index that read zero sites is not a pass.
	if (parsed.sites.length === 0) throw new FailClosed("3c", `the index at ${indexFile} read zero sites`);

	// 3d: the index holds at least every `.py` file the scored package holds.
	const packageDir = join(spec.checkout, spec.scoredPackage);
	if (!existsSync(packageDir)) {
		throw new FailClosed("3d", `the scored package directory ${packageDir} is missing from the checkout`);
	}
	const packageFiles = countPythonFiles(packageDir);
	const indexed = countIndexFilesUnder(parsed.files, spec.scoredPackage);
	if (indexed < packageFiles) {
		throw new FailClosed(
			"3d",
			`the index holds ${indexed} file(s) under ${spec.scoredPackage}; the checkout holds ${packageFiles}`,
		);
	}

	return { spec, indexFile, index: parsed, packageFiles };
}

/** 3g: the scorer ran and exited 0; its verdict is the output, not the exit code. */
function scoreRepository(prepared: Prepared, config: GateConfig, spawn: Spawn): Scored {
	const flags = config.scorer.flags ?? ["-I"];
	const result = spawn(
		config.scorer.command,
		[...flags, config.scorer.scriptPath, prepared.spec.name, prepared.indexFile],
		{ cwd: config.glyphRepoRoot, env: { ...process.env } },
	);
	if (result.errorCode !== undefined) {
		throw new FailClosed(
			"3g",
			`the scorer could not start (${result.errorCode}: ${result.errorMessage ?? ""}); is ${config.scorer.command} installed?`,
		);
	}
	if (result.status !== 0) {
		throw new FailClosed(
			"3g",
			`the scorer exited ${result.status === null ? "without a status" : result.status} for ${prepared.spec.name}, which is the run's fail-closed answer`,
			result.status === null ? 1 : result.status,
		);
	}
	return { spec: prepared.spec, stdout: result.stdout, stderr: result.stderr };
}

/** Rule 4: the measured object, printed before any score. */
function renderRecord(
	bundle: { path: string; sha256: string },
	glyphRepo: { commit: string; clean: boolean },
	prepared: readonly Prepared[],
): string {
	const lines = [
		"gate record (printed before any score)",
		`  glyph commit: ${glyphRepo.commit} (tree ${glyphRepo.clean ? "clean" : "dirty"})`,
		`  glyph bundle: ${bundle.path}`,
		`  glyph bundle sha256: ${bundle.sha256}`,
	];
	for (const entry of prepared) {
		lines.push(
			`  ${entry.spec.name}: commit ${entry.spec.pinnedCommit}; index files ${entry.index.files.length}, sites ${entry.index.sites.length}; ${entry.spec.scoredPackage} python files ${entry.packageFiles}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** True when the value carries the three arrays the runner reads. */
function isIndexShape(value: unknown): value is RawIndex {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { files?: unknown; symbols?: unknown; sites?: unknown };
	return Array.isArray(candidate.files) && Array.isArray(candidate.symbols) && Array.isArray(candidate.sites);
}

/** Every regular file under a directory, recursively, sorted. */
function listFilesRecursive(root: string): string[] {
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
			else if (entry.isFile()) found.push(absolute);
		}
	};
	walk(root);
	return found.sort();
}

/** `.py` files under a directory, recursively (rule 3d's checkout side). */
function countPythonFiles(root: string): number {
	let count = 0;
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
			else if (entry.isFile() && entry.name.endsWith(".py")) count += 1;
		}
	};
	walk(root);
	return count;
}

/** Index files restricted to the scored package directory (rule 3d's index side). */
function countIndexFilesUnder(files: readonly string[], scoredPackage: string): number {
	const prefix = scoredPackage.endsWith("/") ? scoredPackage : `${scoredPackage}/`;
	let count = 0;
	for (const file of files) {
		if (typeof file !== "string") continue;
		if (file.startsWith(prefix) && file.endsWith(".py")) count += 1;
	}
	return count;
}

/** The named fail-closed answer, on stderr, with no score on stdout. */
function failureResult(error: unknown, stdout: string): GateResult {
	const failure = error instanceof FailClosed ? error : new FailClosed("internal", messageOf(error));
	return {
		ok: false,
		exitCode: failure.exitCode,
		stdout,
		stderr: `gate: fail-closed ${failure.stage}: ${failure.message}\n`,
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Only the first line of a diagnostic belongs in a message. */
function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

/** The result of `--fetch`: either the directory is ready or the reason it is not. */
export interface CheckoutResult {
	readonly ok: boolean;
	readonly message: string;
}

/**
 * Make `target` a clean checkout of the pinned commit: accept it when it already
 * is, refuse to clobber a non-empty directory that is not, otherwise init, add
 * the remote, fetch the one commit and check it out. Never fatal to a caller
 * that treats a false `ok` as a failure. Verified by `git rev-parse HEAD`.
 */
export function ensureCheckout(
	target: string,
	spec: Pick<RepositorySpec, "pinnedCommit" | "url">,
	spawn: Spawn = defaultSpawn,
): CheckoutResult {
	const existing = spawn("git", ["-C", target, "rev-parse", "HEAD"], {});
	if (existing.status === 0 && existing.stdout.trim() === spec.pinnedCommit) {
		return { ok: true, message: `${target} is already at ${spec.pinnedCommit}` };
	}
	if (existsSync(target)) {
		const stats = statSync(target);
		if (!stats.isDirectory()) return { ok: false, message: `${target} exists and is not a directory` };
		if (readdirSync(target).length > 0) {
			return { ok: false, message: `${target} exists and is not the pinned commit ${spec.pinnedCommit}` };
		}
	}
	mkdirSync(target, { recursive: true });
	const steps: string[][] = [
		["init", "-q", target],
		["-C", target, "remote", "add", "origin", spec.url],
		["-C", target, "fetch", "-q", "--depth", "1", "origin", spec.pinnedCommit],
		["-C", target, "checkout", "-q", "FETCH_HEAD"],
	];
	for (const args of steps) {
		const step = spawn("git", args, {});
		if (step.status !== 0) {
			return { ok: false, message: `git ${args.join(" ")} failed: ${firstLine(step.stderr)}` };
		}
	}
	const verify = spawn("git", ["-C", target, "rev-parse", "HEAD"], {});
	if (verify.status !== 0 || verify.stdout.trim() !== spec.pinnedCommit) {
		return { ok: false, message: `git rev-parse HEAD at ${target} did not report ${spec.pinnedCommit}` };
	}
	return { ok: true, message: `${target} fetched at ${spec.pinnedCommit}` };
}

// ---------------------------------------------------------------------------
// The pinned configuration and thin CLI entry.
// ---------------------------------------------------------------------------

/** The repository holding this runner; `run_gate.ts` sits in `<root>/test/gate-runner/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The held-out repositories, pinned exactly as DEC-303 (a17) 1 names them. */
const PINNED_REPOSITORIES: readonly Omit<RepositorySpec, "checkout">[] = [
	{
		name: "click",
		url: "https://github.com/pallets/click.git",
		pinnedCommit: "1784558ed7c75c65764d2a434bd9cbb206ca939d",
		scoredPackage: "src/click",
		symbol: "echo",
		file: "src/click/utils.py",
	},
	{
		name: "requests",
		url: "https://github.com/psf/requests.git",
		pinnedCommit: "3c7baaa05ab4aa49cc819ce3a819d260de19c157",
		scoredPackage: "src/requests",
		symbol: "to_key_val_list",
		file: "src/requests/utils.py",
	},
];

const USAGE = `usage: run_gate.ts <${PINNED_REPOSITORIES.map((repo) => `${repo.name}Checkout`).join("> <")}>
       run_gate.ts --fetch <directory>

Indexes each clean, pinned checkout through the built dist/glyph.js, from an
empty cache, and feeds the index to the held-out scorer unchanged. Exits
non-zero and prints no score on any fail-closed condition (DEC-303 (a17) 2).
With --fetch, clones the pinned commits into <directory>/<name> and verifies
each with git rev-parse HEAD.
`;

/** The CLI entry: parse the two checkouts (or `--fetch`), run, write, return the exit code. */
export function cliMain(argv: readonly string[]): number {
	let fetchDir: string | undefined;
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--fetch") {
			const value = argv[index + 1];
			if (value === undefined) {
				process.stderr.write("gate: --fetch needs a directory\n");
				return 2;
			}
			fetchDir = resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(USAGE);
			return 0;
		}
		if (arg.startsWith("-")) {
			process.stderr.write(`gate: unknown option ${arg}\n${USAGE}`);
			return 2;
		}
		positional.push(resolve(arg));
	}

	const reuse = defaultSpawn;
	let checkouts: string[];
	if (fetchDir !== undefined) {
		checkouts = [];
		for (const pinned of PINNED_REPOSITORIES) {
			const target = join(fetchDir, pinned.name);
			const ensured = ensureCheckout(target, pinned, reuse);
			if (!ensured.ok) {
				process.stderr.write(`gate: fetch failed for ${pinned.name}: ${ensured.message}\n`);
				return 1;
			}
			checkouts.push(target);
		}
	} else {
		if (positional.length !== PINNED_REPOSITORIES.length) {
			process.stderr.write(
				`gate: expected ${PINNED_REPOSITORIES.length} checkout directories (${PINNED_REPOSITORIES.map((repo) => repo.name).join(", ")}), got ${positional.length}\n${USAGE}`,
			);
			return 2;
		}
		checkouts = positional;
	}

	const repositories: RepositorySpec[] = [];
	for (const [index, pinned] of PINNED_REPOSITORIES.entries()) {
		const checkout = checkouts[index];
		if (checkout === undefined) {
			process.stderr.write(`gate: missing checkout for ${pinned.name}\n`);
			return 2;
		}
		repositories.push({ ...pinned, checkout });
	}

	const config: GateConfig = {
		glyphRepoRoot: REPO_ROOT,
		bundlePath: join(REPO_ROOT, "dist", "glyph.js"),
		build: { command: "node", args: [join(REPO_ROOT, "scripts", "build.mjs")], cwd: REPO_ROOT },
		repositories,
		scorer: {
			command: "python3",
			scriptPath: join(REPO_ROOT, "test", "python-gate", "gate_score.py"),
			flags: ["-I"],
		},
	};

	const result = runGate(config);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	return result.exitCode;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	process.exitCode = cliMain(process.argv.slice(2));
}
