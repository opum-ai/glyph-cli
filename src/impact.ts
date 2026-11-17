import type { GlyphIndex, SiteEntry, SymbolEntry } from "./types.ts";

/**
 * `glyph impact` — the transitive reverse closure of the call graph.
 *
 * The walk is a breadth-first search from the selected symbol over the reverse
 * of `index.sites`, so every caller is discovered at its shortest depth and
 * exactly once. A caller's reported path is one shortest path to the target,
 * chosen by the total order the design record fixes: the path string first,
 * then the call site's file, line and column. Because the queue is FIFO, every
 * candidate that can reach a symbol at depth k arrives while the depth k - 1
 * level is still being expanded, so the path stored when a symbol is expanded
 * is final — no re-expansion is needed after a tie-break replacement.
 *
 * The bound is honest in both directions: the full closure is traversed even
 * when the answer is depth-bounded, so `truncated` and the count of callers
 * left unexplored are exact rather than a frontier estimate, and a cycle
 * cannot hang the walk (each symbol is discovered once). Cycle membership is
 * decided by strongly connected components over the discovered subgraph, so a
 * caller is marked `cycle: true` when it can reach itself through the target.
 *
 * A call site at module scope has no enclosing declaration (`callerId` is
 * null). Per DEC-216 (a1), as amended by (a2), it is a terminal caller:
 * reported at its true depth with `symbol: null` and the full path of edges
 * down to the target, never expanded, so impact's depth-1 set is a superset of
 * `callers`.
 *
 * Under DEC-216 (a3) the walk is still one breadth-first search, now over the
 * union of `call`, `new`, `import`, `extends` and `implements` sites. An import
 * is module scope (`callerId` null), so it is a terminal exactly like a
 * module-scope call; an `extends`/`implements` edge has the subclass or
 * implementer as its caller, so the walk continues from it over every kind. A
 * namespace or side-effect import binds no symbol: it is a depth-1 terminal of
 * any symbol impact STARTS from in the imported module (not of every symbol the
 * walk later reaches there). A changed method never fans out to overriding
 * methods in v1; that limitation is named in ADR 0004 and the README.
 */

/** One edge of a reported shortest path, carrying the call site that forms it. */
export interface ImpactEdge {
	file: string;
	line: number;
	column: number;
	kind: SiteEntry["kind"];
	callerId: string | null;
	/** The symbol this hop lands on; for a module edge, the symbol impact is walking from. */
	calleeId: string;
	/** Import hops only. */
	typeOnly?: boolean;
	/** Module-edge hops only: the file the namespace or side-effect import resolves to. */
	moduleTarget?: string;
}

export interface ImpactCaller {
	/** null when the caller is a module-scope call site. */
	symbol: SymbolEntry | null;
	depth: number;
	/** From this caller down to the target; the first edge is this caller's call. */
	path: ImpactEdge[];
	cycle: boolean;
}

export interface ImpactResult {
	callers: ImpactCaller[];
	truncated: boolean;
	/** Callers beyond the depth bound, counted exactly. */
	unexplored: number;
	/** Every caller found before the bound, included in `callers` or not. */
	total: number;
	/** True when any symbol in the closure, the target included, sits on a cycle. */
	cycle: boolean;
}

/** A module-scope call site is not a symbol; this key keeps its path unique. */
const MODULE_SCOPE = "module";

interface Discovery {
	symbol: SymbolEntry | null;
	depth: number;
	/** Symbol ids (or the module-site key) from this caller down to the target. */
	nodes: string[];
	edges: ImpactEdge[];
}

function position(
	a: { file: string; line: number; column: number },
	b: { file: string; line: number; column: number },
): number {
	return compareText(a.file, b.file) || a.line - b.line || a.column - b.column;
}

/**
 * Codepoint order, never `localeCompare`: the byte-identical guarantee must not
 * depend on the host's ICU default locale.
 */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function pathString(discovery: Discovery): string {
	return discovery.nodes.join(">");
}

/** The total order: depth, path string, then the first edge's position. */
function compareCallers(a: Discovery, b: Discovery): number {
	if (a.depth !== b.depth) return a.depth - b.depth;
	const byPath = compareText(pathString(a), pathString(b));
	if (byPath !== 0) return byPath;
	const first = a.edges[0];
	const other = b.edges[0];
	if (first === undefined || other === undefined) return a.edges.length - b.edges.length;
	return position(first, other);
}

function moduleKey(site: SiteEntry): string {
	return `${MODULE_SCOPE}:${site.file}:${site.line}:${site.column}`;
}

