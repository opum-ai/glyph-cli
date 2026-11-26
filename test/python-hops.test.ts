import { describe, expect, test } from "bun:test";
import { analyzePythonCalls, type PythonCallsResult } from "../src/python/calls.ts";
import type { PythonModuleInput } from "../src/python/modules.ts";

// GCLI-118 (DEC-303 (a49) item 5, (a50) items 3 and 4, (a52) item 1, (a53), (a54) item 3): a hop module's own
// bindings are read (N3), a comprehension target is no module binding for a read outside it (N1), a star import
// in a holder is walked last to first (N2), and A2's interim single-binding refusal is retired.

const encoder = new TextEncoder();
const py = (path: string, source: string): PythonModuleInput => ({ path, bytes: encoder.encode(source) });

async function analyze(files: PythonModuleInput[]): Promise<PythonCallsResult> {
	const result = await analyzePythonCalls(files);
	const b = result.callBins;
	expect(b.resolvedInRepo + b.resolvedExternal + b.receiverNeedsInference + b.nameNotBound).toBe(
		result.callExpressionCount,
	);
	return result;
}

type Delta = { inRepo: number; external: number; receiver: number; nameNotBound: number };

/** `CALL` in the app is the probed call (the text of `call`) in the with-source and `pass` in the without-source. */
async function probe(app: string, call: string, others: Record<string, string> = {}) {
	const files = (body: string): PythonModuleInput[] => [
		...Object.entries(others).map(([path, source]) => py(path, source)),
		py("app.py", app.replace("CALL", body)),
	];
	const withCall = await analyze(files(call));
	const without = await analyze(files("pass"));
	const delta: Delta = {
		inRepo: withCall.callBins.resolvedInRepo - without.callBins.resolvedInRepo,
		external: withCall.callBins.resolvedExternal - without.callBins.resolvedExternal,
		receiver: withCall.callBins.receiverNeedsInference - without.callBins.receiverNeedsInference,
		nameNotBound: withCall.callBins.nameNotBound - without.callBins.nameNotBound,
	};
	const sites = withCall.sites.filter((site) => site.file === "app.py");
	const callees = sites.map((site) => {
		const symbol = withCall.symbols.find((s) => s.id === site.calleeId);
		return symbol === undefined ? null : `${symbol.file}:${symbol.qualname}`;
	});
	return { delta, sites, callees };
}

const RESOLVED: Delta = { inRepo: 1, external: 0, receiver: 0, nameNotBound: 0 };

const m = "def f():\n    pass\n";
const FROM = "from n import f\nCALL\n";
const ATTR = "import n\nCALL\n";

