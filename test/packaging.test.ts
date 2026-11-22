import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shipped package's shape (GCLI-46, DEC-299 item 2).
 *
 * These assertions are about package.json, which is the surface npm reads
 * before the bundle exists. The built artifact itself — its Node shebang, what
 * the tarball contains, and every command run under node from an installed
 * copy — is proved by scripts/check-package.mjs in the Package CI job, because
 * that has to install the tarball and cannot be a unit test.
 *
 * `private` and `version` are this slice's values. The release change that
 * flips them (DEC-299) updates these two assertions with package.json.
 */
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

describe("the shipped package manifest", () => {
	test("the bin points at the bundled Node entry", () => {
		expect(packageJson.bin).toEqual({ glyph: "dist/glyph.js" });
	});

	test("files is exactly the bundle and the two shipped documents", () => {
		expect(packageJson.files).toEqual(["dist", "README.md", "LICENSE"]);
	});

	test("the runtime engine is Node >= 24, while development stays on Bun", () => {
		expect(packageJson.engines).toEqual({ node: ">=24" });
		expect(packageJson.packageManager).toStartWith("bun@");
	});

	test("the bundle is built by prepack, and its externals stay runtime dependencies", () => {
		expect(packageJson.scripts.prepack).toBeDefined();
		expect(packageJson.scripts.build).toBeDefined();
		expect(packageJson.dependencies.typescript).toBeDefined();
		expect(packageJson.dependencies.commander).toBeDefined();
	});

	test("private stays true and version stays 0.0.0 in this slice", () => {
		expect(packageJson.private).toBe(true);
		expect(packageJson.version).toBe("0.0.0");
	});

	test("a built bundle, when present, starts with the Node shebang", () => {
		const dist = fileURLToPath(new URL("../dist/glyph.js", import.meta.url));
		if (!existsSync(dist)) return; // The Check job does not build; the Package job proves this artifact.
		expect(readFileSync(dist, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
	});

	// tsconfig's `types: ["bun"]` still offers the Bun global to every source
	// file, so a Bun.* regression would typecheck. This guard is cheap and runs
	// in the Check job; the Package job proves the artifact itself.
	test("no shipped source references a Bun global", () => {
		const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
		const offenders = (readdirSync(srcDir, { recursive: true }) as string[])
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => /\bBun\./.test(readFileSync(join(srcDir, name), "utf8")));
		expect(offenders).toEqual([]);
	});
});
