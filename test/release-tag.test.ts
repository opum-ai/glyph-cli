import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/check-release-tag.mjs` refuses a tag that is not "v" + the packed
 * version.
 *
 * These tests run under `bun test`, so `process.execPath` and
 * `node:child_process` are Bun's implementations. The script itself runs with
 * the `node` binary in the release workflow; it uses only node built-ins, so
 * the two exercise the same logic.
 */
const script = fileURLToPath(new URL("../scripts/check-release-tag.mjs", import.meta.url));

function tarballWithVersion(version: string): string {
	const dir = mkdtempSync(join(tmpdir(), "glyph-tag-"));
	mkdirSync(join(dir, "package"), { recursive: true });
	writeFileSync(join(dir, "package", "package.json"), `${JSON.stringify({ name: "@opum-ai/glyph", version })}\n`);
	const tarball = join(dir, "pkg.tgz");
	const result = spawnSync("tar", ["-czf", tarball, "-C", dir, "package"], { encoding: "utf8" });
	expect(result.status).toBe(0);
	return tarball;
}

function run(refName: string, tarball: string) {
	return spawnSync(process.execPath, [script], {
		env: { ...process.env, GITHUB_REF_NAME: refName, RELEASE_TARBALL: tarball },
		encoding: "utf8",
	});
}

describe("check-release-tag", () => {
	test("accepts a tag that is v + the packed version", () => {
		const result = run("v0.1.0", tarballWithVersion("0.1.0"));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("matches the packed version");
	});

	test("rejects a mismatched tag", () => {
		const result = run("v0.1.1", tarballWithVersion("0.1.0"));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("does not match");
	});

	test("rejects a bare version with no v prefix", () => {
		const result = run("0.1.0", tarballWithVersion("0.1.0"));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("does not match");
	});

	test("rejects a missing tag", () => {
		const result = run("", tarballWithVersion("0.1.0"));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("GITHUB_REF_NAME is not set");
	});
});
