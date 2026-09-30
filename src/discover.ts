import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * Source discovery is Glyph's own walk, not the project's tsconfig `include`.
 *
 * DEC-66 chose "TypeScript and JavaScript, as one target", so the walk takes
 * both regardless of what a project's tsconfig chooses to compile — a tsconfig
 * that excludes its own `.js` files must not make those files invisible to the
 * call graph. The tsconfig is still read, but only for compiler *options*
 * (paths, jsx, and friends), never for the file list; that keeps behavior
 * uniform across repositories that have a tsconfig and ones that do not.
 */

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Directories that never contain the repository's own sources. */
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", "vendor", ".next", ".nuxt"]);

function hasSourceExtension(path: string): boolean {
	return EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Repository-relative paths of every TS/JS source under `repoRoot`, sorted. */
export function discoverSources(repoRoot: string): string[] {
	const found: string[] = [];

	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return; // An unreadable directory contributes nothing; discovery is best-effort.
		}
		for (const entry of entries) {
			const absolute = join(dir, entry);
			let isDirectory = false;
			try {
				isDirectory = statSync(absolute).isDirectory();
			} catch {
				continue;
			}
			if (isDirectory) {
				if (!EXCLUDED_DIRS.has(entry)) walk(absolute);
			} else if (hasSourceExtension(entry)) {
				found.push(relative(repoRoot, absolute).split("\\").join("/"));
			}
		}
	};

	walk(repoRoot);
	return found.sort();
}

/**
 * Compiler options for the program: the project's tsconfig when one exists,
 * otherwise a permissive default. `allowJs` is forced on either way so the
 * walk's `.js` files take part, and diagnostics are never surfaced — Glyph
 * resolves calls through types when the checker can and reports what it found;
 * it is not a linter and must not fail on code that does not compile cleanly
 * (ADR 0001's consequence: recall is a property of the language, and v0 makes
 * no precision promise).
 */
export function loadCompilerOptions(repoRoot: string, configPath: string | undefined): ts.CompilerOptions {
	const defaults: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		jsx: ts.JsxEmit.Preserve,
		allowJs: true,
		skipLibCheck: true,
		noEmit: true,
	};
	const found = configPath ?? ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
	if (!found) return defaults;
	const read = ts.readConfigFile(found, ts.sys.readFile);
	if (read.error || !read.config) return defaults;
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
	return {
		...parsed.options,
		allowJs: true,
		skipLibCheck: true,
		noEmit: true,
	};
}
