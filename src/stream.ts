/**
 * `--stream`: the opt-in NDJSON variant of `--json` (Opum command contract §1a,
 * DEC-299).
 *
 * stdout carries one compact success envelope (§2) per line, each newline
 * terminated and written as it is produced, with `principal` last by
 * construction. Item lines carry `<command>.item` and one element of the list
 * the batch answer would return; exactly one `<command>.result` line ends the
 * stream, carrying the batch data with the item list replaced by `itemCount`.
 * A failure mid-stream leaves no result line, writes the §5 error envelope to
 * stderr and exits with the mapped code — `run()` owns that dispatch, so a
 * throw from `item()`/`result()` is enough to stop the stream.
 */

import { type CodeMapOutput, codeMapTruncated } from "./codemap.ts";
import { successEnvelope } from "./contract.ts";
import { indeterminateError } from "./errors.ts";

/**
 * Test-only fault-injection seams. Both are read only when a stream writer is
 * created, so neither can affect a non-streaming invocation.
 *
 * - `GLYPH_TEST_STREAM_FAIL_AFTER=n` throws a classified `indeterminate`
 *   failure once `n` item lines have been written, proving the mid-stream
 *   failure clause (no result line, error envelope on stderr, mapped exit 7).
 * - `GLYPH_TEST_STREAM_PAUSE_AFTER_MS=n` sleeps for `n` ms after the first
 *   item line, so a test can read that line from a pipe while the process is
 *   provably still alive — the per-line flush proof.
 */
export const STREAM_FAIL_AFTER_ENV = "GLYPH_TEST_STREAM_FAIL_AFTER";
export const STREAM_PAUSE_AFTER_ENV = "GLYPH_TEST_STREAM_PAUSE_AFTER_MS";

export interface StreamWriter {
	/** Write one `<command>.item` line now. */
	item(kind: string, data: unknown): void;
	/** Write the single `<command>.result` line. */
	result(kind: string, data: unknown): void;
	/** Item lines written so far, for `itemCount`. */
	readonly itemCount: number;
}

/** One compact §2 envelope per line. `successEnvelope` fixes `principal` last. */
export function streamLine(kind: string, data: unknown): string {
	return `${JSON.stringify(successEnvelope(kind, data))}\n`;
}

function integerFromEnv(name: string): number | null {
	const raw = process.env[name];
	if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
	return Number.parseInt(raw, 10);
}

/** A synchronous sleep, so the flush test can hold the child open without a runtime API bet. */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A writer for one streaming invocation. Each `item` call writes and flushes a
 * whole line immediately; the process is never asked to buffer the list.
 */
export function createStreamWriter(): StreamWriter {
	const failAfter = integerFromEnv(STREAM_FAIL_AFTER_ENV);
	const pauseAfter = integerFromEnv(STREAM_PAUSE_AFTER_ENV);
	let count = 0;
	const faultCheck = (): void => {
		if (failAfter !== null && count >= failAfter) {
			throw indeterminateError(
				`forced mid-stream failure after ${count} item line(s) (test injection, ${STREAM_FAIL_AFTER_ENV})`,
			);
		}
	};
	return {
		get itemCount(): number {
			return count;
		},
		item(kind: string, data: unknown): void {
			faultCheck();
			process.stdout.write(streamLine(kind, data));
			count += 1;
			if (pauseAfter !== null && count === 1) sleepSync(pauseAfter);
		},
		result(kind: string, data: unknown): void {
			// Checked here too, so a one-item answer cannot slip a result line out
			// past an injected failure.
			faultCheck();
			process.stdout.write(streamLine(kind, data));
		},
	};
}

/**
 * A command's streamed result-line data: the batch data with the item list
 * removed and `itemCount` added last. Extra budget/truncation fields, when a
 * command has them, stay in place (code-map's `truncated` is supplied here).
 */
export function streamResultData(
	batch: Record<string, unknown>,
	itemKey: string,
	itemCount: number,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(batch)) {
		if (key === itemKey) continue;
		rest[key] = value;
	}
	return { ...rest, ...extra, itemCount };
}

/** code-map's result line: `{omissions, truncated, itemCount}` (ADR 0005's budget stays visible). */
export function codeMapStreamResultData(output: CodeMapOutput): Record<string, unknown> {
	return { omissions: output.omissions, truncated: codeMapTruncated(output), itemCount: output.pointers.length };
}

