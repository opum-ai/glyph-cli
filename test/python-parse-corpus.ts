import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parsePython } from "../src/python/parse.ts";

/**
 * Parse every .py file under a directory and print per-file and total
 * ERROR/MISSING counts. Not part of `bun test` (no .test. suffix); run it by
 * hand to take a corpus measurement, e.g.
 *
 *   bun test/python-parse-corpus.ts /path/to/src/click
 *
 * The directory is read as untrusted data: files are decoded and parsed, never
 * executed or imported.
 */

function walk(dir: string): string[] {
	const files: string[] = [];
	const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const absolute = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(absolute));
		else if (entry.isFile() && entry.name.endsWith(".py")) files.push(absolute);
	}
	return files;
}

const dir = process.argv[2];
if (dir === undefined) {
	console.error("usage: bun test/python-parse-corpus.ts <directory>");
	process.exit(2);
}

const files = walk(dir);
if (files.length === 0) {
	console.error(`no .py files under ${dir}`);
	process.exit(1);
}

let totalBytes = 0;
let totalErrors = 0;
let totalMissing = 0;
let filesWithError = 0;
let totalReplacements = 0;

console.log("# path\tbytes\tERROR\tMISSING\thasError\tdecodeReplacements\tlimit");
for (const file of files) {
	const bytes = readFileSync(file);
	const result = await parsePython(bytes, relative(dir, file));
	totalBytes += bytes.length;
	totalErrors += result.errorCount;
	totalMissing += result.missingCount;
	totalReplacements += result.decodeReplacements;
	if (result.hasError) filesWithError++;
	console.log(
		[
			relative(dir, file),
			bytes.length,
			result.errorCount,
			result.missingCount,
			result.hasError,
			result.decodeReplacements,
			result.limit ?? "-",
		].join("\t"),
	);
	// The regions are copied out as plain objects, so the tree can be freed here.
	result.tree.delete();
}

console.log(
	`TOTAL\t${files.length} files\t${totalBytes} bytes\t${totalErrors} ERROR\t${totalMissing} MISSING\t` +
		`${filesWithError} files with an error\t${totalReplacements} decode replacements`,
);
