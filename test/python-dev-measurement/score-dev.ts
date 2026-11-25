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
 */
import { readFileSync } from "node:fs";
import { analyzeRepository } from "./measure.ts";

interface Site {
	file: string;
	line: number;
	src: string;
}
interface Target {
	file: string;
	qual: string;
	sites: Site[];
}

const [root, enumPath, labelsPath] = process.argv.slice(2);
if (root === undefined || enumPath === undefined || labelsPath === undefined) {
	throw new Error("usage: bun test/python-dev-measurement/score-dev.ts <repo-root> <enum.json> <labels.json>");
}

const result = await analyzeRepository(root);
const targets = JSON.parse(readFileSync(enumPath, "utf8")) as Target[];
const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as Record<string, string[]>;

const symbolIds = new Map<string, string>();
for (const symbol of result.symbols) symbolIds.set(`${symbol.file}\u0000${symbol.qualname}`, symbol.id);
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
		const symbolId = symbolIds.get(`${target.file}\u0000${target.qual}`);
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