describe("N3 — a re-export hop reads the hop module's own bindings", () => {
	const shapes: Record<string, string> = {
		"del f": "from m import f\ndel f\n",
		"f = wrap(f)": "from m import f\nf = wrap(f)\n",
		"f = None": "from m import f\nf = None\n",
		"a for target": "from m import f\nfor f in []:\n    pass\n",
		"a global write": "from m import f\ndef g():\n    global f\n    f = 1\n",
	};
	for (const [label, source] of Object.entries(shapes)) {
		test(`${label}: neither from n import f; f() nor n.f() gets an edge`, async () => {
			const fromImport = await probe(FROM, "f()", { "m.py": m, "n.py": source });
			expect(fromImport.sites.map((s) => s.calleeId)).toEqual([]);
			expect(fromImport.delta.inRepo).toBe(0);
			const attribute = await probe(ATTR, "n.f()", { "m.py": m, "n.py": source });
			expect(attribute.sites.map((s) => s.calleeId)).toEqual([]);
			expect(attribute.delta.inRepo).toBe(0);
		});
	}

	test("the bin of the refused hop is the bin a rebound name has (GCLI-116's shape, one hop nearer)", async () => {
		const hop = await probe(FROM, "f()", { "m.py": m, "n.py": "from m import f\ndel f\n" });
		const direct = await probe("from m import f\nCALL\n", "f()", { "m.py": `${m}del f\n` });
		expect(hop.delta).toEqual(direct.delta);
		const hopAttr = await probe(ATTR, "n.f()", { "m.py": m, "n.py": "from m import f\ndel f\n" });
		const directAttr = await probe("import m\nCALL\n", "m.f()", { "m.py": `${m}del f\n` });
		expect(hopAttr.delta).toEqual(directAttr.delta);
	});

	test("the twin without the rebinding resolves to m.f, callee pinned, both forms", async () => {
		const fromImport = await probe(FROM, "f()", { "m.py": m, "n.py": "from m import f\n" });
		expect(fromImport.delta).toEqual(RESOLVED);
		expect(fromImport.callees).toEqual(["m.py:f"]);
		const attribute = await probe(ATTR, "n.f()", { "m.py": m, "n.py": "from m import f\n" });
		expect(attribute.delta).toEqual(RESOLVED);
		expect(attribute.callees).toEqual(["m.py:f"]);
	});

	test("a rebinding two hops away ends the chain: the middle module is read too", async () => {
		const files = { "m.py": "from o import f\nf = None\n", "o.py": m, "n.py": "from m import f\n" };
		const refused = await probe(FROM, "f()", files);
		expect(refused.sites.map((s) => s.calleeId)).toEqual([]);
		const attribute = await probe(ATTR, "n.f()", files);
		expect(attribute.sites.map((s) => s.calleeId)).toEqual([]);
		const twin = await probe(FROM, "f()", { "m.py": "from o import f\n", "o.py": m, "n.py": "from m import f\n" });
		expect(twin.delta).toEqual(RESOLVED);
		expect(twin.callees).toEqual(["o.py:f"]);
	});

	test("a chain of three hops ending in a module that rebinds the name ends at the rebinding", async () => {
		const files = {
			"p.py": m,
			"o.py": "from p import f\ndel f\n",
			"m.py": "from o import f\n",
			"n.py": "from m import f\n",
		};
		const fromImport = await probe(FROM, "f()", files);
		expect(fromImport.sites.map((s) => s.calleeId)).toEqual([]);
		const attribute = await probe(ATTR, "n.f()", files);
		expect(attribute.sites.map((s) => s.calleeId)).toEqual([]);
		const twin = await probe(FROM, "f()", { ...files, "o.py": "from p import f\n" });
		expect(twin.callees).toEqual(["p.py:f"]);
	});

	test("(a54) item 3, the second-hop rebind: m has from n import C, n has from o import C and C = None", async () => {
		const o = "class C:\n    def meth(self):\n        pass\n";
		const files = { "o.py": o, "n.py": "from o import C\nC = None\n", "m.py": "from n import C\n" };
		const attribute = await probe("import m\nCALL\n", "m.C.meth()", files);
		expect(attribute.sites.map((s) => s.calleeId)).toEqual([]);
		const bare = await probe("from m import C\nCALL\n", "C.meth()", files);
		expect(bare.sites.map((s) => s.calleeId)).toEqual([]);
		expect(bare.delta.inRepo).toBe(0);
		const twin = await probe("import m\nCALL\n", "m.C.meth()", {
			"o.py": o,
			"n.py": "from o import C\n",
			"m.py": "from n import C\n",
		});
		expect(twin.delta).toEqual(RESOLVED);
		expect(twin.callees).toEqual(["o.py:C.meth"]);
	});

	test("two imports of the name in the hop (a try/except) stay alternatives, not a first pick", async () => {
		const files = {
			"a.py": m,
			"b.py": m,
			"n.py": "try:\n    from a import f\nexcept ImportError:\n    from b import f\n",
		};
		const r = await probe(FROM, "f()", files);
		expect(r.callees.sort()).toEqual(["a.py:f", "b.py:f"]);
		expect(r.sites.every((s) => s.multiplyBound === true)).toBe(true);
	});
});

describe("N1 — a module-level comprehension target is no binding of the module name outside it", () => {
	const def = "def f():\n    pass\n";
	test("a same-module call to a def f with a comprehension target named f resolves, callee pinned", async () => {
		const r = await probe(`${def}_ = [0 for f in range(3)]\nCALL\n`, "f()");
		expect(r.delta).toEqual(RESOLVED);
		expect(r.callees).toEqual(["app.py:f"]);
	});

	test("a walrus target inside a comprehension still binds the module name (PEP 572): the call is refused", async () => {
		const r = await probe(`${def}_ = [(f := 1) for _ in range(3)]\nCALL\n`, "f()");
		expect(r.sites).toEqual([]);
		expect(r.delta.inRepo).toBe(0);
	});

	test("a call from inside the comprehension that binds the name keeps the binding (refused)", async () => {
		const inside = await analyze([py("app.py", `${def}_ = [f() for f in range(3)]\n`)]);
		expect(inside.sites.filter((s) => s.file === "app.py")).toEqual([]);
		const inFilter = await analyze([py("app.py", `${def}_ = [0 for f in range(3) if f()]\n`)]);
		expect(inFilter.sites.filter((s) => s.file === "app.py")).toEqual([]);
		const inIterable = await analyze([py("app.py", `${def}_ = [0 for f in f()]\n`)]);
		expect(inIterable.sites.filter((s) => s.file === "app.py")).toEqual([]);
	});

	test("a second ordinary binding of the name still refuses beside the comprehension target", async () => {
		const r = await probe(`${def}f = None\n_ = [0 for f in range(3)]\nCALL\n`, "f()");
		expect(r.sites).toEqual([]);
	});

	test("function level is unchanged: a local def and a comprehension target of the same name refuse", async () => {
		const r = await probe("def g():\n    def f():\n        pass\n    _ = [0 for f in range(3)]\n    CALL\n", "f()");
		expect(r.sites).toEqual([]);
		expect(r.delta.inRepo).toBe(0);
	});

	test("a set, dict and generator comprehension target at module level resolve the same way", async () => {
		for (const comp of ["{0 for f in range(3)}", "{0: 0 for f in range(3)}", "list(0 for f in range(3))"]) {
			const r = await probe(`${def}_ = ${comp}\nCALL\n`, "f()");
			expect(r.callees, comp).toEqual(["app.py:f"]);
		}
	});
});

