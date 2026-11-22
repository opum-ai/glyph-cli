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
 * - `status` is the exit code, or null when the child never reported one (a
 *   timeout, a signal, a spawn failure) — the callers treat null as a failed
 *   read, never as success.
 * - `input` feeds stdin; `timeout` kills the child at the limit; `maxBuffer`
 *   caps how much output is captured. The default is generous (1 GiB) because
 *   `git ls-tree` and `git cat-file --batch` can print a whole tree.
 * - A child that cannot start at all (ENOENT, EACCES) throws, which is what
 *   Bun's `spawnSync` did; a timeout and a buffer overflow return `status: null`
 *   instead, because those are reads the caller must classify (a budget stop
 *   versus an indeterminate repository) rather than failed spawns.
 *
 * `timedOut` distinguishes the timeout case from a signal or a buffer overflow
 * without the caller re-reading `error.code`.
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
	if (error !== undefined && (error.code === "ENOENT" || error.code === "EACCES")) {
		// The command could not be started. Bun threw here, and the callers rely
		// on that distinction: codemap names it "git could not start".
		throw error;
	}
	return {
		status: result.status,
		stdout: result.stdout ?? Buffer.alloc(0),
		stderr: result.stderr ?? Buffer.alloc(0),
		signal: result.signal,
		timedOut: error?.code === "ETIMEDOUT",
	};
}
