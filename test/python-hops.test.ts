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

	test("a star on the same line as the import cannot be ordered against it: either order is unresolved", async () => {
		for (const holder of ["from x import *; from o import f\n", "from o import f; from x import *\n"]) {
			const r = await both(holder, { "x.py": x, "o.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(
					one.sites.map((s) => s.calleeId),
					holder,
				).toEqual([]);
				expect(one.delta.inRepo, holder).toBe(0);
			}
		}
		// the twin on separate lines: the star after the import decides; the star before it is overridden
		const after = await both("from o import f\nfrom x import *\n", { "x.py": x, "o.py": x });
		for (const one of [after.fromImport, after.attribute]) expect(one.callees).toEqual(["x.py:f"]);
		const before = await both("from x import *\nfrom o import f\n", { "x.py": x, "o.py": x });
		for (const one of [before.fromImport, before.attribute]) expect(one.callees).toEqual(["o.py:f"]);
	});

	test("a conditional alias assignment has no position: a star AFTER the last unconditional binding that may bind the name leaves it unresolved", async () => {
		const shapes: Record<string, string> = {
			"def f, star, if-arm f = g": "def g():\n    pass\ndef f():\n    pass\nfrom x import *\nif C:\n    f = g\n",
			"import f, star, if-arm f = g": "def g():\n    pass\nfrom y import f\nfrom x import *\nif C:\n    f = g\n",
		};
		for (const [label, holder] of Object.entries(shapes)) {
			const r = await both(holder, { "x.py": x, "y.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees, label).not.toContain("x.py:f");
				expect(
					one.sites.map((s) => s.calleeId),
					label,
				).toEqual([]);
			}
		}
		// a star BEFORE the last unconditional def is overridden by it; the conditional alias stays an alternative
		const overridden = await both(
			"def g():\n    pass\nfrom x import *\ndef f():\n    pass\ntry:\n    pass\nexcept E:\n    f = g\n",
			{ "x.py": x },
		);
		for (const one of [overridden.fromImport, overridden.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "m.py:g"]);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
		}
		// twin: no star, the conditional alias stays an alternative (Q2's multiply-bound edge)
		const noStar = await both("def g():\n    pass\ndef f():\n    pass\nif C:\n    f = g\n", {});
		for (const one of [noStar.fromImport, noStar.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "m.py:g"]);
		}
		// an unpositioned alias with an external star BEFORE the unconditional def: the def overrides the star
		const external = await both("from os import *\ndef g():\n    pass\ndef f():\n    pass\nif C:\n    f = g\n", {});
		for (const one of [external.fromImport, external.attribute])
			expect(one.callees.sort()).toEqual(["m.py:f", "m.py:g"]);
	});

	test("a star that cannot bind the name is skipped, not a tie or an unpositioned refusal (the `matters` guard)", async () => {
		const z = "def g():\n    pass\n";
		const sameLine = await both("from o import f; from z import *\n", { "z.py": z, "o.py": x });
		for (const one of [sameLine.fromImport, sameLine.attribute]) expect(one.callees).toEqual(["o.py:f"]);
		const alias = await both("def g():\n    pass\ndef f():\n    pass\nfrom z import *\nif C:\n    f = g\n", {
			"z.py": z,
		});
		for (const one of [alias.fromImport, alias.attribute]) expect(one.callees.sort()).toEqual(["m.py:f", "m.py:g"]);
	});

	test("moving the overridden break first hides no tie: a star on the same line as the LAST unconditional binding still refuses", async () => {
		// the star is on the line of the last (only) unconditional binding: not before it, so it is a tie
		for (const holder of ["from o import f; from x import *\n", "from x import *; from o import f\n"]) {
			const r = await both(holder, { "x.py": x, "o.py": x });
			for (const one of [r.fromImport, r.attribute])
				expect(
					one.sites.map((s) => s.calleeId),
					holder,
				).toEqual([]);
		}
		// and with a star one line LATER the same import is overridden, not a tie
		const later = await both("from o import f\nfrom x import *\n", { "x.py": x, "o.py": x });
		for (const one of [later.fromImport, later.attribute]) expect(one.callees).toEqual(["x.py:f"]);
	});

	test("a case-arm DEF is an alternative while a case-arm ASSIGNMENT still refuses (GCLI-116's rule, unchanged)", async () => {
		const def = await both("def f():\n    pass\nmatch v:\n    case 1:\n        def f():\n            pass\n", {});
		for (const one of [def.fromImport, def.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "m.py:f"].sort());
			expect(one.sites.length).toBe(2);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
		}
		const assign = await both("def f():\n    pass\nmatch v:\n    case 1:\n        f = None\n", {});
		for (const one of [assign.fromImport, assign.attribute]) {
			expect(one.sites.map((s) => s.calleeId)).toEqual([]);
			expect(one.delta.inRepo).toBe(0);
		}
	});

	test("a same-line star before a LATER unconditional def is overridden by it, not a tie", async () => {
		const r = await both("from o import f; from x import *\ndef f():\n    pass\n", { "x.py": x, "o.py": x });
		// the star is no part of the answer (no tie, no refusal): the gate's own alternatives stand, as on dev
		for (const one of [r.fromImport, r.attribute]) expect(one.callees.sort()).toEqual(["m.py:f", "o.py:f"]);
	});

	test("a conditional def or import AFTER a star is an alternative of the star's name, not the only edge (dev's from-import shape)", async () => {
		const shapes: Record<string, string> = {
			"if-arm def": "from x import *\nif C:\n    def f():\n        pass\n",
			"try-arm def": "from x import *\ntry:\n    pass\nexcept E:\n    def f():\n        pass\n",
			"if-arm import": "from x import *\nif C:\n    from o import f\n",
			"if-arm class": "from x import *\nif C:\n    class f:\n        pass\n",
		};
		for (const [label, holder] of Object.entries(shapes)) {
			const r = await both(holder, { "x.py": x, "o.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees.sort(), label).toEqual([label === "if-arm import" ? "o.py:f" : "m.py:f", "x.py:f"]);
				expect(
					one.sites.every((s) => s.multiplyBound === true),
					label,
				).toBe(true);
			}
		}
		const arms: Record<string, string> = {
			"try body with an except arm": "from x import *\ntry:\n    def f():\n        pass\nexcept E:\n    pass\n",
			"elif arm": "from x import *\nif C:\n    pass\nelif D:\n    def f():\n        pass\n",
			"else arm": "from x import *\nif C:\n    pass\nelse:\n    def f():\n        pass\n",
			"case clause": "from x import *\nmatch v:\n    case 1:\n        def f():\n            pass\n",
			"finally inside an if":
				"from x import *\nif C:\n    try:\n        pass\n    finally:\n        def f():\n            pass\n",
			"for body": "from x import *\nfor i in v:\n    def f():\n        pass\n",
			"while else": "from x import *\nwhile C:\n    pass\nelse:\n    def f():\n        pass\n",
		};
		for (const [label, holder] of Object.entries(arms)) {
			const r = await both(holder, { "x.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees.sort(), label).toEqual(["m.py:f", "x.py:f"]);
				expect(
					one.sites.every((s) => s.multiplyBound === true),
					label,
				).toBe(true);
			}
		}
		// (a62) item 3: a with body is conditional (a context manager can suppress an exception raised earlier in
		// its body, so the def after a failing import is skipped and the star's f stands)
		const withBody = await both("from x import *\nwith v:\n    def f():\n        pass\n", { "x.py": x });
		for (const one of [withBody.fromImport, withBody.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f"]);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
		}
		const suppress = await both(
			"import contextlib\nfrom x import *\nwith contextlib.suppress(ImportError):\n    import failing\n    def f():\n        pass\n",
			{ "x.py": x },
		);
		for (const one of [suppress.fromImport, suppress.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f"]);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
		}
		// a try's else arm is conditional; a decorated def inside an if is conditional
		const tryElse = await both(
			"from x import *\ntry:\n    pass\nexcept E:\n    pass\nelse:\n    def f():\n        pass\n",
			{
				"x.py": x,
			},
		);
		for (const one of [tryElse.fromImport, tryElse.attribute]) expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f"]);
		const decoratedInIf = await both("from x import *\nif C:\n    @dec\n    def f():\n        pass\n", { "x.py": x });
		for (const one of [decoratedInIf.fromImport, decoratedInIf.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f"]);
		}
		// twins that RUN: a def in a finally (always runs), in a try body whose try has only a finally, and a
		// decorated module-level def each override the star
		const alwaysRuns: Record<string, string> = {
			finally: "from x import *\ntry:\n    pass\nfinally:\n    def f():\n        pass\n",
			"finally of a try that has an except arm":
				"from x import *\ntry:\n    pass\nexcept E:\n    pass\nfinally:\n    def f():\n        pass\n",
			"try body with only a finally": "from x import *\ntry:\n    def f():\n        pass\nfinally:\n    pass\n",
			"decorated def": "from x import *\n@dec\ndef f():\n    pass\n",
		};
		for (const [label, holder] of Object.entries(alwaysRuns)) {
			const r = await both(holder, { "x.py": x });
			for (const one of [r.fromImport, r.attribute]) expect(one.callees, label).toEqual(["m.py:f"]);
		}
		// an @overload group with the star BETWEEN the stubs and the implementation: the implementation overrides it
		const between = await both(
			"from typing import overload\n@overload\ndef f(a: int): ...\n@overload\ndef f(a: str): ...\nfrom x import *\ndef f(a):\n    pass\n",
			{ "x.py": x },
		);
		for (const one of [between.fromImport, between.attribute]) expect(one.callees).toEqual(["m.py:f"]);
		// an @overload group is one binding: its collapsed stubs do not count as unpositioned bindings
		const overload =
			"from x import *\nfrom typing import overload\n@overload\ndef f(a: int): ...\n@overload\ndef f(a: str): ...\ndef f(a):\n    pass\n";
		const overloaded = await both(overload, { "x.py": x });
		for (const one of [overloaded.fromImport, overloaded.attribute]) expect(one.callees).toEqual(["m.py:f"]);
		// a collapsed stub is skipped only where the implementation is certainly the later binding: a stub AFTER the
		// implementation (Python: f is the overload dummy), a conditional stub after the star, and unconditional
		// stubs before a CONDITIONAL implementation each leave the name unresolved, never one unflagged edge
		const stubShapes: Record<string, string> = {
			"stub after the implementation and the star":
				"from typing import overload\ndef f(a):\n    pass\nfrom x import *\n@overload\ndef f(a: int): ...\n",
			"conditional stub after the star":
				"from typing import overload\ndef f(a):\n    pass\nfrom x import *\nif C:\n    @overload\n    def f(a: int): ...\n",
			"unconditional stubs before a conditional implementation":
				"from typing import overload\nfrom x import *\n@overload\ndef f(a: int): ...\n@overload\ndef f(a: str): ...\nif C:\n    def f(a): ...\n",
		};
		for (const [label, holder] of Object.entries(stubShapes)) {
			const r = await both(holder, { "x.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees, label).not.toContain("x.py:f");
				expect(
					one.sites.map((s) => s.calleeId),
					label,
				).toEqual([]);
			}
		}
		// stubs and implementation inside the same arm: the stub is before the implementation that runs wherever it
		// does, so the group is the implementation, an alternative of the star's name
		const sameArm = await both(
			"from typing import overload\nfrom x import *\nif C:\n    @overload\n    def f(a: int): ...\n    def f(a):\n        pass\n",
			{ "x.py": x },
		);
		for (const one of [sameArm.fromImport, sameArm.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f"]);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
		}
		// a star AFTER the group decides (x.f): the stubs are not unpositioned bindings that force a refusal
		const afterGroup = await both(`${overload}from x import *\n`, { "x.py": x });
		for (const one of [afterGroup.fromImport, afterGroup.attribute]) expect(one.callees).toEqual(["x.py:f"]);
		const overloadedPartial = await both(`from nowhere import *\n${overload}`, { "x.py": x });
		for (const one of [overloadedPartial.fromImport, overloadedPartial.attribute])
			expect(one.callees).toEqual(["m.py:f"]);
		// twins: an UNCONDITIONAL def after the star overrides it; a conditional def BEFORE the star is overridden
		const overrides = await both("from x import *\ndef f():\n    pass\n", { "x.py": x });
		for (const one of [overrides.fromImport, overrides.attribute]) expect(one.callees).toEqual(["m.py:f"]);
		const before = await both("if C:\n    def f():\n        pass\nfrom x import *\n", { "x.py": x });
		for (const one of [before.fromImport, before.attribute]) expect(one.callees).toEqual(["x.py:f"]);
		// a conditional alternative that does not resolve to a symbol leaves the name unresolved
		const external = await both("from x import *\nif C:\n    from nowhere import f\n", { "x.py": x });
		for (const one of [external.fromImport, external.attribute]) expect(one.sites.map((s) => s.calleeId)).toEqual([]);
	});

	test("the visit key is (module, name): a walk that returns to a module under another name continues", async () => {
		const r = await probe("from m import f\nCALL\n", "f()", {
			"m.py": "def h():\n    pass\nfrom o import g as f\n",
			"o.py": "from m import h as g\n",
		});
		expect(r.delta).toEqual(RESOLVED);
		expect(r.callees).toEqual(["m.py:h"]);
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
