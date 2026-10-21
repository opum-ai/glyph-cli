import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { configHostOf, indexSnapshot, snapshotAtRef } from "../src/snapshot.ts";
import { discoverSources, loadCompilerOptions } from "../src/discover.ts";
import { impactOf } from "../src/impact.ts";
import { buildIndex } from "../src/indexer.ts";
import { resolveSymbol } from "../src/queries.ts";
import type { GlyphIndex, SymbolEntry } from "../src/types.ts";
import { makeScratchRepo } from "./helpers.ts";

/** a -> b -> c -> d, so d's impact is c at 1, b at 2 and a at 3. */
const CHAIN: Record<string, string> = {
	"src/d.ts": "export function d(): number {\n  return 1;\n}\n",
	"src/c.ts": 'import { d } from "./d";\nexport function c(): number {\n  return d();\n}\n',
	"src/b.ts": 'import { c } from "./c";\nexport function b(): number {\n  return c();\n}\n',
	"src/a.ts": 'import { b } from "./b";\nexport function a(): number {\n  return b();\n}\n',
};

function indexOf(files: Record<string, string>): GlyphIndex {
	const repo = makeScratchRepo(files);
	return buildIndex(repo.root, discoverSources(repo.root));
}

function symbolOf(index: GlyphIndex, name: string): SymbolEntry {
	return resolveSymbol(index, name, undefined);
}

