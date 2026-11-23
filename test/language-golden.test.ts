import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLanguageFixture, type GoldenInvocation, languageGoldenInvocations } from "./language-fixtures.ts";
import { LANGUAGE_GOLDENS } from "./language-goldens.ts";

/**
 * Byte identity for a TypeScript-only repository (ADR 0008, GCLI-70).
 *
 * `test/language-goldens.ts` was captured from an unmodified dev build
 * (`test/goldens/gen-language-goldens.ts`) over the batch, human-text, streamed,
 * `--ref` and cache-hit answers. Every invocation reads the shared index the
 * language seam now governs, so any byte the seam perturbs in a TypeScript-only
 * answer fails this test. The invocations excluded from the golden, and why, are
 * named in `test/language-fixtures.ts`.
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

/** Run an invocation in its cache and return the captured (last) stdout. */
function capture(root: string, invocation: GoldenInvocation): string {
	const cache = mkdtempSync(join(tmpdir(), "glyph-lang-golden-cache-"));
	const runs = invocation.repeat ?? 1;
	let stdout = "";
	for (let attempt = 0; attempt < runs; attempt += 1) {
		const result = runCli(root, invocation.args, cache, invocation.stdin);
		expect(result.code).toBe(0);
		stdout = result.stdout;
	}
	return stdout;
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
			expect(capture(fixture.root, invocation)).toBe(LANGUAGE_GOLDENS[name] as string);
		});
	}

	test("a hostile global git config cannot move the fixture or the answer", () => {
		// The fixture commits with a fixed identity under an isolated config (the
		// parity precedent); this proves it. A hostile config would otherwise move
		// the diff/--ref SHAs or break the commit.
		const hostile = join(mkdtempSync(join(tmpdir(), "glyph-lang-hostile-")), "gitconfig");
		writeFileSync(
			hostile,
			[
				"[user]\n\tname = Hostile User\n\temail = hostile@example.test",
				"[commit]\n\tgpgsign = true",
				"[core]\n\tquotepath = false",
				"",
			].join("\n"),
		);
		const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
		try {
			process.env.GIT_CONFIG_GLOBAL = hostile;
			process.env.GIT_CONFIG_NOSYSTEM = "1";
			const hostileFixture = buildLanguageFixture();
			// Positive control: the hostile config is in force for a git read that is
			// not isolated, so the equal bytes below were produced under it.
			const probe = spawnSync("git", ["-C", hostileFixture.root, "config", "user.email"], {
				encoding: "utf8",
				env: { ...process.env },
			});
			expect(probe.stdout.trim()).toBe("hostile@example.test");
			for (const [name, invocation] of Object.entries(languageGoldenInvocations(hostileFixture))) {
				expect(capture(hostileFixture.root, invocation)).toBe(LANGUAGE_GOLDENS[name] as string);
			}
		} finally {
			if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved.global;
			if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
			else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
		}
	});
});