describe("N2 — a star import in the holder is walked last to first", () => {
	const x = "def f():\n    pass\n";
	const run = async (holder: string, others: Record<string, string>) => ({
		fromImport: await probe("from m import f\nCALL\n", "f()", { "m.py": holder, ...others }),
		attribute: await probe("import m\nCALL\n", "m.f()", { "m.py": holder, ...others }),
	});

	test("a def f followed by a star of a complete x that exports f resolves as x.f, not m.f", async () => {
		const r = await run(`${m}from x import *\n`, { "x.py": x });
		for (const one of [r.fromImport, r.attribute]) {
			expect(one.delta).toEqual(RESOLVED);
			expect(one.callees).toEqual(["x.py:f"]);
		}
	});

	test("twin: x complete and not exporting f leaves the def standing", async () => {
		const r = await run(`${m}from x import *\n`, { "x.py": "def g():\n    pass\n" });
		for (const one of [r.fromImport, r.attribute]) {
			expect(one.delta).toEqual(RESOLVED);
			expect(one.callees).toEqual(["m.py:f"]);
		}
	});

	test("twin: a star BEFORE the def is overridden by it", async () => {
		const r = await run(`from x import *\n${m}`, { "x.py": x });
		for (const one of [r.fromImport, r.attribute]) {
			expect(one.delta).toEqual(RESOLVED);
			expect(one.callees).toEqual(["m.py:f"]);
		}
	});

	test("a partial star (unresolved or external) after the def leaves the name star-bound and unresolved", async () => {
		for (const star of ["from nowhere import *\n", "from os import *\n"]) {
			const r = await run(`${m}${star}`, {});
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.sites.map((s) => s.calleeId)).toEqual([]);
				expect(one.delta.inRepo).toBe(0);
			}
		}
	});

	test("a partial star reached before the complete exporting one decides: unresolved; the other order resolves x.f", async () => {
		const partialLast = await run(`${m}from x import *\nfrom nowhere import *\n`, { "x.py": x });
		for (const one of [partialLast.fromImport, partialLast.attribute]) {
			expect(one.sites.map((s) => s.calleeId)).toEqual([]);
		}
		const partialFirst = await run(`${m}from nowhere import *\nfrom x import *\n`, { "x.py": x });
		for (const one of [partialFirst.fromImport, partialFirst.attribute]) {
			expect(one.callees).toEqual(["x.py:f"]);
		}
	});

	test("a star after a RE-EXPORT of the name also decides it", async () => {
		const r = await run("from o import f\nfrom x import *\n", { "x.py": x, "o.py": m });
		for (const one of [r.fromImport, r.attribute]) expect(one.callees).toEqual(["x.py:f"]);
	});
});

