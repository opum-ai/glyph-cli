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
// Node kills a timed-out child with SIGTERM too, so its signal matches an
// overflow's; only the error code and `timedOut` tell them apart. Asserted
// here because src/spawn.ts's docstring says both carry SIGTERM.
if (process.platform !== "win32") {
	must(timeout.signal === "SIGTERM", `timeout: expected signal SIGTERM, got ${timeout.signal}`);
}

// Write until the helper kills the child, exactly as test/spawn.test.ts does
// after glyph-cli#97: a single write races the kill (measured: the child
// finished first in 1 of 100 local iterations), so this check would be flaky.
// A writer that stops itself after 3 s still fails loudly if the limit is gone.
const overflow = spawnSync(
	node,
	[
		"-e",
		'const t = setInterval(() => process.stdout.write("x".repeat(1000)), 2); setTimeout(() => { clearInterval(t); process.exit(0); }, 3000)',
	],
	{ maxBuffer: 100, stdio: ["pipe", "pipe", "pipe"] },
);
// Node KILLS the child when captured output exceeds maxBuffer: status is null
// and signal is SIGTERM, the same signal a timeout sends. `timedOut` is false
// (the error code is ENOBUFS, not ETIMEDOUT), and that flag — not the signal —
// is what distinguishes an overflow from a timeout. Measured on node 24.22.2.
must(
	overflow.status === null && overflow.error?.code === "ENOBUFS",
	`maxBuffer: status=${overflow.status} code=${overflow.error?.code} signal=${overflow.signal}`,
);
if (process.platform !== "win32") {
	must(overflow.signal === "SIGTERM", `maxBuffer: expected signal SIGTERM, got ${overflow.signal}`);
}

if (process.platform !== "win32") {
	const e2big = spawnSync("/bin/echo", ["x".repeat(2 * 1024 * 1024)], { stdio: ["pipe", "pipe", "pipe"] });
	must(e2big.error?.code === "E2BIG", `E2BIG: code=${e2big.error?.code}`);
}

console.log(`timeout, maxBuffer (signal ${overflow.signal ?? "none"}) and E2BIG classified under node`);
