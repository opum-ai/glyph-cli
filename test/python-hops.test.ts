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

	test("an import that may not run, after a star, is an alternative of the star's name (loop, except*, with)", async () => {
		const arms: Record<string, string> = {
			"for body": "from x import *\nfor i in v:\n    from o import f\n",
			"while body": "from x import *\nwhile C:\n    from o import f\n",
			"except* arm": "from x import *\ntry:\n    pass\nexcept* E:\n    from o import f\n",
			"with body": "from x import *\nwith v:\n    from o import f\n",
			"star on its own line then a loop import": "from o import f\nfrom x import *\nfor i in v:\n    from o import f\n",
		};
		for (const [label, holder] of Object.entries(arms)) {
			const r = await both(holder, { "x.py": x, "o.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees.sort(), label).toEqual(["o.py:f", "x.py:f"]);
				expect(
					one.sites.every((s) => s.multiplyBound === true),
					label,
				).toBe(true);
			}
		}
		// the same-line shape (a tie with the unconditional import) is the tie rule's: unresolved, in both forms
		const tie = await both("from o import f; from x import *\nfor i in v:\n    from o import f\n", {
			"x.py": x,
			"o.py": x,
		});
		for (const one of [tie.fromImport, tie.attribute]) expect(one.sites.map((s) => s.calleeId)).toEqual([]);
		// GCLI-126: an import in a finally, or in a try body with only a finally, always runs: it overrides the star
		for (const holder of [
			"from x import *\ntry:\n    pass\nfinally:\n    from o import f\n",
			"from x import *\ntry:\n    from o import f\nfinally:\n    pass\n",
		]) {
			const r = await both(holder, { "x.py": x, "o.py": x });
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees, holder).toEqual(["o.py:f"]);
				expect(one.sites.some((s) => s.multiplyBound === true)).toBe(false);
			}
		}
		// twins: an UNCONDITIONAL import after the star overrides it
		const overrides = await both("from x import *\nfrom o import f\n", { "x.py": x, "o.py": x });
		for (const one of [overrides.fromImport, overrides.attribute]) expect(one.callees).toEqual(["o.py:f"]);
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

// GCLI-125 (DEC-303 (a62) item 6, N-6): a star inside an if or try arm may not run, so after an unconditional def
// the name is the star's OR the def's (Q2), never the star's alone.
describe("GCLI-125 — a conditional star is a may-skip alternative", () => {
	const x = "def f():\n    pass\n";
	const both = async (holder: string) => ({
		fromImport: await probe("from m import f\nCALL\n", "f()", { "m.py": holder, "x.py": x, "y.py": x }),
		attribute: await probe("import m\nCALL\n", "m.f()", { "m.py": holder, "x.py": x, "y.py": x }),
	});
	const def = "def f():\n    pass\n";

	// the star's may-skip is the maySkipStatement rule a def, a class and an import follow (Opus round 1, 8a5de372)
	const mayBeSkipped: Record<string, string> = {
		"def, if-star": `${def}if C:\n    from x import *\n`,
		"def, elif-star": `${def}if C:\n    pass\nelif D:\n    from x import *\n`,
		"def, else-star": `${def}if C:\n    pass\nelse:\n    from x import *\n`,
		"def, try-star": `${def}try:\n    from x import *\nexcept ImportError:\n    pass\n`,
		"def, except-star": `${def}try:\n    pass\nexcept ImportError:\n    from x import *\n`,
		"def, try-else-star": `${def}try:\n    pass\nexcept ImportError:\n    pass\nelse:\n    from x import *\n`,
		"def, except*-star": `${def}try:\n    pass\nexcept* E:\n    from x import *\n`,
		"def, with-star": `${def}with C:\n    from x import *\n`,
		"def, for-star": `${def}for _ in ():\n    from x import *\n`,
		"def, for-else-star": `${def}for _ in ():\n    pass\nelse:\n    from x import *\n`,
		"def, while-star": `${def}while C:\n    from x import *\n`,
		"def, case-star": `${def}match C:\n    case 1:\n        from x import *\n`,
		"def, if-try-finally-star": `${def}if C:\n    try:\n        pass\n    finally:\n        from x import *\n`,
	};
	test("a star that may be skipped, after an unconditional def, gives every alternative, each multiplyBound", async () => {
		for (const [label, holder] of Object.entries(mayBeSkipped)) {
			const r = await both(holder);
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees.sort(), label).toEqual(["m.py:f", "x.py:f"]);
				expect(
					one.sites.every((s) => s.multiplyBound === true),
					label,
				).toBe(true);
				// one call expression, two edges: the bins count the call once
				expect(one.delta, label).toEqual(RESOLVED);
				expect(new Set(one.sites.map((s) => `${s.line}:${s.column}`)).size, label).toBe(1);
			}
		}
	});

	test("an import then a skippable star gives both, flagged; the same symbol on both sides is one unflagged symbol", async () => {
		const r = await both("from y import f\nif C:\n    from x import *\n");
		for (const one of [r.fromImport, r.attribute]) {
			expect(one.callees.sort()).toEqual(["x.py:f", "y.py:f"]);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
			expect(one.delta).toEqual(RESOLVED);
		}
		const same = await both("from x import f\nif C:\n    from x import *\n");
		for (const one of [same.fromImport, same.attribute]) {
			expect(one.callees).toEqual(["x.py:f"]);
			expect(one.sites.some((s) => s.multiplyBound === true)).toBe(false);
			expect(one.delta).toEqual(RESOLVED);
		}
	});

	test("a star in a finally, or in a try body with only a finally, always runs: it decides x.f alone, as on dev", async () => {
		const holders: Record<string, string> = {
			finally: `${def}try:\n    pass\nfinally:\n    from x import *\n`,
			"try-only-finally body": `${def}try:\n    from x import *\nfinally:\n    pass\n`,
		};
		for (const [label, holder] of Object.entries(holders)) {
			const r = await both(holder);
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees, label).toEqual(["x.py:f"]);
				expect(one.sites.some((s) => s.multiplyBound === true)).toBe(false);
			}
		}
	});

	test("an earlier star overridden by the def does not block the may-skip union; only an earlier live star does", async () => {
		const r = await both(`from y import *\n${def}if C:\n    from x import *\n`);
		for (const one of [r.fromImport, r.attribute]) expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f"]);
	});

	test("a one-symbol union with a multiply outcome in it keeps the multiplyBound flag (DEC-303 (a65))", async () => {
		const bare = (holder: string, others: Record<string, string>) => ({ "m.py": holder, ...others });
		// round 2 (64aed52a): the fallback is `multiply` (ext.f or x.f), the star's symbol is x.f: Python allows ext.f or x.f
		const viaFallback = bare(
			"try:\n    from ext import f\nexcept ImportError:\n    from x import f\nif C:\n    from x import *\n",
			{
				"x.py": x,
			},
		);
		// the same through a later alternative that cannot be skipped by the star's own condition
		const viaLater = bare("from x import *\nif C:\n    from x import f\n", {
			"x.py": "try:\n    from ext import f\nexcept ImportError:\n    def f():\n        pass\n",
		});
		for (const [label, others] of Object.entries({ viaFallback, viaLater })) {
			const fromImport = await probe("from m import f\nCALL\n", "f()", others);
			const attribute = await probe("import m\nCALL\n", "m.f()", others);
			for (const one of [fromImport, attribute]) {
				expect(one.callees, label).toEqual(["x.py:f"]);
				expect(
					one.sites.every((s) => s.multiplyBound === true),
					label,
				).toBe(true);
				expect(one.delta, label).toEqual(RESOLVED);
			}
		}
	});

	test("an earlier star that is external or unresolved, then a skippable star, is a refusal", async () => {
		for (const first of ["from ext_missing import *\n", "from .nowhere import *\n"]) {
			const r = await both(`${def}${first}if C:\n    from x import *\n`);
			for (const one of [r.fromImport, r.attribute]) {
				expect(
					one.sites.map((s) => s.calleeId),
					first,
				).toEqual([]);
				expect(one.delta.inRepo, first).toBe(0);
			}
		}
	});

	test("twins: an unconditional star after the def decides x.f alone; a conditional star BEFORE the def is overridden", async () => {
		const after = await both(`${def}from x import *\n`);
		for (const one of [after.fromImport, after.attribute]) {
			expect(one.callees).toEqual(["x.py:f"]);
			expect(one.sites.some((s) => s.multiplyBound === true)).toBe(false);
		}
		const before = await both(`if C:\n    from x import *\n${def}`);
		for (const one of [before.fromImport, before.attribute]) expect(one.callees).toEqual(["m.py:f"]);
		const lone = await both("if C:\n    from x import *\n");
		for (const one of [lone.fromImport, lone.attribute]) expect(one.callees).toEqual(["x.py:f"]);
	});

	test("an earlier star that could bind the name, or a rest that is not a symbol, is a refusal, not a pick", async () => {
		const holders: Record<string, string> = {
			"two conditional stars": `${def}if C:\n    from x import *\nelse:\n    from y import *\n`,
			"unconditional star then conditional star": `${def}from y import *\nif C:\n    from x import *\n`,
			"external import then conditional star": "from ext import f\nif C:\n    from x import *\n",
		};
		for (const [label, holder] of Object.entries(holders)) {
			const r = await both(holder);
			for (const one of [r.fromImport, r.attribute]) {
				expect(
					one.sites.map((s) => s.calleeId),
					label,
				).toEqual([]);
				expect(one.delta.inRepo, label).toBe(0);
			}
		}
	});
});

