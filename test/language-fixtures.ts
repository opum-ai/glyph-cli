import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The TypeScript-only repository the byte-identity golden is captured on.
 *
 * It is deliberately free of non-TypeScript source, so every language entry the
 * seam can add must be ABSENT from its answers (ADR 0008, GCLI-70). Two commits
 * give `diff` real history; the SHAs are reproducible because the commits are
 * written with a fixed identity and date, so the generator's capture and the
 * test's own fixture describe the same commits byte for byte.
 */

const FIXED_DATE = "1577836800 +0000"; // 2020-01-01T00:00:00Z

const COMMIT_ENV = {
	GIT_AUTHOR_NAME: "glyph test",
	GIT_AUTHOR_EMAIL: "test@opum.test",
	GIT_AUTHOR_DATE: FIXED_DATE,
	GIT_COMMITTER_NAME: "glyph test",
	GIT_COMMITTER_EMAIL: "test@opum.test",
	GIT_COMMITTER_DATE: FIXED_DATE,
} as const;

function git(root: string, args: string[]): string {
	const proc = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...COMMIT_ENV },
	});
	if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
	return proc.stdout.trim();
}

export interface LanguageFixture {
	root: string;
	/** The first commit; `diff`'s base. Reproducible across runs. */
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

	git(root, ["init", "-q"]);
	write("src/util.ts", "export function helper(n: number): number {\n  return n + 1;\n}\n");
	write("src/main.ts", 'import { helper } from "./util";\nexport function main(): number {\n  return helper(1);\n}\n');
	git(root, ["add", "-A"]);
	git(root, ["commit", "-qm", "base"]);
	const base = git(root, ["rev-parse", "HEAD"]);

	write(
		"src/main.ts",
		'import { helper } from "./util";\nexport function main(): number {\n  const total = helper(1);\n  return total;\n}\n',
	);
	git(root, ["commit", "-qam", "tweak main"]);
	const head = git(root, ["rev-parse", "HEAD"]);

	return { root, base, head };
}

export interface GoldenInvocation {
	args: string[];
	stdin?: string;
}

/**
 * Every invocation the byte-identity golden pins, on the fixture above. These
 * are the answers the language seam could perturb: `callers`, `impact` and
 * `diff` all read the shared index `loadIndex` now builds through it.
 *
 * Deliberately NOT here, and why:
 * - `code-map`: its tier-3 index is read by `codemap-tier3.ts` straight from
 *   `indexSnapshot`, not through the seam, and is already pinned byte-for-byte
 *   against the producer by `test/parity.test.ts`.
 * - `cache path` / `cache clear`: they read no index and print absolute paths.
 * - `help`: `--language` is an intended additive entry in its manifest, so it
 *   cannot be byte-identical to dev; a separate test asserts the addition.
 */
export function languageGoldenInvocations(fixture: LanguageFixture): Record<string, GoldenInvocation> {
	return {
		callers: { args: ["--json", "callers", "helper"] },
		impact: { args: ["--json", "impact", "helper"] },
		diff: { args: ["--json", "diff", fixture.base, "HEAD"] },
		version: { args: ["--json", "--version"] },
	};
}
