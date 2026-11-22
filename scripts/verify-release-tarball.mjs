#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Bind the bytes the Publish job uploads to the tarball the Package job
 * verified (GCLI-47 N1).
 *
 * Why this exists. The Package job used to write SHA256SUMS beside the tarball
 * and upload both in one artifact; the Publish job then ran `sha256sum -c
 * SHA256SUMS`. A sums file that travels with the bytes it describes proves only
 * that the transfer preserved both together — a swapped tarball and a swapped
 * sums file still match. The gate's own digest (scripts/check-package.mjs,
 * printed) was never compared. The Package job now exports the digest it
 * verified as a job output, and this script checks the downloaded file against
 * that value, which did not travel with the artifact.
 *
 * Two modes, both run with `node`:
 *
 *   record <dir>
 *     Assert exactly one *.tgz in <dir>, hash it, and print
 *     `tarball=<name>` / `sha256=<hex>` for $GITHUB_OUTPUT.
 *
 *   verify <dir> <expected-sha256> <expected-name>
 *     Assert exactly one *.tgz, hash it, and fail unless both its digest and
 *     its name match what the Package job recorded. On success print the one
 *     tarball's path on stdout, so the tag check and the publish step share
 *     exactly the file this check verified.
 *
 * node:crypto rather than a shell utility: the same logic runs on macOS and the
 * Linux runner, and the unit test (test/release-tarball.test.ts, under Bun) can
 * drive it with no `sha256sum` dependency.
 */

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

function onlyTarball(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		fail(`could not read ${dir}: ${error.message}`);
	}
	const names = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
		.map((entry) => entry.name)
		.sort();
	if (names.length !== 1) {
		fail(`expected exactly one .tgz in ${dir}, found ${names.length}: ${names.join(", ") || "(none)"}`);
	}
	return names[0];
}

function sha256(tarball) {
	return createHash("sha256").update(readFileSync(tarball)).digest("hex");
}

const [mode, dir, expectedSha256, expectedName] = process.argv.slice(2);

if (mode === "record") {
	if (!dir) fail("usage: verify-release-tarball.mjs record <dir>");
	const name = onlyTarball(dir);
	const digest = sha256(join(dir, name));
	process.stdout.write(`tarball=${name}\nsha256=${digest}\n`);
} else if (mode === "verify") {
	if (!dir || !expectedSha256 || !expectedName) {
		fail("usage: verify-release-tarball.mjs verify <dir> <expected-sha256> <expected-name>");
	}
	const name = onlyTarball(dir);
	const tarball = join(dir, name);
	if (name !== expectedName) {
		fail(`${tarball} is named ${name}, but the Package job recorded ${expectedName}`);
	}
	const digest = sha256(tarball);
	if (digest !== expectedSha256) {
		fail(`${tarball} has sha256 ${digest}, but the Package job recorded ${expectedSha256}`);
	}
	console.error(`sha256 ${digest}  ${tarball} matches the Package job's digest`);
	process.stdout.write(`${tarball}\n`);
} else {
	fail(`unknown mode ${JSON.stringify(mode)}; use "record" or "verify"`);
}
