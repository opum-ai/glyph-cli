import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { produceCodeMap } from "../src/codemap.ts";
import {
	buildManifest,
	itemKindOf,
	kindOf,
	STREAMING_COMMANDS,
	streamItemKinds,
	validateResultKinds,
} from "../src/contract.ts";
import {
	checkStreamStdout,
	codeMapStreamResultData,
	STREAM_FAIL_AFTER_ENV,
	STREAM_PAUSE_AFTER_ENV,
	streamLine,
	type StreamSpec,
} from "../src/stream.ts";
import { makeScratchRepo, scratchCacheDir, type ScratchRepo } from "./helpers.ts";
import { STREAM_BATCH_GOLDENS } from "./stream-goldens.ts";
import { STREAM_BATCH_INVOCATIONS, STREAM_CODEMAP_TASK, STREAM_FIXTURE_FILES } from "./stream-fixtures.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(
	cwd: string,
	args: string[],
	cacheDir: string,
	stdin?: string,
	env?: Record<string, string>,
): CliResult {
	const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
		cwd,
		env: { ...process.env, GLYPH_CACHE_DIR: cacheDir, ...env },
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function fixture(): ScratchRepo {
	const repo = makeScratchRepo(STREAM_FIXTURE_FILES);
	repo.commit("base");
	return repo;
}

interface Envelope {
	schemaVersion: number;
	kind: string;
	data: Record<string, unknown>;
	principal: null;
}

function envelopes(stdout: string): Envelope[] {
	return stdout
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Envelope);
}

const SPECS: Record<"callers" | "impact" | "code-map", StreamSpec & { stream: string[]; stdin?: string }> = {
	callers: {
		itemKind: itemKindOf("callers"),
		resultKind: kindOf("callers"),
		itemKey: "callers",
		stream: ["callers", "helper", "--stream"],
	},
	impact: {
		itemKind: itemKindOf("impact"),
		resultKind: kindOf("impact"),
		itemKey: "callers",
		stream: ["impact", "helper", "--stream"],
	},
	"code-map": {
		itemKind: itemKindOf("code-map"),
		resultKind: kindOf("code-map"),
		itemKey: "pointers",
		stream: ["code-map", "--source-ref", "HEAD", "--stream"],
		stdin: STREAM_CODEMAP_TASK,
	},
};

const STREAMING = ["callers", "impact", "code-map"] as const;

