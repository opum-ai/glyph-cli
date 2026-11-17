import { notFoundError, usageError } from "./errors.ts";
import type { FileChange } from "./git.ts";
import { CALL_KINDS, type GlyphIndex, type SiteEntry, type SymbolEntry } from "./types.ts";

/**
 * The two queries, answered over the index. Nothing here re-parses source:
 * everything the queries need was resolved once, at index time, through the
 * type checker.
 */

/** A call site with its caller resolved for reporting. */
export interface CallerSite extends SiteEntry {
	caller: SymbolEntry | null;
}

function byPosition(a: SymbolEntry | SiteEntry, b: SymbolEntry | SiteEntry): number {
	return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}

/** Every symbol whose name matches, optionally narrowed by a file-path substring. */
export function findSymbols(index: GlyphIndex, name: string, filePattern: string | undefined): SymbolEntry[] {
	return index.symbols
		.filter((symbol) => symbol.name === name && (filePattern === undefined || symbol.file.includes(filePattern)))
		.sort(byPosition);
}

/**
 * The one symbol a caller meant. Ambiguity is a usage error (exit 2) that
 * lists the candidates rather than guessing; absence is not-found (exit 3).
 * `remedy` names the command's own disambiguation path, because the advice in
 * one command's error must not name a flag another command does not have.
 */
export function resolveSymbol(
	index: GlyphIndex,
	name: string,
	filePattern: string | undefined,
	remedy = "narrow with --file",
): SymbolEntry {
	const matches = findSymbols(index, name, filePattern);
	const narrowed = filePattern !== undefined ? ` in files matching '${filePattern}'` : "";
	if (matches.length === 0) {
		throw notFoundError(`no symbol named '${name}'${narrowed} in ${index.repo}`);
	}
	if (matches.length > 1) {
		const lines = matches.map((m) => `  ${display(m)} (${m.kind}) at ${m.file}:${m.line}:${m.column}`);
		throw usageError(`'${name}' matches ${matches.length} symbols${narrowed}; ${remedy}:\n${lines.join("\n")}`);
	}
	const only = matches[0];
	if (only === undefined) throw notFoundError(`no symbol named '${name}'${narrowed} in ${index.repo}`);
	return only;
}

/** `Container.name` when the symbol sits in one, `name` otherwise. */
export function display(symbol: SymbolEntry): string {
	return symbol.container === null ? symbol.name : `${symbol.container}.${symbol.name}`;
}

/** Call and `new` sites only: `callers` answers "what invokes this", never imports or heritage edges. */
export function callersOf(index: GlyphIndex, symbol: SymbolEntry): CallerSite[] {
	const byId = new Map(index.symbols.map((entry) => [entry.id, entry]));
	return index.sites
		.filter((site) => site.calleeId === symbol.id && CALL_KINDS.includes(site.kind))
		.map((site): CallerSite => ({ ...site, caller: site.callerId !== null ? (byId.get(site.callerId) ?? null) : null }))
		.sort(byPosition);
}

export interface TouchedResult {
	symbols: SymbolEntry[];
	filesChanged: number;
}

/**
 * Symbols a diff touches: any index symbol whose span intersects a changed line
 * range in its file. Only the innermost touched symbols are reported — a change
 * inside a method reports the method, not also every class that contains it,
 * because the outer symbols' spans always intersect anything the inner ones do.
 */
export function touchedSymbols(index: GlyphIndex, changes: FileChange[]): TouchedResult {
	const byFile = new Map(changes.map((change) => [change.file, change]));
	const touched = index.symbols.filter((symbol) => {
		const change = byFile.get(symbol.file);
		if (change === undefined) return false;
		if (change.wholeFile) return true;
		return change.ranges.some((range) => symbol.startLine <= range.end && symbol.endLine >= range.start);
	});

	const byFileSymbols = new Map<string, SymbolEntry[]>();
	for (const symbol of touched) {
		const list = byFileSymbols.get(symbol.file);
		if (list === undefined) byFileSymbols.set(symbol.file, [symbol]);
		else list.push(symbol);
	}
	const innermost: SymbolEntry[] = [];
	for (const list of byFileSymbols.values()) {
		for (const symbol of list) {
			// Drop a symbol that CONTAINS another touched symbol (the class, not the
			// method): the container's span always intersects whatever the inner one
			// does, so reporting both would double-report every method change.
			const containsOther = list.some(
				(other) =>
					other !== symbol &&
					symbol.startLine <= other.startLine &&
					symbol.endLine >= other.endLine &&
					(symbol.startLine < other.startLine || symbol.endLine > other.endLine),
			);
			if (!containsOther) innermost.push(symbol);
		}
	}
	innermost.sort(byPosition);
	return { symbols: innermost, filesChanged: changes.length };
}