// GCLI-124 (DEC-303 (a60) item 9, (a61) item 5): a hop that imports the name conditionally and under an alias
// (`if C: from p import g as f`) is followed with its imported name g, as the unconditional form is; the first-hop
// name f is never looked up in the target. p.f is the WRONG edge (p.g is what Python binds).
describe("GCLI-124 — a conditional alias hop names the imported name, not the first-hop name", () => {
	const p = "def g():\n    pass\n\ndef f():\n    pass\n";
	const both = async (holder: string, others: Record<string, string>) => ({
		fromImport: await probe("from m import f\nCALL\n", "f()", { "m.py": holder, ...others }),
		attribute: await probe("import m\nCALL\n", "m.f()", { "m.py": holder, ...others }),
	});

	test("the reproducing input gives p.g, never p.f, in both forms, in an if, a try and a with arm", async () => {
		const holders: Record<string, string> = {
			if: "if C:\n    from p import g as f\n",
			"if / else-less nested": "if C:\n    if D:\n        from p import g as f\n",
			try: "try:\n    from p import g as f\nexcept ImportError:\n    pass\n",
			with: "with C:\n    from p import g as f\n",
		};
		for (const [label, holder] of Object.entries(holders)) {
			const r = await both(holder, { "p.py": p });
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees, label).toEqual(["p.py:g"]);
				expect(one.delta, label).toEqual(RESOLVED);
			}
		}
	});

	test("twins: no alias keeps p.f, an unconditional alias keeps p.g", async () => {
		const plain = await both("if C:\n    from p import f\n", { "p.py": p });
		for (const one of [plain.fromImport, plain.attribute]) expect(one.callees).toEqual(["p.py:f"]);
		const unconditional = await both("from p import g as f\n", { "p.py": p });
		for (const one of [unconditional.fromImport, unconditional.attribute]) expect(one.callees).toEqual(["p.py:g"]);
	});

	test("two conditional hops of the name (both try/except ImportError arms) are alternatives, never one pick", async () => {
		const q = "def h():\n    pass\n\ndef f():\n    pass\n";
		const holder = "try:\n    from p import g as f\nexcept ImportError:\n    from q import h as f\n";
		const r = await both(holder, { "p.py": p, "q.py": q });
		for (const one of [r.fromImport, r.attribute]) {
			expect(one.callees.sort()).toEqual(["p.py:g", "q.py:h"]);
			expect(one.callees).not.toContain("p.py:f");
			expect(one.callees).not.toContain("q.py:f");
		}
	});

	test("a conditional alias hop and a star that can bind the name: alternatives where both can bind, the later one alone only where it always runs", async () => {
		const x = "def f():\n    pass\n";
		// the star runs first and the hop may replace it: x.f or p.g
		const starFirst = await both("from x import *\nif C:\n    from p import g as f\n", { "p.py": p, "x.py": x });
		for (const one of [starFirst.fromImport, starFirst.attribute]) {
			expect(one.callees.sort()).toEqual(["p.py:g", "x.py:f"]);
		}
		// the unconditional star after the hop overrides it: x.f alone is what Python binds
		const starLast = await both("if C:\n    from p import g as f\nfrom x import *\n", { "p.py": p, "x.py": x });
		for (const one of [starLast.fromImport, starLast.attribute]) expect(one.callees).toEqual(["x.py:f"]);
		for (const one of [starFirst.fromImport, starFirst.attribute, starLast.fromImport, starLast.attribute]) {
			expect(one.callees).not.toContain("p.py:f");
		}
	});
});

// GCLI-124 Opus round 1 (f041dc25): the from-import form never looks the FIRST-HOP name up in S3's collapsed target
// once the hop walk has renamed the name and dead-ended, or reached a plain-import hop that binds a module.
describe("GCLI-124 round 1 — the targets loop does not look up the old name after a rename or a module hop", () => {
	const xg = "def g():\n    pass\n\ndef f():\n    pass\n";
	const wrap = (cond: boolean, line: string) => (cond ? `if C:\n    ${line}\n` : `${line}\n`);

	for (const cond of [true, false]) {
		const form = cond ? "conditional" : "unconditional";

		test(`(a) ${form} alias through a star-only middle module: x.f is never an edge, the attribute form gives x.g`, async () => {
			const others = { "x.py": xg, "n.py": "from x import *\n", "m.py": wrap(cond, "from n import g as f") };
			const fromImport = await probe("from m import f\nCALL\n", "f()", others);
			expect(fromImport.callees).not.toContain("x.py:f");
			expect(fromImport.callees).toEqual([]);
			expect(fromImport.delta.inRepo).toBe(0);
			const attribute = await probe("import m\nCALL\n", "m.f()", others);
			expect(attribute.callees).toEqual(["x.py:g"]);
		});

		test(`(b) ${form} alias of a submodule (from . import g as f) binds a module: g.f is never an edge`, async () => {
			const others = {
				"pkg/__init__.py": "",
				"pkg/g.py": "def f():\n    pass\n",
				"pkg/m.py": wrap(cond, "from . import g as f"),
			};
			const fromImport = await probe("from pkg.m import f\nCALL\n", "f()", others);
			expect(fromImport.callees).toEqual([]);
			expect(fromImport.delta.inRepo).toBe(0);
			const attribute = await probe("from pkg import m\nCALL\n", "m.f()", others);
			expect(attribute.callees).not.toContain("pkg/g.py:f");
		});

		test(`(c) ${form} plain-import hop (import p as f) binds a module: p.f is never an edge`, async () => {
			const others = { "p.py": "def f():\n    pass\n", "m.py": wrap(cond, "import p as f") };
			const fromImport = await probe("from m import f\nCALL\n", "f()", others);
			expect(fromImport.callees).toEqual([]);
			expect(fromImport.delta.inRepo).toBe(0);
			const attribute = await probe("import m\nCALL\n", "m.f()", others);
			expect(attribute.callees).not.toContain("p.py:f");
		});
	}

	test("a conditional hop deeper in a chain reaches the next module's own bindings: n deletes f, so no edge (was p.f)", async () => {
		const others = {
			"p.py": "def f():\n    pass\n",
			"n.py": "from p import f\ndel f\n",
			"m.py": "if C:\n    from n import f\n",
		};
		const fromImport = await probe("from m import f\nCALL\n", "f()", others);
		expect(fromImport.callees).toEqual([]);
		expect(fromImport.delta.inRepo).toBe(0);
	});

	test("a conditional alias hop at depth 2 gives p.g in both forms (the attribute form gave p.f on dev)", async () => {
		const others = { "p.py": xg, "m.py": "if C:\n    from p import g as f\n", "a.py": "from m import f\n" };
		const fromImport = await probe("from a import f\nCALL\n", "f()", others);
		expect(fromImport.callees).toEqual(["p.py:g"]);
		const attribute = await probe("import a\nCALL\n", "a.f()", others);
		expect(attribute.callees).toEqual(["p.py:g"]);
	});

	test("twins: a plain hop through a star-only middle module, and an unaliased import of a def, keep their edge", async () => {
		const star = await probe("from m import f\nCALL\n", "f()", {
			"x.py": xg,
			"n.py": "from x import *\n",
			"m.py": "from n import f\n",
		});
		expect(star.callees).toEqual(["x.py:f"]);
		const plain = await probe("from m import f\nCALL\n", "f()", { "p.py": xg, "m.py": "if C:\n    from p import f\n" });
		expect(plain.callees).toEqual(["p.py:f"]);
	});
});

