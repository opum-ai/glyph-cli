import { discoverFiles, SOURCE_EXTENSIONS } from "./discover.ts";
import { notFoundError, usageError } from "./errors.ts";
import { buildIndex } from "./indexer.ts";
import { pythonIndexer } from "./python/indexer.ts";
import { indexSnapshot, snapshotAtRef } from "./snapshot.ts";
import type { GlyphIndex } from "./types.ts";

/**
 * The language seam (ADR 0008, GCLI-70 and GCLI-82): one language per run,
 * selected by detection or by `--language`, and indexed by the one registered
 * `LanguageIndexer` for it.
 *
 * Recognition and registration are separate. A language is *recognised* by its
 * file extensions so it can be detected and reported; it is *indexed* only when
 * an indexer is registered for it. TypeScript and Python are both registered as
 * of S7: a Python-only repository is indexed rather than refused, and a mixed
 * tree indexes the one language detection picks (TypeScript before Python,
 * `--language python` overrides) while naming the other as not indexed in this
 * run — never a silent empty answer (ADR 0008's ruled item 4).
 */

/** The language a run indexes when the caller names none and TypeScript is present. */
export const DEFAULT_LANGUAGE = "typescript";

/**
 * Every language Glyph recognises by file extension, in detection preference
 * order. The order is total, so a mixed tree needs no tie-break beyond "the
 * earlier language wins": TypeScript before Python.
 */
export const KNOWN_LANGUAGES: readonly string[] = Object.freeze(["typescript", "python"]);

/**
 * The extensions each recognised language claims. TypeScript's list is
 * `SOURCE_EXTENSIONS` itself, so the seam's recognition and the indexer's
 * discovery cannot drift; TypeScript covers JS too (DEC-66).
 */
export const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	typescript: SOURCE_EXTENSIONS,
	python: [".py"],
});

/**
 * Directory segments a Python file under which is not counted. A virtualenv or a
 * byte-cache is not the project's Python source. This is a Python rule only:
 * TypeScript discovery keeps dev's excluded-directory set and still indexes a
 * `.ts` under these segments. Applied by path segment to the working-tree and
 * `--ref` listings alike, so a TRACKED file under one of them is not counted
 * either — one rule for both sources.
 */
const PYTHON_EXCLUDED_SEGMENTS = new Set([".venv", "venv", "__pycache__", ".tox"]);

function underExcludedPythonSegment(path: string): boolean {
	return path
		.split("/")
		.slice(0, -1)
		.some((segment) => PYTHON_EXCLUDED_SEGMENTS.has(segment));
}

/** The language a repository-relative path belongs to, or null when none claims it. */
export function languageOfPath(path: string): string | null {
	for (const id of KNOWN_LANGUAGES) {
		if (LANGUAGE_EXTENSIONS[id]?.some((ext) => path.endsWith(ext)) === true) return id;
	}
	return null;
}

