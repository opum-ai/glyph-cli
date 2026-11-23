import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { indeterminateError } from "./errors.ts";
import { gitRun } from "./git.ts";
/**
 * Source discovery is Glyph's own selection, not the project's tsconfig
 * `include`.
 *
 * DEC-66 chose "TypeScript and JavaScript, as one target", so discovery takes
 * both regardless of what a project's tsconfig chooses to compile — a tsconfig
 * that excludes its own `.js` files must not make those files invisible to the
 * call graph. The tsconfig is still read, but only for compiler *options*
 * (paths, jsx, and friends), never for the file list; that keeps behavior
 * uniform across repositories that have a tsconfig and ones that do not.
 *
 * In a Git repository the file selection is Git's own: tracked files plus
 * **untracked** files that `.gitignore` does not exclude. That inherits nested
 * ignore files, negation patterns and `.git/info/exclude` instead of a fixed
 * directory list, so an untracked generated or local directory the repository
 * ignores cannot inflate the index (DEC-216). Two consequences worth naming:
 *
 * - A **tracked** file stays visible even when a pattern matches it, because
 *   Git ignores patterns for tracked files. A repository that commits `dist/`,
 *   `vendor/` or `build/`, or leaves `node_modules/` untracked and unignored,
 *   therefore indexes those files. That is the decided behavior, not a fixed
 *   list quietly applied over Git's answer.
 * - `git ls-files` does not descend into submodules or nested repositories;
 *   their contents are not indexed. It lists a submodule as a gitlink, which
 *   this selection skips because it is not a file.
 *
 * Symlinks are followed when they resolve to a file (`statSync`), and the
 * link's own repository-relative path is what enters the index.
 *
 * A directory outside Git falls back to a filesystem walk, where Git has no
 * ignore rules to apply; that walk keeps a fixed excluded-directory list. Git
 * failing for any other reason — "dubious ownership", a corrupt index, a
 * permission error — is **indeterminate** (exit 7), never a silent walk that
 * would index sources Git was refusing to describe.
 */

/** Only the first line of git's stderr belongs in a diagnostic. */
function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

/** Git prints POSIX paths; the walk fallback normalizes only on Windows. */
function toPosix(path: string): string {
	return sep === "\\" ? path.split("\\").join("/") : path;
}

/** Extensions discovery takes in a working tree and at a ref alike. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Directories a non-Git walk never descends into; Git ignores them in a
 * repository. The Python entries (`.venv`, `venv`, `__pycache__`, `.tox`) keep a
 * nested environment or cache from inflating the recognised Python count; they
 * change nothing for a TypeScript-only tree, whose language golden still passes.
 */
const EXCLUDED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	".next",
	".nuxt",
	".venv",
	"venv",
	"__pycache__",
	".tox",
]);

function hasSourceExtension(path: string): boolean {
	return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Repository-relative paths of every TS/JS source in scope, sorted. */
export function discoverSources(repoRoot: string): string[] {
	return discoverFiles(repoRoot, hasSourceExtension);
}

/**
 * Repository-relative paths of every file `accept` selects, sorted.
 *
 * The selection is exactly {@link discoverSources}'s — Git's tracked plus
 * unignored-untracked set inside a repository, a fixed-directory walk outside
 * one — so language detection and the index always agree about what is in
 * scope. An excluded path contributes no file to any language.
 */
export function discoverFiles(repoRoot: string, accept: (path: string) => boolean): string[] {
	const inside = gitRun(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0) {
		if (/not a git repository/i.test(inside.stderr)) return walkFiles(repoRoot, accept);
		throw indeterminateError(`git could not read ${repoRoot}: ${firstLine(inside.stderr)}`);
	}

	const listed = gitRun(repoRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (listed.code !== 0) {
		throw indeterminateError(`git ls-files failed in ${repoRoot}: ${firstLine(listed.stderr)}`);
	}
	const found = new Set<string>();
	for (const path of listed.stdout.split("\0")) {
		if (path === "" || !accept(path)) continue;
		try {
			if (!statSync(join(repoRoot, path)).isFile()) continue;
		} catch {
			continue; // Listed in the index but absent from this worktree.
		}
		found.add(toPosix(path));
	}
	return [...found].sort();
}

function walkFiles(repoRoot: string, accept: (path: string) => boolean): string[] {
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
			} else if (accept(entry)) {
				found.push(toPosix(relative(repoRoot, absolute)));
			}
		}
	};

	walk(repoRoot);
	return found.sort();
}

/**
 * Where a tsconfig is read from. The default is the filesystem; the `--ref`
 * path supplies an in-memory host over the commit's tree, so compiler options
 * are those the commit chose, not those of whatever checkout happens to exist.
 */
export interface ConfigReadHost {
	useCaseSensitiveFileNames: boolean;
	fileExists(path: string): boolean;
	readFile(path: string): string | undefined;
	readDirectory(
		path: string,
		extensions: readonly string[],
		excludes: readonly string[] | undefined,
		includes: readonly string[],
		depth?: number,
	): string[];
}

/**
 * Compiler options for the program: the project's tsconfig when one exists,
 * otherwise a permissive default. `allowJs` is forced on either way so the
 * walk's `.js` files take part, and diagnostics are never surfaced — Glyph
 * resolves calls through types when the checker can and reports what it found;
 * it is not a linter and must not fail on code that does not compile cleanly
 * (ADR 0001's consequence: recall is a property of the language, and v0 makes
 * no precision promise).
 *
 * Only the options are taken from the tsconfig; the file list is always
 * discovery's own. With a custom `host`, the tsconfig is looked for at the
 * repository root only: walking upward would leave the tree the host describes.
 */
export function loadCompilerOptions(
	repoRoot: string,
	configPath: string | undefined,
	host?: ConfigReadHost,
): ts.CompilerOptions {
	const defaults: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		jsx: ts.JsxEmit.Preserve,
		allowJs: true,
		skipLibCheck: true,
		noEmit: true,
	};
	const rootConfig = join(repoRoot, "tsconfig.json");
	const found =
		configPath ??
		(host === undefined
			? ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json")
			: host.fileExists(rootConfig)
				? rootConfig
				: undefined);
	if (found === undefined) return defaults;
	const readHost = host ?? ts.sys;
	const read = ts.readConfigFile(found, (path) => readHost.readFile(path));
	if (read.error || !read.config) return defaults;
	const parsed = ts.parseJsonConfigFileContent(read.config, readHost, repoRoot);
	return {
		...parsed.options,
		allowJs: true,
		skipLibCheck: true,
		noEmit: true,
	};
}