export interface StreamSpec {
	/** The kind every item line carries, e.g. `callers.item`. */
	itemKind: string;
	/** The kind the last line carries, e.g. `callers.result`. */
	resultKind: string;
	/** The batch `data` key replaced by `itemCount`, e.g. `callers` or `pointers`. */
	itemKey: string;
}

export interface StreamCheckOptions {
	/** Mutation seam: skip the `itemCount` assertion (used to prove it is not decorative). */
	skipItemCount?: boolean;
	/** Mutation seam: skip the principal-last assertion. */
	skipPrincipalLast?: boolean;
}

interface ParsedEnvelope {
	line: string;
	value: Record<string, unknown>;
}

/**
 * The §1a conformance check for one streamed stdout. Empty findings means it
 * conforms: every line is a compact, newline-terminated §2 envelope with
 * `principal` last; item lines carry the item kind; exactly one result line
 * ends the stream; `itemCount` matches; and every non-item field equals the
 * batch answer.
 *
 * The two `skip` options are an injected seam for the mutation test, exactly as
 * `validateKindRegistry`'s `dotted` parameter is: mutating the CHECK — not its
 * input — and confirming a predicted subset of findings disappears proves the
 * assertion is load-bearing.
 */
export function checkStreamStdout(
	stdout: string,
	batch: Record<string, unknown>,
	spec: StreamSpec,
	options: StreamCheckOptions = {},
): string[] {
	const findings: string[] = [];
	if (stdout.length === 0) return ["VACUOUS: stream stdout is empty"];
	if (!stdout.endsWith("\n")) findings.push("NOT NEWLINE-TERMINATED: stdout does not end with a newline");

	const rawLines = stdout.split("\n");
	if (rawLines[rawLines.length - 1] === "") rawLines.pop(); // the final terminator
	const parsed: ParsedEnvelope[] = [];
	for (const [index, line] of rawLines.entries()) {
		if (line.length === 0) {
			findings.push(`BLANK LINE at line ${index}`);
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			findings.push(`NOT JSON at line ${index}`);
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			findings.push(`NOT A §2 ENVELOPE at line ${index}`);
			continue;
		}
		const envelope = value as Record<string, unknown>;
		parsed.push({ line, value: envelope });
		if (envelope.schemaVersion !== 1) findings.push(`BAD schemaVersion at line ${index}`);
		if (typeof envelope.kind !== "string" || envelope.kind === "") {
			findings.push(`BAD kind at line ${index}`);
		}
		if (typeof envelope.data !== "object" || envelope.data === null || Array.isArray(envelope.data)) {
			findings.push(`BAD data at line ${index}`);
		}
		if (!Object.hasOwn(envelope, "principal") || envelope.principal !== null) {
			findings.push(`MISSING principal:null at line ${index}`);
		}
		const keys = Object.keys(envelope);
		if (!options.skipPrincipalLast && keys[keys.length - 1] !== "principal") {
			findings.push(`PRINCIPAL NOT LAST at line ${index}`);
		}
		if (JSON.stringify(envelope) !== line) findings.push(`NOT COMPACT at line ${index}`);
	}
	if (parsed.length === 0) return findings;

	const resultEnvelope = parsed[parsed.length - 1];
	const itemEnvelopes = parsed.slice(0, -1);
	if (resultEnvelope === undefined) return findings;
	if (resultEnvelope.value.kind !== spec.resultKind) {
		findings.push(`LAST LINE KIND: expected ${spec.resultKind}, got ${String(resultEnvelope.value.kind)}`);
	}
	for (const [index, item] of itemEnvelopes.entries()) {
		if (item.value.kind !== spec.itemKind) {
			findings.push(`ITEM LINE KIND at line ${index}: expected ${spec.itemKind}, got ${String(item.value.kind)}`);
		}
	}
	const resultValue = resultEnvelope.value.data;
	const result =
		typeof resultValue === "object" && resultValue !== null && !Array.isArray(resultValue)
			? (resultValue as Record<string, unknown>)
			: {};
	if (!options.skipItemCount) {
		if (typeof result.itemCount !== "number") {
			findings.push("RESULT MISSING itemCount");
		} else if (result.itemCount !== itemEnvelopes.length) {
			findings.push(`ITEMCOUNT MISMATCH: result says ${result.itemCount}, ${itemEnvelopes.length} item line(s)`);
		}
	}
	for (const [key, value] of Object.entries(batch)) {
		if (key === spec.itemKey) continue;
		if (JSON.stringify(result[key]) !== JSON.stringify(value)) findings.push(`FIELD MISMATCH: ${key}`);
	}
	return findings;
}
