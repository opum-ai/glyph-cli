import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { type ConfigReadHost, loadCompilerOptions, SOURCE_EXTENSIONS } from "./discover.ts";
import { listTree, readBlobs } from "./git.ts";
import { indexProgram } from "./indexer.ts";
import type { GlyphIndex } from "./types.ts";

/**
 * The index source for `--ref`: the tree of one commit, read without a
 * checkout (DEC-216 Q4, as ruled in DEC-216 (a2)).
 *
 * The commit's own files are authoritative. Blobs are listed with
 * `git ls-tree -r` and read with one `git cat-file --batch`, so nothing is
 * taken from the working tree. In-repo `node_modules` is **not** read from
 * disk, apart from the running TypeScript package's own library directory: a
 * module that would resolve through the checkout's installed dependencies is
 * not resolved through that install, and its call sites are counted in
 * `unresolvedSites`. That makes what the commit carries authoritative and
 * consistent with a cache key that cannot see node_modules content. A tracked
 * `node_modules` is part of the tree, so it is served from the tree like any
 * other committed path. Inputs the commit does not carry are not part of that
 * promise: a hoisted dependency tree, a parent tsconfig, or a different
 * TypeScript package can still move a cold answer.
 *
 * `ts.sys` is the fallback for three kinds of path the commit does not carry:
 * a hoisted dependency tree above the root, a parent-directory tsconfig
 * reached through `extends`, and the running TypeScript package's standard
 * library. That
 * library is served wherever it sits — inside the analyzed checkout too, when
 * the package is a dependency of it — because it belongs to the tool rather
 * than to the commit.
 *
 * Symlinks are not followed here (a tree records the link text, not the
 * target), and submodules are gitlinks, not blobs, so neither enters the file
 * list.
 */

/** Extensions read from the tree: the sources, plus JSON for tsconfig and package metadata. */
function isReadablePath(path: string): boolean {
	return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) || path.endsWith(".json");
}

export interface TreeSnapshot {
	root: string;
	sha: string;
	/** Repository-relative POSIX paths of the tree's source files, sorted. */
	files: string[];
	/** Every readable blob in the tree, keyed by repository-relative path. */
	docs: Map<string, string>;
	readFile(absolutePath: string): string | undefined;
	fileExists(absolutePath: string): boolean;
	directoryExists(absolutePath: string): boolean;
	getDirectories(absolutePath: string): string[];
	readDirectory(
		path: string,
		extensions: readonly string[],
		excludes: readonly string[] | undefined,
		includes: readonly string[],
		depth?: number,
	): string[];
}

/**
 * Separator normalisation for a path that may come from the host. Windows
 * `node:path` produces backslashes; on every other platform a backslash is an
 * ordinary character in a file name, so a path from `git ls-tree` -- already
 * POSIX -- is returned untouched and a legal name containing a backslash is not
 * turned into a directory separator. On Windows the rewrite still applies to
 * every input, which is harmless there: a Windows file name cannot contain a
 * backslash, and the listing and the snapshot share this function, so their
 * keys stay consistent.
 */
function posix(path: string): string {
	return process.platform === "win32" ? path.split("\\").join("/") : path;
}

/** Agent paths are POSIX; the map is keyed that way. */
function repositoryPath(root: string, absolutePath: string): string | null {
	const rel = posix(relative(root, resolve(absolutePath)));
	if (rel === "" || rel === ".") return "";
	if (rel.startsWith("../") || rel === ".." || rel.startsWith("/")) return null;
	return rel;
}

/**
 * The running TypeScript package's own library directory. It is part of the
 * tool, not of any commit, so it is served from disk even when the analyzed
 * checkout is the one that contains the tool.
 */
const TYPESCRIPT_LIB_DIRECTORY = resolve(dirname(ts.getDefaultLibFilePath({})));

function isTypeScriptLibrary(absolutePath: string): boolean {
	const path = resolve(absolutePath);
	return path === TYPESCRIPT_LIB_DIRECTORY || path.startsWith(`${TYPESCRIPT_LIB_DIRECTORY}/`);
}

/**
 * The source files of `sha`'s tree from `git ls-tree` alone. The cache key
 * needs no blob content, so a hit costs one listing rather than reading every
 * file the tree contains.
 */
export function sourceFilesAtRef(repoRoot: string, sha: string): string[] {
	return listTree(repoRoot, sha)
		.filter(
			(entry) =>
				entry.type === "blob" &&
				(entry.mode === "100644" || entry.mode === "100755") &&
				SOURCE_EXTENSIONS.some((ext) => entry.path.endsWith(ext)),
		)
		.map((entry) => posix(entry.path))
		.sort();
}

