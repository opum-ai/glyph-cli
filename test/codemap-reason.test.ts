import { describe, expect, test } from "bun:test";
import { noExitStatusReason } from "../src/codemap.ts";

/**
 * The reason text in the code map's "did not report an exit status" error.
 * The budget tests exercise the budget path; this pins the three strings the
 * message can carry, without provoking a real timeout or signal.
 */
describe("the no-exit-status reason", () => {
	test("names the timeout, the signal, or neither", () => {
		expect(noExitStatusReason(true, "SIGTERM")).toBe("timeout");
		expect(noExitStatusReason(false, "SIGKILL")).toBe("signal SIGKILL");
		expect(noExitStatusReason(false, null)).toBe("no exit status");
	});
});