describe("--stream (contract §1a)", () => {
	test("the manifest declares --stream on exactly callers, impact and code-map", () => {
		const manifest = buildManifest();
		expect(manifest.commands.length).toBeGreaterThan(0);
		const declared = manifest.commands
			.filter((command) => command.flags.some((flag) => flag.name === "stream"))
			.map((command) => command.name)
			.sort();
		// Hand-transcribed golden set, compared by exact equality in both directions.
		expect(declared).toEqual(["callers", "code-map", "impact"]);
		expect(declared).not.toContain("diff");
		expect([...declared].sort()).toEqual([...STREAMING_COMMANDS].sort());
		// The item kinds are dotted and the set is non-vacuous.
		expect(streamItemKinds().length).toBe(3);
		expect(validateResultKinds(streamItemKinds())).toEqual([]);
		for (const name of STREAMING) expect(itemKindOf(name)).toBe(`${name}.item`);
	});

	test("--stream on a command that does not declare it exits 2 with a usage envelope", () => {
		const repo = fixture();
		const cases: Array<[string, string[]]> = [
			["diff", ["diff", "HEAD", "--stream"]],
			["cache path", ["cache", "path", "--stream"]],
			["cache clear", ["cache", "clear", "--stream"]],
			["help", ["help", "--stream"]],
		];
		for (const [name, args] of cases) {
			const result = runCli(repo.root, args, scratchCacheDir());
			expect(result.code, name).toBe(2);
			expect(result.stdout, name).toBe("");
			const error = JSON.parse(result.stderr) as { error_type: string; principal: null };
			expect(error.error_type, name).toBe("usage");
			expect(error.principal, name).toBeNull();
		}
	});

	test("--stream combined with --plain exits 2 on each of the three commands", () => {
		const repo = fixture();
		for (const name of STREAMING) {
			const spec = SPECS[name];
			const result = runCli(repo.root, [...spec.stream, "--plain"], scratchCacheDir(), spec.stdin);
			expect(result.code, name).toBe(2);
			expect(result.stdout, name).toBe("");
			const error = JSON.parse(result.stderr) as { error_type: string; principal: null };
			expect(error.error_type, name).toBe("usage");
			expect(error.principal, name).toBeNull();
		}
	});

	test("every stdout line is a compact, newline-terminated §2 envelope with principal last", () => {
		const repo = fixture();
		for (const name of STREAMING) {
			const spec = SPECS[name];
			const streamed = runCli(repo.root, spec.stream, scratchCacheDir(), spec.stdin);
			expect(streamed.code, name).toBe(0);
			expect(streamed.stderr, name).toBe("");

			const batch = runCli(
				repo.root,
				STREAM_BATCH_INVOCATIONS[name].args,
				scratchCacheDir(),
				STREAM_BATCH_INVOCATIONS[name].stdin,
			);
			const batchData = (JSON.parse(batch.stdout) as Envelope).data;
			expect(checkStreamStdout(streamed.stdout, batchData, spec), name).toEqual([]);
		}
	});

	test("the last line carries the result kind with itemCount, and every non-item field equals the batch answer", () => {
		const repo = fixture();
		for (const name of STREAMING) {
			const spec = SPECS[name];
			const streamed = runCli(repo.root, spec.stream, scratchCacheDir(), spec.stdin);
			const lines = envelopes(streamed.stdout);
			expect(lines.length, name).toBeGreaterThanOrEqual(2);

			const result = lines[lines.length - 1];
			expect(result?.kind, name).toBe(spec.resultKind);
			const itemLines = lines.slice(0, -1);
			for (const item of itemLines) expect(item.kind, name).toBe(spec.itemKind);
			expect(result?.data.itemCount, name).toBe(itemLines.length);

			const batch = runCli(
				repo.root,
				STREAM_BATCH_INVOCATIONS[name].args,
				scratchCacheDir(),
				STREAM_BATCH_INVOCATIONS[name].stdin,
			);
			const batchData = (JSON.parse(batch.stdout) as Envelope).data;
			for (const [key, value] of Object.entries(batchData)) {
				if (key === spec.itemKey) continue;
				expect(result?.data[key], `${name}.${key}`).toEqual(value);
			}
		}
	});

	test("the item multiset equals the non-stream answer, for each command", () => {
		const repo = fixture();
		for (const name of STREAMING) {
			const spec = SPECS[name];
			const streamed = runCli(repo.root, spec.stream, scratchCacheDir(), spec.stdin);
			const batch = runCli(
				repo.root,
				STREAM_BATCH_INVOCATIONS[name].args,
				scratchCacheDir(),
				STREAM_BATCH_INVOCATIONS[name].stdin,
			);
			const batchData = (JSON.parse(batch.stdout) as Envelope).data;
			const streamedItems = envelopes(streamed.stdout)
				.slice(0, -1)
				.map((envelope) => JSON.stringify(envelope.data))
				.sort();
			const batchItems = (batchData[spec.itemKey] as unknown[]).map((item) => JSON.stringify(item)).sort();
			expect(streamedItems.length, name).toBeGreaterThan(0);
			expect(streamedItems, name).toEqual(batchItems);
		}
	});

	test("a forced mid-stream failure writes no result line, reports the error envelope, and exits 7", () => {
		const repo = fixture();
		for (const name of STREAMING) {
			const spec = SPECS[name];
			const failed = runCli(repo.root, spec.stream, scratchCacheDir(), spec.stdin, {
				[STREAM_FAIL_AFTER_ENV]: "1",
			});
			expect(failed.code, name).toBe(7);
			const lines = envelopes(failed.stdout);
			expect(lines.length, name).toBeGreaterThanOrEqual(1);
			for (const line of lines) expect(line.kind, name).toBe(spec.itemKind);
			expect(
				lines.some((line) => line.kind === spec.resultKind),
				name,
			).toBe(false);
			const error = JSON.parse(failed.stderr) as { error_type: string; message: string; principal: null };
			expect(error.error_type, name).toBe("indeterminate");
			expect(error.principal, name).toBeNull();
			expect(error.message).toContain("forced mid-stream failure");
		}
	});

	test("code-map keeps ADR 0005's wall-time budget, and the result line says whether it truncated", () => {
		const repo = fixture();
		const tiny = produceCodeMap({
			repositoryPath: repo.root,
			sourceRef: "HEAD",
			taskText: STREAM_CODEMAP_TASK,
			timeBudgetMs: 0,
			now: () => 0,
		});
		const tinyLine = JSON.parse(streamLine(kindOf("code-map"), codeMapStreamResultData(tiny))) as Envelope;
		expect(tinyLine.kind).toBe("code-map.result");
		expect(tinyLine.data.truncated).toBe(true);

		const generous = produceCodeMap({
			repositoryPath: repo.root,
			sourceRef: "HEAD",
			taskText: STREAM_CODEMAP_TASK,
			timeBudgetMs: 60_000,
			now: () => 0,
		});
		const generousLine = JSON.parse(streamLine(kindOf("code-map"), codeMapStreamResultData(generous))) as Envelope;
		expect(generousLine.kind).toBe("code-map.result");
		expect(generousLine.data.truncated).toBe(false);

		// The CLI's streaming path uses the same result-line builder: a run inside
		// the default 7.0 s budget reports truncated false on its last line.
		const streamed = runCli(
			repo.root,
			["code-map", "--source-ref", "HEAD", "--stream"],
			scratchCacheDir(),
			STREAM_CODEMAP_TASK,
		);
		expect(streamed.code).toBe(0);
		const streamedLines = envelopes(streamed.stdout);
		const streamedResult = streamedLines[streamedLines.length - 1];
		expect(streamedResult?.kind).toBe(kindOf("code-map"));
		expect(streamedResult?.data.truncated).toBe(false);
	});

	test("a run without --stream emits exactly the pre-stream golden bytes", () => {
		const repo = fixture();
		for (const name of STREAMING) {
			const invocation = STREAM_BATCH_INVOCATIONS[name];
			const batch = runCli(repo.root, invocation.args, scratchCacheDir(), invocation.stdin);
			expect(batch.code, name).toBe(0);
			expect(batch.stdout, name).toBe(STREAM_BATCH_GOLDENS[name]);
		}
	});

	test("the README's streaming example is the fixture's actual output", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n");
		const start = readme.findIndex((line) => line.startsWith("## Streaming"));
		expect(start).toBeGreaterThanOrEqual(0);
		let inFence = false;
		const example: string[] = [];
		for (let index = start + 1; index < readme.length; index += 1) {
			const line = readme[index] ?? "";
			if (!inFence) {
				if (line.trim() === "```console") inFence = true;
				continue;
			}
			if (line.trim() === "```") break;
			if (line.startsWith("$ ")) continue;
			example.push(line);
		}

		const repo = fixture();
		const streamed = runCli(repo.root, ["callers", "helper", "--stream"], scratchCacheDir());
		expect(streamed.code).toBe(0);
		expect(example).toEqual(streamed.stdout.split("\n").filter((line) => line.length > 0));
	});

	test("the flush proof: an item line is readable from the pipe while the child is still alive", async () => {
		const repo = fixture();
		const proc = Bun.spawn(["bun", "run", CLI, "callers", "helper", "--stream"], {
			cwd: repo.root,
			env: { ...process.env, GLYPH_CACHE_DIR: scratchCacheDir(), [STREAM_PAUSE_AFTER_ENV]: "400" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (!buffer.includes("\n")) {
			const { value, done } = await reader.read();
			if (done || value === undefined) break;
			buffer += decoder.decode(value, { stream: true });
		}
		const firstLine = buffer.slice(0, buffer.indexOf("\n"));
		expect(firstLine).toContain(`"kind":"${itemKindOf("callers")}"`);
		// The child is sleeping after the first item, so seeing it here proves the
		// line was flushed when written rather than buffered until exit.
		expect(proc.exitCode).toBeNull();
		await proc.exited;
		expect(proc.exitCode).toBe(0);
	});

	describe("the stream conformance check is proven on a deliberate violation", () => {
		const batch = { symbol: { name: "helper" }, totals: { callers: 1 }, index: { cache: "miss" } };
		const spec: StreamSpec = { itemKind: "callers.item", resultKind: "callers.result", itemKey: "callers" };
		const item = { file: "src/main.ts", line: 3, column: 10, kind: "call", caller: null };
		const clean =
			streamLine(spec.itemKind, item) +
			streamLine(spec.resultKind, { symbol: batch.symbol, totals: batch.totals, index: batch.index, itemCount: 1 });

		test("a clean stream has no findings, and a corrupted itemCount is named", () => {
			expect(checkStreamStdout(clean, batch, spec)).toEqual([]);
			const corrupted = clean.replace('"itemCount":1', '"itemCount":2');
			const findings = checkStreamStdout(corrupted, batch, spec);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toContain("ITEMCOUNT MISMATCH");
		});

		test("mutating the check, not the input, removes a predicted subset of findings", () => {
			// Two deliberate violations: itemCount wrong and principal not last.
			const corrupted = `${JSON.stringify({ schemaVersion: 1, kind: spec.itemKind, principal: null, data: item })}\n${streamLine(
				spec.resultKind,
				{ symbol: batch.symbol, totals: batch.totals, index: batch.index, itemCount: 9 },
			)}`;
			const both = checkStreamStdout(corrupted, batch, spec);
			expect(both.some((finding) => finding.startsWith("ITEMCOUNT MISMATCH"))).toBe(true);
			expect(both.some((finding) => finding.startsWith("PRINCIPAL NOT LAST"))).toBe(true);

			// Skipping only the itemCount assertion removes exactly that finding.
			const withoutItemCount = checkStreamStdout(corrupted, batch, spec, { skipItemCount: true });
			expect(withoutItemCount.some((finding) => finding.startsWith("ITEMCOUNT MISMATCH"))).toBe(false);
			expect(withoutItemCount.some((finding) => finding.startsWith("PRINCIPAL NOT LAST"))).toBe(true);

			// Skipping only the principal-position assertion removes exactly that one.
			const withoutPrincipal = checkStreamStdout(corrupted, batch, spec, { skipPrincipalLast: true });
			expect(withoutPrincipal.some((finding) => finding.startsWith("PRINCIPAL NOT LAST"))).toBe(false);
			expect(withoutPrincipal.some((finding) => finding.startsWith("ITEMCOUNT MISMATCH"))).toBe(true);
		});
	});
});
