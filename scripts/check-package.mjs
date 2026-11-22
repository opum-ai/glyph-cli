#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/*
 * The packaging gate for the shipped artifact (GCLI-46, DEC-299 items 2/3 and
 * (a1)).
 *
 * It proves the thing npm will serve, not the working tree:
 *
 *   1. `npm pack` builds through the `prepack` wiring and produces a tarball;
 *      with --out-dir <dir> that exact tarball is written there and left in
 *      place, so the release job publishes the bytes this gate verified rather
 *      than re-packing the tree;
 *   2. the tarball contains exactly package.json, README.md, LICENSE and dist/,
 *      dist/glyph.js begins with a Node shebang, and it carries no baked
 *      absolute __dirname/__filename (the signature of an inlined dependency);
 *   3. the tarball installs into an EMPTY directory with --ignore-scripts
 *      (DEC-240), the INSTALLED typescript resolves its lib.*.d.ts files with
 *      zero diagnostics (scripts/lib-probe.mjs, copied into that install), and
 *      every command `glyph help --json` advertises runs under node (never Bun)
 *      with exit 0 and a JSON envelope. The list comes from the manifest, so a
 *      new command with no invocation here fails the gate;
 *   4. a negative control: dist/ is removed from a copy of the REAL packed
 *      tarball, that copy is re-packed and installed, and the gate is asserted
 *      to fail on it. If it did not, the gate would not catch a missing bundle.
 *
 * Run locally with `node scripts/check-package.mjs [--out-dir release]`; Bun
 * (see .bun-version) and network access for the runtime dependencies are
 * required. It never publishes.
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

function tarballNameFrom(stdout) {
	return (stdout ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".tgz"))
		.pop();
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
	must(
		pkg.bin?.glyph === "dist/glyph.js",
		`package.json bin.glyph must be dist/glyph.js, got ${JSON.stringify(pkg.bin)}`,
	);
	must(
		JSON.stringify(pkg.files) === JSON.stringify(["dist", "README.md", "LICENSE"]),
		`package.json files must be exactly ["dist","README.md","LICENSE"], got ${JSON.stringify(pkg.files)}`,
	);
	must(pkg.engines?.node === ">=24", `package.json engines.node must be >=24, got ${JSON.stringify(pkg.engines)}`);
	must(
		typeof pkg.scripts?.prepack === "string",
		"package.json must wire a prepack build so a packed tarball contains dist",
	);
	must(pkg.scripts.build !== undefined, "package.json must define a build script");
	must(
		pkg.dependencies?.typescript !== undefined && pkg.dependencies?.commander !== undefined,
		"typescript and commander must stay runtime dependencies: the bundle keeps them external",
	);
}

