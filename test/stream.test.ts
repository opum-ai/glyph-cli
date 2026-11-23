import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codeMapTruncated, produceCodeMap } from "../src/codemap.ts";
import {
	buildManifest,
	itemKindOf,
	kindOf,
	STREAMING_COMMANDS,
	streamItemKinds,
	validateResultKinds,
} from "../src/contract.ts";
import { checkStreamStdout, codeMapStreamResultData, streamLine, type StreamSpec } from "../src/stream.ts";
import { makeScratchRepo, scratchCacheDir, type ScratchRepo } from "./helpers.ts";
import { STREAM_BATCH_GOLDENS } from "./stream-goldens.ts";
import { STREAM_BATCH_INVOCATIONS, STREAM_CODEMAP_TASK, STREAM_FIXTURE_FILES } from "./stream-fixtures.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
/** The test-only entry point that installs the fault hook; the shipped CLI does not. */
const TEST_ENTRY = new URL("./support/stream-entry.ts", import.meta.url).pathname;

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

/** Spawn the test-only entry point, which installs the stream hook from env. */
function runEntry(
	cwd: string,
	args: string[],
	cacheDir: string,
	stdin?: string,
	env?: Record<string, string>,
): CliResult {
	const proc = Bun.spawnSync(["bun", "run", TEST_ENTRY, ...args], {
		cwd,
		env: { ...process.env, GLYPH_CACHE_DIR: cacheDir, ...env },
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
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

		// The manifest publishes each streaming command's itemKind, and no other
		// command has one, so `help --json` carries the item kinds (finding 4).
		const published = manifest.commands
			.filter((command) => command.itemKind !== undefined)
			.map((command) => command.itemKind)
			.sort();
		expect(published).toEqual(["callers.item", "code-map.item", "impact.item"]);
		expect(manifest.commands.map((command) => command.itemKind).filter((kind) => kind === undefined)).toHaveLength(
			manifest.commands.length - 3,
		);
		for (const command of manifest.commands) {
			if (STREAMING.includes(command.name as (typeof STREAMING)[number])) {
				expect(command.itemKind, command.name).toBe(`${command.name}.item`);
			} else {
				expect(Object.hasOwn(command, "itemKind"), command.name).toBe(false);
			}
		}
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

	test("--stream is rejected with --version, --help and a bare invocation", () => {
		const repo = fixture();
		const cases: Array<[string, string[]]> = [
			["--version", ["--version", "--stream"]],
			["--help", ["--help", "--stream"]],
			["command --help", ["callers", "helper", "--stream", "--help"]],
			// Exercises program.ts's `|| scanned.version` branch: a streaming
			// command token is present, but --version still rejects --stream.
			["command --version", ["callers", "helper", "--stream", "--version"]],
			["version before command", ["--version", "callers", "helper", "--stream"]],
			["bare", ["--stream"]],
		];
		for (const [label, args] of cases) {
			const result = runCli(repo.root, args, scratchCacheDir());
			expect(result.code, label).toBe(2);
			expect(result.stdout, label).toBe("");
			const error = JSON.parse(result.stderr) as { error_type: string; principal: null };
			expect(error.error_type, label).toBe("usage");
			expect(error.principal, label).toBeNull();
		}
	});

	test("a --stream after --file is parsed as the flag, not swallowed as --file's value", () => {
		const repo = fixture();
		// `--stream` is registered at program level (hidden) as `--json` is, so
		// commander extracts it and `--file` is left without a value: a usage error,
		// not a batch query whose file pattern is the literal string `--stream`.
		const result = runCli(repo.root, ["callers", "helper", "--file", "--stream"], scratchCacheDir());
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		const error = JSON.parse(result.stderr) as { error_type: string; principal: null };
		expect(error.error_type).toBe("usage");
		expect(error.principal).toBeNull();
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
			const failed = runEntry(repo.root, spec.stream, scratchCacheDir(), spec.stdin, {
				GLYPH_TEST_STREAM_FAIL_AFTER: "1",
			});
			expect(failed.code, name).toBe(7);
			const lines = envelopes(failed.stdout);
			// Exactly one item line: a command that swallowed the item error and kept
			// emitting would produce more, so this catches the swallowing case.
			expect(lines.length, name).toBe(1);
			expect(lines[0]?.kind, name).toBe(spec.itemKind);
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

	test("a one-item answer cannot slip a result line past the injected failure", () => {
		// One call site means exactly one item. The injected throw lands on the
		// result write, after that item, proving the result() hook catches the
		// one-item case the stream.ts comment describes.
		const repo = makeScratchRepo({
			"src/util.ts": "export function solo(): number {\n  return 1;\n}\n",
			"src/main.ts": 'import { solo } from "./util";\nexport function main(): number {\n  return solo();\n}\n',
		});
		repo.commit("base");
		const failed = runEntry(repo.root, ["callers", "solo", "--stream"], scratchCacheDir(), undefined, {
			GLYPH_TEST_STREAM_FAIL_AFTER: "1",
		});
		expect(failed.code).toBe(7);
		const lines = envelopes(failed.stdout);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.kind).toBe(itemKindOf("callers"));
		expect(lines.some((line) => line.kind === kindOf("callers"))).toBe(false);
		const error = JSON.parse(failed.stderr) as { error_type: string };
		expect(error.error_type).toBe("indeterminate");
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

		// The CLI path with a pinned zero budget: ADR 0005 stops the run and the
		// result line says truncated true. The budget override is a test-entry seam.
		const tinyCli = runEntry(
			repo.root,
			["code-map", "--source-ref", "HEAD", "--stream"],
			scratchCacheDir(),
			STREAM_CODEMAP_TASK,
			{ GLYPH_TEST_CODE_MAP_TIME_BUDGET_MS: "0" },
		);
		expect(tinyCli.code).toBe(0);
		const tinyLines = envelopes(tinyCli.stdout);
		const tinyResult = tinyLines[tinyLines.length - 1];
		expect(tinyResult?.kind).toBe(kindOf("code-map"));
		expect(tinyResult?.data.truncated).toBe(true);
	});

	test("code-map's onPointer fires exactly for the pointers the token cap keeps", () => {
		// Twelve long identifiers matched by ten files make the pointer reasons large
		// enough that the 2,000-token cap drops the tail; the stream seam must see
		// exactly what the batch answer returns, no more.
		const ids = Array.from({ length: 12 }, (_, index) => `identifier${index}${"x".repeat(40)}`);
		const files: Record<string, string> = {};
		for (let file = 0; file < 10; file += 1) {
			files[`src/file-${String(file).padStart(2, "0")}.ts`] =
				`// ${ids.join(" ")}\nexport const value${file} = ${file};\n`;
		}
		const repo = makeScratchRepo(files);
		repo.commit("base");
		const taskText = `fix ${ids.map((id) => `\`${id}\``).join(" ")}`;
		const collected: string[] = [];
		const output = produceCodeMap({
			repositoryPath: repo.root,
			sourceRef: "HEAD",
			taskText,
			onPointer: (pointer) => collected.push(pointer.path),
		});
		// The fixture really exercises the token cap, so the assertion is not vacuous.
		expect(output.omissions.some((row) => row.reason.includes("token cap"))).toBe(true);
		// A token-cap cut is NOT budget truncation: `truncated` stays false, which
		// is the narrow meaning DEC-299 and section 1a give the field.
		expect(codeMapTruncated(output)).toBe(false);
		expect(output.pointers.length).toBeGreaterThan(0);
		expect(output.pointers.length).toBeLessThan(10);
		expect(collected).toEqual(output.pointers.map((pointer) => pointer.path));
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
		let command = "";
		const example: string[] = [];
		for (let index = start + 1; index < readme.length; index += 1) {
			const line = readme[index] ?? "";
			if (!inFence) {
				if (line.trim() === "```console") inFence = true;
				continue;
			}
			if (line.trim() === "```") break;
			if (line.startsWith("$ ")) {
				command = line.slice(2);
				continue;
			}
			example.push(line);
		}
		expect(command).toBe("glyph callers helper --stream");

		const repo = fixture();
		const streamed = runCli(repo.root, ["callers", "helper", "--stream"], scratchCacheDir());
		expect(streamed.code).toBe(0);
		expect(example).toEqual(streamed.stdout.split("\n").filter((line) => line.length > 0));
	});

	test("the README's callers example is the fixture's actual output", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n");
		const start = readme.findIndex((line) => line.startsWith("### `glyph callers"));
		expect(start).toBeGreaterThanOrEqual(0);
		let inFence = false;
		let command = "";
		const example: string[] = [];
		for (let index = start + 1; index < readme.length; index += 1) {
			const line = readme[index] ?? "";
			if (!inFence) {
				if (line.trim() === "```console") inFence = true;
				continue;
			}
			if (line.trim() === "```") break;
			if (line.startsWith("$ ")) command = line.slice(2);
			else example.push(line);
		}
		expect(command).toBe("glyph callers helper");

		const repo = fixture();
		const run = runCli(repo.root, ["callers", "helper"], scratchCacheDir());
		expect(run.code).toBe(0);
		expect(example).toEqual(run.stdout.split("\n").filter((line) => line.length > 0));
	});

	test("the flush proof: an item line is readable from the pipe while the child is still alive", async () => {
		const repo = fixture();
		const pauseMs = 1500;
		const proc = Bun.spawn(["bun", "run", TEST_ENTRY, "callers", "helper", "--stream"], {
			cwd: repo.root,
			env: {
				...process.env,
				GLYPH_CACHE_DIR: scratchCacheDir(),
				GLYPH_TEST_STREAM_PAUSE_AFTER_MS: String(pauseMs),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const timedOut = Symbol("timeout");
		let timer: ReturnType<typeof setTimeout> | undefined;
		// A generous overall bound. Bun startup, loading TypeScript and a cold
		// createProgram all happen before the first item and are not the property
		// under test; the pause is the only thing this test measures.
		const deadline = new Promise<typeof timedOut>((resolve) => {
			timer = setTimeout(() => resolve(timedOut), 30_000);
		});
		const firstLine = await Promise.race([
			(async () => {
				while (!buffer.includes("\n")) {
					const { value, done } = await reader.read();
					if (done || value === undefined) return null;
					buffer += decoder.decode(value, { stream: true });
				}
				return buffer.slice(0, buffer.indexOf("\n"));
			})(),
			deadline,
		]);
		clearTimeout(timer);
		if (typeof firstLine !== "string") throw new Error(`no item line arrived: ${String(firstLine)}`);
		const arrivedAt = performance.now();
		expect(firstLine).toContain(`"kind":"${itemKindOf("callers")}"`);
		// The child is still in its post-first-item pause when the line arrives.
		expect(proc.exitCode).toBeNull();
		await proc.exited;
		// A flushed writer arrives before the pause and the child lives another
		// ~pauseMs afterwards. A writer that buffered until the result line would
		// write the first line only at the end, so it could not stay alive.
		expect(performance.now() - arrivedAt).toBeGreaterThanOrEqual(1000);
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
