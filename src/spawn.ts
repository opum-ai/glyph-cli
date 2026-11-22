import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

/**
 * The one place Glyph runs a child process.
 *
 * `src/git.ts` and `src/codemap.ts` used Bun's `spawnSync` while Glyph was
 * Bun-only. The shipped package now runs on Node (DEC-299), so both call this
 * helper, which wraps `node:child_process.spawnSync` and keeps the behavior
 * they relied on:
 *
 * - `stdout` and `stderr` are the child's raw bytes, decoded by the caller.
 * - `status` is the exit code, or null when the child never reported one. The
 *   callers treat null as a failed read, never as success, and read `timedOut`
 *   and `signal` to say which kind of failure it was.
 * - `input` feeds stdin; `timeout` kills the child at the limit; `maxBuffer`
 *   caps how much output is captured. The default is generous (1 GiB) because
 *   `git ls-tree` and `git cat-file --batch` can print a whole tree.
 * - A spawn FAILURE throws, which is what Bun's `spawnSync` did. That includes
 *   ENOENT and EACCES (the command could not start) and E2BIG, EMFILE and any
 *   other exec-level error, so a broken environment is reported as such rather
 *   than as an empty read. A timeout and a buffer overflow are different: the
 *   child DID run, so they return `status: null` with `timedOut` set (timeout)
 *   or neither set (buffer overflow), for the caller to classify.
 */

/** One run's limits, in Node's own vocabulary. */
export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** Bytes written to the child's stdin. */
	input?: Uint8Array;
	timeout?: number;
	maxBuffer?: number;
}

export interface SpawnResult {
	/** The exit code, or null when the child never reported one. */
	status: number | null;
	stdout: Buffer;
	stderr: Buffer;
	signal: string | null;
	/** True when Node killed the child at `timeout`. */
	timedOut: boolean;
}

/** Bun captured up to 1 GiB by default; Node's own default is 1 MiB, too small for a tree. */
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * Codes that describe a child that ran but did not finish normally, so the
 * caller (not this helper) decides what they mean. Everything else is a spawn
 * failure and throws.
 */
function isResultErrorCode(code: string | undefined): boolean {
	return code === "ETIMEDOUT" || code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/**
 * True when the error means the child never ran. Exported so the unit test can
 * pin the classification for E2BIG, EMFILE and the codes Node actually emits
 * without having to provoke each one.
 */
export function isSpawnFailure(error: { code?: string } | undefined): boolean {
	return error !== undefined && !isResultErrorCode(error.code);
}

export function spawnResult(command: string, args: readonly string[], options: SpawnOptions = {}): SpawnResult {
	const result = spawnSync(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		input: options.input,
		timeout: options.timeout,
		maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const error = result.error as (Error & { code?: string }) | undefined;
	if (isSpawnFailure(error)) throw error;
	return {
		status: result.status,
		stdout: result.stdout ?? Buffer.alloc(0),
		stderr: result.stderr ?? Buffer.alloc(0),
		signal: result.signal,
		timedOut: error?.code === "ETIMEDOUT",
	};
}