/** Read the tree of `sha` into memory. Throws indeterminate when Git refuses it. */
export function snapshotAtRef(repoRoot: string, sha: string): TreeSnapshot {
	const root = resolve(repoRoot);
	const entries = listTree(repoRoot, sha).filter(
		(entry) =>
			entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755") && isReadablePath(entry.path),
	);
	const blobs = readBlobs(
		repoRoot,
		entries.map((entry) => entry.sha),
	);
	const docs = new Map<string, string>();
	const files: string[] = [];
	for (const entry of entries) {
		const text = blobs.get(entry.sha);
		if (text === undefined) continue;
		const path = posix(entry.path);
		if (docs.has(path)) continue;
		docs.set(path, text);
		if (SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) files.push(path);
	}
	files.sort();

	const readFile = (absolutePath: string): string | undefined => {
		const rel = repositoryPath(root, absolutePath);
		if (rel === null) return ts.sys.readFile(absolutePath);
		const text = docs.get(rel);
		if (text !== undefined) return text;
		return isTypeScriptLibrary(absolutePath) ? ts.sys.readFile(absolutePath) : undefined;
	};
	const fileExists = (absolutePath: string): boolean => {
		const rel = repositoryPath(root, absolutePath);
		if (rel === null) return ts.sys.fileExists(absolutePath);
		if (docs.has(rel)) return true;
		return isTypeScriptLibrary(absolutePath) ? ts.sys.fileExists(absolutePath) : false;
	};
	const directoryExists = (absolutePath: string): boolean => {
		const rel = repositoryPath(root, absolutePath);
		if (rel === null) return ts.sys.directoryExists(absolutePath);
		if (rel === "") return true;
		const prefix = `${rel}/`;
		for (const key of docs.keys()) {
			if (key.startsWith(prefix)) return true;
		}
		return isTypeScriptLibrary(absolutePath) ? (ts.sys.directoryExists?.(absolutePath) ?? false) : false;
	};
	const getDirectories = (absolutePath: string): string[] => {
		const rel = repositoryPath(root, absolutePath);
		if (rel === null || isTypeScriptLibrary(absolutePath)) return ts.sys.getDirectories(absolutePath);
		const prefix = rel === "" ? "" : `${rel}/`;
		const names = new Set<string>();
		for (const key of docs.keys()) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length).split("/");
			if (rest.length > 1 && rest[0] !== undefined && rest[0] !== "") names.add(rest[0]);
		}
		return [...names].sort();
	};
	const readDirectory = (
		path: string,
		extensions: readonly string[],
		excludes: readonly string[] | undefined,
		includes: readonly string[],
		depth?: number,
	): string[] => {
		const rel = repositoryPath(root, path);
		if (rel === null || isTypeScriptLibrary(path)) {
			return ts.sys.readDirectory(path, extensions, excludes, includes, depth);
		}
		const prefix = rel === "" ? "" : `${rel}/`;
		const found: string[] = [];
		for (const key of docs.keys()) {
			if (!key.startsWith(prefix)) continue;
			if (!extensions.some((ext) => key.endsWith(ext))) continue;
			found.push(join(root, key));
		}
		return found.sort();
	};

	return { root, sha, files, docs, readFile, fileExists, directoryExists, getDirectories, readDirectory };
}

/** The snapshot as the tsconfig reader wants it: options come from the commit, too. */
export function configHostOf(snapshot: TreeSnapshot): ConfigReadHost {
	return {
		useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		fileExists: snapshot.fileExists,
		readFile: snapshot.readFile,
		readDirectory: snapshot.readDirectory,
	};
}

function createSnapshotHost(snapshot: TreeSnapshot, options: ts.CompilerOptions): ts.CompilerHost {
	const base = ts.createCompilerHost(options);
	return {
		...base,
		getCurrentDirectory: () => snapshot.root,
		fileExists: snapshot.fileExists,
		readFile: snapshot.readFile,
		directoryExists: snapshot.directoryExists,
		getDirectories: snapshot.getDirectories,
		readDirectory: snapshot.readDirectory,
		realpath: (path) => path,
		getSourceFile: (fileName, languageVersionOrOptions, _onError, shouldCreateNewSourceFile) => {
			const text = snapshot.readFile(fileName);
			if (text === undefined) return undefined;
			return ts.createSourceFile(fileName, text, languageVersionOrOptions, shouldCreateNewSourceFile ?? true);
		},
	};
}

/** Build the index over a snapshot's tree, with its own tsconfig options. */
export function indexSnapshot(snapshot: TreeSnapshot): GlyphIndex {
	const options = loadCompilerOptions(snapshot.root, undefined, configHostOf(snapshot));
	const program = ts.createProgram({
		rootNames: snapshot.files.map((file) => join(snapshot.root, file)),
		options,
		host: createSnapshotHost(snapshot, options),
	});
	return indexProgram(snapshot.root, snapshot.files, program);
}