describe("A2 — the interim single-binding refusal is retired (the httpx shape)", () => {
	const pkg = (init: string) => ({
		"pkg/__init__.py": init,
		"pkg/_s.py": "class codes:\n    @classmethod\n    def get(cls):\n        pass\n",
	});
	const call = "import pkg\nCALL\n";

	test("pkg binds the class only through a complete star: pkg.codes.get() resolves, callee pinned", async () => {
		const r = await probe(call, "pkg.codes.get()", pkg('from ._s import *\n__all__ = ["codes"]\n'));
		expect(r.delta).toEqual(RESOLVED);
		expect(r.callees).toEqual(["pkg/_s.py:codes.get"]);
		const noAll = await probe(call, "pkg.codes.get()", pkg("from ._s import *\n"));
		expect(noAll.callees).toEqual(["pkg/_s.py:codes.get"]);
	});

	test("refused: a partial star, a rebind, a del and a second import after the star", async () => {
		const shapes: Record<string, string> = {
			"partial star": "from nowhere import *\n",
			"rebind after the star": "from ._s import *\ncodes = None\n",
			"del after the star": "from ._s import *\ndel codes\n",
			"a partial star after the complete one": "from ._s import *\nfrom nowhere import *\n",
		};
		for (const [label, init] of Object.entries(shapes)) {
			const r = await probe(call, "pkg.codes.get()", pkg(init));
			expect(r.sites, label).toEqual([]);
			expect(r.delta.inRepo, label).toBe(0);
		}
	});

	test("one import binding still resolves (the case the interim refusal allowed)", async () => {
		const r = await probe(call, "pkg.codes.get()", pkg("from ._s import codes\n"));
		expect(r.callees).toEqual(["pkg/_s.py:codes.get"]);
	});
});

// GCLI-118 Opus round 1 (eeb6f8ef): a star decides only after the LAST binding of the name, the hop walk follows an
// alias, a cycle in the walk terminates, and an import-only holder's module-valued bindings stay the old path's.
describe("GCLI-118 round 1 — star after the last binding, alias hops, cycles", () => {
	const x = "def f():\n    pass\n";
	const both = async (holder: string, others: Record<string, string>) => ({
		fromImport: await probe("from m import f\nCALL\n", "f()", { "m.py": holder, ...others }),
		attribute: await probe("import m\nCALL\n", "m.f()", { "m.py": holder, ...others }),
	});

	test("a star between two bindings does not decide: the later def overrides it, x.f gets no edge", async () => {
		const r = await both("from y import f\nfrom x import *\ndef f():\n    pass\n", { "x.py": x, "y.py": x });
		for (const one of [r.fromImport, r.attribute]) {
			expect(one.callees).not.toContain("x.py:f");
			expect(one.callees.sort()).toEqual(["m.py:f", "y.py:f"]);
		}
	});

	test("a rebinding after the star ends it: del, None, a for target and a global write give no edge", async () => {
		const rebinders: Record<string, string> = {
			del: "del f\n",
			"f = None": "f = None\n",
			"for target": "for f in []:\n    pass\n",
			"global write": "def g():\n    global f\n    f = 1\n",
		};
		for (const [label, tail] of Object.entries(rebinders)) {
			const r = await both(`${m}from x import *\n${tail}`, { "x.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(
					one.sites.map((s) => s.calleeId),
					label,
				).toEqual([]);
				expect(one.delta.inRepo, label).toBe(0);
			}
		}
	});

	test("a star on the same line as the import before it does not decide; the import stands", async () => {
		const r = await both("from x import *; from o import f\n", { "x.py": x, "o.py": x });
		for (const one of [r.fromImport, r.attribute]) expect(one.callees).toEqual(["o.py:f"]);
	});

	test("an aliased hop reads the next module by the imported name (from o import g as f)", async () => {
		const files = { "o.py": "from p import g\ndef f():\n    pass\n", "p.py": "def g():\n    pass\n" };
		const r = await both("from o import g as f\n", files);
		for (const one of [r.fromImport, r.attribute]) {
			expect(one.delta).toEqual(RESOLVED);
			expect(one.callees).toEqual(["p.py:g"]);
		}
		// o rebinding the IMPORTED name g ends the chain
		const rebound = await both("from o import g as f\n", { ...files, "o.py": "from p import g\ng = None\n" });
		for (const one of [rebound.fromImport, rebound.attribute]) {
			expect(one.sites.map((s) => s.calleeId)).toEqual([]);
		}
		// o rebinding an unrelated name f does not
		const unrelated = await both("from o import g as f\n", { ...files, "o.py": "from p import g\nf = None\n" });
		for (const one of [unrelated.fromImport, unrelated.attribute]) {
			expect(one.callees).toEqual(["p.py:g"]);
		}
	});

	test("a cycle in the hop walk (a imports f from b, b from a) terminates with no edge", async () => {
		const files = { "a.py": "from b import f\n", "b.py": "from a import f\n" };
		const fromImport = await probe("from a import f\nCALL\n", "f()", files);
		expect(fromImport.sites.map((s) => s.calleeId)).toEqual([]);
		const attribute = await probe("import a\nCALL\n", "a.f()", files);
		expect(attribute.sites.map((s) => s.calleeId)).toEqual([]);
	});
});
