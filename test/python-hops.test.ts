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
		// GCLI-144 (DEC-303 (a74) item 2): a lazy alias value reads the class's final bindings, and here nothing was
		// dropped (a class def, no later import), so the correct edge stays.
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

		// A lazy alias value is evaluated after the class body has run, so it sees the class's FINAL binding (here the
		// later import), never a module-level `x` (opum-doc, DEC-303 (a73) runtime basis). The eager read reads the globals.
		describe("a lazy alias value in a class body", () => {
			const moduleApp = (read: string, tail = later) => `${classes}x = C()\nclass Outer:\n${read}${tail}`;
			const eager = "        y = CALL\n";
			const lazy: Record<string, string> = {
				"type A": "        type A = CALL\n",
				"type A[T]": "        type A[T] = CALL\n",
			};

			test("module x = C(), no function: the eager read still resolves to C.run (correct at runtime, as dev)", async () => {
				const r = await probe(moduleApp(eager), "x.run()", { "m.py": mod });
				expect(r.delta.inRepo).toBe(1);
				expect(runs(r)).toEqual(["app.py:C.run"]);
			});

			for (const [label, read] of Object.entries(lazy)) {
				test(`${label}: an early import and a later one of different classes: refused (dev: the early import's edge)`, async () => {
					const r = await probe(`${classes}class Outer:\n${later}${read}        from n import Y as x\n`, "x.run()", {
						"m.py": mod,
						"n.py": "class Y:\n    def run(self):\n        pass\n",
					});
					expect(r.delta, label).toEqual(REFUSED);
					expect(runs(r), label).toEqual([]);
				});
			}

			for (const [label, read] of Object.entries(lazy)) {
				test(`module x = C(), no function: ${label} is refused, NOT C.run (dev: C.run)`, async () => {
					const r = await probe(moduleApp(read), "x.run()", { "m.py": mod });
					expect(r.delta, label).toEqual(REFUSED);
					expect(runs(r), label).toEqual([]);
				});
				test(`${label}: a class-body import BEFORE the alias keeps its exact edge (nothing was dropped), m.X.run`, async () => {
					const r = await probe(moduleApp(read, "").replace("class Outer:\n", `class Outer:\n${later}`), "x.run()", {
						"m.py": mod,
					});
					expect(runs(r), label).toEqual(["m.py:X.run"]);
					expect(r.delta.inRepo, label).toBe(1);
				});
				test(`${label}: no class-body binding of x resolves through the module (the twin)`, async () => {
					const r = await probe(moduleApp(read, ""), "x.run()", { "m.py": mod });
					expect(r.delta.inRepo, label).toBe(1);
					expect(runs(r), label).toEqual(["app.py:C.run"]);
				});
			}
		});

		// Opus round 1: a NON-generic alias value had no scope of its own on dev, so a comprehension target or a walrus in it
		// was recorded on the class body. The lazy scope made only to mark the read must record them there too, or the
		// class loses a binding and a read, or a method call through it, resolves where dev refused.
		describe("bindings made inside a non-generic alias value stay on the class body, as on dev", () => {
			const comp = "    type A = [x for x in ()]\n";
			const walrus = "    type A = (x := 1)\n";

			test("1: module x = C(), a comprehension target x in the alias: y = x.run() is refused (dev: receiver)", async () => {
				for (const [label, alias] of [
					["comprehension", comp],
					["walrus", walrus],
				] as const) {
					const r = await probe(`${classes}x = C()\nclass Outer:\n${alias}    y = CALL\n`, "x.run()");
					expect(r.delta, label).toEqual(REFUSED);
					expect(runs(r), label).toEqual([]);
				}
			});

			test("2: the same with x = C() inside def outer()", async () => {
				for (const [label, alias] of [
					["comprehension", comp],
					["walrus", walrus],
				] as const) {
					const r = await probe(
						`${classes}def outer():\n    x = C()\n    class Outer:\n${alias.replace("    type", "        type")}        y = CALL\n`,
						"x.run()",
					);
					expect(r.delta, label).toEqual(REFUSED);
					expect(runs(r), label).toEqual([]);
				}
			});

			test("3: a method's self.helper() is refused when the alias binds the name helper on the class (dev: receiver)", async () => {
				for (const [label, alias] of [
					["comprehension", "    type A = [helper for helper in ()]\n"],
					["walrus", "    type A = (helper := 1)\n"],
				] as const) {
					const r = await probe(
						`class Outer:\n    def helper(self):\n        pass\n    def run(self):\n        CALL\n${alias}`,
						"self.helper()",
					);
					expect(r.delta, label).toEqual(REFUSED);
					expect(r.callees, label).toEqual([]);
				}
			});

			test("twin: an alias that binds an unrelated name leaves self.helper() resolving", async () => {
				const r = await probe(
					"class Outer:\n    def helper(self):\n        pass\n    def run(self):\n        CALL\n    type A = [n for n in ()]\n",
					"self.helper()",
				);
				expect(r.delta.inRepo).toBe(1);
				expect(r.callees).toEqual(["app.py:Outer.helper"]);
			});
		});
	});
});

// GCLI-147 (DEC-303 (a75) item 2) pinned the lookup's behaviour when Rule 38 dropped EVERY class binding of a lazy
// read and nothing is bound further out. GCLI-146 (DEC-303 (a76)) folds N1a and N1b in: that read is refused (a
// flagged empty result, `lazyEmpty` in `lookupBindings`), no longer the null that claimed a builtin or a star name.
// The expectations below were "unchanged from dev" under GCLI-147 and are REFUSED now.
describe("GCLI-147 — the lazy-read condition GCLI-144 left untested", () => {
	const mod = (name: string) => `def ${name}(o=None):\n    pass\n`;
	const NOT_BOUND: Delta = { inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 };

	test("N1a: a lazy alias reading len, the class importing len later, is refused, not claimed as the builtin (dev: external 1)", async () => {
		const r = await probe("class Outer:\n    type A = CALL\n    from m import len\n", "len([])", {
			"m.py": mod("len"),
		});
		expect(r.delta).toEqual(NOT_BOUND);
		expect(r.callees).toEqual([]);
	});

	test("N1b: a lazy alias reading a star-supplied f, the class importing f later, is refused (dev: the edge to s.py:f)", async () => {
		const r = await probe("from s import *\nclass Outer:\n    type A = CALL\n    from m import f\n", "f()", {
			"s.py": mod("f"),
			"m.py": mod("f"),
		});
		expect(r.delta).toEqual(NOT_BOUND);
		expect(r.callees).toEqual([]);
	});

	test("N2: a decorator read of a name the class imports later gets no edge to the enclosing function's def", async () => {
		const r = await probe(
			"def outer():\n    def staticmethod(f):\n        return f\n    class Outer:\n        @staticmethod\n        def m(self):\n            self.n()\n        def n(self):\n            pass\n        from m import X as staticmethod\n",
			"pass",
			{ "m.py": "class X:\n    pass\n" },
		);
		// Python reads the builtin staticmethod; origin/dev before GCLI-144 had an edge to outer.staticmethod.
		expect(r.callees).not.toContain("app.py:outer.staticmethod");
		expect(r.callees).toContain("app.py:outer.Outer.n");
	});
});

// GCLI-146 (DEC-303 (a76)): a LAZY class-body read (an alias value, or an alias type parameter's bound or constraint) of a
// name the class body binds ANYWHERE never resolves through an enclosing scope, a star import or a builtin; it REFUSES
// and does not resolve to the class binding (that would create edges). The bound forms were read eagerly on dev.
// A PEP 696 default `[T = x.run()]` is walked too (this grammar makes an ERROR node of `T` only), but it is refused by
// the SUPERSET rule, not the lazy rule: `typeParameterNames` counts every identifier of a type-parameter list that holds a
// parse error as a type-parameter name, so a call in a class-body alias default refuses with or without a later import,
// and loses its dev edge even when that edge was correct. Accepted over-refusal (removal-only); a grammar that parses
// defaults would restore the edges (see the guard fixture below).
describe("GCLI-146 — a lazy class-body read of a name the class binds refuses", () => {
	const cls = "class C:\n    def run(self):\n        pass\n";
	const others = { "m.py": "class X:\n    def run(self):\n        pass\n" };
	const later = "    from m import X as x\n";
	const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };

	/** Delta of `x.run()` against `int` in the same position (`pass` is no expression in a bound). */
	async function bound(app: string) {
		const run = async (expr: string, extra: Record<string, string> = others) => {
			const r = await analyze([
				...Object.entries(extra).map(([path, source]) => py(path, source)),
				py("app.py", app.replace("CALL", expr)),
			]);
			return r;
		};
		const withCall = await run("x.run()");
		const without = await run("int");
		const callees = withCall.sites
			.filter((s) => s.file === "app.py")
			.map((s) => withCall.symbols.find((x) => x.id === s.calleeId)?.qualname)
			.filter((q) => q?.endsWith(".run"));
		return {
			delta: {
				inRepo: withCall.callBins.resolvedInRepo - without.callBins.resolvedInRepo,
				external: withCall.callBins.resolvedExternal - without.callBins.resolvedExternal,
				receiver: withCall.callBins.receiverNeedsInference - without.callBins.receiverNeedsInference,
				nameNotBound: withCall.callBins.nameNotBound - without.callBins.nameNotBound,
			} as Delta,
			callees,
		};
	}

	const forms: Record<string, string> = {
		bound: "    type A[T: CALL] = int\n",
		constraint: "    type A[T: (CALL, int)] = int\n",
	};

	for (const [label, alias] of Object.entries(forms)) {
		test(`${label}, module x = C(), a later class-body import of x: refused (dev: C.run)`, async () => {
			const r = await bound(`${cls}x = C()\nclass Outer:\n${alias}${later}`);
			expect(r.delta, label).toEqual(REFUSED);
			expect(r.callees, label).toEqual([]);
		});
		test(`${label}, x = C() in an enclosing function: refused (dev: C.run)`, async () => {
			const r = await bound(
				`${cls}def outer():\n    x = C()\n    class Outer:\n${alias.replace(/^/gm, "    ")}${later.replace(/^/gm, "    ")}`,
			);
			expect(r.delta, label).toEqual(REFUSED);
			expect(r.callees, label).toEqual([]);
		});
		test(`${label}, no class-body binding of x (the twin): resolves through the module`, async () => {
			const r = await bound(`${cls}x = C()\nclass Outer:\n${alias}`);
			expect(r.delta.inRepo, label).toBe(1);
			expect(r.callees, label).toEqual(["C.run"]);
		});
		test(`${label}, a class-body import BEFORE the alias keeps its exact edge (nothing dropped), m.X.run`, async () => {
			const r = await bound(`${cls}x = C()\nclass Outer:\n${later}${alias}`);
			expect(r.callees, label).toEqual(["X.run"]);
		});
	}

	test("a bound of a def or a class is not walked: no edge either way, unchanged (GCLI-145)", async () => {
		for (const member of ["    def f[T: CALL](self):\n        pass\n", "    class K[T: CALL]:\n        pass\n"]) {
			const r = await bound(`${cls}x = C()\nclass Outer:\n${member}${later}`);
			expect(r.callees, member).toEqual([]);
		}
	});

	test("a module-level alias bound is outside a class body and keeps its edge (module x = C())", async () => {
		const r = await bound(`${cls}x = C()\ntype A[T: CALL] = int\n`);
		expect(r.callees).toEqual(["C.run"]);
	});

	// Guard for the PEP 696 default (opum-doc, DEC-303 (a76) item 2), measured: this grammar does NOT drop the call. For
	// `type A[T = x.run()] = int` the parser makes an ERROR node of `T` only, and `x.run()` is a normal `call` under a
	// sibling `type` node of the `type_parameter`, so it is walked and recorded as a site (origin/dev: an eager read, the
	// edge C.run). It is refused by the SUPERSET rule (every identifier under a parse error in the list counts as a
	// type-parameter name), with or without the later import, not by the lazy rule: accepted over-refusal. If a grammar
	// upgrade changes how a default parses, a red here goes to opum-doc and is not "fixed" by resolving the default.
	test("guard: a PEP 696 default type A[T = x.run()] is refused by the superset rule, no C.run (dev: C.run), also without a later import", async () => {
		const r = await bound(`${cls}x = C()\nclass Outer:\n    type A[T = CALL] = int\n${later}`);
		expect(r.delta).toEqual(REFUSED);
		expect(r.callees).toEqual([]);
	});

	// Binders inside a generic alias's bound, constraint or default (a comprehension target) stay on the class body,
	// as on dev, where that side was walked in the class scope: moving them to the type-parameter scope would let a
	// class read or a method call resolve where dev refused or claimed nothing (Opus round 1, A, B and C).
	describe("binders inside a generic alias's bound stay on the class body, as on dev", () => {
		const observe = async (source: string) => {
			const r = await analyze([py("m.py", "def len(o=None):\n    pass\n"), py("app.py", source)]);
			const edges = r.sites
				.filter((site) => site.file === "app.py")
				.map((site) => r.symbols.find((x) => x.id === site.calleeId)?.qualname)
				.filter((q): q is string => q !== undefined);
			const b = r.callBins;
			return {
				edges,
				bins: {
					inRepo: b.resolvedInRepo,
					external: b.resolvedExternal,
					receiver: b.receiverNeedsInference,
					nameNotBound: b.nameNotBound,
				},
			};
		};
		const comps: Record<string, string> = {
			"list in a bound": "T: [NAME for NAME in ()]",
			"list in a constraint": "T: ([NAME for NAME in ()], int)",
			"set in a bound": "T: {NAME for NAME in ()}",
			"dict in a bound": "T: {NAME: 1 for NAME in ()}",
			"generator in a bound": "T: (NAME for NAME in ())",
		};

		for (const [label, form] of Object.entries(comps)) {
			test(`C, ${label}: a class read of g is not resolved to the module g (dev: no edge)`, async () => {
				const r = await observe(
					`def g():\n    pass\nclass Outer:\n    type A[${form.replaceAll("NAME", "g")}] = int\n    y = g()\n`,
				);
				expect(r.edges, label).toEqual([]);
				expect(r.bins.nameNotBound, label).toBe(1);
			});
			test(`B, ${label}: self.helper() is not resolved when the bound binds helper (dev: receiver)`, async () => {
				const r = await observe(
					`class Outer:\n    def helper(self):\n        pass\n    def run(self):\n        self.helper()\n    type A[${form.replaceAll("NAME", "helper")}] = int\n`,
				);
				expect(r.edges, label).toEqual([]);
				expect(r.bins.receiver, label).toBe(1);
			});
		}

		test("A: a bound that binds len leaves a class read of len([]) unclaimed, not the builtin (dev: nameNotBound)", async () => {
			const r = await observe("class Outer:\n    type A[T: [len for len in ()]] = int\n    y = len([])\n");
			expect(r.bins).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 });
		});

		test("a default is unchanged from dev (the edge to g), a binder in a default is not moved either", async () => {
			const r = await observe("def g():\n    pass\nclass Outer:\n    type A[T = [g for g in ()]] = int\n    y = g()\n");
			expect(r.edges).toEqual(["g"]);
		});

		test("twin: a bound that binds an unrelated name leaves the class read of g resolving", async () => {
			const r = await observe("def g():\n    pass\nclass Outer:\n    type A[T: [n for n in ()]] = int\n    y = g()\n");
			expect(r.edges).toEqual(["g"]);
		});

		test("a def's alias binder stays on the def, as on dev (g() is refused)", async () => {
			const r = await observe("def g():\n    pass\ndef f():\n    type A[T: [g for g in ()]] = int\n    g()\n");
			expect(r.edges).toEqual([]);
			expect(r.bins.nameNotBound).toBe(1);
		});

		test("a module-level alias is outside a class body: its bound is read in the enclosing scope, unchanged from dev", async () => {
			// Pre-existing and not GCLI-146's rule (dev resolves the module T although the bound's T is the type parameter).
			// It pins that only a CLASS-BODY alias gets the lazy left-side walk.
			const r = await observe("def T():\n    pass\ntype A[T: T()] = int\n");
			expect(r.edges).toEqual(["T"]);
		});

		test("the eager twin keeps the builtin claim: y = len([]) then a later import of len is external, as on dev", async () => {
			const r = await observe("class Outer:\n    y = len([])\n    from m import len\n");
			expect(r.bins).toEqual({ inRepo: 0, external: 1, receiver: 0, nameNotBound: 0 });
		});
	});

	// Opus round 2 (N2, measured): the bound of a class-body alias now sees the alias's own type parameter names, so a
	// name that is the alias's type parameter is refused where dev resolved a module def or claimed a builtin (removals;
	// accepted by DEC-303 (a77) item 2, closer to Python).
	// Class-body alias defaults, measured: every call in a PEP 696 default refuses, with or without a later binding.
	// Superset rule; accepted by DEC-303 (a77); a grammar fix for default parsing would restore the edges.
	describe("a class-body alias default refuses every call in it (measured over-refusal)", () => {
		test("T = x.run() with x = C() and NO later import: refused (dev: C.run)", async () => {
			const r = await bound(`${cls}x = C()\nclass Outer:\n    type A[T = CALL] = int\n`);
			// Superset rule; accepted by DEC-303 (a77); a grammar fix for default parsing would restore the edge.
			expect(r.delta).toEqual(REFUSED);
			expect(r.callees).toEqual([]);
		});
		test("T = f() with a module def f and NO later import: refused (dev: the edge to f)", async () => {
			const r = await analyze([py("app.py", "def f():\n    pass\nclass Outer:\n    type A[T = f()] = int\n")]);
			// Superset rule; accepted by DEC-303 (a77); a grammar fix for default parsing would restore the edge.
			const names = r.sites
				.map((site) => r.symbols.find((x) => x.id === site.calleeId)?.qualname)
				.filter((q) => q !== undefined);
			expect(names).toEqual([]);
			expect(r.callBins.nameNotBound).toBe(1);
		});
		test("a default outside a class body is unchanged from dev (module-level T = f(): the edge to f)", async () => {
			const r = await analyze([py("app.py", "def f():\n    pass\ntype A[T = f()] = int\n")]);
			const names = r.sites
				.map((site) => r.symbols.find((x) => x.id === site.calleeId)?.qualname)
				.filter((q) => q !== undefined);
			expect(names).toEqual(["f"]);
		});
	});

	describe("a bound sees the alias's own type parameters (measured removals)", () => {
		const observe = async (source: string) => {
			const r = await analyze([py("app.py", source)]);
			const edges = r.sites
				.filter((site) => site.file === "app.py")
				.map((site) => r.symbols.find((x) => x.id === site.calleeId)?.qualname)
				.filter((q): q is string => q !== undefined);
			const b = r.callBins;
			return {
				edges,
				bins: {
					inRepo: b.resolvedInRepo,
					external: b.resolvedExternal,
					receiver: b.receiverNeedsInference,
					nameNotBound: b.nameNotBound,
				},
			};
		};
		const NOT_BOUND = { inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 };

		test("type A[T: T()] with a module def T: refused (dev: the edge to T)", async () => {
			const r = await observe("def T():\n    pass\nclass Outer:\n    type A[T: T()] = int\n");
			expect(r.edges).toEqual([]);
			expect(r.bins).toEqual(NOT_BOUND);
		});
		test("type A[U, T: U()] with a module def U: refused (dev: the edge to U)", async () => {
			const r = await observe("def U():\n    pass\nclass Outer:\n    type A[U, T: U()] = int\n");
			expect(r.edges).toEqual([]);
			expect(r.bins).toEqual(NOT_BOUND);
		});
		test("type A[len, T: len([])]: refused, no builtin claim (dev: external 1)", async () => {
			const r = await observe("class Outer:\n    type A[len, T: len([])] = int\n");
			expect(r.bins).toEqual(NOT_BOUND);
		});
		test("a self parameter of a method read in a nested class's bound is unchanged from dev (the edge to Outer.helper)", async () => {
			const r = await observe(
				"class Outer:\n    def helper(self):\n        pass\n    def m(self):\n        class Inner:\n            type A[T: self.helper()] = int\n",
			);
			expect(r.edges).toEqual(["Outer.helper"]);
		});
		test("Rule 36(ii): a bare call in a bound is a class-body use, so helper() gives no receiver to its def (n is not reached)", async () => {
			const r = await observe(
				"class Outer:\n    def helper(self):\n        self.n()\n    def n(self):\n        pass\n    type A[T: helper()] = int\n",
			);
			// dev and head: the bare call marks helper as a plain function, so self.n() gets no edge; dropping the lazy
			// scope's typeParams mark would add the edge to Outer.n.
			expect(r.edges).toEqual(["Outer.helper"]);
		});
	});
});