// GCLI-127 (DEC-303 (a64) item 2): the attribute form `m.f()` where m has no binding of f and two stars could bind
// it. A star that may be skipped does not decide alone when an earlier star could bind the name: a refusal (the
// attribute lookup has no multiply outcome), where the bare form gives both alternatives, each multiplyBound.
describe("GCLI-127 — a may-skip star with an earlier star that could bind the name is no single edge", () => {
	const f = "def f():\n    pass\n";
	const files = (holder: string): Record<string, string> => ({ "a.py": f, "b.py": f, "m.py": holder });
	const bare = (holder: string) => probe("from m import f\nCALL\n", "f()", files(holder));
	const attr = (holder: string) => probe("import m\nCALL\n", "m.f()", files(holder));

	const skippable: Record<string, string> = {
		"try / except ImportError": "try:\n    from a import *\nexcept ImportError:\n    from b import *\n",
		"unconditional star then if": "from a import *\nif C:\n    from b import *\n",
		"star then else arm": "from a import *\nif C:\n    pass\nelse:\n    from b import *\n",
		"star then for body": "from a import *\nfor _ in ():\n    from b import *\n",
		"star then case arm": "from a import *\nmatch C:\n    case 1:\n        from b import *\n",
		"star then except* arm": "from a import *\ntry:\n    pass\nexcept* E:\n    from b import *\n",
	};
	test("the attribute form gives no edge, never b.f alone; the bare form gives both alternatives", async () => {
		for (const [label, holder] of Object.entries(skippable)) {
			const one = await attr(holder);
			expect(
				one.sites.map((s) => s.calleeId),
				label,
			).toEqual([]);
			expect(one.delta.inRepo, label).toBe(0);
			const both = await bare(holder);
			expect(both.callees.sort(), label).toEqual(["a.py:f", "b.py:f"]);
			expect(
				both.sites.every((s) => s.multiplyBound === true),
				label,
			).toBe(true);
		}
	});

	test("an earlier star that is incomplete (external or unresolved) before a may-skip star is a refusal too", async () => {
		for (const first of ["from ext_missing import *\n", "from .nowhere import *\n"]) {
			const one = await attr(`${first}if C:\n    from b import *\n`);
			expect(
				one.sites.map((s) => s.calleeId),
				first,
			).toEqual([]);
		}
	});

	test("twins: an unconditional last star, a lone may-skip star, and a star in a finally keep deciding", async () => {
		const twins: Record<string, [string, string]> = {
			"two unconditional stars": ["from a import *\nfrom b import *\n", "b.py:f"],
			"lone may-skip star": ["if C:\n    from b import *\n", "b.py:f"],
			"earlier star that does not export f": ["from y import *\nif C:\n    from b import *\n", "b.py:f"],
			"star in a finally": ["from a import *\ntry:\n    pass\nfinally:\n    from b import *\n", "b.py:f"],
		};
		for (const [label, [holder, expected]] of Object.entries(twins)) {
			const others = { ...files(holder), "y.py": "def other():\n    pass\n" };
			const one = await probe("import m\nCALL\n", "m.f()", others);
			expect(one.callees, label).toEqual([expected]);
			expect(one.delta, label).toEqual(RESOLVED);
		}
	});
});

// GCLI-127 Opus round 1 (6d7e0f63): the refusal needs a DIFFERENT earlier binding. An earlier star that binds the very
// same symbol leaves one possible binding, so the deciding star keeps its edge; the reason and the bins are pinned.
describe("GCLI-127 round 1 — same-symbol stars keep deciding, the refusal is star-bound in the receiver bin", () => {
	const f = "def f():\n    pass\n";
	const attrFiles = (holder: string, others: Record<string, string>) => [
		...Object.entries(others).map(([path, source]) => py(path, source)),
		py("m.py", holder),
		py("app.py", "import m\nm.f()\n"),
	];

	test("the refusal is unresolved star-bound in one bin, and the bins add up", async () => {
		const result = await analyze(attrFiles("from a import *\nif C:\n    from b import *\n", { "a.py": f, "b.py": f }));
		expect(result.sites.filter((s) => s.file === "app.py" && s.calleeId !== null)).toEqual([]);
		const reasons = [...result.unresolvedNameReasons, ...result.unresolvedReceiverReasons];
		expect(reasons.map((r) => r.reason)).toContain("star-bound");
		const without = await analyze(
			attrFiles("from a import *\nif C:\n    from b import *\n", { "a.py": f, "b.py": f }).map((file) =>
				file.path === "app.py" ? py("app.py", "import m\npass\n") : file,
			),
		);
		const delta = {
			inRepo: result.callBins.resolvedInRepo - without.callBins.resolvedInRepo,
			external: result.callBins.resolvedExternal - without.callBins.resolvedExternal,
			receiver: result.callBins.receiverNeedsInference - without.callBins.receiverNeedsInference,
			nameNotBound: result.callBins.nameNotBound - without.callBins.nameNotBound,
		};
		expect(delta.inRepo).toBe(0);
		expect(delta.external).toBe(0);
		expect(delta.receiver + delta.nameNotBound).toBe(1);
	});

	test("an earlier star that binds the SAME symbol (the same file, or a re-export of it) leaves one binding: b.f, bare and attribute", async () => {
		const shapes: Record<string, [string, Record<string, string>]> = {
			"A: the same star twice": ["from b import *\nif C:\n    from b import *\n", { "b.py": f }],
			"B: a re-export": ["from y import *\nif C:\n    from b import *\n", { "b.py": f, "y.py": "from b import f\n" }],
			"star in a try with an except pass": [
				"from b import *\ntry:\n    from c import *\nexcept ImportError:\n    pass\n",
				{ "b.py": f, "c.py": "from b import *\n" },
			],
		};
		for (const [label, [holder, others]] of Object.entries(shapes)) {
			const attribute = await probe("import m\nCALL\n", "m.f()", { "m.py": holder, ...others });
			expect(attribute.callees, label).toEqual(["b.py:f"]);
			expect(attribute.delta, label).toEqual(RESOLVED);
			// the bare form agrees: no def or import of f in m, so the star-bound symbol is read from S3's target
			const bare = await probe("from m import f\nCALL\n", "f()", { "m.py": holder, ...others });
			expect(bare.callees, label).toEqual(["b.py:f"]);
		}
	});

	test("the package case: from .core import * then try: from .extras import * (extras re-exports core) binds core.f", async () => {
		const others = {
			"pkg/__init__.py": "",
			"pkg/core.py": f,
			"pkg/extras.py": "from .core import *\n",
		};
		const holder = "from .core import *\ntry:\n    from .extras import *\nexcept ImportError:\n    pass\n";
		const attribute = await probe("import pkg.m\nCALL\n", "pkg.m.f()", { ...others, "pkg/m.py": holder });
		expect(attribute.callees).toEqual(["pkg/core.py:f"]);
	});

	test("a star in a try body that has only a finally always runs: the earlier star's name still decides alone", async () => {
		const others = { "a.py": f, "b.py": f };
		const one = await probe("import m\nCALL\n", "m.f()", {
			"m.py": "from a import *\ntry:\n    from b import *\nfinally:\n    pass\n",
			...others,
		});
		expect(one.callees).toEqual(["b.py:f"]);
	});
});

