import { describe, expect, test } from "bun:test";
import { isSpawnFailure, spawnResult } from "../src/spawn.ts";

/**
 * The one spawn helper (GCLI-46). The git readers used to call Bun.spawnSync;
 * these tests pin the Node behavior they now rely on: bytes, exit codes, stdin,
 * the timeout, the buffer limit, and which failures throw.
 */

const NODE = process.execPath;

function run(script: string, options: Parameters<typeof spawnResult>[2] = {}) {
	return spawnResult(NODE, ["-e", script], options);
}

describe("spawnResult", () => {
	test("returns the child's stdout bytes and exit code", () => {
		const result = run('process.stdout.write("hi")');
		expect(result.status).toBe(0);
		expect(result.stdout.toString()).toBe("hi");
		expect(result.stderr.toString()).toBe("");
		expect(result.timedOut).toBe(false);
	});

	test("returns a non-zero exit code rather than throwing", () => {
		const result = run('process.stderr.write("nope"); process.exit(3)');
		expect(result.status).toBe(3);
		expect(result.stderr.toString()).toBe("nope");
	});

	test("feeds stdin to the child", () => {
		const result = run('process.stdout.write(require("fs").readFileSync(0, "utf8"))', {
			input: new TextEncoder().encode("from stdin"),
		});
		expect(result.status).toBe(0);
		expect(result.stdout.toString()).toBe("from stdin");
	});

	test("a timeout reports status null, timedOut, and a signal instead of throwing", () => {
		const result = run("setTimeout(() => {}, 5000)", { timeout: 200 });
		expect(result.status).toBeNull();
		expect(result.timedOut).toBe(true);
		expect(result.signal).not.toBeNull();
	});

	test("a buffer overflow is reported, not thrown", () => {
		const result = run('process.stdout.write("x".repeat(100000))', { maxBuffer: 100 });
		expect(result.status).toBeNull();
		expect(result.timedOut).toBe(false);
	});

	test("a command that cannot start throws (ENOENT)", () => {
		expect(() => spawnResult("definitely-not-a-real-binary-xyz", [])).toThrow();
	});

	test("an exec-level failure that is not a timeout throws (E2BIG)", () => {
		if (process.platform === "win32") return; // No /bin/echo and a different argv limit.
		expect(() => spawnResult("/bin/echo", ["x".repeat(2 * 1024 * 1024)])).toThrow();
	});

	test("classifies spawn failures and result errors by code", () => {
		for (const code of ["ENOENT", "EACCES", "E2BIG", "EMFILE", "ENOMEM", "UNKNOWN"]) {
			expect(isSpawnFailure({ code })).toBe(true);
		}
		for (const code of ["ETIMEDOUT", "ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
			expect(isSpawnFailure({ code })).toBe(false);
		}
		expect(isSpawnFailure(undefined)).toBe(false);
	});
});