/** Strongly connected components (Kosaraju), iterative so depth cannot overflow. */
function cyclicSymbols(ids: readonly string[], callGraph: Map<string, string[]>): Set<string> {
	const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
	const reverse = new Map<string, string[]>(ids.map((id) => [id, []]));
	const selfLoops = new Set<string>();
	for (const [caller, callees] of callGraph) {
		for (const callee of callees) {
			if (caller === callee) selfLoops.add(caller);
			(adjacency.get(caller) ?? []).push(callee);
			(reverse.get(callee) ?? []).push(caller);
		}
	}

	const seen = new Set<string>();
	const order: string[] = [];
	for (const start of ids) {
		if (seen.has(start)) continue;
		const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
		seen.add(start);
		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			if (frame === undefined) break;
			const neighbours = adjacency.get(frame.id) ?? [];
			if (frame.next < neighbours.length) {
				const neighbour = neighbours[frame.next];
				frame.next += 1;
				if (neighbour !== undefined && !seen.has(neighbour)) {
					seen.add(neighbour);
					stack.push({ id: neighbour, next: 0 });
				}
				continue;
			}
			order.push(frame.id);
			stack.pop();
		}
	}

	const component = new Map<string, number>();
	let nextComponent = 0;
	const sizes: number[] = [];
	for (let index = order.length - 1; index >= 0; index -= 1) {
		const start = order[index];
		if (start === undefined || component.has(start)) continue;
		let size = 0;
		const stack = [start];
		component.set(start, nextComponent);
		while (stack.length > 0) {
			const id = stack.pop();
			if (id === undefined) break;
			size += 1;
			for (const neighbour of reverse.get(id) ?? []) {
				if (!component.has(neighbour)) {
					component.set(neighbour, nextComponent);
					stack.push(neighbour);
				}
			}
		}
		sizes[nextComponent] = size;
		nextComponent += 1;
	}

	const cyclic = new Set<string>();
	for (const id of ids) {
		const componentId = component.get(id);
		if (componentId === undefined) continue;
		if ((sizes[componentId] ?? 0) > 1 || selfLoops.has(id)) cyclic.add(id);
	}
	return cyclic;
}

/**
 * Every caller of `symbol`, computed over `index`. `depthBound` is the number
 * of hops to answer (the command's default is 5); `null` is the full closure.
 */
export function impactOf(index: GlyphIndex, symbol: SymbolEntry, depthBound: number | null): ImpactResult {
	const target = symbol.id;
	const byId = new Map(index.symbols.map((entry) => [entry.id, entry]));
	const reverse = new Map<string, SiteEntry[]>();
	/** Module edges, keyed by the file they target. */
	const byModule = new Map<string, SiteEntry[]>();
	for (const site of index.sites) {
		const [map, key] = site.calleeId !== null ? [reverse, site.calleeId] : [byModule, site.moduleTarget];
		if (key === undefined) continue;
		const list = map.get(key);
		if (list === undefined) map.set(key, [site]);
		else list.push(site);
	}
	for (const list of reverse.values()) list.sort(position);
	for (const list of byModule.values()) list.sort(position);

	const discovered = new Map<string, Discovery>();
	discovered.set(target, { symbol, depth: 0, nodes: [target], edges: [] });
	/** Module-scope sites are keyed by the site, which is already unique. */
	const moduleCallers = new Map<string, Discovery>();
	const queue: string[] = [target];

	while (queue.length > 0) {
		const id = queue.shift();
		if (id === undefined) break;
		const current = discovered.get(id);
		if (current === undefined) continue;
		const incoming = reverse.get(id) ?? [];
		const sites = id === target ? [...incoming, ...(byModule.get(symbol.file) ?? [])].sort(position) : incoming;
		for (const site of sites) {
			const edge: ImpactEdge = {
				file: site.file,
				line: site.line,
				column: site.column,
				kind: site.kind,
				callerId: site.callerId,
				calleeId: site.calleeId ?? id,
			};
			if (site.typeOnly !== undefined) edge.typeOnly = site.typeOnly;
			if (site.moduleTarget !== undefined) edge.moduleTarget = site.moduleTarget;
			const edges = [edge, ...current.edges];
			if (site.callerId === null) {
				const key = moduleKey(site);
				const candidate: Discovery = { symbol: null, depth: current.depth + 1, nodes: [key, ...current.nodes], edges };
				const existing = moduleCallers.get(key);
				if (existing === undefined || compareCallers(candidate, existing) < 0) moduleCallers.set(key, candidate);
				continue;
			}
			// The selected symbol is never its own impact; a self-call is a cycle.
			if (site.callerId === target) continue;
			const caller = byId.get(site.callerId) ?? null;
			const candidate: Discovery = {
				symbol: caller,
				depth: current.depth + 1,
				nodes: [site.callerId, ...current.nodes],
				edges,
			};
			const existing = discovered.get(site.callerId);
			if (existing === undefined) {
				discovered.set(site.callerId, candidate);
				queue.push(site.callerId);
			} else if (compareCallers(candidate, existing) < 0) {
				// Equal depth only in practice: the first discovery is the shortest.
				discovered.set(site.callerId, candidate);
			}
		}
	}

	const all: Discovery[] = [...discovered.values()]
		.filter((entry) => entry.depth > 0)
		.concat([...moduleCallers.values()]);
	all.sort(compareCallers);

	const ids = [...discovered.keys()];
	const callers = new Map<string, string[]>(ids.map((id) => [id, []]));
	for (const site of index.sites) {
		if (site.callerId === null || site.calleeId === null || !callers.has(site.callerId)) continue;
		if (!discovered.has(site.calleeId)) continue;
		(callers.get(site.callerId) ?? []).push(site.calleeId);
	}
	const cyclic = cyclicSymbols(ids, callers);

	const emitted: ImpactCaller[] = [];
	let unexplored = 0;
	for (const entry of all) {
		if (depthBound !== null && entry.depth > depthBound) {
			unexplored += 1;
			continue;
		}
		emitted.push({
			symbol: entry.symbol,
			depth: entry.depth,
			path: entry.edges,
			cycle: entry.symbol === null ? false : cyclic.has(entry.symbol.id),
		});
	}

	return {
		callers: emitted,
		truncated: unexplored > 0,
		unexplored,
		total: all.length,
		cycle: cyclic.size > 0,
	};
}