// GCLI-126 (DEC-303 (a62) item 5, (a63)): an import is conditional by the walk a def and a class follow
// (maySkipStatement: a finally and a try-only-finally body are walked through), not by S3's own condition.
describe("GCLI-126 — an import in a finally or a try-only-finally body is not an alternative of an earlier binding", () => {
	const x = "def f():\n    pass\n";
	const both = async (holder: string) => ({
		fromImport: await probe("from m import f\nCALL\n", "f()", { "m.py": holder, "x.py": x, "y.py": x }),
		attribute: await probe("import m\nCALL\n", "m.f()", { "m.py": holder, "x.py": x, "y.py": x }),
	});
	const def = "def f():\n    pass\n";

	test("a finally or try-only-finally import after an earlier binding decides alone: x.f, unflagged, one call in the bins", async () => {
		const holders: Record<string, string> = {
			"def, finally import": `${def}try:\n    pass\nfinally:\n    from x import f\n`,
			"def, try-only-finally import": `${def}try:\n    from x import f\nfinally:\n    pass\n`,
			// the walk is the same for a plain unconditional import: it always runs, so it overrides the def too
			"def, plain import": `${def}from x import f\n`,
			"import, finally import": "from y import f\ntry:\n    pass\nfinally:\n    from x import f\n",
			"import, nested try-finally import":
				"from y import f\ntry:\n    try:\n        pass\n    finally:\n        from x import f\nfinally:\n    pass\n",
		};
		for (const [label, holder] of Object.entries(holders)) {
			const r = await both(holder);
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees, label).toEqual(["x.py:f"]);
				expect(
					one.sites.some((s) => s.multiplyBound === true),
					label,
				).toBe(false);
				expect(one.delta, label).toEqual(RESOLVED);
			}
		}
	});

	test("an import in any arm that may be skipped stays an alternative of the earlier binding, each multiplyBound", async () => {
		const arms: Record<string, string> = {
			if: "if C:\n    from x import f\n",
			elif: "if C:\n    pass\nelif D:\n    from x import f\n",
			else: "if C:\n    pass\nelse:\n    from x import f\n",
			"try body with an except": "try:\n    from x import f\nexcept ImportError:\n    pass\n",
			except: "try:\n    pass\nexcept ImportError:\n    from x import f\n",
			"except*": "try:\n    pass\nexcept* E:\n    from x import f\n",
			case: "match C:\n    case 1:\n        from x import f\n",
			for: "for _ in ():\n    from x import f\n",
			while: "while C:\n    from x import f\n",
			with: "with C:\n    from x import f\n",
		};
		for (const [label, arm] of Object.entries(arms)) {
			const r = await both(`${def}${arm}`);
			for (const one of [r.fromImport, r.attribute]) {
				expect(one.callees.sort(), label).toEqual(["m.py:f", "x.py:f"]);
				expect(
					one.sites.every((s) => s.multiplyBound === true),
					label,
				).toBe(true);
				expect(one.delta, label).toEqual(RESOLVED);
			}
		}
	});

	test("twins: a def AFTER the finally import, and a conditional import after it, keep every alternative", async () => {
		const defAfter = await both(`try:\n    pass\nfinally:\n    from x import f\n${def}`);
		for (const one of [defAfter.fromImport, defAfter.attribute]) {
			expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f"]);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
		}
		const condAfter = await both(`${def}try:\n    pass\nfinally:\n    from x import f\nif C:\n    from y import f\n`);
		for (const one of [condAfter.fromImport, condAfter.attribute]) {
			// the last binding may be skipped, so nothing is overridden: every binding stays an alternative, as before
			expect(one.callees.sort()).toEqual(["m.py:f", "x.py:f", "y.py:f"]);
			expect(one.sites.every((s) => s.multiplyBound === true)).toBe(true);
		}
	});
});

describe("GCLI-120 item 2 — C.__class__ is the metaclass, never a def in C's body", () => {
	const run = (body: string, others: Record<string, string> = {}) =>
		probe(`${body}def g():\n    f = ALIAS\n    CALL\n`.replace("ALIAS", "C.__class__"), "f()", others);
	const forms: Record<string, string> = {
		method: "class C:\n    def __class__(self):\n        pass\n",
		property: "class C:\n    @property\n    def __class__(self):\n        return 1\n",
		attribute: "class C:\n    __class__ = 1\n",
	};
	for (const [label, body] of Object.entries(forms)) {
		test(`${label}: f = C.__class__; f() resolves no edge to C's __class__`, async () => {
			const r = await run(body);
			expect(r.callees).toEqual([]);
			expect(r.delta.inRepo).toBe(0);
			expect(r.delta).toEqual({
				inRepo: 0,
				external: 0,
				receiver: 0,
				nameNotBound: 1,
			});
		});
	}

	test("a def __class__ in an in-repo base class is refused too", async () => {
		const r = await run("class B:\n    def __class__(self):\n        pass\nclass C(B):\n    pass\n");
		expect(r.callees).toEqual([]);
		expect(r.delta.inRepo).toBe(0);
	});

	test("twin: a class without __class__ still resolves f = C.g; f() to C.g, and an inherited method too", async () => {
		for (const body of [
			"class C:\n    def g(self):\n        pass\n",
			"class B:\n    def g(self):\n        pass\nclass C(B):\n    pass\n",
		]) {
			const r = await probe(`${body}def h():\n    f = C.g\n    CALL\n`, "f(1)");
			expect(r.callees).toEqual([expect.stringMatching(/^app\.py:.*\.g$/)]);
			expect(r.delta).toEqual(RESOLVED);
		}
	});
});

describe("GCLI-120 item 3 — a complete star set that misses a binding form does not claim the unshadowed builtin", () => {
	const run = (target: string, extra: Record<string, string> = {}) =>
		probe("from s import *\ndef g(x):\n    CALL\n", "len(x)", {
			"s.py": target,
			...extra,
		});
	const EXTERNAL: Delta = {
		inRepo: 0,
		external: 1,
		receiver: 0,
		nameNotBound: 0,
	};
	const NOT_BUILTIN: Delta = {
		inRepo: 0,
		external: 0,
		receiver: 0,
		nameNotBound: 1,
	};
	const forms: Record<string, string> = {
		"a for target": "for len in []:\n    pass\n",
		"a with-as target": "with open('f') as len:\n    pass\n",
		"a walrus": "if (len := 1):\n    pass\n",
		"a match capture": "match 1:\n    case len:\n        pass\n",
		"a list target": "[len, other] = 1, 2\n",
		"a nested target": "(a, (len, b)) = (1, (2, 3))\n",
		"a starred target": "a, *len = 1, 2, 3\n",
		"a global write": "def f():\n    global len\n    len = 1\n",
	};
	for (const [label, target] of Object.entries(forms)) {
		test(`${label} in the star target: len(x) is not the builtin`, async () => {
			const r = await run(target);
			expect(r.delta, label).toEqual(NOT_BUILTIN);
		});
	}

	test("twins: a star target whose set is exact keeps len(x) the builtin", async () => {
		const exact: Record<string, [string, Record<string, string>]> = {
			"plain def": ["def helper():\n    pass\n", {}],
			"a missed form on a private name": ["for _len in []:\n    pass\n", {}],
			"a literal __all__ with a missed form outside it": [
				"__all__ = ['helper']\ndef helper():\n    pass\nfor len in []:\n    pass\n",
				{},
			],
			"an exact nested star": ["from t import *\n", { "t.py": "def helper():\n    pass\n" }],
		};
		for (const [label, [target, extra]] of Object.entries(exact)) {
			const r = await run(target, extra);
			expect(r.delta, label).toEqual(EXTERNAL);
		}
	});

	test("a missed form behind a nested star in the target is refused too", async () => {
		const r = await run("from t import *\n", {
			"t.py": "for len in []:\n    pass\n",
		});
		expect(r.delta).toEqual(NOT_BUILTIN);
	});
});

describe("GCLI-120 round 1 — rule 46 shares the exactness rule, and `__all__` must be an unconditional value", () => {
	const staticApp =
		"from s import *\nclass C:\n    def helper(self):\n        pass\n    @staticmethod\n    def m(self):\n        self.helper()\n    def use(self):\n        CALL\n";
	const runStatic = (target: string) => probe(staticApp, "C.m()", { "s.py": target });

	test("a staticmethod under an inexact complete star keeps self a plain parameter: no C.helper edge from m", async () => {
		const r = await runStatic("for i in []:\n    pass\n");
		expect(r.callees).toEqual(["app.py:C.m"]);
	});

	test("twin: under an exact star target the same shape also has no C.helper edge", async () => {
		const r = await runStatic("def other():\n    pass\n");
		expect(r.callees).toEqual(["app.py:C.m"]);
	});

	const classApp = "from s import *\nclass C:\n    @classmethod\n    def m(cls):\n        CALL\n";
	test("a classmethod under an inexact complete star: cls() is not a construction", async () => {
		const r = await probe(classApp, "cls()", { "s.py": "for i in []:\n    pass\n" });
		expect(r.delta).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 });
		expect(r.callees).toEqual([]);
	});
	test("twin: a classmethod under an exact star target still constructs C", async () => {
		const r = await probe(classApp, "cls()", { "s.py": "def other():\n    pass\n" });
		expect(r.callees).toEqual(["app.py:C"]);
	});

	const run = (target: string) => probe("from s import *\ndef g(x):\n    CALL\n", "len(x)", { "s.py": target });
	test("a conditional `__all__` is not certified: len(x) is not the builtin", async () => {
		const r = await run("if X:\n    __all__ = ['helper']\ndef helper():\n    pass\nfor len in [1]:\n    pass\n");
		expect(r.delta).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 });
		expect(r.callees).toEqual([]);
	});
	test("a bare annotated `__all__` is not certified: a def len in the target is not the builtin", async () => {
		const r = await run("__all__: list[str]\ndef len(x):\n    pass\n");
		expect(r.delta).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 });
		expect(r.callees).toEqual([]);
	});
});