function installTarball(tarball) {
	const installDir = mkdtempSync(join(tmpdir(), "glyph-install-"));
	writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "glyph-pack-check", private: true })}\n`);
	const install = npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], installDir);
	must(install.status === 0, `npm install of ${basename(tarball)} failed: ${summary(install)}`);
	return installDir;
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
			'\treturn "hi " + name;',
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
			'\treturn "hello " + name;',
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

/**
 * Everything the gate asserts about one tarball, from its bytes to an installed
 * copy running every command. Throws on the first failure, so the positive run
 * passes and the negative control (a real tarball with dist removed) goes red.
 */
function verifyPackagedTarball(tarball) {
	const label = basename(tarball);

	// 1. Contents: exactly the allow-list, with the bundle and the licence.
	const entries = tarEntries(tarball);
	const allowed = (entry) =>
		entry === "package/package.json" ||
		entry === "package/README.md" ||
		entry === "package/LICENSE" ||
		entry.startsWith("package/dist/");
	const unexpected = entries.filter((entry) => !allowed(entry));
	must(unexpected.length === 0, `${label} contains paths outside [dist, README.md, LICENSE]: ${unexpected.join(", ")}`);
	must(entries.includes("package/dist/glyph.js"), `${label} does not contain dist/glyph.js`);
	must(entries.includes("package/LICENSE"), `${label} does not contain LICENSE`);
	const head = sh("tar", ["-xOzf", tarball, "package/dist/glyph.js"]);
	must(head.status === 0, `could not read dist/glyph.js from ${label}: ${summary(head)}`);
	const firstLine = (head.stdout ?? "").split("\n")[0];
	must(firstLine === "#!/usr/bin/env node", `${label}: dist/glyph.js first line is ${JSON.stringify(firstLine)}`);
	console.log(`  ${label}: paths ${entries.join(", ")}; shebang ok`);

	// 2. Install into an empty directory (DEC-240) and inspect the INSTALLED bundle.
	const installDir = installTarball(tarball);
	const installedBin = join(installDir, "node_modules", "@opum-ai", "glyph", "dist", "glyph.js");
	must(existsSync(installedBin), `installed ${label} has no ${installedBin}`);
	const installedSource = readFileSync(installedBin, "utf8");
	// A bare specifier is the spelling-independent evidence that a dependency
	// stayed external. It catches an inlined dependency even when Bun's bundled
	// form emits no absolute __dirname (commander is a case: bundling it leaves
	// no baked path at all).
	const importsBare = (specifier) =>
		new RegExp(`\\bfrom\\s+["']${specifier}["']|\\brequire\\(\\s*["']${specifier}["']\\s*\\)`).test(installedSource);
	must(
		importsBare("typescript"),
		`installed ${label} does not import "typescript" as a bare specifier: it was bundled instead of kept external`,
	);
	must(
		importsBare("commander"),
		`installed ${label} does not import "commander" as a bare specifier: it was bundled instead of kept external`,
	);
	console.log(`  ${label}: typescript and commander are imported as bare specifiers`);
	// Keep the baked-path check as the second, spelling-specific witness.
	must(
		!/__dirname\s*=\s*["']\//.test(installedSource),
		`installed ${label} bakes an absolute __dirname: a dependency was bundled instead of kept external`,
	);
	must(
		!/__filename\s*=\s*["']\//.test(installedSource),
		`installed ${label} bakes an absolute __filename: a dependency was bundled instead of kept external`,
	);

	// 3. The installed TypeScript must resolve its own libs in THIS clean install.
	// The probe is copied into the install so its `import "typescript"` resolves
	// beside the tarball, not from the repository's development copy.
	copyFileSync(join(root, "scripts", "lib-probe.mjs"), join(installDir, "lib-probe.mjs"));
	const probe = sh(process.execPath, [join(installDir, "lib-probe.mjs")], { cwd: installDir });
	must(probe.status === 0, `installed typescript lib probe failed: ${summary(probe)}`);
	const report = JSON.parse(probe.stdout);
	must(
		report.libExists === true && report.libFiles > 0 && report.diagnostics === 0,
		`installed typescript lib probe reported ${probe.stdout.trim()}`,
	);
	console.log(
		`  ${label}: installed typescript resolves ${report.libFiles} lib files, ${report.diagnostics} diagnostics`,
	);

	// 4. Every advertised command under node, plus the ref path (git cat-file
	// and stdin) which a working-tree command does not exercise.
	const fixture = makeFixtureRepo();
	const cacheDir = mkdtempSync(join(tmpdir(), "glyph-pack-cache-"));
	const manifestRun = runInstalledGlyph(installedBin, fixture.repo, ["help", "--json"], { cacheDir });
	must(
		manifestRun.status === 0,
		`installed glyph help --json exited ${manifestRun.status}: ${(manifestRun.stderr ?? "").slice(0, 600)}`,
	);
	const manifest = parseEnvelope(manifestRun.stdout, "installed glyph help --json").data;
	must(Array.isArray(manifest.commands) && manifest.commands.length > 0, "help --json published no commands");

	// One or more invocations per advertised command. A command the manifest
	// advertises but this map does not cover FAILS the gate; that is the
	// coverage rule. Extra invocations (impact --ref) are additional checks.
	const invocations = new Map([
		["callers", [{ argv: ["callers", "greet"] }]],
		["impact", [{ argv: ["impact", "greet"] }, { argv: ["impact", "greet", "--ref", "HEAD"] }]],
		["diff", [{ argv: ["diff", fixture.base] }]],
		["code-map", [{ argv: ["code-map", "--source-ref", "HEAD"], stdin: "fix greet in src/a.ts\n" }]],
		["cache path", [{ argv: ["cache", "path"] }]],
		["cache clear", [{ argv: ["cache", "clear"] }]],
		["help", [{ argv: ["help"] }]],
	]);
	const advertised = manifest.commands.map((command) => command.name);
	for (const name of advertised) {
		const list = invocations.get(name);
		must(
			list !== undefined && list.length > 0,
			`manifest advertises command "${name}" but scripts/check-package.mjs has no invocation for it; add one`,
		);
		const command = manifest.commands.find((entry) => entry.name === name);
		must(
			Array.isArray(command.exitCodes) && command.exitCodes.includes(0),
			`manifest command "${name}" does not declare exit code 0`,
		);
		for (const invocation of list) {
			const result = runInstalledGlyph(installedBin, fixture.repo, [...invocation.argv, "--json"], {
				stdin: invocation.stdin,
				cacheDir,
			});
			must(
				result.status === 0,
				`installed glyph ${invocation.argv.join(" ")} exited ${result.status}: ${(result.stderr ?? "").slice(0, 600)}`,
			);
			parseEnvelope(result.stdout, `installed glyph ${invocation.argv.join(" ")} --json`);
			console.log(`  ${label}: ${invocation.argv.join(" ")}: exit 0, JSON envelope`);
		}
	}
	// Streaming commands (contract §1a): the manifest publishes `itemKind` and a
	// `stream` flag for exactly the same commands. Run each under node and
	// assert NDJSON: every line is an envelope, item lines carry itemKind, the
	// last line is the result kind, and its itemCount matches the item lines.
	const streamCommands = manifest.commands.filter((command) => {
		const hasStreamFlag = Array.isArray(command.flags) && command.flags.some((flag) => flag.name === "stream");
		const hasItemKind = typeof command.itemKind === "string";
		must(
			hasStreamFlag === hasItemKind,
			`manifest command "${command.name}": stream flag=${hasStreamFlag} but itemKind=${JSON.stringify(command.itemKind)}; both must agree`,
		);
		return hasStreamFlag;
	});
	must(
		streamCommands.length > 0,
		"help --json advertised no streaming command: the stream coverage check read nothing",
	);
	for (const command of streamCommands) {
		const primary = invocations.get(command.name)?.[0];
		must(primary !== undefined, `streaming command "${command.name}" has no base invocation in the gate`);
		const result = runInstalledGlyph(installedBin, fixture.repo, [...primary.argv, "--stream"], {
			stdin: primary.stdin,
			cacheDir,
		});
		must(
			result.status === 0,
			`installed glyph ${primary.argv.join(" ")} --stream exited ${result.status}: ${(result.stderr ?? "").slice(0, 600)}`,
		);
		const lines = (result.stdout ?? "").split("\n").filter((line) => line.trim() !== "");
		must(lines.length > 0, `installed glyph ${command.name} --stream wrote no lines`);
		const parsed = lines.map((line, index) => {
			let envelope;
			try {
				envelope = JSON.parse(line);
			} catch {
				throw new Error(
					`installed glyph ${command.name} --stream line ${index + 1} is not JSON: ${line.slice(0, 200)}`,
				);
			}
			must(
				envelope.schemaVersion === 1 && "principal" in envelope,
				`installed glyph ${command.name} --stream line ${index + 1} is not an envelope`,
			);
			return envelope;
		});
		const last = parsed[parsed.length - 1];
		must(last.kind === command.kind, `stream result kind ${last.kind} does not match manifest kind ${command.kind}`);
		const items = parsed.slice(0, -1);
		for (const item of items) {
			must(
				item.kind === command.itemKind,
				`stream item kind ${item.kind} does not match manifest itemKind ${command.itemKind}`,
			);
		}
		must(
			typeof last.data?.itemCount === "number" && last.data.itemCount === items.length,
			`stream result itemCount ${last.data?.itemCount} does not equal ${items.length} item line(s)`,
		);
		console.log(`  ${label}: ${primary.argv.join(" ")} --stream: ${items.length} item line(s), result ${command.kind}`);
	}
	for (const name of invocations.keys()) {
		must(
			advertised.includes(name),
			`scripts/check-package.mjs covers "${name}", which the manifest does not advertise`,
		);
	}
	console.log(`  ${label}: ran every advertised command under node`);
}

function main() {
	const { values } = parseArgs({ options: { "out-dir": { type: "string" } }, allowPositionals: false });
	const outDir = values["out-dir"] === undefined ? undefined : resolve(root, values["out-dir"]);

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

	// The unit tests run under Bun's node:child_process; this runs the edge
	// cases under the `node` binary the artifact actually targets (F7).
	const spawnEdge = sh("node", [join(root, "scripts", "node-spawn-check.mjs")]);
	must(spawnEdge.status === 0, `node spawnSync edge checks failed: ${summary(spawnEdge)}`);
	console.log(`node spawnSync edge checks: ${(spawnEdge.stdout ?? "").trim()}`);

	if (outDir !== undefined) {
		mkdirSync(outDir, { recursive: true });
		const existing = readdirSync(outDir).filter((name) => name.endsWith(".tgz"));
		must(
			existing.length === 0,
			`${outDir} already contains ${existing.join(", ")}; use a fresh directory so the published tarball is unambiguous`,
		);
	}
	const packDir = outDir ?? mkdtempSync(join(tmpdir(), "glyph-pack-"));

	// Pack once. No --ignore-scripts here: prepack must build dist, and that is
	// what this gate proves. (The installs below use --ignore-scripts, DEC-240.)
	const pack = npm(["pack", "--pack-destination", packDir], root);
	must(pack.status === 0, `npm pack failed: ${summary(pack)}`);
	// prepack's own output shares stdout with the tarball name, so take the last
	// line that is a .tgz rather than assuming the filename is the only line.
	const tarballName = tarballNameFrom(pack.stdout);
	must(tarballName !== undefined, `npm pack did not report a tarball name: ${JSON.stringify(pack.stdout)}`);
	const tarball = join(packDir, tarballName);
	must(existsSync(tarball), `npm pack reported ${tarballName} but it does not exist`);
	const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
	console.log(`packed ${tarball}`);
	console.log(`sha256 ${digest}  ${tarballName}`);

	verifyPackagedTarball(tarball);

	// Negative control: the REAL tarball with dist removed. It is re-packed and
	// installed (so this is a real package, not a missing file), then the gate
	// itself must reject it.
	const extractDir = mkdtempSync(join(tmpdir(), "glyph-pack-negative-"));
	const extract = sh("tar", ["-xzf", tarball, "-C", extractDir]);
	must(extract.status === 0, `could not extract the real tarball: ${summary(extract)}`);
	const extractedPackage = join(extractDir, "package");
	rmSync(join(extractedPackage, "dist"), { recursive: true, force: true });
	const tamperedDir = mkdtempSync(join(tmpdir(), "glyph-pack-negative-tarball-"));
	const tamperedPack = npm(["pack", "--ignore-scripts", "--pack-destination", tamperedDir], extractedPackage);
	must(tamperedPack.status === 0, `could not re-pack the dist-less tarball: ${summary(tamperedPack)}`);
	const tamperedName = tarballNameFrom(tamperedPack.stdout);
	must(
		tamperedName !== undefined,
		`re-packing the dist-less tarball reported no tarball: ${JSON.stringify(tamperedPack.stdout)}`,
	);
	const tampered = join(tamperedDir, tamperedName);
	installTarball(tampered); // It installs; it just has no bundle.
	let negativeError;
	try {
		verifyPackagedTarball(tampered);
	} catch (error) {
		negativeError = error;
	}
	must(negativeError !== undefined, "negative control failed: the gate accepted a real tarball with dist removed");
	must(
		/dist\/glyph\.js/.test(negativeError.message),
		`negative control failed: the gate rejected the tarball for an unexpected reason: ${negativeError.message}`,
	);
	console.log(`negative control: the gate rejected a dist-less copy of the real tarball (${negativeError.message})`);

	console.log(`packaging gate passed${outDir === undefined ? "" : `; verified tarball left at ${tarball}`}`);
}

try {
	main();
} catch (error) {
	console.error(`::error::packaging gate failed: ${error.message}`);
	process.exit(1);
}