describe("impact", () => {
	test("a chain reports each caller once at its shortest depth with the path that reaches the target", () => {
		const index = indexOf(CHAIN);
		const d = symbolOf(index, "d");
		const result = impactOf(index, d, 5);
		expect(result.callers.map((caller) => [caller.symbol?.name ?? null, caller.depth])).toEqual([
			["c", 1],
			["b", 2],
			["a", 3],
		]);
		expect(result.truncated).toBe(false);
		expect(result.unexplored).toBe(0);
		expect(result.total).toBe(3);
		expect(result.cycle).toBe(false);
		const c = result.callers[0];
		const b = result.callers[1];
		const a = result.callers[2];
		expect(c?.path).toHaveLength(1);
		expect(c?.path[0]?.calleeId).toBe(d.id);
		expect(b?.path.map((edge) => edge.calleeId)).toEqual([symbolOf(index, "c").id, d.id]);
		expect(a?.path.map((edge) => edge.calleeId)).toEqual([symbolOf(index, "b").id, symbolOf(index, "c").id, d.id]);
		expect(a?.path.map((edge) => edge.callerId)).toEqual([
			a?.symbol?.id ?? "",
			symbolOf(index, "b").id,
			symbolOf(index, "c").id,
		]);
	});

	test("--depth bounds the answer, and the unexplored count is exact rather than a frontier estimate", () => {
		const index = indexOf(CHAIN);
		const d = symbolOf(index, "d");

		const one = impactOf(index, d, 1);
		expect(one.callers.map((caller) => caller.symbol?.name)).toEqual(["c"]);
		expect(one.truncated).toBe(true);
		expect(one.unexplored).toBe(2);
		expect(one.total).toBe(3);

		const two = impactOf(index, d, 2);
		expect(two.callers.map((caller) => caller.symbol?.name)).toEqual(["c", "b"]);
		expect(two.unexplored).toBe(1);

		const all = impactOf(index, d, null);
		expect(all.callers).toHaveLength(3);
		expect(all.truncated).toBe(false);
		expect(all.unexplored).toBe(0);
	});

	test("an unrelated symbol is empty, not an error", () => {
		const index = indexOf({ ...CHAIN, "src/x.ts": "export function x(): number {\n  return 2;\n}\n" });
		const result = impactOf(index, symbolOf(index, "x"), 5);
		expect(result.callers).toEqual([]);
		expect(result.total).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.cycle).toBe(false);
	});

	test("equal-length paths resolve to the documented winner, the same one on every run", () => {
		const files: Record<string, string> = {
			"src/d.ts": "export function d(): number {\n  return 1;\n}\n",
			"src/b.ts": 'import { d } from "./d";\nexport function b(): number {\n  return d();\n}\n',
			"src/c.ts": 'import { d } from "./d";\nexport function c(): number {\n  return d();\n}\n',
			"src/a.ts":
				'import { b } from "./b";\nimport { c } from "./c";\nexport function a(): number {\n  return b() + c();\n}\n',
		};
		const index = indexOf(files);
		const d = symbolOf(index, "d");
		const first = impactOf(index, d, 5);
		const second = impactOf(index, d, 5);
		expect(first).toEqual(second);
		const a = first.callers.find((caller) => caller.symbol?.name === "a");
		expect(a?.depth).toBe(2);
		// Both a -> b -> d and a -> c -> d are shortest; the path string order
		// picks the b route.
		expect(a?.path[0]?.calleeId).toBe(symbolOf(index, "b").id);
	});

	test("several call sites from one caller are one caller, and the first site wins the tie", () => {
		const files: Record<string, string> = {
			"src/d.ts": "export function d(): number {\n  return 1;\n}\n",
			"src/a.ts": 'import { d } from "./d";\nexport function a(): number {\n  return d() + d();\n}\n',
		};
		const index = indexOf(files);
		const result = impactOf(index, symbolOf(index, "d"), 5);
		expect(result.callers).toHaveLength(1);
		expect(result.callers[0]?.symbol?.name).toBe("a");
		expect(result.callers[0]?.path[0]?.line).toBe(3);
	});

	test("a cycle terminates and marks the symbols on it", () => {
		const files: Record<string, string> = {
			"src/d.ts": "export function d(): number {\n  return 1;\n}\n",
			"src/c.ts": 'import { d } from "./d";\nexport function c(): number {\n  return d();\n}\n',
			"src/b.ts":
				'import { c } from "./c";\nimport { a } from "./a";\nexport function b(): number {\n  return c() + a();\n}\n',
			"src/a.ts": 'import { b } from "./b";\nexport function a(): number {\n  return b();\n}\n',
		};
		const index = indexOf(files);
		const result = impactOf(index, symbolOf(index, "d"), 5);
		expect(result.callers.map((caller) => caller.symbol?.name)).toEqual(["c", "b", "a"]);
		expect(result.cycle).toBe(true);
		expect(result.callers.find((caller) => caller.symbol?.name === "c")?.cycle).toBe(false);
		expect(result.callers.find((caller) => caller.symbol?.name === "a")?.cycle).toBe(true);
		expect(result.callers.find((caller) => caller.symbol?.name === "b")?.cycle).toBe(true);
	});

	test("a self-recursive target terminates and is marked, without listing itself as its own caller", () => {
		const files: Record<string, string> = {
			"src/d.ts": "export function d(n: number): number {\n  return n <= 0 ? 0 : d(n - 1);\n}\n",
		};
		const index = indexOf(files);
		const result = impactOf(index, symbolOf(index, "d"), 5);
		expect(result.callers).toEqual([]);
		expect(result.cycle).toBe(true);
	});

	test("a module-scope call site is a terminal caller: symbol null, one-site path, never expanded", () => {
		const files: Record<string, string> = {
			"src/d.ts": "export function d(): number {\n  return 1;\n}\n",
			"src/c.ts": 'import { d } from "./d";\nexport function c(): number {\n  return d();\n}\n',
			"src/m.ts": 'import { c } from "./c";\nc();\n',
			"src/m2.ts": 'import { d } from "./d";\nd();\n',
		};
		const index = indexOf(files);
		const result = impactOf(index, symbolOf(index, "d"), 5);
		expect(result.callers.find((caller) => caller.symbol?.name === "c")?.depth).toBe(1);
		const direct = result.callers.find((caller) => caller.symbol === null && caller.path[0]?.file === "src/m2.ts");
		const indirect = result.callers.find((caller) => caller.symbol === null && caller.path[0]?.file === "src/m.ts");
		expect(direct?.depth).toBe(1);
		expect(direct?.path).toHaveLength(1);
		expect(indirect?.depth).toBe(2);
		expect(indirect?.path).toHaveLength(2);
		expect(indirect?.path[0]?.callerId).toBeNull();
		expect(indirect?.path[1]?.calleeId).toBe(symbolOf(index, "d").id);
		expect(indirect?.cycle).toBe(false);
		expect(result.total).toBe(3);
	});

	test("the ref-pinned index ignores a dirty checkout, while the working tree does not", () => {
		const repo = makeScratchRepo(CHAIN);
		const base = repo.commit("base");
		const before = indexSnapshot(snapshotAtRef(repo.root, base));

		repo.write(
			"src/a.ts",
			'import { b } from "./b";\nimport { d } from "./d";\nexport function a(): number {\n  return b() + d();\n}\n',
		);
		const after = indexSnapshot(snapshotAtRef(repo.root, base));
		const refD = symbolOf(after, "d");
		expect(impactOf(after, refD, 5).callers.map((caller) => [caller.symbol?.name ?? null, caller.depth])).toEqual([
			["c", 1],
			["b", 2],
			["a", 3],
		]);
		expect(impactOf(after, refD, 5)).toEqual(impactOf(before, symbolOf(before, "d"), 5));

		const working = buildIndex(repo.root, discoverSources(repo.root));
		const workingD = symbolOf(working, "d");
		expect(impactOf(working, workingD, 5).callers.map((caller) => [caller.symbol?.name ?? null, caller.depth])).toEqual(
			[
				["a", 1],
				["c", 1],
				["b", 2],
			],
		);
	});

	test("a file deleted from the checkout is still in the ref index", () => {
		const repo = makeScratchRepo({ ...CHAIN, "src/e.ts": "export function e(): number {\n  return 3;\n}\n" });
		const base = repo.commit("base");
		rmSync(join(repo.root, "src/e.ts"));
		const snapshot = snapshotAtRef(repo.root, base);
		expect(snapshot.files).toContain("src/e.ts");
		expect(discoverSources(repo.root)).not.toContain("src/e.ts");
		expect(indexSnapshot(snapshot).symbols.map((entry) => entry.name)).toContain("e");
	});

	test("compiler options come from the commit's tsconfig, not the dirty one", () => {
		const repo = makeScratchRepo({
			...CHAIN,
			"tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/*"] } } }, null, 2),
		});
		const base = repo.commit("base");
		repo.write("tsconfig.json", "{}\n");
		const snapshot = snapshotAtRef(repo.root, base);
		const refOptions = loadCompilerOptions(snapshot.root, undefined, configHostOf(snapshot));
		expect(refOptions.paths?.["@lib/*"]).toEqual(["src/*"]);
		const workingOptions = loadCompilerOptions(repo.root, undefined);
		expect(workingOptions.paths).toBeUndefined();
	});
});