/** `1 file` / `N files`, for the coverage line and the not-indexed message. */
export function fileCountLabel(count: number): string {
	return `${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * One language's indexer: produces the shared `GlyphIndex` over a repository
 * root and that language's files. The seam keeps every query and consumer on
 * the same index shape whatever produced it.
 *
 * `index` may return a promise: the Python grammar loads through wasm, so its
 * indexer is asynchronous (S7 rule 1). The TypeScript indexer stays synchronous
 * and its output bytes do not change. `indexRef` builds the same index for one
 * commit's tree, read without a checkout.
 */
export interface LanguageIndexer {
	readonly id: string;
	/**
	 * `markerDirs` are the Python project-root marker directories from the same
	 * listing the caller selected `files` from (S8a, DEC-303 (a18)); a language
	 * with no use for them ignores the argument, so TypeScript output is unchanged.
	 */
	index(repoRoot: string, files: string[], markerDirs?: readonly string[]): GlyphIndex | Promise<GlyphIndex>;
	indexRef(
		repoRoot: string,
		sha: string,
		files: string[],
		markerDirs?: readonly string[],
	): GlyphIndex | Promise<GlyphIndex>;
	/**
	 * The version constants a cache key adds beyond the language id and the file
	 * list (S7 rule 6). Absent for TypeScript, whose key is unchanged.
	 */
	readonly cacheKey?: { analyzerVersion: string; grammarVersion: string };
}

const REGISTRY = new Map<string, LanguageIndexer>();

/** Register one language's indexer. The registry is keyed by language id. */
export function registerLanguage(indexer: LanguageIndexer): void {
	REGISTRY.set(indexer.id, indexer);
}

/** The registered (indexable) language ids, sorted, for usage-error messages. */
export function registeredLanguages(): string[] {
	return [...REGISTRY.keys()].sort();
}

/** Build the index for `languageId` through its registered indexer. Callers await it. */
export async function indexWith(
	languageId: string,
	repoRoot: string,
	files: string[],
	markerDirs?: readonly string[],
): Promise<GlyphIndex> {
	const indexer = REGISTRY.get(languageId);
	if (indexer === undefined) {
		// Unreachable through the CLI: selection only ever names a registered
		// language. An internal error (exit 1), never a second exit-7 cause.
		throw new Error(`internal: no indexer is registered for language '${languageId}'`);
	}
	return await indexer.index(repoRoot, files, markerDirs);
}

/** Build the index for one commit's tree through its registered indexer. */
export async function indexRefWith(
	languageId: string,
	repoRoot: string,
	sha: string,
	files: string[],
	markerDirs?: readonly string[],
): Promise<GlyphIndex> {
	const indexer = REGISTRY.get(languageId);
	if (indexer === undefined) {
		throw new Error(`internal: no indexer is registered for language '${languageId}'`);
	}
	return await indexer.indexRef(repoRoot, sha, files, markerDirs);
}

/**
 * The cache-key scope for a language, or undefined when its key needs none.
 * Python adds its id, an analyzer version and the grammar version, plus the
 * nested project-root marker directories when there are any (S8a: a changed
 * marker set changes resolution without changing the file list); TypeScript
 * returns undefined so its key is unchanged (S7 rule 6).
 */
export interface LanguageCacheScope {
	language: string;
	analyzerVersion: string;
	grammarVersion: string;
	/** Python only: the marker directories that change resolution, sorted, when non-empty. */
	markerDirs?: readonly string[];
}

export function cacheScopeOf(languageId: string, markerDirs?: readonly string[]): LanguageCacheScope | undefined {
	const indexer = REGISTRY.get(languageId);
	if (indexer?.cacheKey === undefined) return undefined;
	const sorted = markerDirs === undefined || markerDirs.length === 0 ? undefined : [...markerDirs].sort();
	return {
		language: languageId,
		...indexer.cacheKey,
		...(sorted === undefined ? {} : { markerDirs: sorted }),
	};
}

// TypeScript/JavaScript through the compiler API. Registering the existing
// `buildIndex` behind the seam is what keeps the index bytes identical to a
// direct call; `indexRef` is the same `indexSnapshot` the `--ref` path already
// used. Python's indexer is native and asynchronous (ADR 0008).
registerLanguage({
	id: "typescript",
	index: buildIndex,
	indexRef: (repoRoot, sha) => indexSnapshot(snapshotAtRef(repoRoot, sha)),
});
registerLanguage(pythonIndexer);

/** One recognised language present in scope, with its files. */
export interface LanguagePresence {
	id: string;
	files: string[];
}

/** Group a file list by recognised language, in {@link KNOWN_LANGUAGES} order. */
export function groupByLanguage(files: readonly string[]): LanguagePresence[] {
	const byLanguage = new Map<string, string[]>();
	for (const path of files) {
		const id = languageOfPath(path);
		if (id === null) continue;
		// Python alone skips a virtualenv/cache segment; TypeScript keeps every path.
		if (id === "python" && underExcludedPythonSegment(path)) continue;
		const list = byLanguage.get(id);
		if (list === undefined) byLanguage.set(id, [path]);
		else list.push(path);
	}
	return KNOWN_LANGUAGES.filter((id) => byLanguage.has(id)).map((id) => ({ id, files: byLanguage.get(id) ?? [] }));
}

/** Every recognised language present in `repoRoot`, in {@link KNOWN_LANGUAGES} order. */
export function detectLanguages(repoRoot: string): LanguagePresence[] {
	return groupByLanguage(discoverFiles(repoRoot, (path) => languageOfPath(path) !== null));
}

/** A recognised language present in scope that this run does not index. */
export interface NotIndexedLanguage {
	language: string;
	files: number;
}

/**
 * The recognised languages present with no registered indexer. Used only for
 * the not-found message: a tree whose only recognised language has no indexer
 * is named and counted rather than answered empty.
 */
export function notIndexedOf(present: readonly LanguagePresence[]): NotIndexedLanguage[] {
	return present
		.filter((entry) => !REGISTRY.has(entry.id))
		.map((entry) => ({ language: entry.id, files: entry.files.length }));
}

/**
 * The languages present that this run does not index: one language per run
 * (ADR 0008 item 5), so every other recognised language in scope is named in
 * the coverage, whether or not an indexer exists for it (S7 rule 1).
 */
function notIndexedIn(present: readonly LanguagePresence[], selectedId: string): NotIndexedLanguage[] {
	return present
		.filter((entry) => entry.id !== selectedId)
		.map((entry) => ({ language: entry.id, files: entry.files.length }));
}

/**
 * The not-found message when the only recognised languages have no indexer.
 *
 * Deliberately free of a repository/ref location, so the working-tree path and
 * the `--ref` path answer with the same bytes. With both TypeScript and Python
 * registered this is unreachable today; it stays as the generic guard for a
 * recognised language a later slice adds before its indexer.
 */
export function noIndexableSourcesMessage(present: readonly LanguagePresence[]): string {
	const notIndexed = notIndexedOf(present);
	const named = notIndexed.map((entry) => `${entry.language} (${fileCountLabel(entry.files)})`).join(", ");
	return `no TypeScript or JavaScript sources; ${named} not indexed yet`;
}

/** Where a selection runs, for the messages that carry a location. */
export interface SourceScope {
	/** Completes "no <language> sources found": `under <repo>` or `at <ref> (<sha>) in <repo>`. */
	where: string;
	/** The exact not-found message when no recognised source exists at all. */
	emptyMessage: string;
}

/** The language a run will index, its files, and any present language it cannot. */
export interface LanguageSelection {
	/** The language whose indexer will run. */
	id: string;
	/** The selected language's files, repository-relative and sorted. */
	files: string[];
	/** Recognised languages present but not indexed; empty on a pure-TypeScript scope. */
	notIndexed: NotIndexedLanguage[];
}

/** True when the selection is the plain default: TypeScript, with nothing left unindexed. */
export function isDefaultLanguage(selection: LanguageSelection): boolean {
	return selection.id === DEFAULT_LANGUAGE && selection.notIndexed.length === 0;
}

/**
 * The language a run will index over the recognised languages `present`.
 *
 * - `requested` unregistered: usage error naming the registered languages.
 * - `requested` registered with no files: not-found naming the language.
 * - No `requested`: the first registered language present wins (TypeScript
 *   before Python); no recognised files is the scope's own not-found.
 *
 * Every other recognised language present is named as not indexed in this run
 * (one language per run, ADR 0008 item 5), so a mixed tree's unselected
 * language is never dropped silently.
 *
 * Shared by the working-tree and `--ref` paths so both answer identically.
 */
export function selectFromPresence(
	present: readonly LanguagePresence[],
	requested: string | undefined,
	scope: SourceScope,
): LanguageSelection {
	if (requested !== undefined) {
		if (!REGISTRY.has(requested)) {
			throw usageError(
				`cannot index language '${requested}'; registered languages: ${registeredLanguages().join(", ")}`,
			);
		}
		const chosen = present.find((entry) => entry.id === requested);
		if (chosen === undefined || chosen.files.length === 0) {
			throw notFoundError(`no ${requested} sources found ${scope.where}`);
		}
		return { id: requested, files: chosen.files, notIndexed: notIndexedIn(present, requested) };
	}

	const chosen = present.find((entry) => REGISTRY.has(entry.id));
	if (chosen !== undefined) {
		return { id: chosen.id, files: chosen.files, notIndexed: notIndexedIn(present, chosen.id) };
	}

	const unindexable = notIndexedOf(present);
	if (unindexable.length > 0) throw notFoundError(noIndexableSourcesMessage(present));
	throw notFoundError(scope.emptyMessage);
}

/** Select over the working tree at `repoRoot`. */
export function selectLanguage(repoRoot: string, requested: string | undefined): LanguageSelection {
	const present = detectLanguages(repoRoot);
	return selectFromPresence(present, requested, {
		where: `under ${repoRoot}`,
		emptyMessage: `no TypeScript or JavaScript sources found under ${repoRoot}`,
	});
}
