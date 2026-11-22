#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The packaging gate for the shipped artifact (GCLI-46, DEC-299 item 2).
 *
 * It proves the thing npm will serve, not the working tree:
 *
 *   1. `npm pack` builds through the `prepack` wiring and produces a tarball;
 *   2. the tarball contains exactly package.json, README.md, LICENSE and dist/,
 *      and dist/glyph.js begins with a Node shebang;
 *   3. the tarball installs into an empty directory with --ignore-scripts
 *      (DEC-240), and every command `glyph help --json` advertises runs under
 *      node (never Bun) and exits 0. The list comes from the manifest, so a
 *      new command with no invocation here fails the gate;
 *   4. a negative control: a tarball packed without dist/ is extracted and run,
 *      and must exit non-zero. If it did not, this gate would not catch a
 *      missing bundle.
 *
 * Run locally with `node scripts/check-package.mjs`; Bun (see .bun-version) and
 * network access for the runtime dependencies are required. It never publishes.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function must(condition, message) {
	if (!condition) throw new Error(message);
}

function sh(command, args, options = {}) {
	return spawnSync(command, args, {
		cwd: options.cwd,
		input: options.input,
		env: { ...process.env, ...options.env },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function npm(args, cwd) {
	return sh(npmCommand, args, { cwd });
}

function summary(result) {
	const stderr = (result.stderr ?? "").trim();
	return stderr === "" ? `exit ${result.status}` : `exit ${result.status}: ${stderr.slice(0, 600)}`;
}

function tarEntries(tarball) {
	const listing = sh("tar", ["-tzf", tarball]);
	must(listing.status === 0, `tar -tzf failed: ${summary(listing)}`);
	return listing.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function assertManifestShape(pkg) {
	must(pkg.bin?.glyph === "dist/glyph.js", `package.json bin.glyph must be dist/glyph.js, got ${JSON.stringify(pkg.bin)}`);
	must(
		JSON.stringify(pkg.files) === JSON.stringify(["dist", "README.md", "LICENSE"]),
		`package.json files must be exactly ["dist","README.md","LICENSE"], got ${JSON.stringify(pkg.files)}`,
	);
	must(pkg.engines?.node === ">=24", `package.json engines.node must be >=24, got ${JSON.stringify(pkg.engines)}`);
	must(typeof pkg.scripts?.prepack === "string", "package.json must wire a prepack build so a packed tarball contains dist");
	must(pkg.scripts.build !== undefined, "package.json must define a build script");
	must(
		pkg.dependencies?.typescript !== undefined && pkg.dependencies?.commander !== undefined,
		"typescript and commander must stay runtime dependencies: the bundle keeps them external",
	);
}

function runInstalledGlyph(installedBin, cwd, argv, { stdin, cacheDir }) {
	return sh(process.execPath, [installedBin, ...argv], {
		cwd,
		input: stdin,
		env: cacheDir === undefined ? undefined : { GLYPH_CACHE_DIR: cacheDir },
	});
}

function parseEnvelope(stdout, what) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`${what}: stdout is not JSON (${error.message}): ${stdout.slice(0, 300)}`);
	}
	must(parsed?.schemaVersion === 1, `${what}: envelope is missing schemaVersion 1`);
	must("principal" in parsed, `${what}: envelope is missing principal`);
	return parsed;
}

function makeFixtureRepo() {
	const repo = mkdtempSync(join(tmpdir(), "glyph-pack-fixture-"));
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(
		join(repo, "src", "a.ts"),
		[
			"export function greet(name: string): string {",
			'\treturn `hi ${name}`;',
			"}",
			"",
			"export function useIt(): string {",
			'\treturn greet("caller");',
			"}",
			"",
		].join("\n"),
	);
	const git = (args) => {
		const result = sh("git", args, { cwd: repo });
		must(result.status === 0, `fixture git ${args.join(" ")} failed: ${summary(result)}`);
		return result;
	};
	git(["init", "-q"]);
	git(["config", "user.email", "pack-check@opum.test"]);
	git(["config", "user.name", "glyph pack check"]);
	git(["add", "-A"]);
	git(["commit", "-qm", "base"]);
	const base = git(["rev-parse", "HEAD"]).stdout.trim();
	writeFileSync(
		join(repo, "src", "a.ts"),
		[
			"export function greet(name: string): string {",
			'\treturn `hello ${name}`;',
			"}",
			"",
			"export function useIt(): string {",
			'\treturn greet("caller");',
			"}",
			"",
		].join("\n"),
	);
	git(["add", "-A"]);
	git(["commit", "-qm", "change greet"]);
	return { repo, base, head: git(["rev-parse", "HEAD"]).stdout.trim() };
}

async function main() {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assertManifestShape(pkg);

	const versions = {
		node: sh(process.execPath, ["--version"]),
		npm: sh(npmCommand, ["--version"]),
		bun: sh("bun", ["--version"]),
	};
	must(versions.bun.status === 0, "bun is required to build the bundle; install the .bun-version toolchain");
	console.log(
		`toolchain: node ${versions.node.stdout.trim()}, npm ${versions.npm.stdout.trim()}, bun ${versions.bun.stdout.trim()}`,
	);

	// 1. Pack. No --ignore-scripts here: prepack must build dist, and that is
	// what this gate proves. (The INSTALL below uses --ignore-scripts, DEC-240.)
	const packDir = mkdtempSync(join(tmpdir(), "glyph-pack-"));
	const pack = npm(["pack", "--pack-destination", packDir], root);
	must(pack.status === 0, `npm pack failed: ${summary(pack)}`);
	// prepack's own output shares stdout with the tarball name, so take the last
	// line that is a .tgz rather than assuming the filename is the only line.
	const tarballName = (pack.stdout ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".tgz"))
		.pop();
	must(tarballName !== undefined, `npm pack did not report a tarball name: ${JSON.stringify(pack.stdout)}`);
	const tarball = join(packDir, tarballName);
	must(existsSync(tarball), `npm pack reported ${tarballName} but it does not exist`);
	console.log(`packed ${tarballName}`);

	// 2. The tarball's contents and the built file's first line.
	const entries = tarEntries(tarball);
	const allowed = (entry) =>
		entry === "package/package.json" ||
		entry === "package/README.md" ||
		entry === "package/LICENSE" ||
		entry.startsWith("package/dist/");
	const unexpected = entries.filter((entry) => !allowed(entry));
	must(unexpected.length === 0, `tarball contains paths outside [dist, README.md, LICENSE]: ${unexpected.join(", ")}`);
	must(entries.includes("package/dist/glyph.js"), "tarball does not contain dist/glyph.js");
	must(entries.includes("package/LICENSE"), "tarball does not contain LICENSE");
	const head = sh("tar", ["-xOzf", tarball, "package/dist/glyph.js"]);
	must(head.status === 0, `could not read dist/glyph.js from the tarball: ${summary(head)}`);
	const firstLine = (head.stdout ?? "").split("\n")[0];
	must(firstLine === "#!/usr/bin/env node", `dist/glyph.js first line is ${JSON.stringify(firstLine)}, not the Node shebang`);
	console.log(`tarball paths: ${entries.join(", ")}`);
	console.log(`dist/glyph.js first line: ${firstLine}`);

	// 3. Install into an empty directory and run every advertised command on node.
	const installDir = mkdtempSync(join(tmpdir(), "glyph-install-"));
	writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "glyph-pack-check", private: true })}\n`);
	const install = npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installDir);
	must(install.status === 0, `npm install of the tarball failed: ${summary(install)}`);
	const installedBin = join(installDir, "node_modules", "@opum-ai", "glyph", "dist", "glyph.js");
	must(existsSync(installedBin), `installed package has no ${installedBin}`);

	const fixture = makeFixtureRepo();
	const cacheDir = mkdtempSync(join(tmpdir(), "glyph-pack-cache-"));
	const manifestRun = runInstalledGlyph(installedBin, fixture.repo, ["help", "--json"], { cacheDir });
	must(manifestRun.status === 0, `installed glyph help --json exited ${manifestRun.status}: ${(manifestRun.stderr ?? "").slice(0, 600)}`);
	const manifest = parseEnvelope(manifestRun.stdout, "installed glyph help --json").data;
	must(Array.isArray(manifest.commands) && manifest.commands.length > 0, "help --json published no commands");

	// One invocation per advertised command. A command the manifest advertises
	// but this map does not cover FAILS the gate; that is the coverage rule.
	const invocations = new Map([
		["callers", { argv: ["callers", "greet"] }],
		["impact", { argv: ["impact", "greet"] }],
		["diff", { argv: ["diff", fixture.base] }],
		["code-map", { argv: ["code-map", "--source-ref", "HEAD"], stdin: "fix greet in src/a.ts\n" }],
		["cache path", { argv: ["cache", "path"] }],
		["cache clear", { argv: ["cache", "clear"] }],
		["help", { argv: ["help"] }],
	]);
	const advertised = manifest.commands.map((command) => command.name);
	for (const name of advertised) {
		const invocation = invocations.get(name);
		must(
			invocation !== undefined,
			`manifest advertises command "${name}" but scripts/check-package.mjs has no invocation for it; add one`,
		);
		const command = manifest.commands.find((entry) => entry.name === name);
		must(
			Array.isArray(command.exitCodes) && command.exitCodes.includes(0),
			`manifest command "${name}" does not declare exit code 0`,
		);
		const result = runInstalledGlyph(installedBin, fixture.repo, [...invocation.argv, "--json"], {
			stdin: invocation.stdin,
			cacheDir,
		});
		must(result.status === 0, `installed glyph ${name} exited ${result.status}: ${(result.stderr ?? "").slice(0, 600)}`);
		parseEnvelope(result.stdout, `installed glyph ${name} --json`);
		console.log(`  ${name}: exit 0, JSON envelope`);
	}
	for (const name of invocations.keys()) {
		must(advertised.includes(name), `scripts/check-package.mjs covers "${name}", which the manifest does not advertise`);
	}
	console.log(`ran ${advertised.length} advertised commands under node ${versions.node.stdout.trim()}`);

	// 4. Negative control: a tarball packed without dist/ must fail when run.
	const negativeDir = mkdtempSync(join(tmpdir(), "glyph-pack-negative-"));
	for (const file of ["package.json", "README.md", "LICENSE"]) {
		copyFileSync(join(root, file), join(negativeDir, file));
	}
	mkdirSync(join(negativeDir, "dist"), { recursive: true });
	const negativePackDir = mkdtempSync(join(tmpdir(), "glyph-pack-negative-tarball-"));
	const negativePack = npm(["pack", "--ignore-scripts", "--pack-destination", negativePackDir], negativeDir);
	must(negativePack.status === 0, `npm pack of the dist-less package failed: ${summary(negativePack)}`);
	const negativeName = (negativePack.stdout ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".tgz"))
		.pop();
	must(negativeName !== undefined, `npm pack of the dist-less package reported no tarball: ${JSON.stringify(negativePack.stdout)}`);
	const negativeTarball = join(negativePackDir, negativeName);
	must(!tarEntries(negativeTarball).includes("package/dist/glyph.js"), "negative tarball unexpectedly contains dist/glyph.js");
	const extractDir = mkdtempSync(join(tmpdir(), "glyph-pack-negative-extract-"));
	const extract = sh("tar", ["-xzf", negativeTarball, "-C", extractDir]);
	must(extract.status === 0, `could not extract the negative tarball: ${summary(extract)}`);
	const negativeRun = runInstalledGlyph(join(extractDir, "package", "dist", "glyph.js"), fixture.repo, ["help", "--json"], {
		cacheDir,
	});
	must(
		negativeRun.status !== 0,
		"negative control failed: a tarball with no dist/glyph.js ran successfully, so this gate would not catch a missing bundle",
	);
	console.log(`negative control: a dist-less tarball exited ${negativeRun.status} under node (expected non-zero)`);

	console.log("packaging gate passed");
}

main().catch((error) => {
	console.error(`::error::packaging gate failed: ${error.message}`);
	process.exit(1);
});