describe("GCLI-122 — an in-repo descendant that binds __class__ makes self.__class__ unresolved", () => {
	const forms: Record<string, string> = {
		attribute: "    __class__ = 1\n",
		property: "    @property\n    def __class__(self):\n        return 1\n",
		method: "    def __class__(self):\n        pass\n",
	};
	const app = (alias: string, d: string, extra = "") =>
		`class C:\n    def m(self):\n        cls = ${alias}\n        CALL\n    def meth(self):\n        pass\nclass D(C):\n${d}${extra}`;
	const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };

	for (const [label, d] of Object.entries(forms)) {
		test(`${label}: self.__class__ refuses, the type(self) twin resolves C.meth`, async () => {
			const refused = await probe(app("self.__class__", d), "cls.meth()");
			expect(refused.callees, label).toEqual([]);
			expect(refused.delta, label).toEqual(REFUSED);
			const twin = await probe(app("type(self)", d), "cls.meth()");
			expect(twin.callees, label).toEqual(["app.py:C.meth"]);
			expect(twin.delta, label).toEqual(RESOLVED);
		});
	}

	test("a grandchild that binds __class__ refuses too", async () => {
		const r = await probe(app("self.__class__", "    pass\n", "class E(D):\n    __class__ = 1\n"), "cls.meth()");
		expect(r.callees).toEqual([]);
		expect(r.delta).toEqual(REFUSED);
	});

	test("twins: a descendant without __class__, and an unrelated class that binds it, still resolve self.__class__", async () => {
		for (const [label, extra] of [
			["no binding", ""],
			["unrelated class", "class U:\n    __class__ = 1\n"],
		] as const) {
			const r = await probe(app("self.__class__", "    pass\n", extra), "cls.meth()");
			expect(r.callees, label).toEqual(["app.py:C.meth"]);
			expect(r.delta, label).toEqual(RESOLVED);
		}
	});
});

describe("GCLI-122 item 3 — a nonlocal-moved write is always a second binding, so the alias refuses by count", () => {
	const cls = "class C:\n    def m(self):\n        pass\n";
	const shapes: Record<string, string> = {
		"outer parameter, call in the outer function": `${cls}def g(f):\n    def h():\n        nonlocal f\n        f = C.m\n    h()\n    f()\n`,
		"outer assign, call in the outer function": `${cls}def g():\n    f = None\n    def h():\n        nonlocal f\n        f = C.m\n    h()\n    f()\n`,
		"outer assign, call in the inner function": `${cls}def g():\n    f = None\n    def h():\n        nonlocal f\n        f = C.m\n        f()\n    h()\n`,
		"two levels of nesting": `${cls}def g():\n    f = None\n    def h():\n        def i():\n            nonlocal f\n            f = C.m\n        i()\n    h()\n    f()\n`,
		"an outer for target": `${cls}def g():\n    for f in []:\n        pass\n    def h():\n        nonlocal f\n        f = C.m\n    h()\n    f()\n`,
	};
	for (const [label, source] of Object.entries(shapes)) {
		test(`${label}: f() has no edge to C.m`, async () => {
			const r = await analyze([py("app.py", source)]);
			const callees = r.sites.map((site) => r.symbols.find((s) => s.id === site.calleeId)?.qualname ?? null);
			expect(callees).not.toContain("C.m");
			expect(r.callBins.nameNotBound).toBe(1);
		});
	}

	test("control: a single unmoved binding still resolves", async () => {
		const r = await analyze([py("app.py", `${cls}def g():\n    f = C.m\n    f()\n`)]);
		expect(r.sites.map((site) => r.symbols.find((s) => s.id === site.calleeId)?.qualname)).toEqual(["C.m"]);
	});
});

describe("GCLI-122 round 1 — a descendant's whole MRO is read, and the descendant may live in another module", () => {
	const forms: Record<string, string> = {
		attribute: "    __class__ = 1\n",
		property: "    @property\n    def __class__(self):\n        return 1\n",
		method: "    def __class__(self):\n        pass\n",
	};
	const C =
		"class C:\n    def m(self):\n        cls = self.__class__\n        CALL\n    def meth(self):\n        pass\n";
	const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };

	for (const [label, mixin] of Object.entries(forms)) {
		test(`${label}: an in-repo mixin of a descendant that binds __class__ refuses`, async () => {
			const r = await probe(`${C}class M:\n${mixin}class D(C, M):\n    pass\n`, "cls.meth()");
			expect(r.callees, label).toEqual([]);
			expect(r.delta, label).toEqual(REFUSED);
		});
	}

	test("twin: a mixin without __class__ keeps the edge", async () => {
		const r = await probe(`${C}class M:\n    pass\nclass D(C, M):\n    pass\n`, "cls.meth()");
		expect(r.callees).toEqual(["app.py:C.meth"]);
		expect(r.delta).toEqual(RESOLVED);
	});

	test("a descendant in another module refuses through a from-import and through a module attribute base", async () => {
		const sub = "from app import C\nclass D(C):\n    __class__ = 1\n";
		const subAttr = "import app\nclass D(app.C):\n    __class__ = 1\n";
		for (const [label, other] of [
			["from-import base", sub],
			["module attribute base", subAttr],
		] as const) {
			const r = await probe(`${C}`, "cls.meth()", { "other.py": other });
			expect(r.callees, label).toEqual([]);
			expect(r.delta, label).toEqual(REFUSED);
		}
	});

	test("twin: a descendant in another module that does not bind __class__ keeps the edge", async () => {
		const r = await probe(`${C}`, "cls.meth()", { "other.py": "from app import C\nclass D(C):\n    pass\n" });
		expect(r.callees).toEqual(["app.py:C.meth"]);
		expect(r.delta).toEqual(RESOLVED);
	});

	test("item 3: a moved write after an outer binding of a DIFFERENT attribute refuses by count", async () => {
		const source =
			"class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\ndef g():\n    f = C.n\n    def h():\n        nonlocal f\n        f = C.m\n    h()\n    f()\n";
		const r = await analyze([py("app.py", source)]);
		const callees = r.sites.map((site) => r.symbols.find((s) => s.id === site.calleeId)?.qualname ?? null);
		expect(callees).not.toContain("C.m");
		expect(callees).not.toContain("C.n");
		expect(r.callBins.nameNotBound).toBe(1);
	});
});

describe("GCLI-122 round 1, DEC-303 (a68) — a descendant's unreadable or non-computing MRO refuses self.__class__", () => {
	const C =
		"class C:\n    def m(self):\n        cls = self.__class__\n        CALL\n    def meth(self):\n        pass\n";
	const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };

	test("an external non-builtin base of a descendant refuses (a name imported from an unindexed module, and mock.Mock)", async () => {
		const shapes: Record<string, string> = {
			"imported mixin": `from lib import Mixin\n${C}class D(C, Mixin):\n    pass\n`,
			"mock.Mock": `from unittest import mock\n${C}class D(C, mock.Mock):\n    pass\n`,
			"module attribute mixin": `import lib\n${C}class D(C, lib.Mixin):\n    pass\n`,
		};
		for (const [label, source] of Object.entries(shapes)) {
			const r = await probe(source, "cls.meth()");
			expect(r.callees, label).toEqual([]);
			expect(r.delta, label).toEqual(REFUSED);
		}
	});

	test("twin: an unshadowed builtin base of a descendant still resolves", async () => {
		for (const base of ["Exception", "dict", "object"]) {
			const r = await probe(`${C}class D(C, ${base}):\n    pass\n`, "cls.meth()");
			expect(r.callees, base).toEqual(["app.py:C.meth"]);
			expect(r.delta, base).toEqual(RESOLVED);
		}
	});

	test("a descendant whose MRO does not compute refuses", async () => {
		const r = await probe(`${C}class B(C):\n    pass\nclass D(C, B):\n    pass\n`, "cls.meth()");
		expect(r.callees).toEqual([]);
		expect(r.delta).toEqual(REFUSED);
	});

	test("type(self) is unaffected by the same descendants", async () => {
		const src = (alias: string) =>
			`from lib import Mixin\nclass C:\n    def m(self):\n        cls = ${alias}\n        CALL\n    def meth(self):\n        pass\nclass D(C, Mixin):\n    pass\n`;
		const r = await probe(src("type(self)"), "cls.meth()");
		expect(r.callees).toEqual(["app.py:C.meth"]);
		expect(r.delta).toEqual(RESOLVED);
	});
});

