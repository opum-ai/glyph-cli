import { describe, expect, test } from "bun:test";
import { noExitStatusReason, noExitStatusTiming } from "../src/codemap.ts";

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

describe("the no-exit-status timing (GCLI-51)", () => {
	test("names the elapsed time, the timeout cap and the budget left", () => {
		expect(noExitStatusTiming(1234.6, 15000, 5600.2)).toBe(
			"elapsed 1235 ms, timeout cap 15000 ms, budget left 5600 ms",
		);
	});

	test("says so when there is no timeout or no budget", () => {
		expect(noExitStatusTiming(2, undefined, null)).toBe("elapsed 2 ms, no timeout, no budget");
	});
});
