import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLanguageFixture, languageGoldenInvocations } from "./language-fixtures.ts";
import { LANGUAGE_GOLDENS } from "./language-goldens.ts";

/**
 * Byte identity for a TypeScript-only repository (ADR 0008, GCLI-70).
 *
 * `test/language-goldens.ts` was captured from an unmodified dev build
 * (`test/goldens/gen-language-goldens.ts`). Every invocation here reads the
 * shared index the language seam now governs, so any byte the seam perturbs in
 * a TypeScript-only answer fails this test. The invocations excluded from the
 * golden, and why, are named in `test/language-fixtures.ts`.
 */

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[], cacheDir: string, stdin?: string): CliResult {
	const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
		cwd,
		env: { ...process.env, GLYPH_CACHE_DIR: cacheDir },
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("TypeScript-only byte identity", () => {
	const fixture = buildLanguageFixture();
	const invocations = languageGoldenInvocations(fixture);

	test("the golden covers exactly the seam's invocations, non-vacuously", () => {
		expect(Object.keys(LANGUAGE_GOLDENS).length).toBeGreaterThan(0);
		expect(Object.keys(LANGUAGE_GOLDENS).sort()).toEqual(Object.keys(invocations).sort());
		for (const stdout of Object.values(LANGUAGE_GOLDENS)) expect(stdout.length).toBeGreaterThan(0);
	});

	for (const [name, invocation] of Object.entries(invocations)) {
		test(`${name}: a TypeScript-only answer is byte-identical to the dev golden`, () => {
			const cache = mkdtempSync(join(tmpdir(), "glyph-lang-golden-cache-"));
			const result = runCli(fixture.root, invocation.args, cache, invocation.stdin);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe(LANGUAGE_GOLDENS[name] as string);
		});
	}
});
