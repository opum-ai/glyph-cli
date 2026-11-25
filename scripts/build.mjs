#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Build the shipped artifact: one bundled dist/glyph.js that runs on Node.
 *
 * Development and tests stay on Bun (package.json script `glyph`, `bun test`);
 * only this bundle targets Node, because the package's consumers install it
 * from npm and run it with `node` (DEC-299 item 2, GCLI-46).
 *
 * `typescript` and `commander` stay EXTERNAL, and therefore runtime
 * dependencies. Bundling typescript would move its `__dirname` into this
 * bundle, where no `lib.*.d.ts` exists: `ts.getDefaultLibFilePath()` resolves
 * against the running package's directory (src/snapshot.ts), so the indexer
 * would lose the compiler's own library. Measured, not assumed: the packed
 * tarball is installed into an empty directory and every command is run under
 * node by scripts/check-package.mjs.
 *
 * `@vscode/tree-sitter-wasm` stays EXTERNAL for the same reason: bundling it
 * bakes the build machine's absolute path to its runtime .wasm into the bundle
 * (the Python indexer, GCLI-82), so a clean install could not find the grammar.
 * Kept external, it is a runtime dependency resolved from the installed package.
 *
 * The entry point starts with a Bun shebang for `bun run src/cli.ts`; the
 * bundle's first line is rewritten to a Node shebang and the file is made
 * executable, so `dist/glyph.js` is runnable directly as well as through the
 * `glyph` bin.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "glyph.js");

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(root, "dist"), { recursive: true });

const build = spawnSync(
	"bun",
	[
		"build",
		"src/cli.ts",
		"--target=node",
		"--format=esm",
		`--outfile=${outfile}`,
		"--external",
		"typescript",
		"--external",
		"commander",
		"--external",
		"@vscode/tree-sitter-wasm",
	],
	{ cwd: root, stdio: "inherit" },
);
if (build.error) {
	console.error(`build failed to start: ${build.error.message}`);
	process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const built = readFileSync(outfile, "utf8");
const body = built.startsWith("#!") ? built.slice(built.indexOf("\n") + 1) : built;
writeFileSync(outfile, `#!/usr/bin/env node\n${body}`);
chmodSync(outfile, 0o755);
console.log(`built ${outfile} (${statSync(outfile).size} bytes, shebang #!/usr/bin/env node)`);
