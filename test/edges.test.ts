import { describe, expect, test } from "bun:test";
import { discoverSources } from "../src/discover.ts";
import { impactOf, type ImpactCaller } from "../src/impact.ts";
import { buildIndex } from "../src/indexer.ts";
import { callersOf, resolveSymbol } from "../src/queries.ts";
import type { GlyphIndex, SiteEntry, SymbolEntry } from "../src/types.ts";
import { INDEX_FORMAT } from "../src/types.ts";
import { makeScratchRepo } from "./helpers.ts";

/**
 * DEC-216 (a3): import edges, implements/extends edges and the one walk over
 * them. Each test names the rule it pins.
 */

function indexOf(files: Record<string, string>): GlyphIndex {
	const repo = makeScratchRepo(files);
	return buildIndex(repo.root, discoverSources(repo.root));
}

function symbolOf(index: GlyphIndex, name: string, container?: string): SymbolEntry {
	if (container === undefined) return resolveSymbol(index, name, undefined);
	const found = index.symbols.find((symbol) => symbol.name === name && symbol.container === container);
	if (found === undefined) throw new Error(`no symbol ${container}.${name}`);
	return found;
}

function sitesOfKind(index: GlyphIndex, kind: SiteEntry["kind"]): SiteEntry[] {
	return index.sites.filter((site) => site.kind === kind);
}

/** `[file, depth, first-hop kind]` per caller, in the walk's own order. */
function shape(callers: ImpactCaller[]): Array<[string, number, string]> {
	return callers.map((caller) => [caller.path[0]?.file ?? "", caller.depth, caller.path[0]?.kind ?? ""]);
}

const M = "export function a(): number {\n  return 1;\n}\n";

