#!/usr/bin/env node
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

/*
 * Prove that TypeScript resolves its own library files in the directory this
 * file runs from.
 *
 * scripts/check-package.mjs copies this file INTO the clean install of the
 * packed tarball before running it. That placement is load-bearing: an ESM
 * import resolves relative to the importing file, so `import ts from
 * "typescript"` here must find the dependency installed beside the tarball,
 * not the repository's development copy. A probe run from the repository would
 * measure the wrong object.
 *
 * The source uses three built-in types (Array, Promise, .map). It passes only
 * when the default lib file exists, at least one lib.*.d.ts was loaded, and the
 * program has no diagnostics.
 */

const libPath = ts.getDefaultLibFilePath({});
const dir = mkdtempSync(join(tmpdir(), "glyph-lib-probe-"));
const source = join(dir, "a.ts");
writeFileSync(
	source,
	[
		"export async function f(): Promise<number> {",
		'\tconst xs: Array<string> = ["a"];',
		"\tconst ys = xs.map((x) => x.length);",
		"\treturn Promise.resolve(ys.length);",
		"}",
		"",
	].join("\n"),
);
const program = ts.createProgram({
	rootNames: [source],
	options: { noEmit: true, skipLibCheck: true, allowJs: true, target: ts.ScriptTarget.ESNext },
});
const libs = program
	.getSourceFiles()
	.map((file) => file.fileName)
	.filter((fileName) => /lib\..*\.d\.ts$/.test(fileName));
const report = {
	libPath,
	libExists: existsSync(libPath),
	libFiles: libs.length,
	diagnostics: ts.getPreEmitDiagnostics(program).length,
};
console.log(JSON.stringify(report));
if (!report.libExists || report.libFiles === 0 || report.diagnostics !== 0) {
	console.error("the installed typescript did not resolve its library files");
	process.exit(1);
}
