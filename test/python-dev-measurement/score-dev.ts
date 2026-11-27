/**
 * Scores the hand labels of a development sample against the repository's own
 * analyzer (GCLI-86, DEC-303 (a23) item 5; (a24) arm A). A labelled true site
 * counts as resolved when the analyzer emitted an edge from that file and line to
 * the target symbol. Development data only: not a test, not run by any workflow,
 * no gate depends on it. Written from scratch; nothing here is derived from
 * test/python-gate.
 *
 *   bun test/python-dev-measurement/score-dev.ts <repo-root> <enum.json> <labels.json>
 *
 * Labels name `<target index>.<site index>` into the enumeration file, grouped by
 * the mechanism a human read at the site (D direct name, N nested def, C
 * Class.method, S self/cls/inherited method, Q2 self.attr.m(), ALIAS, TS, K a
 * known-class local; X marks excluded sites and is not scored).
 *
 * A target is matched to an analyzer symbol by DECLARATION SITE — the
 * declaration's file, its line and the 1-based column of its name — never by
 * qualname, a suffix or a fuzzy match (DEC-303 (a93) item 4, Q-B A). The census
 * records that column (GCLI-168). An enumeration generated before the column was
 * recorded is matched on the declaration line only when exactly one symbol sits
 * there; a line holding more than one symbol is undecidable and stays unresolved
 * rather than guessed.
 */
import { readFileSync } from "node:fs";
import { analyzeRepository } from "./measure.ts";

interface Site {
	file: string;
	line: number;
	src: string;
}
export interface Target {
	file: string;
	line: number;
	/** 1-based column of the declared name; absent from pre-GCLI-168 enumerations. */
	column?: number;
	qual: string;
	sites: Site[];
}

/** A symbol's declaration site: where the analyzer says the name is declared. */
export interface DeclaredSymbol {
	file: string;
	line: number;
	column: number;
	id: string;
}

/** Declaration sites of one analysis, keyed for exact site and for exact line. */
export interface DeclarationIndex {
	readonly bySite: ReadonlyMap<string, string>;
	readonly byLine: ReadonlyMap<string, readonly string[]>;
}

const NUL = "\u0000";

function siteKey(file: string, line: number, column: number): string {
	return `${file}${NUL}${line}${NUL}${column}`;
}

function lineKey(file: string, line: number): string {
	return `${file}${NUL}${line}`;
}

export function buildDeclarationIndex(symbols: readonly DeclaredSymbol[]): DeclarationIndex {
	const bySite = new Map<string, string>();
	const byLine = new Map<string, string[]>();
	for (const symbol of symbols) {
		bySite.set(siteKey(symbol.file, symbol.line, symbol.column), symbol.id);
		const key = lineKey(symbol.file, symbol.line);
		const atLine = byLine.get(key) ?? [];
		atLine.push(symbol.id);
		byLine.set(key, atLine);
	}
	return { bySite, byLine };
}

/**
 * The analyzer symbol declared at a target's site, or undefined when nothing is
 * declared there. For an enumeration without a column the answer is the single
 * symbol on that declaration line; a line with several symbols is refused.
 */
export function symbolIdForTarget(
	index: DeclarationIndex,
	target: Pick<Target, "file" | "line" | "column">,
): string | undefined {
	if (typeof target.column === "number") {
		return index.bySite.get(siteKey(target.file, target.line, target.column));
	}
	const atLine = index.byLine.get(lineKey(target.file, target.line));
	return atLine !== undefined && atLine.length === 1 ? atLine[0] : undefined;
}

async function main(): Promise<void> {
	const [root, enumPath, labelsPath] = process.argv.slice(2);
	if (root === undefined || enumPath === undefined || labelsPath === undefined) {
		throw new Error("usage: bun test/python-dev-measurement/score-dev.ts <repo-root> <enum.json> <labels.json>");
	}

	const result = await analyzeRepository(root);
	const targets = JSON.parse(readFileSync(enumPath, "utf8")) as Target[];
	const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string[]>;

	const index = buildDeclarationIndex(result.symbols);
	const edgeTargets = new Map<string, Set<string>>();
	for (const site of result.sites) {
		if (site.calleeId === null) continue;
		const key = `${site.file}:${site.line}`;
		const set = edgeTargets.get(key) ?? new Set<string>();
		set.add(site.calleeId);
		edgeTargets.set(key, set);
	}

	let total = 0;
	let hits = 0;
	for (const [category, ids] of Object.entries(labels)) {
		if (category === "X") continue;
		let hit = 0;
		const misses: string[] = [];
		for (const id of ids) {
			const [targetIndex, siteIndex] = id.split(".").map(Number);
			const target = targets[targetIndex ?? -1];
			const site = target?.sites[siteIndex ?? -1];
			if (target === undefined || site === undefined) throw new Error(`label ${id} names no enumerated site`);
			const symbolId = symbolIdForTarget(index, target);
			const resolved = symbolId !== undefined && (edgeTargets.get(`${site.file}:${site.line}`)?.has(symbolId) ?? false);
			if (resolved) hit++;
			else misses.push(`${id} ${target.qual} <- ${site.file}:${site.line} ${site.src.slice(0, 60)}`);
		}
		total += ids.length;
		hits += hit;
		console.log(`${category} ${hit}/${ids.length}`);
		for (const miss of misses) console.log(`   miss: ${miss}`);
	}
	console.log(`TOTAL ${hits}/${total} ${total === 0 ? "n/a" : (hits / total).toFixed(4)}`);
}

if (import.meta.main) await main();