describe("import edges", () => {
	test("the index format is bumped for the new shape", () => {
		expect(INDEX_FORMAT).toBe(2);
		expect(indexOf({ "src/m.ts": M }).schemaVersion).toBe(2);
	});

	test("a re-export and alias chain resolves to the original declaration, with the barrel and the importer at depth 1", () => {
		const index = indexOf({
			"src/m.ts": M,
			"src/mid.ts": 'export { a as aa } from "./m";\n',
			"src/barrel.ts": 'export * from "./mid";\n',
			"src/use.ts": 'import { aa as local } from "./barrel";\nexport function use(): number {\n  return local();\n}\n',
		});
		const a = symbolOf(index, "a");
		const imports = sitesOfKind(index, "import");
		// mid.ts re-exports `a`, use.ts imports it through two hops; both bind the
		// ORIGINAL declaration. `export *` binds no symbol, so it is a module edge.
		const bound = imports.filter((site) => site.calleeId !== null);
		expect(bound.map((site) => [site.file, site.calleeId, site.callerId, site.typeOnly])).toEqual([
			["src/mid.ts", a.id, null, false],
			["src/use.ts", a.id, null, false],
		]);
		expect(imports.filter((site) => site.calleeId === null).map((site) => [site.file, site.moduleTarget])).toEqual([
			["src/barrel.ts", "src/mid.ts"],
		]);

		const result = impactOf(index, a, 5);
		// Depth 1: the barrel chain's importers resolve to `a` itself, so there is no
		// transitive hop through the barrel. `use` is the caller of `a` through the alias.
		expect(shape(result.callers)).toEqual([
			["src/mid.ts", 1, "import"],
			["src/use.ts", 1, "import"],
			["src/use.ts", 1, "call"],
		]);
		expect(result.callers.map((caller) => caller.symbol?.name ?? null)).toEqual([null, null, "use"]);
		expect(index.unresolvedSites).toBe(0);
	});

	test("a default import resolves like a named import", () => {
		const index = indexOf({
			"src/m.ts": "export default function main(): number {\n  return 1;\n}\n",
			"src/use.ts": 'import main from "./m";\nexport function use(): number {\n  return main();\n}\n',
		});
		const main = symbolOf(index, "main");
		const imports = sitesOfKind(index, "import");
		expect(imports.map((site) => site.calleeId)).toEqual([main.id]);
		expect(shape(impactOf(index, main, 5).callers)).toEqual([
			["src/use.ts", 1, "import"],
			["src/use.ts", 1, "call"],
		]);
	});

	test("a type-only import is recorded and flagged, whether declaration-level or specifier-level", () => {
		const index = indexOf({
			"src/t.ts": "export interface Shape {\n  sides: number;\n}\nexport type Id = string;\n",
			"src/use.ts":
				'import type { Shape } from "./t";\nimport { type Id } from "./t";\nexport const s: Shape | Id | null = null;\n',
		});
		const imports = sitesOfKind(index, "import");
		expect(
			imports.map((site) => [site.calleeId === symbolOf(index, "Shape").id ? "Shape" : "Id", site.typeOnly]),
		).toEqual([
			["Shape", true],
			["Id", true],
		]);
		const result = impactOf(index, symbolOf(index, "Shape"), 5);
		expect(result.callers).toHaveLength(1);
		expect(result.callers[0]?.path[0]?.typeOnly).toBe(true);
		expect(result.callers[0]?.symbol).toBeNull();
	});

	test("a namespace importer is a depth-1 terminal of a symbol in its target module, without a calleeId", () => {
		const index = indexOf({
			"src/m.ts": M,
			"src/other.ts": "export function z(): number {\n  return 2;\n}\n",
			"src/ns.ts": 'import * as m from "./m";\nexport const v = m;\n',
			"src/side.ts": 'import "./m";\n',
		});
		const modules = index.sites.filter((site) => site.calleeId === null);
		expect(modules.map((site) => [site.file, site.kind, site.moduleTarget, site.callerId])).toEqual([
			["src/ns.ts", "import", "src/m.ts", null],
			["src/side.ts", "import", "src/m.ts", null],
		]);
		const result = impactOf(index, symbolOf(index, "a"), 5);
		expect(shape(result.callers)).toEqual([
			["src/ns.ts", 1, "import"],
			["src/side.ts", 1, "import"],
		]);
		expect(result.callers.every((caller) => caller.symbol === null && caller.depth === 1)).toBe(true);
		expect(result.callers[0]?.path[0]?.moduleTarget).toBe("src/m.ts");
		// A symbol in an unrelated module is not reached.
		expect(impactOf(index, symbolOf(index, "z"), 5).callers).toEqual([]);
	});

	test("an unresolved import is counted by kind and never dropped", () => {
		const index = indexOf({
			"src/use.ts":
				'import { helper } from "no-such-package";\nimport "./missing";\nimport * as ns from "./also-missing";\nexport const v = [helper, ns];\n',
		});
		expect(index.sites).toEqual([]);
		expect(index.unresolvedByKind).toEqual({ call: 0, import: 3, extends: 0, implements: 0, dynamic: 0 });
		expect(index.unresolvedSites).toBe(3);
	});

	test("dynamic import() and require() are counted as dynamic and never followed", () => {
		const index = indexOf({
			"src/m.ts": M,
			"src/use.ts": 'export async function load(): Promise<unknown> {\n  require("./m");\n  return import("./m");\n}\n',
		});
		expect(index.sites).toEqual([]);
		expect(index.unresolvedByKind.dynamic).toBe(2);
		expect(index.unresolvedByKind.call).toBe(0);
		expect(impactOf(index, symbolOf(index, "a"), 5).callers).toEqual([]);
	});

	test("the dynamic kind does not swallow an ordinary unresolved call", () => {
		const index = indexOf({
			"src/use.ts": "export function f(o: Record<string, () => void>): void {\n  o.x();\n  o['y']();\n}\n",
		});
		expect(index.unresolvedByKind.call).toBe(2);
		expect(index.unresolvedByKind.dynamic).toBe(0);
	});
});

