import { describe, expect, test } from "bun:test";
import { discoverSources } from "../src/discover.ts";
import { GlyphError } from "../src/errors.ts";
import type { FileChange } from "../src/git.ts";
import { buildIndex } from "../src/indexer.ts";
import { callersOf, resolveSymbol, touchedSymbols } from "../src/queries.ts";
import type { GlyphIndex } from "../src/types.ts";
import { makeScratchRepo } from "./helpers.ts";

function indexOf(files: Record<string, string>): GlyphIndex {
	const repo = makeScratchRepo(files);
	return buildIndex(repo.root, discoverSources(repo.root));
}

function change(file: string, ranges: { start: number; end: number }[], wholeFile = false): FileChange {
	return { file, ranges, wholeFile };
}

describe("queries", () => {
	test("resolveSymbol narrows by --file and reports both failure kinds with their codes", () => {
		const index = indexOf({
			"src/util.ts": "export function helper(): void {}\n",
			"src/other.ts": "export function helper(): void {}\n",
		});

		let ambiguous: unknown;
		try {
			resolveSymbol(index, "helper", undefined);
		} catch (error) {
			ambiguous = error;
		}
		expect(ambiguous).toBeInstanceOf(GlyphError);
		expect((ambiguous as GlyphError).code).toBe(2);
		expect((ambiguous as GlyphError).message).toContain("src/util.ts");

		const narrowed = resolveSymbol(index, "helper", "src/other.ts");
		expect(narrowed.file).toBe("src/other.ts");

		let missing: unknown;
		try {
			resolveSymbol(index, "nope", undefined);
		} catch (error) {
			missing = error;
		}
		expect(missing).toBeInstanceOf(GlyphError);
		expect((missing as GlyphError).code).toBe(3);
	});

	test("callersOf returns sites sorted by position with callers resolved", () => {
		const index = indexOf({
			"src/util.ts": "export function helper(): void {}\n",
			"src/b.ts": 'import { helper } from "./util";\nexport function second(): void {\n  helper();\n}\n',
			"src/a.ts": 'import { helper } from "./util";\nexport function first(): void {\n  helper();\n}\n',
		});
		const symbol = resolveSymbol(index, "helper", undefined);
		const callers = callersOf(index, symbol);
		expect(callers.map((site) => site.file)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(callers.map((site) => site.caller?.name)).toEqual(["first", "second"]);
	});

	test("a change attributes to exactly the symbol whose span intersects it", () => {
		const index = indexOf({
			"src/util.ts": "export function alpha(): void {}\nexport function beta(): void {}\n",
		});
		const only = touchedSymbols(index, [change("src/util.ts", [{ start: 1, end: 1 }])]);
		expect(only.symbols.map((symbol) => symbol.name)).toEqual(["alpha"]);
	});

	test("only the innermost touched symbol is reported, not its containers", () => {
		const index = indexOf({
			"src/report.ts": "export class Report {\n  render(): void {\n    const x = 1;\n  }\n}\n",
		});
		const touched = touchedSymbols(index, [change("src/report.ts", [{ start: 3, end: 3 }])]);
		expect(touched.symbols.map((symbol) => symbol.name)).toEqual(["render"]);
	});

	test("a new file reports every symbol in it", () => {
		const index = indexOf({
			"src/fresh.ts": "export function one(): void {}\nexport function two(): void {}\n",
		});
		const touched = touchedSymbols(index, [change("src/fresh.ts", [], true)]);
		expect(touched.symbols.map((symbol) => symbol.name)).toEqual(["one", "two"]);
	});

	test("a directly attached comment block belongs to the declaration; a header does not", () => {
		const index = indexOf({
			"src/util.ts":
				"/** attached docs */\nexport function documented(): void {}\n\n// a section header\n\nexport function separate(): void {}\n",
		});
		const documented = resolveSymbol(index, "documented", undefined);
		const separate = resolveSymbol(index, "separate", undefined);
		expect(documented.startLine).toBe(1); // the comment line
		expect(separate.startLine).toBe(6); // the declaration itself, not the header at line 4
	});
});
