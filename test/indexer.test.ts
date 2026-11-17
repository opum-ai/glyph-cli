import { describe, expect, test } from "bun:test";
import { discoverSources } from "../src/discover.ts";
import { buildIndex } from "../src/indexer.ts";
import type { GlyphIndex } from "../src/types.ts";
import { makeScratchRepo } from "./helpers.ts";

function indexOf(files: Record<string, string>): GlyphIndex {
	const repo = makeScratchRepo(files);
	return buildIndex(repo.root, discoverSources(repo.root));
}

function symbolId(index: GlyphIndex, name: string): string {
	const symbol = index.symbols.find((entry) => entry.name === name);
	if (symbol === undefined) throw new Error(`fixture symbol '${name}' is missing from the index`);
	return symbol.id;
}

describe("indexer", () => {
	test("resolves an aliased import through the type checker", () => {
		// The DEC-66 claim under test: `h(1)` is a call of `helper` because of
		// types, not because of the letters at the call site.
		const index = indexOf({
			"src/util.ts": "export function helper(n: number): number {\n  return n + 1;\n}\n",
			"src/main.ts":
				'import { helper as h } from "./util";\n\nexport function main(): number {\n  return h(1) + h(2);\n}\n',
		});
		const mainId = symbolId(index, "main");
		const sites = index.sites.filter((site) => site.calleeId === symbolId(index, "helper") && site.kind === "call");
		expect(sites.length).toBe(2);
		expect(sites.every((site) => site.kind === "call")).toBe(true);
		expect(sites.every((site) => site.callerId === mainId)).toBe(true);
		expect(sites.map((site) => site.line)).toEqual([4, 4]);
	});

	test("a module-scope arrow-const is a caller; a function-local arrow attributes to its enclosing function", () => {
		const index = indexOf({
			"src/util.ts": "export function helper(n: number): number {\n  return n + 1;\n}\n",
			"src/main.ts":
				'import { helper } from "./util";\n\nexport const topWrapper = () => helper(1);\n\nexport function outer(): number {\n  const local = () => helper(2);\n  return local();\n}\n',
		});
		const helperSites = index.sites.filter(
			(site) => site.calleeId === symbolId(index, "helper") && site.kind === "call",
		);
		expect(helperSites.map((site) => site.callerId)).toEqual([symbolId(index, "topWrapper"), symbolId(index, "outer")]);

		// The local arrow is deliberately not a symbol, and the call of `local()`
		// is counted as unresolved rather than guessed at.
		expect(index.symbols.some((symbol) => symbol.name === "local")).toBe(false);
		expect(index.unresolvedSites).toBe(1);
	});

	test("counts dynamic callees as unresolved instead of guessing", () => {
		const index = indexOf({
			"src/main.ts":
				'export function main(x: Record<string, () => void>): void {\n  const key = "a";\n  x[key]();\n  (function () {})();\n}\n',
		});
		expect(index.sites.length).toBe(0);
		expect(index.unresolvedSites).toBe(2);
	});

	test("records new-expressions as 'new' sites against the class", () => {
		const index = indexOf({
			"src/widget.ts": "export class Widget {}\n\nexport function build(): Widget {\n  return new Widget();\n}\n",
		});
		const sites = index.sites.filter((site) => site.calleeId === symbolId(index, "Widget"));
		expect(sites.length).toBe(1);
		expect(sites[0]?.kind).toBe("new");
		expect(sites[0]?.callerId).toBe(symbolId(index, "build"));
	});

	test("records a method's container so same-named methods stay distinguishable", () => {
		const index = indexOf({
			"src/report.ts": "export class Report {\n  render(): void {}\n}\n\nexport class Page {\n  render(): void {}\n}\n",
		});
		const renders = index.symbols.filter((symbol) => symbol.name === "render");
		expect(renders.map((symbol) => symbol.container).sort()).toEqual(["Page", "Report"]);
	});
});
