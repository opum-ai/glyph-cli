/**
 * The shape of Glyph's local index and its JSON envelope.
 *
 * The index is the one derived artifact Glyph keeps, and it is disposable:
 * everything in it is re-derivable from the repository (ADR 0001's consequence —
 * deleting the cache must never lose evidence, only time).
 */

/** Bumped when the index shape changes; part of every cache key. */
export const INDEX_FORMAT = 1;

/** Bumped when the envelope shape changes. */
export const ENVELOPE_SCHEMA = 1;

export type SymbolKind = "function" | "method" | "property" | "class" | "interface" | "type" | "enum" | "variable";

/** One declaration in the symbol table. Ids are `file:line:column` of the name. */
export interface SymbolEntry {
	id: string;
	name: string;
	/** Nearest enclosing class/interface/enum, or null for top-level declarations. */
	container: string | null;
	kind: SymbolKind;
	/** Repository-relative path. */
	file: string;
	/**
	 * 1-based line of the declaration's leading trivia (comments included), which
	 * is the span's start for "does this diff touch it". `line`/`column` stay at
	 * the name for identity and reporting.
	 */
	startLine: number;
	/** 1-based. */
	line: number;
	/** 1-based. */
	column: number;
	/** 1-based; the declaration's last line. */
	endLine: number;
}

/**
 * One call site, resolved through the type checker to the declaration it
 * invokes. `reference` sites (reading a symbol without calling it) are not
 * recorded in v0 — the index answers "what calls this symbol" as call sites,
 * which is the query the ADR names (see README's limits section).
 */
export type SiteKind = "call" | "new";

export interface SiteEntry {
	/** The `SymbolEntry.id` this site invokes. */
	calleeId: string;
	/** The enclosing declaration at the call site, or null at module scope. */
	callerId: string | null;
	file: string;
	line: number;
	column: number;
	kind: SiteKind;
}

export interface GlyphIndex {
	schemaVersion: typeof INDEX_FORMAT;
	repo: string;
	createdAt: string;
	files: string[];
	symbols: SymbolEntry[];
	sites: SiteEntry[];
	/** Call-shaped sites whose callee resolved outside the repository (or not at all). */
	unresolvedSites: number;
}

/** Summary of the index source, carried in every query result. */
export interface IndexInfo {
	cache: "hit" | "miss";
	files: number;
	symbols: number;
	sites: number;
}

export type ExitOk = 0;
export const EXIT_OK: ExitOk = 0;
