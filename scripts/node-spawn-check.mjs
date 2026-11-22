#!/usr/bin/env node
import { spawnSync } from "node:child_process";

/*
 * Node's own `node:child_process.spawnSync` edge behavior (GCLI-46 review F7).
 *
 * `test/spawn.test.ts` runs under `bun test`, so its `node:child_process` is
 * Bun's implementation. The shipped artifact runs under Node, so the gate runs
 * this file with the `node` binary and checks the three outcomes that are easy
 * for an implementation to spell differently: a timeout, a buffer overflow, and
 * an exec-level failure (E2BIG).
 */

function must(condition, message) {
	if (!condition) {
		console.error(`node spawnSync check failed: ${message}`);
		process.exit(1);
	}
}

const node = process.execPath;

const timeout = spawnSync(node, ["-e", "setTimeout(() => {}, 5000)"], {
	timeout: 200,
	stdio: ["pipe", "pipe", "pipe"],
});
must(
	timeout.status === null && timeout.error?.code === "ETIMEDOUT",
	`timeout: status=${timeout.status} code=${timeout.error?.code}`,
);

const overflow = spawnSync(node, ["-e", "process.stdout.write('x'.repeat(100000))"], {
	maxBuffer: 100,
	stdio: ["pipe", "pipe", "pipe"],
});
must(
	overflow.status === null && overflow.error?.code === "ENOBUFS",
	`maxBuffer: status=${overflow.status} code=${overflow.error?.code}`,
);

if (process.platform !== "win32") {
	const e2big = spawnSync("/bin/echo", ["x".repeat(2 * 1024 * 1024)], { stdio: ["pipe", "pipe", "pipe"] });
	must(e2big.error?.code === "E2BIG", `E2BIG: code=${e2big.error?.code}`);
}

console.log("timeout, maxBuffer and E2BIG classified under node");
