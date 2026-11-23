#!/usr/bin/env bun
/**
 * Regenerate `test/language-goldens.ts` from an UNMODIFIED dev build, so the
 * committed goldens prove the language seam (ADR 0008, GCLI-70) leaves a
 * TypeScript-only repository's answers byte-for-byte unchanged.
 *
 * Run from anywhere: `bun run test/goldens/gen-language-goldens.ts`.
 *
 * It archives the baseline commit with `git archive`, links the repository's
 * own `node_modules` beside the archive, and runs that baseline CLI against the
 * shared deterministic fixture with a fresh cache per invocation. Regenerating
 * it against the current tree must reproduce `test/language-goldens.ts` with an
 * empty diff.
 */
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildLanguageFixture, languageGoldenInvocations } from "../language-fixtures.ts";

/** `origin/dev` when GCLI-70 branched: a build with no language seam at all. */
const BASELINE_COMMIT = "4cf670e";
const repoRoot = resolve(import.meta.dir, "..", "..");

function run(command: string[], cwd: string, stdin?: Uint8Array): Uint8Array {
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

const baseline = mkdtempSync(join(tmpdir(), "glyph-lang-golden-baseline-"));
const archive = run(["git", "archive", BASELINE_COMMIT], repoRoot);
run(["tar", "-x", "-C", baseline], repoRoot, archive);
symlinkSync(nearestNodeModules(repoRoot), join(baseline, "node_modules"), "dir");

const fixture = buildLanguageFixture();
const invocations = languageGoldenInvocations(fixture);

const out: Record<string, string> = {};
for (const [name, invocation] of Object.entries(invocations)) {
	const cache = mkdtempSync(join(tmpdir(), "glyph-lang-golden-cache-"));
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
	`// Generated from dev commit ${BASELINE_COMMIT} by test/goldens/gen-language-goldens.ts.`,
	"// A TypeScript-only repository's answers must stay byte-for-byte this.",
	"export const LANGUAGE_GOLDENS: Record<string, string> = {",
	...Object.entries(out).map(([name, stdout]) => `\t${name}: ${JSON.stringify(stdout)},`),
	"};",
	"",
].join("\n");

const target = join(repoRoot, "test", "language-goldens.ts");
writeFileSync(target, body);
// The repository's formatter owns the file's layout; running it here makes a
// regeneration reproduce the committed file byte-for-byte (an empty git diff).
const formatted = Bun.spawnSync(["bun", "run", "biome", "format", "--write", target], {
	cwd: repoRoot,
	stdout: "pipe",
	stderr: "pipe",
});
if (formatted.exitCode !== 0) throw new Error(`biome format failed: ${formatted.stderr.toString()}`);
console.log(`regenerated test/language-goldens.ts from ${BASELINE_COMMIT}`);