describe("GCLI-136 — an __all__ in a statement that may be skipped does not make the star's export set exact", () => {
	const tail = "def helper():\n    pass\nfor len in [1]:\n    pass\n";
	const all = "    __all__ = ['helper']\n";
	const run = (target: string) => probe("from s import *\ndef g(x):\n    CALL\n", "len(x)", { "s.py": target });
	const NOT_BUILTIN: Delta = { inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 };
	const BUILTIN: Delta = { inRepo: 0, external: 1, receiver: 0, nameNotBound: 0 };

	{
		const bodies: Record<string, string> = {
			for: `for _ in []:\n${all}`,
			while: `while C:\n${all}`,
			with: `with C:\n${all}`,
			"for else": `for _ in []:\n    pass\nelse:\n${all}`,
			"while else": `while C:\n    pass\nelse:\n${all}`,
			case: `match C:\n    case 1:\n    ${all}`,
			if: `if C:\n${all}`,
			"if else": `if C:\n    pass\nelse:\n${all}`,
			"try body with an except": `try:\n${all}except E:\n    pass\n`,
			"except arm": `try:\n    pass\nexcept E:\n${all}`,
			"chained inside a for body": "for _ in []:\n    x = __all__ = ['helper']\n",
		};
		for (const [label, head] of Object.entries(bodies)) {
			test(`${label}: the star is partial, so len(x) is not claimed as the builtin`, async () => {
				const r = await run(head + tail);
				expect(r.delta, label).toEqual(NOT_BUILTIN);
			});
		}
	}

	test("twins: an __all__ that always runs keeps the exact set, so len(x) is still the builtin", async () => {
		const always: Record<string, string> = {
			"module level": "__all__ = ['helper']\n",
			"try body with only a finally": `try:\n${all}finally:\n    pass\n`,
			"finally body": `try:\n    pass\nfinally:\n${all}`,
			"chained, __all__ inner": "x = __all__ = ['helper']\n",
			"chained, three targets": "a = b = __all__ = ['helper']\n",
		};
		for (const [label, head] of Object.entries(always)) {
			const r = await run(head + tail);
			expect(r.delta, label).toEqual(BUILTIN);
		}
	});
});

// GCLI-121 (DEC-303 (a70), arm A): a plain quoted annotation resolves exactly as its unquoted twin.
describe("GCLI-121 — a quoted annotation resolves as its unquoted twin", () => {
	const cls = "class C:\n    def meth(self):\n        pass\n";
	const run = (ann: string, prelude = cls) => probe(`${prelude}def g(x: ${ann}):\n    CALL\n`, "x.meth()");
	const EDGE = ["app.py:C.meth"];
	const NONE: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };

	const resolves: Record<string, string> = {
		name: '"C"',
		"single quotes": "'C'",
		"X | None": '"C | None"',
		"None | X": '"None | C"',
		"Optional[X]": '"Optional[C]"',
		"Union[X, None]": '"Union[C, None]"',
		"typing.Optional": '"typing.Optional[C]"',
		"inner quoted in Optional": 'Optional["C"]',
		"quoted in a pipe": '"C" | None',
		spaces: '" C | None "',
	};
	for (const [label, ann] of Object.entries(resolves)) {
		test(`${label}: ${ann} resolves x.meth()`, async () => {
			const r = await run(ann);
			expect(r.delta, label).toEqual(RESOLVED);
			expect(r.callees, label).toEqual(EDGE);
		});
	}

	test("a forward reference to a later class, in a function scope and at module scope", async () => {
		const later = 'def g(x: "C"):\n    CALL\n\nclass C:\n    def meth(self):\n        pass\n';
		const r = await probe(later, "x.meth()");
		expect(r.delta).toEqual(RESOLVED);
		const inner = await probe(
			'def outer():\n    def g(x: "C"):\n        CALL\n    class C:\n        def meth(self):\n            pass\n',
			"x.meth()",
		);
		expect(inner.delta).toEqual(RESOLVED);
	});

	test("imported, TYPE_CHECKING-imported, and a dotted name through a TYPE_CHECKING import", async () => {
		const others = { "m.py": cls };
		for (const [prelude, ann] of [
			["from m import C\n", '"C"'],
			["from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from m import C\n", '"C"'],
			["from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import m\n", '"m.C"'],
			["import m\n", '"m.C | None"'],
		] as const) {
			const r = await probe(`${prelude}def g(x: ${ann}):\n    CALL\n`, "x.meth()", others);
			expect(r.delta, prelude + ann).toEqual(RESOLVED);
			expect(r.callees, prelude + ann).toEqual(["m.py:C.meth"]);
		}
	});

	const refused: Record<string, string> = {
		"two classes": '"C | D"',
		"list[C]": '"list[C]"',
		garbage: '"C D"',
		empty: '""',
		"unclosed bracket": '"Optional[C"',
		"f-string": 'f"C"',
		"r-string": 'r"C"',
		"b-string": 'b"C"',
		concatenated: '"C" "D"',
		"triple-quoted": '"""C"""',
		escaped: '"C\\x41"',
		"Optional of two": '"Optional[C, None]"',
		"nested quote": "\"Optional['C']\"",
		"a call": '"C()"',
		"Union two classes": '"Union[C, D]"',
	};
	for (const [label, ann] of Object.entries(refused)) {
		test(`refused ${label}: ${ann} gives no edge`, async () => {
			const r = await run(ann, `${cls}class D:\n    def meth(self):\n        pass\n`);
			expect(r.delta, label).toEqual(NONE);
			expect(r.callees, label).toEqual([]);
		});
	}

	test("a quoted name bound twice, or conditionally, refuses", async () => {
		const twice = await run('"C"', `${cls}class C:\n    def meth(self):\n        pass\n`);
		expect(twice.delta).toEqual(NONE);
		const cond = await probe(
			'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from m import C\nelse:\n    C = object\ndef g(x: "C"):\n    CALL\n',
			"x.meth()",
			{ "m.py": cls },
		);
		expect(cond.delta).toEqual(NONE);
	});

	test("twins: the unquoted annotation of each shape resolves as before", async () => {
		for (const ann of ["C", "C | None", "None | C", "Optional[C]", "Union[C, None]"]) {
			const r = await run(ann, `from typing import Optional, Union\n${cls}`);
			expect(r.delta, ann).toEqual(RESOLVED);
		}
	});

	test("Q2 (self.attr.m()) and Q3 (return annotations) stay out: no edge", async () => {
		const q2 = await probe(
			`${cls}class H:\n    def __init__(self):\n        self.a: "C" = make()\n    def run(self):\n        CALL\n`,
			"self.a.meth()",
		);
		expect(q2.delta).toEqual(NONE);
		const q3 = await probe(`${cls}def make() -> "C":\n    pass\ndef g():\n    CALL\n`, "make().meth()");
		expect(q3.callees).not.toContain("app.py:C.meth");
		expect(q3.delta.receiver).toBe(1);
	});
});

