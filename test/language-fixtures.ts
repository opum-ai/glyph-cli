import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The TypeScript-only repository the byte-identity golden is captured on.
 *
 * It is deliberately free of recognised non-TypeScript source, so every language
 * entry the seam can add must be ABSENT from its answers (ADR 0008, GCLI-70).
 * Two commits give `diff` and `--ref` real history; the SHAs are reproducible
 * because the commits are written with a fixed identity and date under an
 * isolated git config (the repository's own precedent,
 * `test/parity/fixtures.ts`), so a hostile global config cannot move them and
 * the generator's capture and the test's own fixture describe the same commits.
 */

const FIXED_DATE = "2026-01-01T00:00:00Z";

/** An isolated git environment: the caller's global/system config cannot reach it. */
function fixtureEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "glyph test",
		GIT_AUTHOR_EMAIL: "test@opum.test",
		GIT_COMMITTER_NAME: "glyph test",
		GIT_COMMITTER_EMAIL: "test@opum.test",
		GIT_AUTHOR_DATE: FIXED_DATE,
		GIT_COMMITTER_DATE: FIXED_DATE,
	};
}

function git(root: string, args: string[]): string {
	const proc = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: fixtureEnv() });
	if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
	return proc.stdout.trim();
}

export interface LanguageFixture {
	root: string;
	/** The first commit; `diff`'s base. Reproducible across runs and hostile configs. */
	base: string;
	/** The second commit; `diff`'s head and HEAD. */
	head: string;
}

export function buildLanguageFixture(): LanguageFixture {
	const root = mkdtempSync(join(tmpdir(), "glyph-lang-fixture-"));
	const write = (relPath: string, content: string): void => {
		const absolute = join(root, relPath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	};
	const commit = (message: string): string => {
		git(root, ["add", "-A"]);
		git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", message]);
		return git(root, ["rev-parse", "HEAD"]);
	};

	git(root, ["init", "-q"]);
	write("src/util.ts", "export function helper(n: number): number {\n  return n + 1;\n}\n");
	write("src/main.ts", 'import { helper } from "./util";\nexport function main(): number {\n  return helper(1);\n}\n');
	const base = commit("base");

	write(
		"src/main.ts",
		'import { helper } from "./util";\nexport function main(): number {\n  const total = helper(1);\n  return total;\n}\n',
	);
	const head = commit("tweak main");

	return { root, base, head };
}

export interface GoldenInvocation {
	args: string[];
	stdin?: string;
	/**
	 * Run this many times in ONE cache and capture the last output (2 = a cache
	 * hit). Absent, the invocation runs once in a fresh cache (a miss).
	 */
	repeat?: number;
}

/**
 * Every invocation the byte-identity golden pins, on the fixture above. These are
 * the answers the language seam could perturb: the batch answers, the human-text
 * answers, the streamed (NDJSON) answers, the `--ref` answer, and the cache-hit
 * path — each reads the shared index `loadIndex` now builds through the seam.
 *
 * Deliberately NOT here, and why:
 * - `code-map`: its tier-3 index is read by `codemap-tier3.ts` straight from
 *   `indexSnapshot`, not through the seam, and is already pinned byte-for-byte
 *   against the producer by `test/parity.test.ts`.
 * - `cache path` / `cache clear`: they read no index and print absolute paths.
 * - `help`: `--language` is an intended additive entry in its manifest, so it
 *   cannot be byte-identical to dev; a separate test asserts the addition.
 * - `version`: it reads no index, and a `package.json` version bump would fail it
 *   while the generator could not repair it.
 */
export function languageGoldenInvocations(fixture: LanguageFixture): Record<string, GoldenInvocation> {
	return {
		callers: { args: ["--json", "callers", "helper"] },
		impact: { args: ["--json", "impact", "helper"] },
		diff: { args: ["--json", "diff", fixture.base, "HEAD"] },
		impact_ref: { args: ["--json", "impact", "helper", "--ref", "HEAD"] },
		callers_human: { args: ["callers", "helper"] },
		impact_human: { args: ["impact", "helper"] },
		callers_stream: { args: ["callers", "helper", "--stream"] },
		impact_stream: { args: ["impact", "helper", "--stream"] },
		callers_cache_hit: { args: ["--json", "callers", "helper"], repeat: 2 },
	};
}
