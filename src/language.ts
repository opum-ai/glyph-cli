import { discoverFiles } from "./discover.ts";
import { indeterminateError, notFoundError, usageError } from "./errors.ts";
import { buildIndex } from "./indexer.ts";
import type { GlyphIndex } from "./types.ts";

/**
 * The language seam (ADR 0008, GCLI-70): one language per run, selected by
 * detection or by `--language`, and indexed by the one registered
 * `LanguageIndexer` for it.
 *
 * Recognition and registration are deliberately separate. A language is
 * *recognised* by its file extensions so it can be detected and reported; it is
 * *indexed* only when an indexer is registered for it. In this slice `python`
 * is recognised but not registered, so a Python-only repository is `not_found`
 * naming the language and its file count (never a silent empty index, the
 * "never a silent empty answer" rule restated as ADR 0008's ruled item 4), and
 * a mixed tree names Python as not-indexed while indexing TypeScript.
 */

/** The language a run indexes when the caller names none and TypeScript is present. */
export const DEFAULT_LANGUAGE = "typescript";

/**
 * Every language Glyph recognises by file extension, in detection preference
 * order. The order is total, so a mixed tree needs no tie-break beyond "the
 * earlier language wins": TypeScript before Python.
 */
export const KNOWN_LANGUAGES: readonly string[] = Object.freeze(["typescript", "python"]);

/** The extensions each recognised language claims. TypeScript covers JS too (DEC-66). */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	typescript: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
	python: [".py"],
});

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
 */
export interface LanguageIndexer {
	readonly id: string;
	index(repoRoot: string, files: string[]): GlyphIndex;
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

/** Build the index for `languageId` through its registered indexer. */
export function indexWith(languageId: string, repoRoot: string, files: string[]): GlyphIndex {
	const indexer = REGISTRY.get(languageId);
	if (indexer === undefined) {
		throw indeterminateError(`no indexer is registered for language '${languageId}'`);
	}
	return indexer.index(repoRoot, files);
}

// The only registered indexer in this slice: TypeScript/JavaScript through the
// compiler API. Registering the existing `buildIndex` behind the seam is what
// keeps the index bytes identical to a direct call.
registerLanguage({ id: "typescript", index: buildIndex });

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

/** A recognised language present in scope that has no registered indexer. */
export interface NotIndexedLanguage {
	language: string;
	files: number;
}

/** The recognised languages present with no registered indexer, as reported. */
export function notIndexedOf(present: readonly LanguagePresence[]): NotIndexedLanguage[] {
	return present
		.filter((entry) => !REGISTRY.has(entry.id))
		.map((entry) => ({ language: entry.id, files: entry.files.length }));
}

/**
 * The not-found message when the only recognised languages have no indexer.
 *
 * Deliberately free of a repository/ref location, so the working-tree path and
 * the `--ref` path answer with the same bytes (ADR 0008 slices after S1 wire
 * Python in; until S7 registers it, a Python-only tree is this exit-3 answer).
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
 * - No `requested`: the first registered language present wins; a tree whose
 *   only recognised language has no indexer is not-found naming that language
 *   and its count (never an empty answer); no recognised files is the scope's
 *   own not-found.
 *
 * Shared by the working-tree and `--ref` paths so both answer identically.
 */
export function selectFromPresence(
	present: readonly LanguagePresence[],
	requested: string | undefined,
	scope: SourceScope,
): LanguageSelection {
	const notIndexed = notIndexedOf(present);

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
		return { id: requested, files: chosen.files, notIndexed };
	}

	const chosen = present.find((entry) => REGISTRY.has(entry.id));
	if (chosen !== undefined) return { id: chosen.id, files: chosen.files, notIndexed };

	if (notIndexed.length > 0) throw notFoundError(noIndexableSourcesMessage(present));
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
