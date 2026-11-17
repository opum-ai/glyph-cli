/**
 * The shape of Glyph's local index and its JSON envelope.
 *
 * The index is the one derived artifact Glyph keeps, and it is disposable:
 * everything in it is re-derivable from the repository (ADR 0001's consequence —
 * deleting the cache must never lose evidence, only time).
 */

/** Bumped when the index shape changes; part of every cache key. */
export const INDEX_FORMAT = 2;

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
 * One edge of the index, beside the symbol table. `call` and `new` are resolved
 * call sites; `import` is an import or re-export binding; `extends` and
 * `implements` are heritage clauses (DEC-216 (a3)). `reference` sites (reading
 * a symbol without calling it) are still not recorded: read/write reference
 * edges stay out of scope, which is why an import's dependent is the importing
 * module and not the declarations that use the binding.
 */
export type SiteKind = "call" | "new" | "import" | "extends" | "implements";

/** The kinds `glyph callers` reports: invocations, never the structural edges. */
export const CALL_KINDS: readonly SiteKind[] = ["call", "new"];

export interface SiteEntry {
	/**
	 * The `SymbolEntry.id` this site targets. Null only for a module edge (a
	 * namespace import, a side-effect import or `export *`), which binds no
	 * single symbol and carries `moduleTarget` instead.
	 */
	calleeId: string | null;
	/**
	 * The enclosing declaration at the site, or null at module scope. An import
	 * or re-export is always module scope; an `extends`/`implements` edge's
	 * caller is the declaration that carries the heritage clause.
	 */
	callerId: string | null;
	file: string;
	line: number;
	column: number;
	kind: SiteKind;
	/** Import sites only: the binding is `import type` or a type-only specifier. */
	typeOnly?: boolean;
	/** Module edges only: the repository-relative file the specifier resolves to. */
	moduleTarget?: string;
}

/** Sites that did not resolve in-repo, by the kind that is blind. */
export interface UnresolvedByKind {
	/** Call and `new` sites, which share one counter. */
	call: number;
	import: number;
	extends: number;
	implements: number;
	/** Dynamic `import()` and `require()`: out of scope for resolution, still counted. */
	dynamic: number;
}

export interface GlyphIndex {
	schemaVersion: typeof INDEX_FORMAT;
	repo: string;
	createdAt: string;
	files: string[];
	symbols: SymbolEntry[];
	sites: SiteEntry[];
	/** Every site that did not resolve in-repo: the sum of `unresolvedByKind`. */
	unresolvedSites: number;
	unresolvedByKind: UnresolvedByKind;
}

/** Summary of the index source, carried in every query result. */
export interface IndexInfo {
	cache: "hit" | "miss";
	files: number;
	symbols: number;
	sites: number;
}