describe("inheritance edges", () => {
	const SHAPES = [
		"export interface Named {\n  name: string;\n}\n",
		"export interface Labelled extends Named {\n  label: string;\n}\n",
		"export class Base {\n  run(): number {\n    return 1;\n  }\n}\n",
	].join("");

	test("extends and implements are edges from the declaration that carries the clause", () => {
		const index = indexOf({
			"src/shapes.ts": SHAPES,
			"src/impl.ts":
				'import { Base, Labelled } from "./shapes";\nexport class Child extends Base {}\nexport class Impl implements Labelled {\n  name = "n";\n  label = "l";\n}\n',
		});
		const edges = index.sites.filter((site) => site.kind === "extends" || site.kind === "implements");
		const name = (id: string | null): string => index.symbols.find((symbol) => symbol.id === id)?.name ?? String(id);
		expect(edges.map((site) => [site.kind, name(site.callerId), name(site.calleeId)])).toEqual([
			["extends", "Child", "Base"],
			["implements", "Impl", "Labelled"],
			["extends", "Labelled", "Named"],
		]);
		expect(index.unresolvedSites).toBe(0);
	});

	test("a changed class or interface reaches its subclasses and implementers at depth + 1, and the walk continues over every kind", () => {
		const index = indexOf({
			"src/shapes.ts": SHAPES,
			"src/impl.ts":
				'import { Base, Labelled } from "./shapes";\nexport class Child extends Base {}\nexport class Impl implements Labelled {\n  name = "n";\n  label = "l";\n}\n',
			"src/make.ts": 'import { Child } from "./impl";\nexport function make(): Child {\n  return new Child();\n}\n',
		});
		const base = impactOf(index, symbolOf(index, "Base"), 5);
		// Child extends Base (depth 1); `make` news Child (depth 2).
		expect(
			base.callers.filter((caller) => caller.symbol !== null).map((caller) => [caller.symbol?.name, caller.depth]),
		).toEqual([
			["Child", 1],
			["make", 2],
		]);
		const child = base.callers.find((caller) => caller.symbol?.name === "Child");
		expect(child?.path.map((edge) => edge.kind)).toEqual(["extends"]);
		const made = base.callers.find((caller) => caller.symbol?.name === "make");
		expect(made?.path.map((edge) => edge.kind)).toEqual(["new", "extends"]);

		// Interface changes reach the interface that extends them and the implementer.
		const named = impactOf(index, symbolOf(index, "Named"), 5);
		expect(
			named.callers.filter((caller) => caller.symbol !== null).map((caller) => [caller.symbol?.name, caller.depth]),
		).toEqual([
			["Labelled", 1],
			["Impl", 2],
		]);
	});

	test("depth 1 stays a superset of callers: callers lists calls only, never import or heritage edges", () => {
		const index = indexOf({
			"src/shapes.ts": SHAPES,
			"src/impl.ts":
				'import { Base } from "./shapes";\nexport class Child extends Base {}\nexport function make(): Base {\n  return new Base();\n}\n',
		});
		const base = symbolOf(index, "Base");
		const callers = callersOf(index, base);
		expect(callers.map((site) => site.kind)).toEqual(["new"]);
		const depthOne = impactOf(index, base, 1).callers.filter((caller) => caller.depth === 1);
		for (const site of callers) {
			expect(depthOne.some((caller) => caller.path[0]?.line === site.line && caller.path[0]?.file === site.file)).toBe(
				true,
			);
		}
		// ...and impact additionally sees the extends edge and the import.
		expect(new Set(depthOne.map((caller) => caller.path[0]?.kind))).toEqual(new Set(["new", "extends", "import"]));
	});

	test("a changed method does NOT reach an overriding method in v1 (a named limitation)", () => {
		const index = indexOf({
			"src/shapes.ts": SHAPES,
			"src/child.ts":
				'import { Base } from "./shapes";\nexport class Child extends Base {\n  run(): number {\n    return 2;\n  }\n}\n',
		});
		const baseRun = symbolOf(index, "run", "Base");
		const childRun = symbolOf(index, "run", "Child");
		const result = impactOf(index, baseRun, 5);
		expect(result.callers.some((caller) => caller.symbol?.id === childRun.id)).toBe(false);
		expect(result.callers).toEqual([]);
		// The class itself is reached; its method is not.
		const cls = impactOf(index, symbolOf(index, "Base"), 5);
		expect(cls.callers.some((caller) => caller.symbol?.name === "Child")).toBe(true);
	});

	test("a heritage clause that does not resolve in-repo is counted by kind", () => {
		const index = indexOf({
			"src/use.ts":
				'import { Ext } from "no-such-package";\nexport class A extends Ext {}\nexport class B implements Ext {}\nexport interface C extends Ext {}\n',
		});
		expect(index.sites).toEqual([]);
		// The import itself is unresolved too; the three clauses are counted by their own kind.
		expect(index.unresolvedByKind).toEqual({ call: 0, import: 1, extends: 2, implements: 1, dynamic: 0 });
		expect(index.unresolvedSites).toBe(4);
	});
});
