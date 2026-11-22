#!/usr/bin/env node
import { spawnSync } from "node:child_process";

/*
 * Refuse to publish unless the dispatch tag names the version inside the
 * tarball being published (GCLI-46 review H1).
 *
 * The publish job already refuses any ref that is not refs/tags/v*, but a
 * `v0.2.0` dispatch could still publish a tarball whose package.json says
 * 0.1.0, or the reverse. This reads the version out of the PACKED tarball —
 * the bytes that would reach the registry — and requires GITHUB_REF_NAME to be
 * exactly "v" + that version.
 *
 * GITHUB_REF_NAME is passed in from the workflow through env: (DEC-240: step
 * values reach the shell through env, never through run interpolation).
 * RELEASE_TARBALL names the downloaded artifact.
 */

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

const refName = process.env.GITHUB_REF_NAME;
const tarball = process.env.RELEASE_TARBALL;
if (typeof refName !== "string" || refName === "") fail("GITHUB_REF_NAME is not set");
if (typeof tarball !== "string" || tarball === "") fail("RELEASE_TARBALL is not set");

const tar = spawnSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" });
if (tar.status !== 0) fail(`could not read package.json from ${tarball}: ${(tar.stderr ?? "").trim()}`);
let version;
try {
	version = JSON.parse(tar.stdout).version;
} catch (error) {
	fail(`package.json in ${tarball} is not JSON: ${error.message}`);
}
if (typeof version !== "string" || version === "") fail(`package.json in ${tarball} has no version`);

const expected = `v${version}`;
if (refName !== expected) {
	fail(`tag ${refName} does not match the packed version ${version} (expected ${expected})`);
}
console.log(`tag ${refName} matches the packed version ${version}`);