// GCLI-112: a PEP 695 type parameter binds its name in the generic's own scope, so a read of it never reaches an
// enclosing binding of the same name.
describe("GCLI-112 — a PEP 695 type parameter shadows an enclosing binding", () => {
	const cls = "class C:\n    def run(self):\n        pass\nclass D:\n    def run(self):\n        pass\n";
	const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };
	/** The `.run` and `.save` callees only: `x = C()` in the setup is itself an edge. */
	const runs = (r: { callees: (string | null)[] }) =>
		r.callees.filter((c) => c?.endsWith(".run") || c?.endsWith(".save"));
	const lines = (body: string, indent: string) =>
		body
			.split("\n")
			.map((line) => (line === "" ? line : indent + line))
			.join("\n");
	// `x = C()` is bound in the enclosing function; the generic declares its own `x`.
	const inFunction = (generic: string, use = "CALL") =>
		`${cls}def outer():\n    x = C()\n${lines(generic.replace("CALL", use), "    ")}\n`;

	const shapes: Record<string, string> = {
		function: "def h[x]():\n    CALL\n",
		"function, bounded": "def h[x: C]():\n    CALL\n",
		"function, constrained": "def h[x: (C, D)]():\n    CALL\n",
		"function, TypeVarTuple": "def h[*x]():\n    CALL\n",
		"function, ParamSpec": "def h[**x]():\n    CALL\n",
		"function, second parameter": "def h[y, x]():\n    CALL\n",
		"function, a default (PEP 696, a parse error)": "def h[x = int]():\n    CALL\n",
		"a method of a generic class sees the class's parameter": "class K[x]:\n    def m(self):\n        CALL\n",
		"a method that is itself generic": "class K:\n    def m[x](self):\n        CALL\n",
		"a nested def inside a generic function": "def h[x]():\n    def inner():\n        CALL\n",
		"type alias": "type A[x] = CALL\n",
		"class body": "class K[x]:\n    CALL\n",
	};
	for (const [label, generic] of Object.entries(shapes)) {
		test(`${label}: x.run() is not claimed as C.run`, async () => {
			const r = await probe(inFunction(generic), "x.run()");
			expect(runs(r)).not.toContain("app.py:C.run");
			expect(r.delta, label).toEqual(REFUSED);
		});
	}

	test("positive twins: a name no type parameter declares still resolves", async () => {
		const twins: Record<string, string> = {
			function: "def h[y]():\n    CALL\n",
			"class body": "class K[y]:\n    CALL\n",
			"type alias": "type A[y] = CALL\n",
			"a method of a generic class": "class K[y]:\n    def m(self):\n        CALL\n",
			"no type parameters": "def h():\n    CALL\n",
		};
		for (const [label, generic] of Object.entries(twins)) {
			const r = await probe(inFunction(generic), "x.run()");
			expect(r.delta.inRepo, label).toBe(1);
			expect(runs(r), label).toEqual(["app.py:C.run"]);
		}
	});

	test("a generic's name does not shadow outside it", async () => {
		const r = await probe(`${cls}x = C()\ndef h[x]():\n    pass\nCALL\n`, "x.run()");
		expect(r.delta.inRepo).toBe(1);
		expect(runs(r)).toEqual(["app.py:C.run"]);
	});

	test("a default value is read in the enclosing scope, not the type-parameter scope", async () => {
		const r = await probe(`${cls}x = C()\ndef h[x](a=x.run()):\n    pass\nCALL\n`, "pass");
		expect(runs(r)).toEqual(["app.py:C.run"]);
	});

	test("an annotation of a type parameter does not resolve to a module class of the same name", async () => {
		const mod = (generic: string) => probe(`${cls}${generic}`, "p.run()");
		const shadowed = await mod("def g[C](p: C):\n    CALL\n");
		expect(runs(shadowed)).not.toContain("app.py:C.run");
		expect(shadowed.delta).toEqual(REFUSED);
		const twin = await mod("def g[T](p: C):\n    CALL\n");
		expect(runs(twin)).toEqual(["app.py:C.run"]);
	});

	test("a base named like a type parameter is not the module class", async () => {
		const generic = await probe(`${cls}class K[C](C):\n    def m(self):\n        CALL\n`, "self.run()");
		expect(runs(generic)).not.toContain("app.py:C.run");
		// The base is the type parameter, a name no class symbol stands behind: an external base, as for any single
		// `rebound` base, so the call is binned external rather than receiver (not an in-repo edge).
		expect(generic.delta).toEqual({ inRepo: 0, external: 1, receiver: 0, nameNotBound: 0 });
		const twin = await probe(`${cls}class K[T](C):\n    def m(self):\n        CALL\n`, "self.run()");
		expect(runs(twin)).toEqual(["app.py:C.run"]);
	});

	test("a list with a parse error refuses every identifier in it, bound names included", async () => {
		const r = await probe(inFunction("def h[x: C = int]():\n    CALL\n"), "C().run()");
		expect(runs(r)).not.toContain("app.py:C.run");
		const twin = await probe(inFunction("def h[x: C]():\n    CALL\n"), "C().run()");
		expect(runs(twin)).toEqual(["app.py:C.run"]);
	});

	// Opus round 1, B1: an annotation scope directly inside a class body still reads the class's names.
	test("a generic declared in a class body reads the class body's names, as before", async () => {
		const item = "class Item:\n    def save(self):\n        pass\n";
		const annotation = await probe(
			`${item}class Outer:\n    class Item:\n        def save(self):\n            pass\n    def get[T](self, item: Item):\n        CALL\n`,
			"item.save()",
		);
		expect(runs(annotation)).toEqual(["app.py:Outer.Item.save"]);
		const base = await probe(
			"class B:\n    def run(self):\n        pass\nclass Outer:\n    class B:\n        def run(self):\n            pass\n    class K[T](B):\n        def m(self):\n            CALL\n",
			"self.run()",
		);
		expect(runs(base)).toEqual(["app.py:Outer.B.run"]);
		const alias = await probe(
			`${item}class Outer:\n    class Item:\n        def save(self):\n            pass\n    type A[T] = CALL\n`,
			"Item().save()",
		);
		expect(runs(alias)).toEqual(["app.py:Outer.Item.save"]);
	});

	test("the body of a generic method still skips the class body", async () => {
		const r = await probe(
			"class Item:\n    def save(self):\n        pass\nclass Outer:\n    class Item:\n        def save(self):\n            pass\n    def get[T](self):\n        CALL\n",
			"Item().save()",
		);
		expect(runs(r)).toEqual(["app.py:Item.save"]);
	});

	test("a class's own type parameter is still seen through the class body by a generic method's annotation", async () => {
		const r = await probe(
			"class C:\n    def run(self):\n        pass\nclass K[C]:\n    def m[U](self, p: C):\n        CALL\n",
			"p.run()",
		);
		expect(runs(r)).toEqual([]);
	});

	// DEC-303 (a71), round 2: Rule 36(ii) -- a bare name called in its own class body runs as a plain function, so the
	// def of that name yields no receiver. A call in a generic's annotation, return type, base, keyword argument or
	// alias value is in the class body for that rule even though it walks in the type-parameter scope.
	describe("a bare call in a generic's expression inside a class body is a class-body use (Rule 36(ii))", () => {
		const helpers = (r: { callees: (string | null)[] }) => r.callees.filter((c) => c?.endsWith(".helper"));
		const bare = (member: string) =>
			probe(
				`class Outer:\n    def helper(self):\n        pass\n    def run(self):\n        CALL\n${member}`,
				"self.helper()",
			);
		const forms: Record<string, string> = {
			"alias value": "    type A[T] = run()\n",
			"parameter annotation": "    def g[T](self, x: run()):\n        pass\n",
			"return type": "    def g[T](self) -> run():\n        pass\n",
			"class base": "    class K[T](run()):\n        pass\n",
			"class keyword argument": "    class K[T](kw=run()):\n        pass\n",
			"non-generic alias (the twin)": "    type A = run()\n",
			"non-generic annotation (the twin)": "    def g(self, x: run()):\n        pass\n",
			"a bare call in the body (the twin)": "    run()\n",
		};
		for (const [label, member] of Object.entries(forms)) {
			test(`${label}: self.helper() inside run gets no receiver edge`, async () => {
				const r = await bare(member);
				expect(r.delta, label).toEqual(REFUSED);
				expect(helpers(r), label).toEqual([]);
			});
		}

		test("a generic whose expressions call nothing keeps the edge", async () => {
			const r = await bare("    type A[T] = int\n    def g[T](self, x: int) -> int:\n        pass\n");
			expect(r.delta.inRepo).toBe(1);
			expect(helpers(r)).toEqual(["app.py:Outer.helper"]);
		});

		test("a bare call in a generic method's own body is not a class-body use", async () => {
			const r = await bare("    def g[T](self):\n        run()\n");
			expect(helpers(r)).toEqual(["app.py:Outer.helper"]);
		});
	});

	// DEC-303 (a72), round 3: a name the class body binds (here by a later import) is read from the class or the
	// globals, never from an enclosing function, also from a generic's lazy alias value. Two bindings of `x` keep
	// Rule 6d from resolving it first, so the call reaches R4 and its `enumerableBindings` class-body guard.
	test("a lazy alias value in a class body that later imports its receiver name refuses", async () => {
		const others = { "m.py": "class X:\n    pass\n" };
		const app = (bindings: string) =>
			`${cls}def outer():\n${bindings}    class Outer:\n        type A[T] = CALL\n        from m import X as x\n`;
		const imported = await probe(app("    x = C()\n    x = C()\n"), "x.run()", others);
		expect(imported.delta).toEqual(REFUSED);
		expect(runs(imported)).not.toContain("app.py:C.run");
	});

	test("twin: the same alias value without the class-body import resolves through the enclosing function", async () => {
		const twin = await probe(
			`${cls}def outer():\n    x = C()\n    x = C()\n    class Outer:\n        type A[T] = CALL\n`,
			"x.run()",
		);
		expect(twin.delta.inRepo).toBe(1);
		expect(runs(twin)).toEqual(["app.py:C.run"]);
	});
});

