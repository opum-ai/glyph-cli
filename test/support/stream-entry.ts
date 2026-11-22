#!/usr/bin/env bun
/**
 * A test-only entry point: it installs the stream fault hook (or a code-map
 * budget override) from environment variables and then runs the real CLI.
 *
 * The shipped `src/cli.ts` installs nothing, so a stray environment variable in
 * a consumer shell cannot make a production run pause or fail. Only tests spawn
 * this file.
 *
 *   GLYPH_TEST_STREAM_FAIL_AFTER=n        throw after n item lines
 *   GLYPH_TEST_STREAM_PAUSE_AFTER_MS=n    sleep after the first item (clamped, never for code-map)
 *   GLYPH_TEST_CODE_MAP_TIME_BUDGET_MS=n  pin ADR 0005's budget
 */
import { setCodeMapTimeBudgetForTests } from "../../src/codemap.ts";
import { indeterminateError } from "../../src/errors.ts";
import { run } from "../../src/program.ts";
import { setStreamFaultHook } from "../../src/stream.ts";

function integerFromEnv(name: string): number | null {
	const raw = process.env[name];
	if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
	return Number.parseInt(raw, 10);
}

const args = process.argv.slice(2);
const budgetMs = integerFromEnv("GLYPH_TEST_CODE_MAP_TIME_BUDGET_MS");
if (budgetMs !== null) setCodeMapTimeBudgetForTests(budgetMs);

const failAfter = integerFromEnv("GLYPH_TEST_STREAM_FAIL_AFTER");
// Clamp the pause, and never pause inside code-map's timed loop: a pause there
// would spend ADR 0005's budget and change the answer.
const pauseAfterMs = args.includes("code-map")
	? null
	: Math.min(integerFromEnv("GLYPH_TEST_STREAM_PAUSE_AFTER_MS") ?? 0, 2_000);

if (failAfter !== null || (pauseAfterMs ?? 0) > 0) {
	setStreamFaultHook({
		beforeWrite(event) {
			if (failAfter !== null && event.itemCount >= failAfter) {
				throw indeterminateError(`forced mid-stream failure after ${event.itemCount} item line(s) (test injection)`);
			}
		},
		afterWrite(event) {
			if (pauseAfterMs !== null && pauseAfterMs > 0 && event.kind === "item" && event.itemCount === 1) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseAfterMs);
			}
		},
	});
}

process.exitCode = await run(args);
