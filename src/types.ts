/**
 * The shape of Glyph's local index and its JSON envelope.
 *
 * The index is the one derived artifact Glyph keeps, and it is disposable:
 * everything in it is re-derivable from the repository (ADR 0001's consequence —
 * deleting the cache must never lose evidence, only time).
 */

/** Bumped when the index shape changes; part of every cache key. */
export const INDEX_FORMAT = 3;

export type SymbolKind = "function" | "method" | "property" | "class" | "interface" | "type" | "enum" | "variable";

/** One declaration in the symbol table. Ids are `file:line:column` of the name. */
export interface SymbolEntry {
	id: string;
	name: string;
	/** Nearest enclosing class/interface/enum, or null for top-level declarations. */
	container: string | null;
	/**
	 * The full enclosing qualified name, for languages that have one: Python
	 * emits it (e.g. `Parameter.type_cast_value._convert`, without a `<locals>`
	 * segment) and TypeScript leaves it absent (DEC-303 (a5) Q6 arm A). `container`
	 * keeps its documented meaning beside it.
	 */
	qualname?: string;
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
	/**
	 * True when a namespace binding (`import * as ns from`) can reach this symbol:
	 * a module-level declaration the module exports, or a member of one. Local and
	 * non-exported declarations are false (DEC-216 (a5)).
	 */
	exported: boolean;
}

/**
 * One edge of the index, beside the symbol table. `call` and `new` are resolved
 * call sites; `decorator` is a bare `@d` application, a resolved incoming edge
 * to `d` in its own kind (DEC-303 (a14) 1); `import` is an import or re-export
 * binding; `extends` and `implements` are heritage clauses (DEC-216 (a3)).
 * `reference` sites (reading a symbol without calling it) are still not
 * recorded: read/write reference edges stay out of scope, which is why an
 * import's dependent is the importing module and not the declarations that use
 * the binding.
 */
export type SiteKind = "call" | "new" | "decorator" | "import" | "extends" | "implements";

/**
 * The kinds `glyph callers` reports: invocations, never the structural edges.
 * A decorator application is an incoming edge to the function it applies, so
 * it belongs here (DEC-303 (a14) 1).
 */
export const CALL_KINDS: readonly SiteKind[] = ["call", "new", "decorator"];

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
	/**
	 * Python only (DEC-303 (a14) 3): every call expression falls in exactly one
	 * of these four bins. ABSENT for TypeScript, never null or zero-filled, so a
	 * TypeScript index and its envelopes keep their exact bytes.
	 */
	callBins?: {
		resolvedInRepo: number;
		resolvedExternal: number;
		receiverNeedsInference: number;
		nameNotBound: number;
	};
	/**
	 * Python only (DEC-303 (a14) 3): S3's unresolved-first-party import count.
	 * Absent for TypeScript, like `callBins`.
	 */
	unresolvedFirstPartyImports?: number;
	/** Python only (DEC-303 (a14) 3): the number of S5 constructor notes. */
	constructorNotes?: number;
	/**
	 * Python only (DEC-303 (a15) 19): one entry per file whose parse holds an
	 * ERROR node, ordered by path, carrying the call expressions dropped inside
	 * its ERROR regions. ABSENT for TypeScript and for a Python run with no parse
	 * errors — never null and never `[]`, so no existing golden changes bytes.
	 * `exact` is not published beside it (rule 20).
	 */
	parseErrorFiles?: ParseErrorFile[];
}

/** One file whose Python parse holds an ERROR node (DEC-303 (a15) 19). */
export interface ParseErrorFile {
	/** Repository-relative POSIX path. */
	path: string;
	/** Call expressions dropped inside this file's ERROR regions. */
	droppedCalls: number;
}

/** Summary of the index source, carried in every query result. */
export interface IndexInfo {
	cache: "hit" | "miss";
	files: number;
	symbols: number;
	sites: number;
	/**
	 * The indexed language, present only when the answer is not the plain
	 * TypeScript default (ADR 0008's additive contract entry). Absent — never
	 * null, never a constant — on a repository with no recognised non-TypeScript
	 * source, so that answer stays byte-identical.
	 */
	language?: string;
	/**
	 * Recognised languages present in scope but not indexed, present only when
	 * there are some. Absent on a pure-TypeScript repository.
	 */
	notIndexed?: { language: string; files: number }[];
}