// GCLI-140 (DEC-303 (a25)): an attribute write is a binding of that attribute (the (a22) item 2 enumeration),
// so a call that would resolve to the def refuses. Shapes: self.m and cls.m in a method, Cls.m anywhere in the
// module, mod.f in the importer and in the defining module, self.__class__/type(self), x.m on a local bound by a
// construction, and setattr with a literal name. Writes from outside the analysed modules and a non-literal
// setattr name stay the accepted blind spot.
describe("GCLI-140 — an attribute write is a binding of that attribute", () => {
	const cls = "class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n";
	const other = "def other():\n    pass\n";
	const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };
	const NOTHING = { inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 };
	const ms = (r: { callees: (string | null)[] }) => r.callees.filter((c) => c?.endsWith(".m"));

	test("self.m = other in a method: self.m() and a subclass's self.m() refuse; the twin resolves", async () => {
		const writes = `${cls}${other}class D(C):\n    def go(self):\n        self.m = other\n    def use(self):\n        CALL\n`;
		const refused = await probe(writes, "self.m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
		const twin = await probe(
			`${cls}${other}class D(C):\n    def go(self):\n        pass\n    def use(self):\n        CALL\n`,
			"self.m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
		expect(twin.delta).toEqual(RESOLVED);
	});

	test("cls.m = other in a classmethod: cls.m() refuses; the twin resolves", async () => {
		const writes = `${cls}${other}class D(C):\n    @classmethod\n    def go(cls):\n        cls.m = other\n    @classmethod\n    def use(cls):\n        CALL\n`;
		const refused = await probe(writes, "cls.m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
		const twin = await probe(
			`${cls}${other}class D(C):\n    @classmethod\n    def go(cls):\n        pass\n    @classmethod\n    def use(cls):\n        CALL\n`,
			"cls.m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("D.m = other at module level: D.m(), an instance x.m() and a write from another class body refuse; twins resolve", async () => {
		const writes = `${cls}${other}class D(C):\n    pass\nD.m = other\nx = D()\nCALL\n`;
		const direct = await probe(writes, "D.m()");
		expect(ms(direct)).toEqual([]);
		expect(direct.delta).toEqual(REFUSED);
		const instance = await probe(writes, "x.m()");
		expect(ms(instance)).toEqual([]);
		expect(instance.delta).toEqual(REFUSED);
		const twin = await probe(`${cls}${other}class D(C):\n    pass\nCALL\n`, "D.m()");
		expect(ms(twin)).toEqual(["app.py:C.m"]);
		expect(twin.delta).toEqual(RESOLVED);
		const fromClassBody = `${cls}${other}class D(C):\n    pass\nclass E:\n    D.m = other\nCALL\n`;
		const body = await probe(fromClassBody, "D.m()");
		expect(ms(body)).toEqual([]);
		expect(body.delta).toEqual(REFUSED);
	});

	test("mod.f = other in an importer: mod.f() refuses; the twin resolves", async () => {
		const others = { "m.py": m };
		const refused = await probe("import m\nm.f = other\ndef other():\n    pass\nCALL\n", "m.f()", others);
		expect(refused.callees.filter((c) => c?.endsWith(":f"))).toEqual([]);
		expect(refused.delta).toEqual(NOTHING);
		const twin = await probe("import m\nCALL\n", "m.f()", others);
		expect(twin.callees).toContain("m.py:f");
	});

	test("mod.f = other inside the defining module: an importer's mod.f() refuses; the twin resolves", async () => {
		const withWrite = `import m\nm.f = other\ndef other():\n    pass\n${m}`;
		const refused = await probe("import m\nCALL\n", "m.f()", { "m.py": withWrite });
		expect(refused.callees.filter((c) => c?.endsWith(":f"))).toEqual([]);
		expect(refused.delta).toEqual(NOTHING);
		const twin = await probe("import m\nCALL\n", "m.f()", { "m.py": m });
		expect(twin.callees).toContain("m.py:f");
	});

	test("a write to the defining module behind a re-export hop refuses the hop's mod.f(); the twin resolves", async () => {
		const others = { "m.py": "from n import f\n", "n.py": m };
		const refused = await probe("import n\nn.f = other\ndef other():\n    pass\nimport m\nCALL\n", "m.f()", others);
		expect(refused.callees.filter((c) => c?.endsWith(":f"))).toEqual([]);
		expect(refused.delta).toEqual(NOTHING);
		const twin = await probe("import m\nCALL\n", "m.f()", others);
		expect(twin.callees).toContain("n.py:f");
	});

	test("a write to a module whose f comes from a star import refuses mod.f(); the twin resolves", async () => {
		const others = { "m.py": "from s import *\n", "s.py": m };
		const refused = await probe("import m\nm.f = other\ndef other():\n    pass\nCALL\n", "m.f()", others);
		expect(refused.callees.filter((c) => c?.endsWith(":f"))).toEqual([]);
		expect(refused.delta).toEqual(NOTHING);
		const twin = await probe("import m\nCALL\n", "m.f()", others);
		expect(twin.callees).toContain("s.py:f");
	});

	test("a write to a submodule attribute refuses the chain through it; the twin resolves", async () => {
		const others = { "pkg/__init__.py": "", "pkg/sub.py": m };
		const refused = await probe("import pkg\npkg.sub = other\ndef other():\n    pass\nCALL\n", "pkg.sub.f()", others);
		expect(refused.callees.filter((c) => c?.endsWith(":f"))).toEqual([]);
		expect(refused.delta).toEqual(NOTHING);
		const twin = await probe("import pkg\nCALL\n", "pkg.sub.f()", others);
		expect(twin.callees).toContain("pkg/sub.py:f");
	});

	test("self.__class__ = Other: k = self.__class__; k.m() and k = type(self); k.m() refuse; twins resolve", async () => {
		const declared = "class Other:\n    pass\n";
		const write =
			"class D(C):\n    def go(self):\n        self.__class__ = Other\n    def use(self):\n        k = self.__class__\n        CALL\n";
		const refused = await probe(`${cls}${declared}${write}`, "k.m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
		const typed = `${cls}${declared}class D(C):\n    def go(self):\n        self.__class__ = Other\n    def use(self):\n        k = type(self)\n        CALL\n`;
		const refusedType = await probe(typed, "k.m()");
		expect(ms(refusedType)).toEqual([]);
		expect(refusedType.delta).toEqual(REFUSED);
		const twin = `${cls}${declared}class D(C):\n    def go(self):\n        pass\n    def use(self):\n        k = self.__class__\n        CALL\n`;
		const resolved = await probe(twin, "k.m()");
		expect(ms(resolved)).toEqual(["app.py:C.m"]);
		expect(resolved.delta).toEqual(RESOLVED);
	});

	test("x.m = other on a local construction: x.m() refuses for the single-binding and the R4 shapes; twins resolve", async () => {
		const single = `${cls}${other}def g():\n    x = C()\n    x.m = other\n    CALL\n`;
		const refused = await probe(single, "x.m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
		const singleTwin = `${cls}${other}def g():\n    x = C()\n    CALL\n`;
		const twin = await probe(singleTwin, "x.m()");
		expect(ms(twin)).toEqual(["app.py:C.m"]);
		expect(twin.delta).toEqual(RESOLVED);
		const r4 = `${cls}${other}def g():\n    x = C()\n    if flag:\n        x = C()\n    x.m = other\n    CALL\n`;
		const multi = await probe(r4, "x.m()");
		expect(ms(multi)).toEqual([]);
		expect(multi.delta).toEqual(REFUSED);
		const r4Twin = `${cls}${other}def g():\n    x = C()\n    if flag:\n        x = C()\n    CALL\n`;
		const multiTwin = await probe(r4Twin, "x.m()");
		expect(ms(multiTwin)).toEqual(["app.py:C.m"]);
	});

	test('setattr(x, "m", other) on a local and setattr(self, "m", v) in a method refuse; a non-literal name stays blind', async () => {
		const local = `${cls}${other}def g():\n    x = C()\n    setattr(x, "m", other)\n    CALL\n`;
		const refused = await probe(local, "x.m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
		const blind = `${cls}${other}def g():\n    x = C()\n    setattr(x, name, other)\n    CALL\n`;
		const literal = await probe(blind, "x.m()");
		expect(ms(literal)).toEqual(["app.py:C.m"]);
		expect(literal.delta).toEqual(RESOLVED);
		const inMethod = `${cls}${other}class D(C):\n    def go(self):\n        setattr(self, "m", other)\n    def use(self):\n        CALL\n`;
		const selfWrite = await probe(inMethod, "self.m()");
		expect(ms(selfWrite)).toEqual([]);
		expect(selfWrite.delta).toEqual(REFUSED);
	});

	test("a write on a base class's attribute refuses a subclass's self.m(); the twin resolves", async () => {
		const writes = `${cls}${other}class D(C):\n    pass\nD.m = other\nclass E(D):\n    def use(self):\n        CALL\n`;
		const refused = await probe(writes, "self.m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
		const twin = await probe(
			`${cls}${other}class D(C):\n    pass\nclass E(D):\n    def use(self):\n        CALL\n`,
			"self.m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("a constructed call through a class with a written attribute refuses; the twin resolves", async () => {
		const writes = `${cls}${other}class D(C):\n    pass\nD.m = other\nCALL\n`;
		const refused = await probe(writes, "D().m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta.receiver).toBe(1);
		const twin = await probe(`${cls}${other}class D(C):\n    pass\nCALL\n`, "D().m()");
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("a shadowed setattr is not the builtin, so it writes nothing and x.m() still resolves", async () => {
		const shadowed = `${cls}${other}def g():\n    def setattr(o, n, v):\n        pass\n    x = C()\n    setattr(x, "m", other)\n    CALL\n`;
		const resolved = await probe(shadowed, "x.m()");
		expect(ms(resolved)).toEqual(["app.py:C.m"]);
		expect(resolved.delta).toEqual(RESOLVED);
	});

	test("a write to a different attribute does not refuse: self.n = other leaves self.m() and m.f() alone", async () => {
		const app = `${cls}${other}class D(C):\n    def go(self):\n        self.n = other\n    def use(self):\n        CALL\n`;
		const resolved = await probe(app, "self.m()");
		expect(ms(resolved)).toEqual(["app.py:C.m"]);
		expect(resolved.delta).toEqual(RESOLVED);
		const mod = await probe("import m\nm.g = other\ndef other():\n    pass\nCALL\n", "m.f()", { "m.py": m });
		expect(mod.callees).toContain("m.py:f");
	});

	// GCLI-140 round 1, F1: the self.__class__ bullet covers every self receiver in the class, a direct self.m() too.
	test("a self.__class__ write leaves a direct self.m() unresolved; the twin resolves", async () => {
		const declared = "class Other:\n    pass\n";
		const refused = await probe(
			`${cls}${declared}class D(C):\n    def go(self):\n        self.__class__ = Other\n    def use(self):\n        CALL\n`,
			"self.m()",
		);
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
		const twin = await probe(
			`${cls}${declared}class D(C):\n    def go(self):\n        pass\n    def use(self):\n        CALL\n`,
			"self.m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	// GCLI-140 round 1, F2: the alias read of a written module attribute is the same second binding.
	test("an alias h = m.f never resolves through a written module attribute; the twin resolves", async () => {
		const app = (write: string) => `import m\n${write}def other():\n    pass\ndef g():\n    h = m.f\n    CALL\n`;
		const refused = await probe(app("m.f = other\n"), "h()", { "m.py": m });
		expect(refused.callees.filter((c) => c?.endsWith(":f"))).toEqual([]);
		expect(refused.delta).toEqual(NOTHING);
		const twin = await probe(app(""), "h()", { "m.py": m });
		expect(twin.callees).toContain("m.py:f");
	});

	// GCLI-140 round 1, R5: a bare attribute annotation binds nothing (PEP 526); an annotated assignment does.
	test("a bare attribute annotation is not a write; an annotated assignment is", async () => {
		const bare = `${cls}${other}class D(C):\n    def go(self):\n        self.m: int\n    def use(self):\n        CALL\n`;
		const resolved = await probe(bare, "self.m()");
		expect(ms(resolved)).toEqual(["app.py:C.m"]);
		expect(resolved.delta).toEqual(RESOLVED);
		const withValue = `${cls}${other}class D(C):\n    def go(self):\n        self.m: int = other\n    def use(self):\n        CALL\n`;
		const refused = await probe(withValue, "self.m()");
		expect(ms(refused)).toEqual([]);
		expect(refused.delta).toEqual(REFUSED);
	});

	// GCLI-140 round 1, R6/F8: every binding position that can target an attribute is a write.
	const binder = (label: string, body: string): void => {
		test(`${label}: the write is a binding, self.m() refuses; the twin resolves`, async () => {
			const app = (inner: string) =>
				`${cls}${other}class D(C):\n    def go(self):\n${inner}    def use(self):\n        CALL\n`;
			const refused = await probe(app(body), "self.m()");
			expect(ms(refused)).toEqual([]);
			expect(refused.delta).toEqual(REFUSED);
			const twin = await probe(app("        pass\n"), "self.m()");
			expect(ms(twin)).toEqual(["app.py:C.m"]);
		});
	};
	binder("for target", "        for self.m in [other]:\n            pass\n");
	binder("with-as target", "        with ctx() as self.m:\n            pass\n");
	binder("comprehension target", "        [0 for self.m in [other]]\n");
	binder("augmented assignment", "        self.m += other\n");
	binder("tuple target", "        self.n, self.m = other, other\n");
	binder("chained assignment", "        a = self.m = other\n");
	binder("write in a nested def", "        def inner():\n            self.m = other\n");
	binder("setattr in a lambda", '        (lambda: setattr(self, "m", other))()\n');

	// GCLI-140 round 1, (a79) Q-A: super().m() reads the class MRO after the current class, never the instance
	// dict, so a class-level write refuses it and an instance write does not.
	test("a class-level write refuses super().m(); an instance-write twin still resolves", async () => {
		const base = "class C:\n    def m(self):\n        pass\n";
		const other = "def other(self):\n    pass\n";
		// The inner `super()` call itself is a builtin external call in the with-source only, so the refused delta
		// carries external 1 beside the receiver refusal.
		const SUPER_REFUSED: Delta = { inRepo: 0, external: 1, receiver: 1, nameNotBound: 0 };
		const classLevel = `${base}${other}C.m = other\nclass D(C):\n    def m(self):\n        CALL\n`;
		const direct = await probe(classLevel, "super().m()");
		expect(ms(direct)).toEqual([]);
		expect(direct.delta).toEqual(SUPER_REFUSED);
		const classmethod = `${base}${other}class E(C):\n    @classmethod\n    def go(cls):\n        cls.m = other\nclass D(E):\n    def m(self):\n        CALL\n`;
		const viaCls = await probe(classmethod, "super().m()");
		expect(ms(viaCls)).toEqual([]);
		expect(viaCls.delta).toEqual(SUPER_REFUSED);
		const viaSetattr = `${base}${other}setattr(C, "m", other)\nclass D(C):\n    def m(self):\n        CALL\n`;
		const onClass = await probe(viaSetattr, "super().m()");
		expect(ms(onClass)).toEqual([]);
		expect(onClass.delta).toEqual(SUPER_REFUSED);
		const instance = `${base}${other}class E(C):\n    def go(self):\n        self.m = other\nclass D(E):\n    def m(self):\n        CALL\n`;
		const resolved = await probe(instance, "super().m()");
		expect(ms(resolved)).toEqual(["app.py:C.m"]);
		expect(resolved.delta).toEqual({ inRepo: 1, external: 1, receiver: 0, nameNotBound: 0 });
	});

	// GCLI-140 round 1, (a79) Q-B: the importer's from-import call is refused (the defining module's own bare
	// call is the follow-up, GCLI-151).
	test("an importer's from m import f; f() refuses when m.f is written; the twin resolves", async () => {
		const app = (write: string) => `import m\n${write}def other():\n    pass\nfrom m import f\nCALL\n`;
		const refused = await probe(app("m.f = other\n"), "f()", { "m.py": m });
		expect(refused.callees.filter((c) => c?.endsWith(":f"))).toEqual([]);
		expect(refused.delta).toEqual(NOTHING);
		const twin = await probe(app(""), "f()", { "m.py": m });
		expect(twin.callees).toContain("m.py:f");
	});

	// GCLI-140 round 1, (a80): the mod.f gate was OFF in a base position and in a two-argument super() first
	// argument, so those paths behaved exactly as on dev. Each pinned a KNOWN WRONG EDGE carried to GCLI-151.
	// GCLI-155 turned the gate on in both positions: the super() first-argument pins below now assert the refusal,
	// and the base-position pin asserts that a written base stays opaque while the descendant relationship dev
	// read survives (`baseAlternatives` reads the base write-blind), so `self.__class__` keeps dev's answer.
	const observe = async (files: Record<string, string>) => {
		const r = await analyze(Object.entries(files).map(([path, source]) => py(path, source)));
		const byId = new Map(r.symbols.map((x) => [x.id, x]));
		const edges = r.sites
			.map((s) => {
				const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
				return `${s.kind} ${s.file}:${s.line}:${s.column} -> ${c?.file}:${c?.qualname}${s.polymorphic ? " POLY" : ""}${s.multiplyBound ? " MULTI" : ""}`;
			})
			.sort();
		const b = r.callBins;
		return {
			edges,
			bins: {
				inRepo: b.resolvedInRepo,
				external: b.resolvedExternal,
				receiver: b.receiverNeedsInference,
				nameNotBound: b.nameNotBound,
			},
			poly: r.polymorphicCount,
		};
	};
	const mClass = "class A:\n    def m(self):\n        pass\nclass C(A):\n    pass\n";

	test("(a80 B1) a written class name in a super() first argument refuses (GCLI-155 #8)", async () => {
		const app =
			"import m\ndef other():\n    pass\nm.C = other\nclass B:\n    def m(self):\n        pass\nclass D(B):\n    def m(self):\n        super(m.C, self).m()\n";
		const r = await observe({ "m.py": mClass, "app.py": app });
		expect(r.edges).toEqual([]);
		expect(r.bins).toEqual({ inRepo: 0, external: 1, receiver: 1, nameNotBound: 0 });
	});

	test("(a80 B1b) the from-import super() first argument refuses (GCLI-155 #8b)", async () => {
		const app =
			"from m import C\nimport m\ndef other():\n    pass\nm.C = other\nclass B:\n    def m(self):\n        pass\nclass D(B):\n    def m(self):\n        super(C, self).m()\n";
		const r = await observe({ "m.py": mClass, "app.py": app });
		expect(r.edges).toEqual([]);
		expect(r.bins).toEqual({ inRepo: 0, external: 1, receiver: 1, nameNotBound: 0 });
	});

	test("(a80 B1) CONTROL (dev-equal): a written class name in a base position stays opaque, and dev's descendant read survives", async () => {
		const mUse =
			"class C:\n    def m(self):\n        pass\n    def use(self):\n        k = self.__class__\n        k.m()\n";
		const direct = await observe({
			"m.py": mUse,
			"app.py": "import m\ndef other():\n    pass\nm.C = other\nclass D(m.C):\n    __class__ = None\n",
		});
		expect(direct.edges).toEqual([]);
		expect(direct.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		const withMethod = await observe({
			"m.py": mUse,
			"app.py":
				"import m\ndef other():\n    pass\nm.C = other\nclass D(m.C):\n    __class__ = None\n    def m(self):\n        pass\n",
		});
		expect(withMethod.edges).toEqual([]);
		expect(withMethod.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		const selfRead = await observe({
			"m.py": "class C:\n    def m(self):\n        pass\n    def use(self):\n        self.m()\n",
			"app.py":
				"import m\ndef other():\n    pass\nm.C = other\nclass D(m.C):\n    __class__ = None\n    def m(self):\n        pass\n",
		});
		// dev gives this edge with the polymorphic flag; the narrowing keeps both.
		expect(selfRead.edges).toEqual(["call m.py:5:9 -> m.py:C.m POLY"]);
		expect(selfRead.poly).toBe(1);
	});

	// (a80) item 5: the class-receiver half of F1, an unrelated class's __class__ write, a class's own write and
	// its own super(), and the class-alias read.
	test("a __class__ write does not refuse a cls.m() class receiver", async () => {
		const app = `${cls}class Other:\n    pass\nclass D(C):\n    def go(self):\n        self.__class__ = Other\n    @classmethod\n    def use(cls):\n        cls.m()\n`;
		const r = await observe({ "app.py": app });
		expect(r.edges.map((e) => e.split(" -> ")[1])).toEqual(["app.py:C.m"]);
	});

	test("a __class__ write in another class leaves this class's self.m() resolving", async () => {
		const app = `${cls}class Other:\n    pass\nclass E:\n    def go(self):\n        self.__class__ = Other\nclass D(C):\n    def use(self):\n        self.m()\n`;
		const r = await observe({ "app.py": app });
		expect(r.edges.map((e) => e.split(" -> ")[1])).toEqual(["app.py:C.m"]);
	});

	test("a class-level write on a class does not refuse its own super().m()", async () => {
		const app =
			"class C:\n    def m(self):\n        pass\ndef other(self):\n    pass\nclass D(C):\n    def m(self):\n        super().m()\nD.m = other\n";
		const r = await observe({ "app.py": app });
		expect(r.edges).toEqual(["call app.py:8:9 -> app.py:C.m"]);
	});

	test("the class-alias read h = D.m; h() is refused (the rule removes dev's edge)", async () => {
		const app = `${cls}${other}class D(C):\n    pass\nD.m = other\ndef g():\n    h = D.m\n    h()\n`;
		const r = await observe({ "app.py": app });
		expect(r.edges.filter((e) => e.includes("C.m"))).toEqual([]);
		expect(r.bins).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 });
	});
});

// GCLI-154 (DEC-303 (a79) Q-C, (a80) item 3): the binder-side half of the attribute-write follow-ups. A write
// the walker dropped (a dotted class target, a type(self)/__class__ expression, a single-binding alias, a
// `del`) is now recorded against its class or module, so every existing reader refuses it. Each fixture has a
// resolving twin; the base position and the two-arg super() first argument stay write-blind per (a80).
describe("GCLI-154 — binder-side attribute writes", () => {
	const ms = (r: { callees: (string | null)[] }) => r.callees.filter((c) => c?.endsWith(".m"));

	test("#2 Outer.Inner.m = other refuses an instance call; the twin resolves", async () => {
		const base = "class Outer:\n    class Inner:\n        def m(self):\n            pass\ndef other(self):\n    pass\n";
		const refused = await probe(`${base}Outer.Inner.m = other\ninst = Outer.Inner()\nCALL\n`, "inst.m()");
		expect(ms(refused)).toEqual([]);
		const bins = await analyze([py("app.py", `${base}Outer.Inner.m = other\ninst = Outer.Inner()\ninst.m()\n`)]);
		expect(bins.callBins).toEqual({
			resolvedInRepo: 0,
			resolvedExternal: 0,
			receiverNeedsInference: 2,
			nameNotBound: 0,
		});
		const twin = await probe(`${base}inst = Outer.Inner()\nCALL\n`, "inst.m()");
		expect(ms(twin)).toEqual(["app.py:Outer.Inner.m"]);
	});

	test("#2 a dotted target inside a function (nested binder position) refuses too", async () => {
		const write =
			"class Outer:\n    class Inner:\n        def m(self):\n            pass\ndef other(self):\n    pass\ndef go():\n    Outer.Inner.m = other\ninst = Outer.Inner()\nCALL\n";
		const refused = await probe(write, "inst.m()");
		expect(ms(refused)).toEqual([]);
	});

	test("#2 m.D.m = other through an import refuses m.D().m(); the twin resolves", async () => {
		const others = { "m.py": "class D:\n    def m(self):\n        pass\n" };
		const refused = await probe("import m\ndef other(self):\n    pass\nm.D.m = other\nCALL\n", "m.D().m()", others);
		expect(ms(refused)).toEqual([]);
		const twin = await probe("import m\ndef other(self):\n    pass\nCALL\n", "m.D().m()", others);
		expect(ms(twin)).toEqual(["m.py:D.m"]);
	});

	test("#3 PIN: m.C = other already refuses the from-import read; the twin resolves", async () => {
		const others = { "m.py": "class C:\n    def m(self):\n        pass\n" };
		const refused = await probe(
			"from m import C\nimport m\ndef other(self):\n    pass\nm.C = other\nCALL\n",
			"C().m()",
			others,
		);
		expect(ms(refused)).toEqual([]);
		const twin = await probe("from m import C\nimport m\ndef other(self):\n    pass\nCALL\n", "C().m()", others);
		expect(ms(twin)).toEqual(["m.py:C.m"]);
	});

	test("#7 (GCLI-155): m.C = other leaves the BASE position opaque; X().m() refuses; the twin resolves", async () => {
		const others = { "m.py": "class C:\n    def m(self):\n        pass\n" };
		const base = await probe(
			"import m\ndef other(self):\n    pass\nm.C = other\nclass X(m.C):\n    pass\nCALL\n",
			"X().m()",
			others,
		);
		expect(ms(base)).toEqual([]);
		const twin = await probe(
			"import m\ndef other(self):\n    pass\nclass X(m.C):\n    pass\nCALL\n",
			"X().m()",
			others,
		);
		expect(ms(twin)).toEqual(["m.py:C.m"]);
	});

	test("#8 (GCLI-155): m.C = other refuses the two-arg super() first argument; the twin resolves", async () => {
		const others = {
			"m.py": "class A:\n    def m(self):\n        pass\nclass C(A):\n    def m(self):\n        pass\n",
		};
		// The first argument m.C is written, so it names no class and there is no fallback to the enclosing class.
		const r = await probe(
			"import m\ndef other(self):\n    pass\nm.C = other\nclass B(m.A):\n    def m(self):\n        CALL\n",
			"super(m.C, self).m()",
			others,
		);
		expect(r.callees).toEqual([]);
		const twin = await probe(
			"import m\ndef other(self):\n    pass\nclass B(m.A):\n    def m(self):\n        CALL\n",
			"super(m.C, self).m()",
			others,
		);
		expect(twin.callees).toEqual(["m.py:A.m"]);
	});

	test("#4 type(self).m = other refuses self.m(); the twin resolves (red-before on dev)", async () => {
		// (a84) item 1: #4 built here. tree-sitter parses `type(self).m = other` as a PEP 695 alias, and the
		// re-dispatch records it as a class-level write on the receiver's class. Dev records nothing and resolves.
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        type(self).m = other\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		const refused = await probe(write, "self.m()");
		expect(ms(refused)).toEqual([]);
		const twin = await probe(write.replace("type(self).m = other", "pass"), "self.m()");
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("#4 type(self).m = other in a NESTED def is dev-equal (control): self.m() still resolves", async () => {
		// (a83) item 1: dev's rebound binding is kept, so a type(self).m write inside a nested def is not attributed
		// against the receiver; the read in another method resolves exactly as on dev (a control, not red-before).
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        def inner():\n            type(self).m = other\n        inner()\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		const r = await probe(write, "self.m()");
		expect(ms(r)).toEqual(["app.py:C.m"]);
	});

	test("#4 self.__class__.m = other refuses self.m(); the twin resolves", async () => {
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        self.__class__.m = other\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		const refused = await probe(write, "self.m()");
		expect(ms(refused)).toEqual([]);
		const twin = await probe(
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        pass\n    def use(self):\n        CALL\ndef other(self):\n    pass\n",
			"self.m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("#4 an unrelated class resolves; a subclass inheriting the written class refuses", async () => {
		// (a84) item 1: the write lands on C only. U is unrelated and resolves; S(C) inherits the class-level write
		// through the ancestor-write guard, so its self.m() refuses (a removal, never a created edge).
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        type(self).m = other\nclass U:\n    def m(self):\n        pass\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		expect(ms(await probe(write, "self.m()"))).toEqual(["app.py:U.m"]);
		const subclass =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        type(self).m = other\nclass S(C):\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		expect(ms(await probe(subclass, "self.m()"))).toEqual([]);
	});

	test("#11 K = C; K.m = other refuses C().m(); the twin resolves", async () => {
		const write = "class C:\n    def m(self):\n        pass\nK = C\ndef other(self):\n    pass\nK.m = other\nCALL\n";
		const refused = await probe(write, "C().m()");
		expect(ms(refused)).toEqual([]);
		const bins = await analyze([py("app.py", write.replace("CALL", "C().m()"))]);
		expect(bins.callBins).toEqual({
			resolvedInRepo: 1,
			resolvedExternal: 0,
			receiverNeedsInference: 1,
			nameNotBound: 0,
		});
		const twin = await probe(
			"class C:\n    def m(self):\n        pass\nK = C\ndef other(self):\n    pass\nCALL\n",
			"C().m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("#11 n = m; n.f = other refuses m.f(); the twin resolves", async () => {
		const others = { "m.py": "def f():\n    pass\n" };
		const refused = await probe("import m\nn = m\ndef other():\n    pass\nn.f = other\nCALL\n", "m.f()", others);
		expect(refused.callees).toEqual([]);
		const twin = await probe("import m\nn = m\ndef other():\n    pass\nCALL\n", "m.f()", others);
		expect(twin.callees).toEqual(["m.py:f"]);
	});

	test("#11 k = cls; k.m = other in a classmethod refuses self.m()", async () => {
		const write =
			"class C:\n    def m(self):\n        pass\n    @classmethod\n    def write(cls):\n        k = cls\n        k.m = other\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		const refused = await probe(write, "self.m()");
		expect(ms(refused)).toEqual([]);
	});

	test("#11 k = type(self); k.m = other refuses self.m(); the twin resolves", async () => {
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        k = type(self)\n        k.m = other\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		const refused = await probe(write, "self.m()");
		expect(ms(refused)).toEqual([]);
		const twin = await probe(
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        k = type(self)\n    def use(self):\n        CALL\ndef other(self):\n    pass\n",
			"self.m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("#11 an alias inside a nested def (binder position) refuses too", async () => {
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        def inner():\n            k = type(self)\n            k.m = other\n        inner()\n    def use(self):\n        CALL\ndef other(self):\n    pass\n";
		const refused = await probe(write, "self.m()");
		expect(ms(refused)).toEqual([]);
	});

	test("#11 a multi-binding enumerable alias is followed: the write lands on every possible class", async () => {
		const app =
			"class C:\n    def m(self):\n        pass\nclass D:\n    def m(self):\n        pass\nK = C\nK = D\ndef other(self):\n    pass\nK.m = other\nCALL\n";
		expect(ms(await probe(app, "C().m()"))).toEqual([]);
		expect(ms(await probe(app, "D().m()"))).toEqual([]);
		const unrelated =
			"class C:\n    def m(self):\n        pass\nclass D:\n    def m(self):\n        pass\nclass U:\n    def m(self):\n        pass\nK = C\nK = D\ndef other(self):\n    pass\nK.m = other\nCALL\n";
		expect(ms(await probe(unrelated, "U().m()"))).toEqual(["app.py:U.m"]);
	});

	test("#11 an alias whose bindings cannot all be enumerated is a blind spot: C().m() still resolves", async () => {
		const app =
			"class C:\n    def m(self):\n        pass\ndef f():\n    pass\nK = C\nK = f()\ndef other(self):\n    pass\nK.m = other\nCALL\n";
		expect(ms(await probe(app, "C().m()"))).toEqual(["app.py:C.m"]);
	});

	test("#11 an alias is followed regardless of binding order: C().m() refuses", async () => {
		// `K.m = other` before `K = C` raises at run time; (a82) records the write on every enumerable binding.
		const app = "class C:\n    def m(self):\n        pass\ndef other(self):\n    pass\nK.m = other\nK = C\nCALL\n";
		expect(ms(await probe(app, "C().m()"))).toEqual([]);
	});

	test("#15 del C.m refuses C().m(); the twin resolves", async () => {
		const refused = await probe("class C:\n    def m(self):\n        pass\ndel C.m\nCALL\n", "C().m()");
		expect(ms(refused)).toEqual([]);
		const bins = await analyze([py("app.py", "class C:\n    def m(self):\n        pass\ndel C.m\nC().m()\n")]);
		expect(bins.callBins).toEqual({
			resolvedInRepo: 1,
			resolvedExternal: 0,
			receiverNeedsInference: 1,
			nameNotBound: 0,
		});
		const twin = await probe("class C:\n    def m(self):\n        pass\nCALL\n", "C().m()");
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("#15 del self.m refuses self.m(); the twin resolves", async () => {
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        del self.m\n    def use(self):\n        CALL\n";
		const refused = await probe(write, "self.m()");
		expect(ms(refused)).toEqual([]);
		const twin = await probe(
			"class C:\n    def m(self):\n        pass\n    def use(self):\n        CALL\n",
			"self.m()",
		);
		expect(ms(twin)).toEqual(["app.py:C.m"]);
	});

	test("#15 a comprehension attribute target (control — passes on dev): self.m() refuses", async () => {
		// (a83): for_in_clause -> recordAttributeTargets is pre-existing GCLI-140 behaviour, so this passes on dev
		// too; kept as a control, not a red-before proof.
		const write =
			"class C:\n    def m(self):\n        pass\n    def write(self):\n        [0 for self.m in []]\n    def use(self):\n        CALL\n";
		const refused = await probe(write, "self.m()");
		expect(ms(refused)).toEqual([]);
	});
});

// GCLI-154 (DEC-303 (a83)): removal-only proof for the `type(x).m = v` misparse, and the item-2 rule — read the
// written attribute, a NEIGHBOUR attribute on the same receiver, and the receiver, before and after the write.
describe("GCLI-154 (a83) — removal-only and item-2 reads", () => {
	const other = "def other(self):\n    pass\n";
	const callees = (r: PythonCallsResult): string[] =>
		r.sites
			.map((s) => {
				const c = s.calleeId ? r.symbols.find((x) => x.id === s.calleeId) : undefined;
				return c ? `${c.file}:${c.qualname}` : "";
			})
			.filter((c) => c !== "");

	test("(a) type(self).m = other; self.n() is dev-equal: no C.n edge, bins equal dev", async () => {
		const app = `class C:\n    def n(self):\n        pass\n    def write(self):\n        type(self).m = other\n        self.n()\n${other}C().write()\n`;
		const r = await analyze([py("app.py", app)]);
		expect(r.callBins).toEqual({ resolvedInRepo: 2, resolvedExternal: 0, receiverNeedsInference: 1, nameNotBound: 0 });
		expect(callees(r)).not.toContain("app.py:C.n");
	});

	test("(b) function x = C(); type(x).m = other; x.m() is dev-equal: no C.m edge", async () => {
		const app = `class C:\n    def m(self):\n        pass\n${other}def f():\n    x = C()\n    type(x).m = other\n    x.m()\nf()\n`;
		const r = await analyze([py("app.py", app)]);
		expect(r.callBins).toEqual({ resolvedInRepo: 2, resolvedExternal: 0, receiverNeedsInference: 1, nameNotBound: 0 });
		expect(callees(r)).not.toContain("app.py:C.m");
	});

	test("(b) module x = C(); type(x).m = other; x.m() is dev-equal: no C.m edge", async () => {
		const app = `class C:\n    def m(self):\n        pass\n${other}x = C()\ntype(x).m = other\nx.m()\n`;
		const r = await analyze([py("app.py", app)]);
		expect(r.callBins).toEqual({ resolvedInRepo: 1, resolvedExternal: 0, receiverNeedsInference: 1, nameNotBound: 0 });
		expect(callees(r)).not.toContain("app.py:C.m");
	});

	test("F3: k = self; k.m = other is an INSTANCE write; D's super().m() still resolves (dev-equal)", async () => {
		const app = `class C:\n    def m(self):\n        pass\n    def write(self):\n        k = self\n        k.m = other\nclass D(C):\n    def m(self):\n        super().m()\n${other}`;
		const r = await analyze([py("app.py", app)]);
		expect(callees(r)).toContain("app.py:C.m");
	});

	test("item 2 #4: written attribute refused, neighbour resolves", async () => {
		// (a84) item 1: #4 is built, so type(self).m records a class-level write on C. The write set is collected
		// before resolution, so every y.m() in the file refuses (before and after), while y.n() resolves twice.
		const app = `class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n    def use(self):\n        y = C()\n        y.m()\n        y.n()\n        type(self).m = other\n        y.m()\n        y.n()\n${other}`;
		const r = await analyze([py("app.py", app)]);
		const cs = callees(r);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});

	test("item 2 #2: written Outer.Inner.m refused, neighbour resolves, instance read", async () => {
		const app = `class Outer:\n    class Inner:\n        def m(self):\n            pass\n        def n(self):\n            pass\n${other}y = Outer.Inner()\ny.m()\ny.n()\nOuter.Inner.m = other\ny.m()\ny.n()\n`;
		const r = await analyze([py("app.py", app)]);
		const cs = callees(r);
		expect(cs.filter((c) => c === "app.py:Outer.Inner.n").length).toBe(2);
		expect(cs).not.toContain("app.py:Outer.Inner.m");
	});

	test("item 2 #11: written K.m refused, neighbour resolves, receiver read", async () => {
		const app = `class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\nK = C\n${other}y = C()\ny.m()\ny.n()\nK.m = other\ny.m()\ny.n()\n`;
		const r = await analyze([py("app.py", app)]);
		const cs = callees(r);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});

	test("item 2 #15: written del C.m refused, neighbour resolves, receiver read", async () => {
		const app =
			"class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\ny = C()\ny.m()\ny.n()\ndel C.m\ny.m()\ny.n()\n";
		const r = await analyze([py("app.py", app)]);
		const cs = callees(r);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});
});

// GCLI-154 (DEC-303 (a84) item 2): item-2 reads (written attribute, neighbour, receiver, before/after) for the
// shapes that survive #4's removal, the cls.__class__.m over-refusal pin, and the observed-red subset control.
describe("GCLI-154 (a84) — remaining item-2 shapes and controls", () => {
	const other = "def other(self):\n    pass\n";
	const callees = (r: PythonCallsResult): string[] =>
		r.sites
			.map((s) => {
				const c = s.calleeId ? r.symbols.find((x) => x.id === s.calleeId) : undefined;
				return c ? `${c.file}:${c.qualname}` : "";
			})
			.filter((c) => c !== "");

	test("item 2 m.D.m: written refused, neighbour resolves", async () => {
		const cs = callees(
			await analyze([
				py("m.py", "class D:\n    def m(self):\n        pass\n    def n(self):\n        pass\n"),
				py("app.py", `import m\n${other}y = m.D()\ny.m()\ny.n()\nm.D.m = other\ny.m()\ny.n()\n`),
			]),
		);
		expect(cs.filter((c) => c === "m.py:D.n").length).toBe(2);
		expect(cs).not.toContain("m.py:D.m");
	});

	test("item 2 self.__class__.m: written refused, neighbour resolves", async () => {
		const cs = callees(
			await analyze([
				py(
					"app.py",
					`class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n    def use(self):\n        y = C()\n        y.m()\n        y.n()\n        self.__class__.m = other\n        y.m()\n        y.n()\n${other}`,
				),
			]),
		);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});

	test("item 2 n = m: written refused, neighbour resolves", async () => {
		const cs = callees(
			await analyze([
				py("m.py", "def f():\n    pass\ndef g():\n    pass\n"),
				py("app.py", "import m\nn = m\ndef other():\n    pass\nm.f()\nm.g()\nn.f = other\nm.f()\nm.g()\n"),
			]),
		);
		expect(cs.filter((c) => c === "m.py:g").length).toBe(2);
		expect(cs).not.toContain("m.py:f");
	});

	test("item 2 k = cls: written refused, neighbour resolves", async () => {
		const cs = callees(
			await analyze([
				py(
					"app.py",
					`class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n    @classmethod\n    def use(cls):\n        y = C()\n        y.m()\n        y.n()\n        k = cls\n        k.m = other\n        y.m()\n        y.n()\n${other}`,
				),
			]),
		);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});

	test("item 2 k = self: written refused, neighbour resolves", async () => {
		const cs = callees(
			await analyze([
				py(
					"app.py",
					`class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n    def use(self):\n        y = C()\n        y.m()\n        y.n()\n        k = self\n        k.m = other\n        y.m()\n        y.n()\n${other}`,
				),
			]),
		);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});

	test("item 2 del self.m: written refused, neighbour resolves", async () => {
		const cs = callees(
			await analyze([
				py(
					"app.py",
					"class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n    def use(self):\n        y = C()\n        y.m()\n        y.n()\n        del self.m\n        y.m()\n        y.n()\n",
				),
			]),
		);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});

	test("item 2 k = type(self): written refused, neighbour resolves", async () => {
		const cs = callees(
			await analyze([
				py(
					"app.py",
					`class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n    def use(self):\n        y = C()\n        y.m()\n        y.n()\n        k = type(self)\n        k.m = other\n        y.m()\n        y.n()\n${other}`,
				),
			]),
		);
		expect(cs.filter((c) => c === "app.py:C.n").length).toBe(2);
		expect(cs).not.toContain("app.py:C.m");
	});

	test("cls.__class__.m: recorded class-level on C — measured over-refusal (accepted by DEC-303 (a84); carried to GCLI-164)", async () => {
		// At runtime `cls.__class__` is the metaclass, so this should not refuse D's super().m(); it does, as a
		// removal-only over-refusal. Pinned here and carried to GCLI-164 (it was neither fixed in GCLI-156 nor
		// carried to GCLI-163/165; #248 round 1 N-f).
		const r = await analyze([
			py(
				"app.py",
				`class C:\n    def m(self):\n        pass\n    @classmethod\n    def write(cls):\n        cls.__class__.m = other\nclass D(C):\n    def m(self):\n        super().m()\n${other}`,
			),
		]);
		expect(r.sites).toEqual([]);
	});

	test("observed-red subset-check control: an injected created edge fails the subset check", async () => {
		const r = await analyze([
			py("app.py", `class C:\n    def m(self):\n        pass\n${other}K = C\nK.m = other\ny = C()\ny.m()\n`),
		]);
		const head = callees(r);
		const isSubset = (sup: string[], sub: string[]) => sub.every((e) => sup.includes(e));
		expect(isSubset([...head, "app.py:C.m"], head)).toBe(true);
		expect(isSubset(head, [...head, "app.py:Injected.m"])).toBe(false);
	});
});

// GCLI-155 (DEC-303 (a79) Q-B, (a80) items 1 and 3): the read-side one-path consumers. Every resolution path that
// did not consult an already recorded attribute write now refuses: the defining module's own bare call (#1), an
// imported instance's attribute call (#5), a written class name in a base position (#7) and in a two-argument
// super() first argument (#8, #8b), the enclosing-class fallback for an unresolved super() first argument (#10),
// the star importer's bare call (#12), classSymbolOfName's alias read and R4 local (#13), a class-attribute
// decorator (#14) and the construction path's __init__ edge (#16). #9 is the (a80) B2 carry: the descendant
// relationship a written base name keeps must not become a created `C.m` edge. Removal-only; the dev edges #10
// removes are named in the PR.
describe("GCLI-155 — read-side attribute-write consumers", () => {
	const cls = "class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n";
	const other = "def other(self):\n    pass\n";
	const observe = async (files: Record<string, string>) => {
		const r = await analyze(Object.entries(files).map(([path, source]) => py(path, source)));
		const byId = new Map(r.symbols.map((x) => [x.id, x]));
		const edges = r.sites
			.map((s) => {
				const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
				return `${s.kind} ${s.file}:${s.line}:${s.column} -> ${c?.file}:${c?.qualname}${s.polymorphic ? " POLY" : ""}${s.multiplyBound ? " MULTI" : ""}`;
			})
			.sort();
		const b = r.callBins;
		return {
			edges,
			bins: {
				inRepo: b.resolvedInRepo,
				external: b.resolvedExternal,
				receiver: b.receiverNeedsInference,
				nameNotBound: b.nameNotBound,
			},
			poly: r.polymorphicCount,
		};
	};

	test("#1 Q-B: the defining module's own bare f() refuses after an importer writes m.f; the twin resolves", async () => {
		const mModule = "def f():\n    pass\ndef n():\n    pass\ndef use():\n    f()\n    n()\n";
		const written = await observe({ "m.py": mModule, "app.py": `import m\n${other}m.f = other\n` });
		// The written name refuses; the neighbour n() on the same module resolves.
		expect(written.edges).toEqual(["call m.py:7:5 -> m.py:n"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 0, receiver: 0, nameNotBound: 1 });
		const twin = await observe({ "m.py": mModule, "app.py": `import m\n${other}` });
		expect(twin.edges).toEqual(["call m.py:6:5 -> m.py:f", "call m.py:7:5 -> m.py:n"]);
	});

	test("#1 class-body read: a written module name read from a class body refuses; the class's own binding stands", async () => {
		const mModule = "def f():\n    pass\nclass K:\n    x = f()\n";
		const written = await observe({ "m.py": mModule, "app.py": `import m\n${other}m.f = other\n` });
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 1 });
		const twin = await observe({ "m.py": mModule, "app.py": `import m\n${other}` });
		expect(twin.edges).toEqual(["call m.py:4:9 -> m.py:f"]);
		// CONTROL (dev-passing): GCLI-144/146: a class body that BINDS the name reads its own binding, not the
		// module's, so no gate fires and the write changes nothing in the class body's own resolution.
		const own = async (write: boolean) =>
			(
				await observe({
					"m.py": "def f():\n    pass\nclass K:\n    f = staticmethod(f)\n    x = f()\n",
					"app.py": `import m\n${other}${write ? "m.f = other\n" : ""}`,
				})
			).bins;
		expect(await own(true)).toEqual(await own(false));
	});

	test("#5: from m import inst; inst.m = other refuses inst.m(); the neighbour inst.n() resolves", async () => {
		const files = (write: boolean) => ({
			"m.py": `${cls}inst = C()\n`,
			"app.py": `from m import inst\n${other}${write ? "inst.m = other\n" : ""}inst.m()\ninst.n()\n`,
		});
		const written = await observe(files(true));
		expect(written.edges).toEqual(["call app.py:6:1 -> m.py:C.n", "new m.py:6:8 -> m.py:C"]);
		expect(written.bins).toEqual({ inRepo: 2, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe(files(false));
		expect(twin.edges).toEqual([
			"call app.py:4:1 -> m.py:C.m",
			"call app.py:5:1 -> m.py:C.n",
			"new m.py:6:8 -> m.py:C",
		]);
	});

	test("#7: class X(m.C) after m.C = other refuses x.m() and x.n(); the twin resolves both", async () => {
		const files = (write: boolean) => ({
			"m.py": cls,
			"app.py": `import m\n${other}${write ? "m.C = other\n" : ""}class X(m.C):\n    pass\nx = X()\nx.m()\nx.n()\n`,
		});
		// The base is opaque: the inherited m and its neighbour n both refuse; the class's own construction stands.
		const written = await observe(files(true));
		expect(written.edges).toEqual(["new app.py:7:5 -> app.py:X"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 0, receiver: 2, nameNotBound: 0 });
		const twin = await observe(files(false));
		expect(twin.edges).toEqual([
			"call app.py:7:1 -> m.py:C.m",
			"call app.py:8:1 -> m.py:C.n",
			"new app.py:6:5 -> app.py:X",
		]);
	});

	test("#8: super(m.C, self).m() refuses after m.C = other; the twin resolves A.m", async () => {
		const mClass = "class A:\n    def m(self):\n        pass\nclass C(A):\n    def m(self):\n        pass\n";
		const files = (write: boolean) => ({
			"m.py": mClass,
			"app.py": `import m\n${other}${write ? "m.C = other\n" : ""}class B(m.A):\n    def m(self):\n        super(m.C, self).m()\n`,
		});
		const written = await observe(files(true));
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 1, receiver: 1, nameNotBound: 0 });
		const twin = await observe(files(false));
		expect(twin.edges).toEqual(["call app.py:6:9 -> m.py:A.m"]);
	});

	test("#8b: the from-import super(C, self).m() refuses after m.C = other; the twin resolves", async () => {
		const mClass = "class A:\n    def m(self):\n        pass\nclass C(A):\n    def m(self):\n        pass\n";
		const files = (write: boolean) => ({
			"m.py": mClass,
			"app.py": `from m import C\nimport m\n${other}${write ? "m.C = other\n" : ""}class B(m.A):\n    def m(self):\n        super(C, self).m()\n`,
		});
		const written = await observe(files(true));
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 1, receiver: 1, nameNotBound: 0 });
		const twin = await observe(files(false));
		expect(twin.edges).toEqual(["call app.py:7:9 -> m.py:A.m"]);
	});

	test("#9 (a80 B2) CONTROL (dev-passing, green on dev and head; DEC-303 (a86) item 4): a written base name keeps dev's descendant read, so self.__class__ stays refused", async () => {
		const mUse =
			"class C:\n    def m(self):\n        pass\n    def use(self):\n        k = self.__class__\n        k.m()\n        self.m()\n";
		const app = (write: boolean) =>
			`import m\n${other}${write ? "m.C = other\n" : ""}class D(m.C):\n    __class__ = None\n`;
		// GCLI-155 #7 must not create `C.m` here: D stays a possible descendant of C (baseAlternatives reads the
		// base write-blind), so self.__class__ is still refused; the same-class self.m() read still resolves.
		const written = await observe({ "m.py": mUse, "app.py": app(true) });
		expect(written.edges).toEqual(["call m.py:7:9 -> m.py:C.m"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({ "m.py": mUse, "app.py": app(false) });
		expect(twin.edges).toEqual(written.edges);
	});

	test("#10: an unresolved super() first argument refuses instead of falling back to the enclosing class", async () => {
		const external = await observe({
			"app.py":
				"from ext import Base\nclass B:\n    def m(self):\n        pass\nclass D(B):\n    def m(self):\n        super(Base, self).m()\n",
		});
		expect(external.edges).toEqual([]);
		expect(external.bins).toEqual({ inRepo: 0, external: 1, receiver: 1, nameNotBound: 0 });
		const param = await observe({
			"app.py":
				"class B:\n    def m(self):\n        pass\nclass D(B):\n    def m(self, base):\n        super(base, self).m()\n",
		});
		expect(param.edges).toEqual([]);
		expect(param.bins).toEqual({ inRepo: 0, external: 1, receiver: 1, nameNotBound: 0 });
		// The resolving twin: a first argument that names an in-repo class reads after that class.
		const twin = await observe({
			"app.py":
				"class B:\n    def m(self):\n        pass\nclass Base(B):\n    def m(self):\n        pass\nclass D(B):\n    def m(self):\n        super(Base, self).m()\n",
		});
		expect(twin.edges).toEqual(["call app.py:9:9 -> app.py:B.m"]);
	});

	test("#12 N2: a star importer's bare f() refuses after s.f is written; the neighbour g() resolves", async () => {
		const s = "def f():\n    pass\ndef g():\n    pass\n";
		const mModule = "from s import *\ndef h():\n    f()\n    g()\n";
		const written = await observe({ "s.py": s, "m.py": mModule, "app.py": `import s\n${other}s.f = other\n` });
		expect(written.edges).toEqual(["call m.py:4:5 -> s.py:g"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 0, receiver: 0, nameNotBound: 1 });
		const twin = await observe({ "s.py": s, "m.py": mModule, "app.py": "import s\n" });
		expect(twin.edges).toEqual(["call m.py:3:5 -> s.py:f", "call m.py:4:5 -> s.py:g"]);
	});

	test("#13 N3: the classSymbolOfName alias read and the R4 local refuse after m.C = other", async () => {
		const app = (write: boolean) =>
			`from m import C\nimport m\n${other}${write ? "m.C = other\n" : ""}def g():\n    h = C.m\n    h()\ndef k():\n    x = C()\n    x.m()\n    x.n()\n`;
		// h = C.m and h() are refused by the name gate; the R4 local's x.m() and its neighbour x.n() are refused
		// because the construction names no class symbol any more.
		const written = await observe({ "m.py": cls, "app.py": app(true) });
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 2, nameNotBound: 2 });
		const twin = await observe({ "m.py": cls, "app.py": app(false) });
		expect(twin.edges).toEqual([
			"call app.py:10:5 -> m.py:C.m",
			"call app.py:11:5 -> m.py:C.n",
			"call app.py:7:5 -> m.py:C.m",
			"new app.py:9:9 -> m.py:C",
		]);
	});

	test("#14 N4: a decorator @C.m refuses after C.m = other; the twin reaches the def", async () => {
		// No call in this module: the decorator loop must collect the write sets itself.
		const app = (write: boolean) =>
			`class C:\n    def m(self, dec):\n        return dec\n${write ? "def other(dec):\n    return dec\nC.m = other\n" : ""}@C.m\ndef g():\n    pass\n`;
		const written = await observe({ "app.py": app(true) });
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 0 });
		const twin = await observe({ "app.py": app(false) });
		expect(twin.edges).toEqual(["decorator app.py:4:2 -> app.py:C.m"]);
	});

	test("R1 (a86 item 2 fallback, GCLI-159): a multiply-bound module-scope base with a write keeps dev's descendant read and POLY", async () => {
		// The shape #238 round 2 blocked on: a base bound twice at module scope whose name an importer writes. The
		// build must be removal-only BY CONSTRUCTION, so this fixture is GREEN ON DEV AND GREEN ON HEAD — it pins
		// dev's exact outcome and turns red if any base RELATION reads a gate. Measured red on 2b3a2ba without the
		// `baseAlternatives` bypass (mutant K5): a CREATED m.py:B.m edge and both POLY flags dropped.
		const r2B = (i: string) =>
			[
				`${i}class B:`,
				`${i}    def m(self):`,
				`${i}        pass`,
				`${i}    def use(self):`,
				`${i}        k = self.__class__`,
				`${i}        k.m()`,
				`${i}        self.m()`,
				`${i}    @classmethod`,
				`${i}    def make(cls):`,
				`${i}        return cls()`,
			].join("\n");
		const app = (write: boolean) => `import m\n${other}${write ? "m.B = other\n" : ""}`;
		const tryFiles = (write: boolean) => ({
			"m.py": `try:\n    from ext import B\nexcept ImportError:\n${r2B("    ")}\nclass D(B):\n    __class__ = None\n    def m(self):\n        pass\n`,
			"app.py": app(write),
		});
		const written = await observe(tryFiles(true));
		expect(written.edges).toEqual(["call m.py:10:13 -> m.py:B.m POLY", "new m.py:13:20 -> m.py:B POLY"]);
		expect(written.bins).toEqual({ inRepo: 2, external: 0, receiver: 1, nameNotBound: 0 });
		expect(written.poly).toBe(2);
		// Without-write twin: the same source with no write reads identically, so the write adds and removes nothing.
		expect(await observe(tryFiles(false))).toEqual(await observe(tryFiles(true)));
		const ifFiles = (write: boolean) => ({
			"m.py": `import sys\nif sys.version_info:\n${r2B("    ")}\nelse:\n${r2B("    ")}\nclass D(B):\n    __class__ = None\n    def m(self):\n        pass\n`,
			"app.py": app(write),
		});
		const ifWritten = await observe(ifFiles(true));
		expect(ifWritten.edges).toEqual([
			"call m.py:20:13 -> m.py:B.m POLY",
			"call m.py:9:13 -> m.py:B.m POLY",
			"new m.py:12:20 -> m.py:B POLY",
			"new m.py:23:20 -> m.py:B POLY",
		]);
		expect(ifWritten.poly).toBe(4);
		expect(await observe(ifFiles(false))).toEqual(await observe(ifFiles(true)));
		// Star importer: the variant that does NOT reach the module-scope gate, so the bypass must cover the
		// star-resolution path too rather than only `resolveBareName`'s module branch.
		const starFiles = (write: boolean) => ({
			"m.py": `try:\n    from ext import B\nexcept ImportError:\n${r2B("    ")}\n`,
			"n.py": "from m import *\nclass D(B):\n    __class__ = None\n    def m(self):\n        pass\n",
			"app.py": app(write),
		});
		const star = await observe(starFiles(true));
		expect(star.edges).toEqual(["call m.py:10:13 -> m.py:B.m POLY", "new m.py:13:20 -> m.py:B POLY"]);
		expect(star.poly).toBe(2);
		expect(await observe(starFiles(false))).toEqual(await observe(starFiles(true)));
		// CONTROL (attr-arm): `class D(m.B)` is a different base shape and is dev-equal in both directions.
		const attrArm = async (write: boolean) =>
			await observe({
				"m.py": `${r2B("")}\n`,
				"app.py": `import m\n${other}${write ? "m.B = other\n" : ""}class D(m.B):\n    __class__ = None\n    def m(self):\n        pass\n`,
			});
		expect(await attrArm(true)).toEqual(await attrArm(false));
		expect((await attrArm(true)).edges).toEqual(["call m.py:7:9 -> m.py:B.m POLY", "new m.py:10:16 -> m.py:B POLY"]);
	});

	test("F1 (a89 round 1): a written head MODULE name keeps dev's rebound-base bin, not external", async () => {
		// The round-1 finding: `baseIsRebound` is a second base-RELATION reader and read the gates, so the #1 gate at
		// the head name turned `m` unresolved and the attr arm fell to false — the base was binned external where dev
		// binned it receiver/rebound-base. No edge either side, so only the bin and the reason prove it.
		const files = (write: boolean) => ({
			"m.py": "try:\n    from ext import B\nexcept ImportError:\n    class B:\n        pass\n",
			"x.py": "import m\nclass K(m.B):\n    def go(self):\n        self.g()\n",
			"w.py": `import x\n${write ? "x.m = None\n" : ""}`,
		});
		const r = await analyze(Object.entries(files(true)).map(([path, source]) => py(path, source)));
		expect(r.callBins).toEqual({ resolvedInRepo: 0, resolvedExternal: 0, receiverNeedsInference: 1, nameNotBound: 0 });
		const reasons = r.unresolvedReceiverReasons.map((x) => x.reason).sort();
		expect(reasons).toEqual(["rebound-base"]);
		// The write is not what creates the bin: dev answers the twin the same way, and so does this build.
		const twin = await analyze(Object.entries(files(false)).map(([path, source]) => py(path, source)));
		expect(twin.callBins).toEqual(r.callBins);
		expect(twin.unresolvedReceiverReasons).toEqual(r.unresolvedReceiverReasons);
	});

	test("F1b (a89 round 2, GCLI-161): a base rebound by an importer's `m.B = L` keeps dev's receiver bin", async () => {
		// The round-2 counterexample. Bypassing the whole gate family in `baseIsRebound` switched off GCLI-140's
		// module-attribute gates too, so this shape claimed the call leaves the repo. Measured identical on dev
		// d58878f and on 034a898: no edges, receiver 1, reason rebound-base.
		const files = (write: boolean) => ({
			"m.py": "from ext import B\n",
			"y.py": "class L:\n    def g(self):\n        pass\n",
			"x.py": "import m\nclass K(m.B):\n    def go(self):\n        self.g()\n",
			"w.py": `import m\nfrom y import L\n${write ? "m.B = L\n" : ""}`,
		});
		const r = await analyze(Object.entries(files(true)).map(([path, source]) => py(path, source)));
		expect(r.callBins).toEqual({ resolvedInRepo: 0, resolvedExternal: 0, receiverNeedsInference: 1, nameNotBound: 0 });
		expect(r.unresolvedReceiverReasons.map((x) => x.reason)).toEqual(["rebound-base"]);
		// Without the write both sides answer external-base, so the bin comes from the write, not from the base.
		const twin = await analyze(Object.entries(files(false)).map(([path, source]) => py(path, source)));
		expect(twin.callBins).toEqual({
			resolvedInRepo: 0,
			resolvedExternal: 1,
			receiverNeedsInference: 0,
			nameNotBound: 0,
		});
	});

	test("F1c (GCLI-161, #245 N3): the BARE-NAME variant of the written base is a known dev-equal GAP, external with and without the write", async () => {
		// A KNOWN GAP, not a control: `from m import B; class K(B)` measured on dev d58878f, on 034a898 and on this
		// head all answer external either way, so the write does not reach the bare-name read on dev and this build
		// does not change that. It is pinned as a gap with its own follow-up task (GCLI-165), which also carries the
		// `from m import m2` residual where m2 is not a module file: there the from-import carries a non-module name
		// and the reader answers it the way dev does, not the way a written module attribute would.
		const files = (write: boolean) => ({
			"m.py": "from ext import B\n",
			"y.py": "class L:\n    def g(self):\n        pass\n",
			"x.py": "from m import B\nclass K(B):\n    def go(self):\n        self.g()\n",
			"w.py": `import m\nfrom y import L\n${write ? "m.B = L\n" : ""}`,
		});
		const written = await observe(files(true));
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 1, receiver: 0, nameNotBound: 0 });
		expect(await observe(files(false))).toEqual(written);
	});

	test("F1d (GCLI-161): a BARE base rebound by a module attribute write keeps the receiver bin (R4)", async () => {
		// The regression the narrowed bypass first introduced: bypassing the bare-name gate for the whole of
		// `baseIsRebound` un-rebounded this shape and moved it to external. Only the attr arm's HEAD read is blind;
		// the name arm keeps the gate, so `m.Base = other` still makes the bare `Base` a second binding.
		const files = (write: boolean) => ({
			"m.py": "from ext import Base\nclass D(Base):\n    def go(self):\n        self.zz()\n",
			"app.py": `import m\ndef other(self):\n    pass\n${write ? "m.Base = other\n" : ""}`,
		});
		const written = await observe(files(true));
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe(files(false));
		expect(twin.bins).toEqual({ inRepo: 0, external: 1, receiver: 0, nameNotBound: 0 });
	});

	test("F2 (a89 round 1): a gated ancestor marks the merged MRO whatever the base order", async () => {
		// The round-1 finding: only keys gated in a base THIS class finds gated were marked, and c3merge keeps the
		// first shared entry it reaches, so E(Outer.F, D) resolved and E(D, Outer.F) refused. The outcome is now the
		// same in both orders — and it is a REMOVAL against dev, which emitted the edge in both.
		const order = (bases: string) =>
			`class Outer:\n    class Inner:\n        def m(self):\n            pass\n    class F(Inner):\n        pass\ndef other(self):\n    pass\nOuter.Inner = other\nclass D(Outer.Inner):\n    pass\nclass E(${bases}):\n    pass\nE().m()\n`;
		const fFirst = await observe({ "app.py": order("Outer.F, D") });
		const dFirst = await observe({ "app.py": order("D, Outer.F") });
		expect(fFirst).toEqual(dFirst);
		expect(fFirst.edges).toEqual(["new app.py:14:1 -> app.py:E"]);
		expect(fFirst.bins).toEqual({ inRepo: 1, external: 0, receiver: 1, nameNotBound: 0 });
		// Twin: with no write the same class resolves Inner.m in both orders, so the refusal is the gate's.
		const twin = (bases: string) => ({
			"app.py": `class Outer:\n    class Inner:\n        def m(self):\n            pass\n    class F(Inner):\n        pass\nclass D(Outer.Inner):\n    pass\nclass E(${bases}):\n    pass\nE().m()\n`,
		});
		const fTwin = await observe(twin("Outer.F, D"));
		expect(fTwin).toEqual(await observe(twin("D, Outer.F")));
		expect(fTwin.edges).toEqual(["call app.py:11:1 -> app.py:Outer.Inner.m", "new app.py:11:1 -> app.py:E"]);
	});

	test("F3 (a89 round 1, a83 item 2): the neighbour attribute and the module read before and after the write", async () => {
		// The R1 fixture never read a neighbouring attribute of `m` or `m` itself across the write. Both orders must
		// agree, and both must be dev's: the written name refuses, the neighbour resolves.
		const files = (write: boolean) => ({
			"m.py": "class B:\n    def m(self):\n        pass\n    def n(self):\n        pass\ndef nn():\n    pass\n",
			"app.py": `import m\ndef before():\n    x = m.B()\n    x.n()\n    m.nn()\n${write ? "def other(self):\n    pass\nm.B = other\n" : ""}def after():\n    y = m.B()\n    y.n()\n    m.nn()\n`,
		});
		const written = await observe(files(true));
		// One `m.nn()` edge from each side of the write, line 5 and line 12, and the same refusal on both sides.
		expect(written.edges).toEqual(["call app.py:12:5 -> m.py:nn", "call app.py:5:5 -> m.py:nn"]);
		expect(written.bins).toEqual({ inRepo: 2, external: 0, receiver: 2, nameNotBound: 2 });
		const twin = await observe(files(false));
		expect(twin.edges).toEqual([
			"call app.py:4:5 -> m.py:B.n",
			"call app.py:5:5 -> m.py:nn",
			"call app.py:8:5 -> m.py:B.n",
			"call app.py:9:5 -> m.py:nn",
			"new app.py:3:9 -> m.py:B",
			"new app.py:7:9 -> m.py:B",
		]);
	});

	test("#16 N6: C.__init__ = other refuses the __init__ edge; the class construction edge stands", async () => {
		const files = (write: boolean) => ({
			"m.py": "class C:\n    def __init__(self):\n        pass\n    def m(self):\n        pass\n",
			"app.py": `from m import C\n${other}${write ? "C.__init__ = other\n" : ""}x = C()\nx.m()\n`,
		});
		// The constructor's method edge is refused; `C()` still constructs C, and the neighbour read stands.
		const written = await observe(files(true));
		expect(written.edges).toEqual(["call app.py:6:1 -> m.py:C.m", "new app.py:5:5 -> m.py:C"]);
		expect(written.bins).toEqual({ inRepo: 2, external: 0, receiver: 0, nameNotBound: 0 });
		const twin = await observe(files(false));
		expect(twin.edges).toEqual([
			"call app.py:5:1 -> m.py:C.m",
			"new app.py:4:5 -> m.py:C",
			"new app.py:4:5 -> m.py:C.__init__",
		]);
	});

	test("#16b: a class-level __init__ write on a local class refuses the __init__ edge too", async () => {
		const r = await observe({
			"app.py": `class C:\n    def __init__(self):\n        pass\n    def m(self):\n        pass\n${other}C.__init__ = other\nx = C()\nx.m()\n`,
		});
		expect(r.edges).toEqual(["call app.py:10:1 -> app.py:C.m", "new app.py:9:5 -> app.py:C"]);
	});

	test("#16 precision CONTROL (dev-passing): a __init__ write on a base the MRO's own def precedes does not refuse the constructor", async () => {
		const r = await observe({
			"app.py":
				"class A:\n    def __init__(self):\n        pass\nclass C(A):\n    def __init__(self):\n        pass\nclass App(C):\n    pass\ndef other(self):\n    pass\nA.__init__ = other\nx = App()\n",
		});
		// App's MRO reaches C's own def before A, so A's write is shadowed and the init edge to C.__init__ stands.
		expect(r.edges).toEqual(["new app.py:12:5 -> app.py:App", "new app.py:12:5 -> app.py:C.__init__"]);
	});
});

// GCLI-155 round 1 (DEC-303 (a86) item 1): the created-edge inputs the Opus reviewer found at 4e7e18b. The MRO is
// built write-blind, exactly as on dev; a base whose name a recorded write rebinds stays in it, marked GATED, and
// every lookup that reaches or crosses it refuses (never falls through to the next base); the write sets are
// collected with all three gates off, so no write is dropped by order or file name. Each fixture created an
// in-repo edge at 4e7e18b and refuses here, and each has its resolving twin. Comments record dev `1887cd0`'s full
// callees and bins, measured by the round-2 subset run.
describe("GCLI-155 round 1 — gated bases and write-collection order (DEC-303 (a86))", () => {
	const observe = async (files: Record<string, string>) => {
		const r = await analyze(Object.entries(files).map(([path, source]) => py(path, source)));
		const byId = new Map(r.symbols.map((x) => [x.id, x]));
		const callees = r.sites
			.map((s) => {
				const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
				return `${s.kind}:${c?.file}:${c?.qualname}`;
			})
			.sort();
		const b = r.callBins;
		return {
			callees,
			bins: {
				inRepo: b.resolvedInRepo,
				external: b.resolvedExternal,
				receiver: b.receiverNeedsInference,
				nameNotBound: b.nameNotBound,
			},
		};
	};

	test("R1 (a84 F1): a written base never falls through to the next base", async () => {
		const files = (write: boolean) => ({
			"m.py": "class C:\n    def __init__(self):\n        pass\n    def f(self):\n        pass\n",
			"app.py": `import m\nclass Mixin:\n    def __init__(self):\n        pass\n    def f(self):\n        pass\n${write ? "m.C = object\n" : ""}class D(m.C, Mixin):\n    def go(self):\n        self.f()\n        super(D, self).f()\nD().f()\nD()\n`,
		});
		// dev: call:m.py:C.f x3, new:app.py:D x2, new:m.py:C.__init__ x2; bins {5,1,0,0}. 4e7e18b: Mixin.f|extbase x2,
		// Mixin.__init__ x2 CREATED. Here the three f calls refuse and only the class edge stands; the init edge is
		// gone with the gated base.
		const written = await observe(files(true));
		expect(written.callees).toEqual(["new:app.py:D", "new:app.py:D"]);
		expect(written.bins).toEqual({ inRepo: 2, external: 1, receiver: 3, nameNotBound: 0 });
		const twin = await observe(files(false));
		expect(twin.callees).toEqual([
			"call:m.py:C.f",
			"call:m.py:C.f",
			"call:m.py:C.f",
			"new:app.py:D",
			"new:app.py:D",
			"new:m.py:C.__init__",
			"new:m.py:C.__init__",
		]);
	});

	test("R2 (a84 F2): an ancestor's write survives a written base (constructed receiver)", async () => {
		const mModule = (write: boolean) =>
			`class B:\n    def __init__(self):\n${write ? "        self.f = None\n" : "        pass\n"}`;
		const xModule = (write: boolean) =>
			`import m\n${write ? "m.B = object\n" : ""}class C(m.B):\n    def f(self):\n        pass\nC().f()\n`;
		// dev: new:m.py:B.__init__, new:x.py:C, receiver 1 (C().f() refused by B's write). 4e7e18b: C.f CREATED and
		// the B.__init__ edge lost. Here the refusal stands and only the init edge is gone.
		const written = await observe({ "m.py": mModule(true), "x.py": xModule(true) });
		expect(written.callees).toEqual(["new:x.py:C"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({ "m.py": mModule(false), "x.py": xModule(false) });
		expect(twin.callees).toEqual(["call:x.py:C.f", "new:m.py:B.__init__", "new:x.py:C"]);
	});

	test("R2b (a84 F2): the __class__ variant refuses too", async () => {
		const mModule = (write: boolean) =>
			`class B:\n    def __init__(self):\n${write ? "        self.__class__ = B\n" : "        pass\n"}`;
		const xModule = (write: boolean) =>
			`import m\n${write ? "m.B = object\n" : ""}class C(m.B):\n    def m(self):\n        pass\n    def go(self):\n        self.m()\n`;
		const written = await observe({ "m.py": mModule(true), "x.py": xModule(true) });
		// dev: no edges, receiver 1. 4e7e18b: x.py:C.m CREATED.
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({ "m.py": mModule(false), "x.py": xModule(false) });
		expect(twin.callees).toEqual(["call:x.py:C.m"]);
	});

	test("R2c (a84 F2): the self-receiver form refuses (the constructed form above masks it)", async () => {
		const mModule = "class B:\n    def __init__(self):\n        self.f = None\n";
		const written = await observe({
			"m.py": mModule,
			"x.py":
				"import m\nm.B = object\nclass C(m.B):\n    def f(self):\n        pass\n    def go(self):\n        self.f()\n",
		});
		// dev: no edges, receiver 1. 4e7e18b: x.py:C.f CREATED.
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({
			"m.py": "class B:\n    def __init__(self):\n        pass\n",
			"x.py": "import m\nclass C(m.B):\n    def f(self):\n        pass\n    def go(self):\n        self.f()\n",
		});
		expect(twin.callees).toEqual(["call:x.py:C.f"]);
	});

	test("R2d (a84 F2): the local-receiver form refuses too", async () => {
		const written = await observe({
			"m.py": "class B:\n    def __init__(self):\n        self.f = None\n",
			"x.py":
				"import m\nm.B = object\nclass C(m.B):\n    def f(self):\n        pass\ndef g():\n    x = C()\n    x.f()\n",
		});
		// dev: new:m.py:B.__init__, new:x.py:C, receiver 1. 4e7e18b: x.py:C.f CREATED.
		expect(written.callees).toEqual(["new:x.py:C"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({
			"m.py": "class B:\n    def __init__(self):\n        pass\n",
			"x.py": "import m\nclass C(m.B):\n    def f(self):\n        pass\ndef g():\n    x = C()\n    x.f()\n",
		});
		expect(twin.callees).toEqual(["call:x.py:C.f", "new:m.py:B.__init__", "new:x.py:C"]);
	});

	test("R3 (a84 F3): a cross-file write never hides a later class write, in either file order", async () => {
		const a = "class C:\n    def x(self):\n        pass\n    def go(self):\n        self.x()\n";
		const c = "from a import C\ndef o(self):\n    pass\nC.x = o\n";
		// dev: receiver 1 in both orders. 4e7e18b: a.py:C.x CREATED when b.py sorts before c.py.
		for (const others of [{ "b.py": "import a\na.C = object\n" }, { "z.py": "import a\na.C = object\n" }] as Record<
			string,
			string
		>[]) {
			const written = await observe({ "a.py": a, "c.py": c, ...others });
			expect(written.callees).toEqual([]);
			expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		}
		// The resolving twin drops the class write as well as the module write.
		const twin = await observe({
			"a.py": a,
			"b.py": "import a\n",
			"c.py": "from a import C\ndef o(self):\n    pass\n",
		});
		expect(twin.callees).toEqual(["call:a.py:C.x"]);
	});

	test("R4 (a84 F3): a same-file alias write is not hidden by a written module name", async () => {
		const z =
			"class C:\n    def m(self):\n        pass\n    def use(self):\n        self.m()\ndef o(self):\n    pass\nK = C\nK.m = o\n";
		const written = await observe({ "z.py": z, "b.py": "import z\nz.C = None\n" });
		// dev: no edges, receiver 1. 4e7e18b: z.py:C.m CREATED.
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		// The resolving twin drops the alias write as well as the module write.
		const twin = await observe({
			"z.py":
				"class C:\n    def m(self):\n        pass\n    def use(self):\n        self.m()\ndef o(self):\n    pass\nK = C\n",
			"b.py": "import z\n",
		});
		expect(twin.callees).toEqual(["call:z.py:C.m"]);
	});

	test("R5 (a84 F3): a class-attribute assignment does not drop the later dotted write", async () => {
		const head =
			"class Outer:\n    class Inner:\n        def m(self):\n            pass\n        def use(self):\n            self.m()\ndef o(self):\n    pass\n";
		const written = await observe({ "app.py": `${head}Outer.Inner = o\nOuter.Inner.m = o\n` });
		// dev: no edges, receiver 1. 4e7e18b: app.py:Outer.Inner.m CREATED (the m write was dropped by the gate).
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({ "app.py": head });
		expect(twin.callees).toEqual(["call:app.py:Outer.Inner.m"]);
	});

	test("R6 (a84 F4): a class-attribute base keeps dev's descendant read (B2 analogue)", async () => {
		const app = (write: boolean) =>
			`class Outer:\n    class Inner:\n        def m(self):\n            pass\n        def use(self):\n            k = self.__class__\n            k.m()\ndef other(self):\n    pass\n${write ? "Outer.Inner = other\n" : ""}class D(Outer.Inner):\n    __class__ = None\n`;
		const written = await observe({ "app.py": app(true) });
		// dev: no edges, receiver 1. 4e7e18b: app.py:Outer.Inner.m CREATED.
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		// The resolving twin drops the descendant's __class__ binding, so k = self.__class__ is Inner again.
		const twin = await observe({
			"app.py":
				"class Outer:\n    class Inner:\n        def m(self):\n            pass\n        def use(self):\n            k = self.__class__\n            k.m()\nclass D(Outer.Inner):\n    pass\n",
		});
		expect(twin.callees).toEqual(["call:app.py:Outer.Inner.m"]);
	});

	test("R7 (a84 F4): a class-attribute base refuses as receiver, never as an external claim", async () => {
		const app = (write: boolean) =>
			`class Outer:\n    class Inner:\n        def m(self):\n            pass\ndef other(self):\n    pass\n${write ? "Outer.Inner = other\n" : ""}class D(Outer.Inner):\n    pass\nD().m()\n`;
		const written = await observe({ "app.py": app(true) });
		// dev: call:app.py:Outer.Inner.m, new:app.py:D, bins {2,0,0,0}. 4e7e18b: the method claim became external
		// with a self or local receiver, and here the constructed receiver was already a receiver refusal.
		expect(written.callees).toEqual(["new:app.py:D"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({ "app.py": app(false) });
		expect(twin.callees).toEqual(["call:app.py:Outer.Inner.m", "new:app.py:D"]);
	});

	test("R7b (a84 F4): the self receiver refuses rather than claiming external", async () => {
		const app = (write: boolean) =>
			`class Outer:\n    class Inner:\n        def m(self):\n            pass\ndef other(self):\n    pass\n${write ? "Outer.Inner = other\n" : ""}class D(Outer.Inner):\n    def go(self):\n        self.m()\n`;
		const written = await observe({ "app.py": app(true) });
		// dev: call:app.py:Outer.Inner.m, bins {1,0,0,0}. 4e7e18b: bins {0,1,0,0}, an external claim.
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual({ inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 });
		const twin = await observe({ "app.py": app(false) });
		expect(twin.callees).toEqual(["call:app.py:Outer.Inner.m"]);
	});
});

// GCLI-155 round 1 (DEC-303 (a83) item 2 standing, (a86) item 1): reads of the written attribute, a NEIGHBOUR
// attribute on the same receiver, and the receiver itself, before and after the write, for the paths that lacked
// them; #9b's fixture; and order-blindness (a read before its write refuses exactly as after it).
describe("GCLI-155 round 1 — item-2 reads, #9b and order", () => {
	const observe = async (files: Record<string, string>) => {
		const r = await analyze(Object.entries(files).map(([path, source]) => py(path, source)));
		const byId = new Map(r.symbols.map((x) => [x.id, x]));
		const callees = r.sites
			.map((s) => {
				const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
				return `${s.kind}:${c?.file}:${c?.qualname}`;
			})
			.sort();
		const b = r.callBins;
		return {
			callees,
			bins: {
				inRepo: b.resolvedInRepo,
				external: b.resolvedExternal,
				receiver: b.receiverNeedsInference,
				nameNotBound: b.nameNotBound,
			},
		};
	};

	test("#9b CONTROL (dev-equal at this head): a descendant with a written base and no __class__ binding keeps both reads", async () => {
		// dev: call:m.py:C.m x2, bins {2,0,0,0}. 4e7e18b: the k.m() edge was removed (the opaque base failed closed
		// on self.__class__). The write-blind MRO restores dev's answer exactly, so #9b is no longer a removal.
		const r = await observe({
			"m.py":
				"class C:\n    def m(self):\n        pass\n    def use(self):\n        k = self.__class__\n        k.m()\n        self.m()\n",
			"app.py": "import m\ndef other(self):\n    pass\nm.C = other\nclass D(m.C):\n    pass\n",
		});
		expect(r.callees).toEqual(["call:m.py:C.m", "call:m.py:C.m"]);
		expect(r.bins).toEqual({ inRepo: 2, external: 0, receiver: 0, nameNotBound: 0 });
	});

	test("#8 item 2: the written super() first argument refuses, its neighbour n() refuses, and self.m() resolves", async () => {
		const mClass =
			"class A:\n    def m(self):\n        pass\n    def n(self):\n        pass\nclass C(A):\n    def m(self):\n        pass\n    def n(self):\n        pass\n";
		const app = (write: boolean) =>
			`import m\ndef other(self):\n    pass\n${write ? "m.C = other\n" : ""}class B(m.A):\n    def m(self):\n        pass\n    def go(self):\n        super(m.C, self).m()\n        super(m.C, self).n()\n    def k(self):\n        self.m()\n`;
		// dev: call:app.py:B.m, call:m.py:A.m, call:m.py:A.n, bins {3,2,0,0}.
		const written = await observe({ "m.py": mClass, "app.py": app(true) });
		expect(written.callees).toEqual(["call:app.py:B.m"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 2, receiver: 2, nameNotBound: 0 });
		const twin = await observe({ "m.py": mClass, "app.py": app(false) });
		expect(twin.callees).toEqual(["call:app.py:B.m", "call:m.py:A.m", "call:m.py:A.n"]);
		expect(twin.bins).toEqual({ inRepo: 3, external: 2, receiver: 0, nameNotBound: 0 });
	});

	test("#10 item 2: an unresolved super() first argument refuses for m() and its neighbour n(); self.m() resolves", async () => {
		// dev: call:app.py:B.m, call:app.py:B.n (the enclosing-class fallback), call:app.py:D.m, bins {3,2,0,0}.
		const written = await observe({
			"app.py":
				"from ext import Base\nclass B:\n    def m(self):\n        pass\n    def n(self):\n        pass\nclass D(B):\n    def m(self):\n        pass\n    def go(self):\n        super(Base, self).m()\n        super(Base, self).n()\n    def k(self):\n        self.m()\n",
		});
		expect(written.callees).toEqual(["call:app.py:D.m"]);
		expect(written.bins).toEqual({ inRepo: 1, external: 2, receiver: 2, nameNotBound: 0 });
		const twin = await observe({
			"app.py":
				"class B:\n    def m(self):\n        pass\n    def n(self):\n        pass\nclass Base(B):\n    def m(self):\n        pass\n    def n(self):\n        pass\nclass D(B):\n    def m(self):\n        pass\n    def go(self):\n        super(Base, self).m()\n        super(Base, self).n()\n    def k(self):\n        self.m()\n",
		});
		expect(twin.callees).toEqual(["call:app.py:B.m", "call:app.py:B.n", "call:app.py:D.m"]);
		expect(twin.bins).toEqual({ inRepo: 3, external: 2, receiver: 0, nameNotBound: 0 });
	});

	test("#14 item 2: the written decorator refuses, the neighbour decorator and the receiver call resolve", async () => {
		const app = (write: boolean) =>
			`class C:\n    def m(self, dec):\n        return dec\n    def n(self, dec):\n        return dec\n${write ? "def other(dec):\n    return dec\nC.m = other\n" : ""}@C.m\ndef g():\n    pass\n@C.n\ndef h():\n    pass\nx = C()\nx.n()\n`;
		// dev: call:app.py:C.n, decorator:app.py:C.m, decorator:app.py:C.n, new:app.py:C, bins {2,0,0,0}.
		const written = await observe({ "app.py": app(true) });
		expect(written.callees).toEqual(["call:app.py:C.n", "decorator:app.py:C.n", "new:app.py:C"]);
		expect(written.bins).toEqual({ inRepo: 2, external: 0, receiver: 0, nameNotBound: 0 });
		const twin = await observe({ "app.py": app(false) });
		expect(twin.callees).toEqual(["call:app.py:C.n", "decorator:app.py:C.m", "decorator:app.py:C.n", "new:app.py:C"]);
		expect(twin.bins).toEqual({ inRepo: 2, external: 0, receiver: 0, nameNotBound: 0 });
	});

	test("#5 order: inst.m() read BEFORE inst.m = other refuses exactly as after it", async () => {
		const r = await observe({
			"m.py": "class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\ninst = C()\n",
			"app.py": "from m import inst\ndef other(self):\n    pass\ninst.m()\ninst.n()\ninst.m = other\n",
		});
		expect(r.callees).toEqual(["call:m.py:C.n", "new:m.py:C"]);
		expect(r.bins).toEqual({ inRepo: 2, external: 0, receiver: 1, nameNotBound: 0 });
	});

	test("#7 order: x.m() read BEFORE m.C = other refuses exactly as after it", async () => {
		const r = await observe({
			"m.py": "class C:\n    def m(self):\n        pass\n    def n(self):\n        pass\n",
			"app.py": "import m\ndef other(self):\n    pass\nclass X(m.C):\n    pass\nx = X()\nx.m()\nx.n()\nm.C = other\n",
		});
		expect(r.callees).toEqual(["new:app.py:X"]);
		expect(r.bins).toEqual({ inRepo: 1, external: 0, receiver: 2, nameNotBound: 0 });
	});

	test("#14 order: a decorator BEFORE C.m = other refuses exactly as after it", async () => {
		const r = await observe({
			"app.py":
				"class C:\n    def m(self, dec):\n        return dec\ndef other(dec):\n    return dec\n@C.m\ndef g():\n    pass\nC.m = other\n",
		});
		expect(r.callees).toEqual([]);
		expect(r.bins).toEqual({ inRepo: 0, external: 0, receiver: 0, nameNotBound: 0 });
	});
});

// GCLI-155 round 1 (DEC-303 (a86) item 1, (a29)): a constructed receiver whose class has a GATED base fails closed,
// even when the class defines the method itself, because the base may be another object with its own __new__ or
// metaclass. The direct self receiver still resolves its own class's def.
describe("GCLI-155 round 1 — constructed receivers over a gated base", () => {
	test("R1b: D().f() refuses where D defines f itself; self.f() resolves", async () => {
		const r = await analyze([
			py("m.py", "class C:\n    def f(self):\n        pass\n"),
			py(
				"app.py",
				"import m\ndef other(self):\n    pass\nm.C = object\nclass D(m.C):\n    def f(self):\n        pass\n    def go(self):\n        self.f()\nD().f()\n",
			),
		]);
		const byId = new Map(r.symbols.map((x) => [x.id, x]));
		const callees = r.sites
			.map((s) => {
				const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
				return `${s.kind}:${c?.file}:${c?.qualname}`;
			})
			.sort();
		// dev: call:app.py:D.f x2, new:app.py:D, bins {3,0,0,0}; the constructed receiver's own-def hit is kept by
		// instanceClassOf alone, so this fixture is what turns that check red when it is removed.
		expect(callees).toEqual(["call:app.py:D.f", "new:app.py:D"]);
		expect(r.callBins).toEqual({
			resolvedInRepo: 2,
			resolvedExternal: 0,
			receiverNeedsInference: 1,
			nameNotBound: 0,
		});
	});
});

// GCLI-155 round 1 (DEC-303 (a84) F4): the local receiver's wrong external claim.
describe("GCLI-155 round 1 — class-attribute base, local receiver", () => {
	test("R7c: a local x = D(); x.m() refuses rather than claiming external", async () => {
		const app = (write: boolean) =>
			`class Outer:\n    class Inner:\n        def m(self):\n            pass\ndef other(self):\n    pass\n${write ? "Outer.Inner = other\n" : ""}class D(Outer.Inner):\n    pass\ndef g():\n    x = D()\n    x.m()\n`;
		const observe = async (source: string) => {
			const r = await analyze([py("app.py", source)]);
			const byId = new Map(r.symbols.map((x) => [x.id, x]));
			const callees = r.sites
				.map((s) => {
					const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
					return `${s.kind}:${c?.file}:${c?.qualname}`;
				})
				.sort();
			return { callees, bins: r.callBins };
		};
		// 4e7e18b: new:app.py:D, bins {1,1,0,0} — an external claim with no edge. dev: Inner.m + D, bins {2,0,0,0}.
		const written = await observe(app(true));
		expect(written.callees).toEqual(["new:app.py:D"]);
		expect(written.bins).toEqual({
			resolvedInRepo: 1,
			resolvedExternal: 0,
			receiverNeedsInference: 1,
			nameNotBound: 0,
		});
		const twin = await observe(app(false));
		expect(twin.callees).toEqual(["call:app.py:Outer.Inner.m", "new:app.py:D"]);
	});
});
describe("GCLI-156 — a write on an in-repo descendant (DEC-303 (a88), shape #6)", () => {
	// The MRO guard in `methodLookup` walks the RECEIVER's own MRO, so a write recorded on a descendant was invisible:
	// `B.m` resolved from B's own `self.m()` even though a `C(B)` instance wrote `self.m`. The guard now propagates
	// over `descendantsOf`, which is already computed, and only removes an edge (removal-only, fail-closed).
	const observe = async (files: Record<string, string>) => {
		const r = await analyze(Object.entries(files).map(([path, source]) => py(path, source)));
		const byId = new Map(r.symbols.map((x) => [x.id, x]));
		const callees = r.sites
			.map((s) => {
				const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
				return `${s.kind}:${c?.file}:${c?.qualname}`;
			})
			.sort();
		return { callees, bins: r.callBins };
	};
	const REFUSED = { resolvedInRepo: 0, resolvedExternal: 0, receiverNeedsInference: 1, nameNotBound: 0 };
	const RESOLVED = { resolvedInRepo: 1, resolvedExternal: 0, receiverNeedsInference: 0, nameNotBound: 0 };
	const base = (tail: string) =>
		`class B:\n    def m(self):\n        return 1\n    def call(self):\n        self.m()\n${tail}`;

	test("#6 same module: a subclass instance write leaves the base call unresolved (dev: B.m)", async () => {
		const written = await observe({
			"app.py": base("\nclass C(B):\n    def setup(self):\n        self.m = lambda: 2\n"),
		});
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual(REFUSED);
	});

	test("#6 twin: a descendant that writes another attribute keeps the edge", async () => {
		const twin = await observe({ "app.py": base("\nclass C(B):\n    def setup(self):\n        self.other = 2\n") });
		expect(twin.callees).toEqual(["call:app.py:B.m"]);
		expect(twin.bins).toEqual(RESOLVED);
	});

	test("#6 twin: no descendant, and an unrelated class's write, keep the edge", async () => {
		expect(await observe({ "app.py": base("") })).toEqual({ callees: ["call:app.py:B.m"], bins: RESOLVED });
		const unrelated = await observe({
			"app.py": base("\nclass Z:\n    def setup(self):\n        self.m = lambda: 2\n"),
		});
		expect(unrelated).toEqual({ callees: ["call:app.py:B.m"], bins: RESOLVED });
	});

	test("#6 cross module: a descendant in another module's write refuses too", async () => {
		const written = await observe({
			"app.py": base(""),
			"c.py": "from app import B\nclass C(B):\n    def setup(self):\n        self.m = 2\n",
		});
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual(REFUSED);
	});

	test("#6 two levels down: the descendant relation is transitive", async () => {
		const written = await observe({
			"app.py": base("\nclass C(B):\n    pass\n\nclass D(C):\n    def setup(self):\n        self.m = 3\n"),
		});
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual(REFUSED);
	});

	test("#6 class-level descendant write (C.m = other) refuses as well", async () => {
		const written = await observe({ "app.py": base("\nclass C(B):\n    pass\nC.m = lambda self: 2\n") });
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual(REFUSED);
	});

	test("#6 super() is not the instance dict: a descendant write keeps super().m() resolving (dev: A.m)", async () => {
		const r = await observe({
			"app.py":
				"class A:\n    def m(self):\n        return 1\n\nclass B(A):\n    def m(self):\n        return super().m()\n\nclass C(B):\n    def setup(self):\n        self.m = 3\n",
		});
		expect(r.callees).toEqual(["call:app.py:A.m"]);
		// `super()` itself is a builtin call and counts external; the method call is the in-repo edge.
		expect(r.bins).toEqual({ resolvedInRepo: 1, resolvedExternal: 1, receiverNeedsInference: 0, nameNotBound: 0 });
	});

	test("#6 (a83 item 2): a neighbour read and both receiver constructions are unchanged across the write", async () => {
		// F3's pattern: the fixture must read a NEIGHBOUR on the same receiver and construct the receivers, before and
		// after the write. The write changes only B.m; `n` and both constructions agree on both sides.
		const body = (write: boolean) =>
			`class B:\n    def m(self):\n        return 1\n    def n(self):\n        return 2\n    def call(self):\n        self.m()\n        self.n()\n\ndef before():\n    b = B()\n    b.n()\n\nclass C(B):\n    def setup(self):\n${write ? "        self.m = lambda: 2\n" : "        pass\n"}\ndef after():\n    c = C()\n    c.n()\n`;
		const written = await observe({ "app.py": body(true) });
		const twin = await observe({ "app.py": body(false) });
		expect(written.callees).toEqual([
			"call:app.py:B.n",
			"call:app.py:B.n",
			"call:app.py:B.n",
			"new:app.py:B",
			"new:app.py:C",
		]);
		expect(twin.callees).toEqual([
			"call:app.py:B.m",
			"call:app.py:B.n",
			"call:app.py:B.n",
			"call:app.py:B.n",
			"new:app.py:B",
			"new:app.py:C",
		]);
		expect(written.bins).toEqual({
			resolvedInRepo: 5,
			resolvedExternal: 0,
			receiverNeedsInference: 1,
			nameNotBound: 0,
		});
		expect(twin.bins).toEqual({ resolvedInRepo: 6, resolvedExternal: 0, receiverNeedsInference: 0, nameNotBound: 0 });
	});

	test("#6 N-d: a write on an opaque base's name is the conservative bin change, named here (dict base)", async () => {
		// dev: external/external-base. head: receiver/needs-inference. A C instance really does have a second
		// binding, so this is the conservative direction, not 3b1ace3's.
		const files = (write: boolean) => ({
			"app.py": `class B(dict):\n    def call(self):\n        self.keys()\n\nclass C(B):\n    def setup(self):\n${write ? "        self.keys = 2\n" : "        self.other = 2\n"}`,
		});
		const written = await observe(files(true));
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual(REFUSED);
		const twin = await observe(files(false));
		expect(twin.callees).toEqual([]);
		expect(twin.bins).toEqual({ resolvedInRepo: 0, resolvedExternal: 1, receiverNeedsInference: 0, nameNotBound: 0 });
	});

	test("#6 N-d: the same bin change over an opaque external base", async () => {
		const files = (write: boolean) => ({
			"app.py": `from ext import Base\nclass B(Base):\n    def call(self):\n        self.keys()\n\nclass C(B):\n    def setup(self):\n${write ? "        self.keys = 2\n" : "        self.other = 2\n"}`,
		});
		const written = await observe(files(true));
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual(REFUSED);
		const twin = await observe(files(false));
		expect(twin.callees).toEqual([]);
		expect(twin.bins).toEqual({ resolvedInRepo: 0, resolvedExternal: 1, receiverNeedsInference: 0, nameNotBound: 0 });
	});
});

describe("#245 N1 — the reviewer's star-imported head shape, measured", () => {
	// The reviewer predicted dev external-base -> head receiver/rebound-base for this shape (s.py `import m`; x.py
	// `from s import *` then `class K(m.B)` with m.B multiply-bound; w.py `s.m = None`), from reading the code without
	// a shell. Measured on dev 58255fc and on this head, BOTH sides answer receiver/needs-inference with reason
	// rebound-base, with and without the write, so the shape is dev-equal. It is pinned as a measured fixture and is
	// NOT a red-before; N1 closes on that measurement, not on a divergence.
	const files = (write: boolean) => ({
		"m.py": "try:\n    from ext import B\nexcept ImportError:\n    from ext2 import B\n",
		"s.py": "import m\n",
		"x.py": "from s import *\nclass K(m.B):\n    def go(self):\n        self.g()\n",
		"w.py": `import s\n${write ? "s.m = None\n" : ""}`,
	});
	const observe = async (source: Record<string, string>) => {
		const r = await analyze(Object.entries(source).map(([path, text]) => py(path, text)));
		return {
			bins: r.callBins,
			reasons: (r.unresolvedReceiverReasons ?? []).map((x) => `${x.reason}:${x.count}`),
			edges: r.sites
				.filter((s) => s.calleeId !== null)
				.map((s) => r.symbols.find((x) => x.id === s.calleeId)?.qualname)
				.filter((q): q is string => q !== undefined),
		};
	};

	test("N1: the star-imported head is dev-equal, receiver/rebound-base with and without the write", async () => {
		const written = await observe(files(true));
		expect(written.edges).toEqual([]);
		expect(written.bins).toEqual({
			resolvedInRepo: 0,
			resolvedExternal: 0,
			receiverNeedsInference: 1,
			nameNotBound: 0,
		});
		expect(written.reasons).toEqual(["rebound-base:1"]);
		expect(await observe(files(false))).toEqual(written);
	});
});

describe("GCLI-164 — #4 re-dispatch (class-body lazy) and N8 diamond super", () => {
	const observe = async (files: Record<string, string>) => {
		const r = await analyze(Object.entries(files).map(([path, source]) => py(path, source)));
		const byId = new Map(r.symbols.map((x) => [x.id, x]));
		const callees = r.sites
			.map((s) => {
				const c = s.calleeId === null ? undefined : byId.get(s.calleeId);
				return `${s.kind}:${c?.file}:${c?.qualname}`;
			})
			.sort();
		return { callees, bins: r.callBins };
	};

	test("#4 F1: class-body type(x).m = helper() reads its value exactly as dev does", async () => {
		// Measured on dev 58255fc, on 98e09e7 (the removed re-dispatch) and on this head: all three agree on both
		// shapes. A class-body import AFTER the write is refused (name-not-bound: the binding is later); a def AFTER
		// the write resolves to it (C.helper). The re-dispatch records the write and leaves the value on the shared
		// lazy class-body path, so this stays dev-equal. The reported F1 helper edge did not reproduce on any of the
		// three implementations by either shape, so this fixture pins dev's answer and is not a red-before.
		const lib = { "lib.py": "def helper():\n    pass\n" };
		const importLater = await observe({
			...lib,
			"app.py": "class C:\n    type(x).m = helper()\n    from lib import helper\n",
		});
		expect(importLater.callees).toEqual([]);
		expect(importLater.bins).toEqual({
			resolvedInRepo: 0,
			resolvedExternal: 0,
			receiverNeedsInference: 0,
			nameNotBound: 1,
		});
		const defLater = await observe({
			"app.py": "class C:\n    type(x).m = helper()\n    def helper(self):\n        pass\n",
		});
		expect(defLater.callees).toEqual(["call:app.py:C.helper"]);
		const twin = await observe({
			...lib,
			"app.py": "class C:\n    type A = helper()\n    from lib import helper\n",
		});
		expect(twin).toEqual(importLater);
	});

	test("#4 a shadowed type is not the builtin: no write, the read resolves", async () => {
		const r = await observe({
			"app.py":
				"class C:\n    def m(self):\n        pass\n    def write(self):\n        def type(v):\n            return v\n        type(self).m = other\n    def use(self):\n        self.m()\ndef other(self):\n    pass\n",
		});
		expect(r.callees).toEqual(["call:app.py:C.m"]);
	});

	const diamond = (order: string) =>
		`class A:\n    def m(self):\n        return 1\nclass B(A):\n    def m(self):\n        return super().m()\nclass C(A):\n    def m(self):\n        return 2\nclass D(${order}):\n    pass\n`;

	test("N8: the diamond D(B, C) refuses B's super() (dev: A.m, a D instance reaches C.m)", async () => {
		const written = await observe({ "app.py": diamond("B, C") });
		expect(written.callees).toEqual([]);
		expect(written.bins).toEqual({
			resolvedInRepo: 0,
			resolvedExternal: 1,
			receiverNeedsInference: 1,
			nameNotBound: 0,
		});
	});

	test("N8: D(C, B) keeps the edge — its MRO orders A after B exactly as B's own does", async () => {
		const r = await observe({ "app.py": diamond("C, B") });
		expect(r.callees).toEqual(["call:app.py:A.m"]);
	});

	test("N8 twins: a linear descendant, no descendant, and an unrelated class all resolve", async () => {
		const linear = await observe({
			"app.py":
				"class A:\n    def m(self):\n        return 1\nclass B(A):\n    def m(self):\n        return super().m()\nclass D(B):\n    pass\n",
		});
		expect(linear.callees).toEqual(["call:app.py:A.m"]);
		const none = await observe({
			"app.py":
				"class A:\n    def m(self):\n        return 1\nclass B(A):\n    def m(self):\n        return super().m()\n",
		});
		expect(none.callees).toEqual(["call:app.py:A.m"]);
		const unrelated = await observe({
			"app.py":
				"class A:\n    def m(self):\n        return 1\nclass B(A):\n    def m(self):\n        return super().m()\nclass Z:\n    pass\n",
		});
		expect(unrelated.callees).toEqual(["call:app.py:A.m"]);
	});

	test("N8: the two-argument super(B, self) refuses on a reordering descendant too", async () => {
		const r = await observe({
			"app.py":
				"class A:\n    def m(self):\n        return 1\nclass B(A):\n    def m(self):\n        return super(B, self).m()\nclass C(A):\n    def m(self):\n        return 2\nclass D(B, C):\n    pass\n",
		});
		expect(r.callees).toEqual([]);
	});
});