// GCLI-144 (DEC-303 (a73)): a class-body read of a name the class body binds ANYWHERE is never resolved through an
// enclosing function's binding. A class body reads such a name from the class, then the globals, then the builtins
// (LOAD_NAME); `from m import X as x` after the read binds it in the class, so the read cannot reach `outer`'s `x`.
describe("GCLI-144 — a class-body read of a name the class body binds skips enclosing functions", () => {
	const cls = "class C:\n    def run(self):\n        pass\n";
	const others = { "m.py": "class X:\n    def run(self):\n        pass\n" };
	const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };
	const runs = (r: { callees: (string | null)[] }) => r.callees.filter((c) => c?.endsWith(".run"));
	const reads: Record<string, string> = {
		"eager read": "        y = CALL\n",
		"lazy alias, type A": "        type A = CALL\n",
		"lazy generic alias, type A[T]": "        type A[T] = CALL\n",
	};
	const app = (read: string, bindings: string, later = "        from m import X as x\n") =>
		`${cls}def outer():\n${bindings}    class Outer:\n${read}${later}`;
	const ONE = "    x = C()\n";
	const TWO = "    x = C()\n    x = C()\n";

	for (const [label, read] of Object.entries(reads)) {
		test(`${label}, one binding of x in the enclosing function: no C.run edge`, async () => {
			const r = await probe(app(read, ONE), "x.run()", others);
			expect(r.delta, label).toEqual(REFUSED);
			expect(runs(r), label).toEqual([]);
		});
		test(`${label}, two bindings (the twin): still refused`, async () => {
			const r = await probe(app(read, TWO), "x.run()", others);
			expect(r.delta, label).toEqual(REFUSED);
			expect(runs(r), label).toEqual([]);
		});
		test(`${label}, no class-body binding (the twin): resolves through the enclosing function`, async () => {
			const r = await probe(app(read, ONE, ""), "x.run()", others);
			expect(r.delta.inRepo, label).toBe(1);
			expect(runs(r), label).toEqual(["app.py:C.run"]);
		});
	}

	test("a class-body binding BEFORE the read is the class's own and is not an enclosing read", async () => {
		const r = await probe(
			`${cls}def outer():\n    x = C()\n    class Outer:\n        from m import X as x\n        y = CALL\n`,
			"x.run()",
			others,
		);
		expect(runs(r)).toEqual(["m.py:X.run"]);
	});

	test("a module-level binding with no class-body binding is still read", async () => {
		const r = await probe(`${cls}x = C()\ndef outer():\n    class Outer:\n        y = CALL\n`, "x.run()", others);
		expect(runs(r)).toEqual(["app.py:C.run"]);
	});

	// DEC-303 (a73) item 2, "only REMOVE edges": a result found in an enclosing function is refused, never replaced by
	// the globals' binding, so no case creates an edge or an external bin. Each case below is measured against dev.
	describe("the outcome only removes edges", () => {
		const mod = "class X:\n    def run(self):\n        pass\n";
		const classes = `${cls}class D:\n    def run(self):\n        pass\n`;
		const later = "        from m import X as x\n";
		const NOT_BOUND: Delta = { inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 };

		test("a: module x = D() and outer x = C() give no edge, NOT D.run (dev: C.run)", async () => {
			const r = await probe(
				`${classes}x = D()\ndef outer():\n    x = C()\n    class Outer:\n        y = CALL\n${later}`,
				"x.run()",
				{ "m.py": mod },
			);
			expect(r.delta).toEqual(REFUSED);
			expect(runs(r)).toEqual([]);
		});

		test("b: no module x, outer x = C() gives no edge (dev: C.run)", async () => {
			const r = await probe(
				`${classes}def outer():\n    x = C()\n    class Outer:\n        y = CALL\n${later}`,
				"x.run()",
				{
					"m.py": mod,
				},
			);
			expect(r.delta).toEqual(REFUSED);
			expect(runs(r)).toEqual([]);
		});

		test("c: module x = D() and no enclosing function binding is unchanged (D.run)", async () => {
			const r = await probe(
				`${classes}x = D()\ndef outer():\n    class Outer:\n        y = CALL\n${later}`,
				"x.run()",
				{
					"m.py": mod,
				},
			);
			expect(r.delta.inRepo).toBe(1);
			expect(runs(r)).toEqual(["app.py:D.run"]);
		});

		test("d: an outer def len is refused, NOT the builtin (dev: outer.len)", async () => {
			const r = await probe(
				"def outer():\n    def len(o):\n        pass\n    class Outer:\n        y = CALL\n        from m import len\n",
				"len([])",
				{ "m.py": "def len(o):\n    pass\n" },
			);
			expect(r.delta).toEqual(NOT_BOUND);
		});

		test("e and f: a module def and an outer def of the name give no edge, NOT the module def (dev: the outer def)", async () => {
			for (const name of ["len", "f"]) {
				const r = await probe(
					`def ${name}(o=None):\n    pass\ndef outer():\n    def ${name}(o=None):\n        pass\n    class Outer:\n        y = CALL\n        from m import X as ${name}\n`,
					`${name}()`,
					{ "m.py": mod },
				);
				expect(r.delta, name).toEqual(NOT_BOUND);
			}
		});

		test("g: a method reads the name, methods skip the class body, unchanged (C.run)", async () => {
			const r = await probe(
				`${classes}def outer():\n    x = C()\n    class Outer:\n${later}        def meth(self):\n            CALL\n`,
				"x.run()",
				{ "m.py": mod },
			);
			expect(r.delta.inRepo).toBe(1);
			expect(runs(r)).toEqual(["app.py:C.run"]);
		});

		test("h: a callable instance read before a class-body import gets no __call__ edge (dev: C.__call__)", async () => {
			const r = await probe(
				`class C:\n    def __call__(self):\n        pass\ndef outer():\n    x = C()\n    class Outer:\n        y = CALL\n${later}`,
				"x()",
				{ "m.py": mod },
			);
			expect(r.callees).not.toContain("app.py:C.__call__");
			expect(r.delta.inRepo).toBe(0);
		});

		test("i: an external import receiver read before a class-body import is not claimed external (dev: external)", async () => {
			const r = await probe(
				`def outer():\n    import os as x\n    class Outer:\n        y = CALL\n${later}`,
				"x.getcwd()",
				{ "m.py": mod },
			);
			expect(r.delta).toEqual(REFUSED);
		});

		test("k: a decorated class whose decorator name is read before a class-body import gets no method edge (dev: In.m)", async () => {
			const r = await probe(
				"def outer():\n    from dataclasses import dataclass\n    class Outer:\n        @dataclass\n        class In:\n            def m(self):\n                pass\n        z = In()\n        CALL\n        from m import X as dataclass\n",
				"z.m()",
				{ "m.py": mod },
			);
			expect(r.callees).not.toContain("app.py:outer.Outer.In.m");
			expect(r.delta.inRepo).toBe(0);
		});
	});
});
