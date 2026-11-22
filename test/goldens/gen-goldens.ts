#!/usr/bin/env bun
/**
 * Regenerate `test/stream-goldens.ts` from the PRE-STREAM commit `a0aecda`
 * (dev before the streaming change), so the committed goldens prove that a
 * batch `--json` answer is byte-for-byte unchanged by `--stream`.
 *
 * Run from anywhere: `bun run test/goldens/gen-goldens.ts`.
 *
 * It archives `a0aecda` with `git archive`, links the repository's existing
 * `node_modules` beside the archive, and runs that baseline CLI against the
 * shared fixture with a fresh cache per invocation. Regenerating it against the
 * current tree must reproduce `test/stream-goldens.ts` with an empty diff.
 */
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { makeScratchRepo } from "../helpers.ts";
import { STREAM_BATCH_INVOCATIONS, STREAM_FIXTURE_FILES } from "../stream-fixtures.ts";

const BASELINE_COMMIT = "a0aecda";
const repoRoot = resolve(import.meta.dir, "..", "..");

function run(command: string[], cwd: string, stdin?: Uint8Array) {
	const proc = Bun.spawnSync(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		...(stdin === undefined ? {} : { stdin }),
	});
	if (proc.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout;
}

/** Walk up from `start` to the nearest directory holding `node_modules`. */
function nearestNodeModules(start: string): string {
	let dir = start;
	while (true) {
		const candidate = join(dir, "node_modules");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`no node_modules found above ${start}`);
		dir = parent;
	}
}

const baseline = mkdtempSync(join(tmpdir(), "glyph-golden-baseline-"));
const archive = run(["git", "archive", BASELINE_COMMIT], repoRoot);
run(["tar", "-x", "-C", baseline], repoRoot, archive);
symlinkSync(nearestNodeModules(repoRoot), join(baseline, "node_modules"), "dir");

const fixture = makeScratchRepo(STREAM_FIXTURE_FILES);
fixture.commit("base");

const out: Record<string, string> = {};
for (const [name, invocation] of Object.entries(STREAM_BATCH_INVOCATIONS)) {
	const cache = mkdtempSync(join(tmpdir(), "glyph-golden-cache-"));
	const proc = Bun.spawnSync(["bun", "run", join(baseline, "src", "cli.ts"), ...invocation.args], {
		cwd: fixture.root,
		env: { ...process.env, GLYPH_CACHE_DIR: cache },
		stdin: invocation.stdin === undefined ? "ignore" : Buffer.from(invocation.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`${name} failed on the baseline: ${proc.stderr.toString()}`);
	out[name] = proc.stdout.toString();
}

const body = [
	"// Generated from the pre-stream commit by test/goldens/gen-goldens.ts.",
	"// The batch answer without --stream must stay byte-for-byte this.",
	'export const STREAM_BATCH_GOLDENS: Record<"callers" | "impact" | "code-map", string> = {',
	...Object.entries(out).map(
		([name, stdout]) => `\t${name === "code-map" ? '"code-map"' : name}: ${JSON.stringify(stdout)},`,
	),
	"};",
	"",
].join("\n");

const target = join(repoRoot, "test", "stream-goldens.ts");
writeFileSync(target, body);
// The repository's formatter owns the file's layout; running it here makes a
// regeneration reproduce the committed file byte-for-byte (an empty git diff).
const formatted = Bun.spawnSync(["bun", "run", "biome", "format", "--write", target], {
	cwd: repoRoot,
	stdout: "pipe",
	stderr: "pipe",
});
if (formatted.exitCode !== 0) throw new Error(`biome format failed: ${formatted.stderr.toString()}`);
console.log(`regenerated test/stream-goldens.ts from ${BASELINE_COMMIT}`);
