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
 * is recognised but not registered, so a Python-only repository is an honest
 * "cannot answer" rather than a silent empty index (DEC-303 item 2), and a
 * mixed tree names Python as not-indexed while indexing TypeScript.
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

/** `1 file` / `N files`, for the coverage line and the indeterminate message. */
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

/** One recognised language present in a repository, with its files. */
export interface LanguagePresence {
	id: string;
	files: string[];
}

/** Every recognised language present in `repoRoot`, in {@link KNOWN_LANGUAGES} order. */
export function detectLanguages(repoRoot: string): LanguagePresence[] {
	const files = discoverFiles(repoRoot, (path) => languageOfPath(path) !== null);
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

/** A recognised language present in scope that has no registered indexer. */
export interface NotIndexedLanguage {
	language: string;
	files: number;
}

/** The language a run will index, its files, and any present language it cannot. */
export interface LanguageSelection {
	/** The language whose indexer will run. */
	id: string;
	/** The selected language's files, repository-relative and sorted. */
	files: string[];
	/** Recognised languages present but not indexed; empty on a pure-TypeScript tree. */
	notIndexed: NotIndexedLanguage[];
}

/** True when the selection is the plain default: TypeScript, with nothing left unindexed. */
export function isDefaultLanguage(selection: LanguageSelection): boolean {
	return selection.id === DEFAULT_LANGUAGE && selection.notIndexed.length === 0;
}

/**
 * The language a run will index.
 *
 * - No `requested`: the first registered language present wins; a recognised
 *   but unregistered language is `indeterminate` (never an empty answer); no
 *   recognised files is the existing not-found.
 * - `requested` unregistered: usage error naming the registered languages.
 * - `requested` registered with no files: not-found naming the language.
 */
export function selectLanguage(repoRoot: string, requested: string | undefined): LanguageSelection {
	const present = detectLanguages(repoRoot);
	const notIndexed = present
		.filter((entry) => !REGISTRY.has(entry.id))
		.map((entry) => ({ language: entry.id, files: entry.files.length }));

	if (requested !== undefined) {
		if (!REGISTRY.has(requested)) {
			throw usageError(
				`cannot index language '${requested}'; registered languages: ${registeredLanguages().join(", ")}`,
			);
		}
		const chosen = present.find((entry) => entry.id === requested);
		if (chosen === undefined || chosen.files.length === 0) {
			throw notFoundError(`no ${requested} sources found under ${repoRoot}`);
		}
		return { id: requested, files: chosen.files, notIndexed };
	}

	const chosen = present.find((entry) => REGISTRY.has(entry.id));
	if (chosen !== undefined) return { id: chosen.id, files: chosen.files, notIndexed };

	if (notIndexed.length > 0) {
		const named = notIndexed.map((entry) => `${entry.language} (${fileCountLabel(entry.files)})`).join(", ");
		throw indeterminateError(
			`detected ${named} under ${repoRoot}, but no indexer is registered for that language; registered languages: ${registeredLanguages().join(", ")}`,
		);
	}

	throw notFoundError(`no TypeScript or JavaScript sources found under ${repoRoot}`);
}
