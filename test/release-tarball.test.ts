import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/verify-release-tarball.mjs` binds the Publish job's bytes to the
 * digest the Package job recorded (GCLI-47 N1).
 *
 * These tests run under `bun test`, so `process.execPath` is Bun; the script
 * uses only node built-ins and is run with the `node` binary in the workflow,
 * so the two exercise the same logic. The mutations below (two tarballs, an
 * altered tarball, a wrong digest, a wrong name, and the clean case) are the
 * proof the check is not vacuous.
 */
const script = fileURLToPath(new URL("../scripts/verify-release-tarball.mjs", import.meta.url));

function sha256(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function dirWith(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "glyph-release-"));
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(dir, name), contents);
	}
	return dir;
}

function run(args: string[]) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("verify-release-tarball", () => {
	test("accepts the single tarball whose name and digest match the recorded ones", () => {
		const dir = dirWith({ "opum-ai-glyph-0.1.0.tgz": "tarball-bytes" });
		const result = run(["verify", dir, sha256("tarball-bytes"), "opum-ai-glyph-0.1.0.tgz"]);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(join(dir, "opum-ai-glyph-0.1.0.tgz"));
	});

	test("rejects two tarballs: exactly one is required", () => {
		const dir = dirWith({ "a.tgz": "a", "b.tgz": "b" });
		const result = run(["verify", dir, sha256("a"), "a.tgz"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("expected exactly one .tgz");
	});

	test("rejects a tarball altered after its digest was recorded", () => {
		const dir = dirWith({ "glyph.tgz": "original" });
		writeFileSync(join(dir, "glyph.tgz"), "altered");
		const result = run(["verify", dir, sha256("original"), "glyph.tgz"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("but the Package job recorded");
	});

	test("rejects a wrong expected digest", () => {
		const dir = dirWith({ "glyph.tgz": "bytes" });
		const result = run(["verify", dir, "0".repeat(64), "glyph.tgz"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("but the Package job recorded");
	});

	test("rejects a tarball whose name is not the recorded one", () => {
		const dir = dirWith({ "glyph.tgz": "bytes" });
		const result = run(["verify", dir, sha256("bytes"), "other.tgz"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("is named glyph.tgz, but the Package job recorded other.tgz");
	});

	test("record emits tarball and sha256 for exactly one tarball", () => {
		const dir = dirWith({ "glyph.tgz": "bytes" });
		const result = run(["record", dir]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("tarball=glyph.tgz");
		expect(result.stdout).toContain(`sha256=${sha256("bytes")}`);
	});
});
