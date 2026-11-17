import { computeRefKey, readCachedIndex, writeCachedIndex } from "./cache.ts";
import { impactOf } from "./impact.ts";
import { findSymbols } from "./queries.ts";
import { indexSnapshot, snapshotAtRef, sourceFilesAtRef } from "./snapshot.ts";
import type { GlyphIndex } from "./types.ts";

/**
 * Tier 3 of the code map (GCLI-37, DEC-216 (a4)(c) and (a6) Q2): the symbols a
 * task text names, resolved through the index to the files that declare them
 * (distance 0) and, one call-graph hop out, the files that reference them
 * (distance 1). A symbol resolved through the type checker is a stronger signal
 * than a text match, so this tier ranks above git-grep.
 */

/** One file tier 3 points at, and why. */
export interface SymbolHit {
	path: string;
	/** 0 = declares a named symbol, 1 = references one at depth 1. Lower ranks first. */
	distance: 0 | 1;
	/** 1-based line of the declaration or of the referencing site. */
	line: number;
	detail: string;
}

/** The verb for one reference site: a call, an import, a heritage clause. */
const VERBS: Readonly<Record<string, string>> = {
	call: "calls",
	new: "constructs",
	import: "imports",
	extends: "extends",
	implements: "implements",
};

/**
 * Hits for `identifiers`, matched against index symbols by EXACT name. A name
 * that matches several symbols includes every one of them, each counted
 * (Q2); a qualified name such as `Foo.bar` matches no symbol and is left to the
 * git-grep tier. A pure function of the index and the identifiers.
 */
export function symbolHits(index: GlyphIndex, identifiers: readonly string[]): SymbolHit[] {
	const hits: SymbolHit[] = [];
	for (const name of identifiers) {
		for (const symbol of findSymbols(index, name, undefined)) {
			hits.push({
				path: symbol.file,
				distance: 0,
				line: symbol.line,
				detail: `declares symbol \`${name}\` (${symbol.kind})`,
			});
			for (const caller of impactOf(index, symbol, 1).callers) {
				// The first edge is the site that makes this caller a caller.
				const edge = caller.path[0];
				if (edge === undefined) continue;
				hits.push({
					path: edge.file,
					distance: 1,
					line: edge.line,
					detail: `${VERBS[edge.kind] ?? "references"} symbol \`${name}\` (depth 1)`,
				});
			}
		}
	}
	return hits;
}

/**
 * The index of `commit`'s tree, from the same ref-keyed cache `--ref` uses, or
 * null when the commit carries no TypeScript or JavaScript source. The tree is
 * read without a checkout, so a dirty working tree cannot move the answer.
 */
export function loadRefIndex(repositoryPath: string, commit: string): GlyphIndex | null {
	const files = sourceFilesAtRef(repositoryPath, commit);
	if (files.length === 0) return null;
	const key = computeRefKey(commit, files);
	const cached = readCachedIndex(repositoryPath, key);
	if (cached !== null) return cached;
	const index = indexSnapshot(snapshotAtRef(repositoryPath, commit));
	writeCachedIndex(repositoryPath, key, index);
	return index;
}
