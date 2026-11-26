import { describe, expect, test } from "bun:test";
import { analyzePythonCalls, type PythonCallsResult } from "../src/python/calls.ts";
import type { PythonModuleInput } from "../src/python/modules.ts";

// GCLI-119 (TS, DEC-303 (a22) item 3, (a23)): a local with exactly ONE binding, a plain unannotated
// `type(self)` or `self.__class__` where self is the method's receiver parameter (rule 26), is
// treated as cls: `k.meth()` is looked up on the enclosing class's MRO as `cls.meth()` is.

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

const idOf = (result: PythonCallsResult, qualname: string): string => {
	const found = result.symbols.find((symbol) => symbol.qualname === qualname);
	if (found === undefined) throw new Error(`no symbol ${qualname}`);
	return found.id;
};

type Delta = { inRepo: number; external: number; receiver: number; nameNotBound: number };

/** `CALL` is `k.meth()` in the with-source and `pass` in the without-source: the exact bin delta of the call. */
async function probe(source: string, extra: PythonModuleInput[] = []) {
	const withCall = await analyze([py("app.py", source.replace("CALL", "k.meth()")), ...extra]);
	const without = await analyze([py("app.py", source.replace("CALL", "pass")), ...extra]);
	const delta: Delta = {
		inRepo: withCall.callBins.resolvedInRepo - without.callBins.resolvedInRepo,
		external: withCall.callBins.resolvedExternal - without.callBins.resolvedExternal,
		receiver: withCall.callBins.receiverNeedsInference - without.callBins.receiverNeedsInference,
		nameNotBound: withCall.callBins.nameNotBound - without.callBins.nameNotBound,
	};
	const meths = new Set(withCall.symbols.filter((s) => s.qualname.endsWith(".meth")).map((s) => s.id));
	const sites = withCall.sites.filter((site) => site.calleeId !== null && meths.has(site.calleeId));
	return { delta, sites, result: withCall };
}

const RESOLVED: Delta = { inRepo: 1, external: 0, receiver: 0, nameNotBound: 0 };
const REFUSED: Delta = { inRepo: 0, external: 0, receiver: 1, nameNotBound: 0 };

const C = "class C:\n    def meth(self):\n        pass\n";

/** A method body holding `CALL`, with `prelude` lines (indented 8) before it. */
const inMethod = (prelude: string, tail = ""): string =>
	`${C}    def run(self):\n${prelude
		.split("\n")
		.map((line) => `        ${line}`)
		.join("\n")}\n        CALL\n${tail}`;

describe("TS — a local bound once to type(self) or self.__class__ is cls", () => {
	for (const [form, rhs] of [
		["type(self)", "type(self)"],
		["self.__class__", "self.__class__"],
	] as const) {
		test(`k = ${form}; k.meth() resolves to C.meth, one in-repo call and nothing else`, async () => {
			const { delta, sites, result } = await probe(inMethod(`k = ${rhs}`));
			expect(delta).toEqual(RESOLVED);
			expect(sites.map((s) => s.calleeId)).toEqual([idOf(result, "C.meth")]);
			expect(sites[0]?.polymorphic).toBeUndefined();
		});

		test(`k = ${form}: a subclass override flags the edge polymorphic, as cls.meth() does`, async () => {
			const source = `${inMethod(`k = ${rhs}`)}class D(C):\n    def meth(self):\n        pass\n`;
			const { delta, sites, result } = await probe(source);
			expect(delta).toEqual(RESOLVED);
			expect(sites.map((s) => s.calleeId)).toEqual([idOf(result, "C.meth")]);
			expect(sites[0]?.polymorphic).toBe(true);
			// the reference: the same lookup through a classmethod's cls
			const ref = await analyze([
				py(
					"app.py",
					`${C}    @classmethod\n    def make(cls):\n        cls.meth()\nclass D(C):\n    def meth(self):\n        pass\n`,
				),
			]);
			const refSite = ref.sites.find((s) => s.calleeId === idOf(ref, "C.meth"));
			expect(refSite?.polymorphic).toBe(true);
		});

		test(`k = ${form}: the method is inherited, so the edge goes to the base`, async () => {
			const source = `class B:\n    def meth(self):\n        pass\nclass C(B):\n    def run(self):\n        k = ${rhs}\n        CALL\n`;
			const { delta, sites, result } = await probe(source);
			expect(delta).toEqual(RESOLVED);
			expect(sites.map((s) => s.calleeId)).toEqual([idOf(result, "B.meth")]);
		});
	}

	test("a closure and a comprehension read the local (the enumeration sees it)", async () => {
		const closure = await probe(inMethod("k = type(self)\ndef g():\n    CALL\ng()"));
		expect(closure.delta).toEqual(RESOLVED);
		const comp = await probe(inMethod("k = self.__class__\nwork = [CALL for _ in [1]]"));
		expect(comp.delta).toEqual(RESOLVED);
	});

	test("the receiver may have any name (rule 26)", async () => {
		const { delta } = await probe(`${C}    def run(me):\n        k = type(me)\n        CALL\n`);
		expect(delta).toEqual(RESOLVED);
	});

	test("the reference tqdm shape: cls = type(self) then cls.attr() and cls.factory()", async () => {
		const source =
			"class T:\n    def __new__(cls):\n        return object.__new__(cls)\n    def factory(self):\n        pass\n    def __init__(self):\n        cls = type(self)\n        cls.factory()\n";
		const result = await analyze([py("app.py", source)]);
		const sites = result.sites.filter((s) => s.calleeId === idOf(result, "T.factory"));
		expect(sites.length).toBe(1);
	});
});

describe("TS — every binding of the local must be the one type(self) or self.__class__", () => {
	const refusedCases: Record<string, string> = {
		"a second type(self) binding": inMethod("k = type(self)\nk = type(self)"),
		"a rebind to another value": inMethod("k = type(self)\nk = None"),
		"a rebind to a class": inMethod("k = type(self)\nk = C"),
		"a rebind in an if arm": inMethod("k = type(self)\nif self:\n    k = int"),
		"a del": inMethod("k = type(self)\ndel k\nk = type(self)"),
		"an augmented assignment": inMethod("k = type(self)\nk += 1"),
		"a for target": inMethod("k = type(self)\nfor k in []:\n    pass"),
		"a with-as": inMethod("k = type(self)\nwith open('f') as k:\n    pass"),
		"a walrus": inMethod("k = type(self)\n(k := 1)"),
		"an except-as": inMethod("k = type(self)\ntry:\n    pass\nexcept Exception as k:\n    pass"),
		"a tuple target": inMethod("k = type(self)\nk, w = 1, 2"),
		"an annotated binding": inMethod("k: type = type(self)"),
		"an annotated twin of self.__class__": inMethod("k: object = self.__class__"),
		"a local import": inMethod("k = type(self)\nimport k"),
		"a nonlocal write from a nested def": inMethod("k = type(self)\ndef g():\n    nonlocal k\n    k = None\ng()"),
		"a nonlocal write that is itself type(self)": inMethod(
			"k = type(self)\ndef g():\n    nonlocal k\n    k = type(self)\ng()",
		),
		"a global declaration between the read and the local": inMethod(
			"k = type(self)\ndef g():\n    global k\n    CALL\ng()",
		),
		"a parameter named k": `${C}    def run(self, k=None):\n        CALL\n`,
		"a parameter named k, then type(self)": `${C}    def run(self, k):\n        k = type(self)\n        CALL\n`,
		"a type(other) that is not the receiver": `${C}    def run(self, other):\n        k = type(other)\n        CALL\n`,
		"other.__class__ that is not the receiver": `${C}    def run(self, other):\n        k = other.__class__\n        CALL\n`,
		"type with two arguments": inMethod("k = type(self, 1)"),
		"type with a keyword argument": inMethod("k = type(object=self)"),
		"type of an attribute": inMethod("k = type(self.x)"),
		"self.__class__.__class__": inMethod("k = self.__class__.__class__"),
		"a call of the class": inMethod("k = type(self)()"),
	};
	for (const [label, source] of Object.entries(refusedCases)) {
		test(`refused: ${label}`, async () => {
			const { delta, sites } = await probe(source);
			expect(sites).toEqual([]);
			expect(delta).toEqual(REFUSED);
		});
	}

	test("a nested-def read of a local the nested def also writes (its own local) refuses", async () => {
		const { delta, sites } = await probe(inMethod("k = type(self)\ndef g():\n    k = None\n    CALL\ng()"));
		expect(sites).toEqual([]);
		expect(delta).toEqual(REFUSED);
	});
});

describe("TS — the receiver, type and self must be what the rule names", () => {
	test("a shadowed builtin type refuses: a module binding, a local binding, a from-import, a star import", async () => {
		const body = "    def run(self):\n        k = type(self)\n        CALL\n";
		for (const [label, head] of [
			["module def", "def type(x):\n    return x\n"],
			["module assignment", "type = lambda x: x\n"],
			["from-import", "from other import type\n"],
		] as const) {
			const { delta, sites } = await probe(`${head}${C}${body}`, [py("other.py", "def type(x):\n    pass\n")]);
			expect(sites, label).toEqual([]);
			expect(delta, label).toEqual(REFUSED);
		}
		const local = await probe(
			`${C}    def run(self):\n        type = lambda x: x\n        k = type(self)\n        CALL\n`,
		);
		expect(local.sites).toEqual([]);
		expect(local.delta).toEqual(REFUSED);
		const star = await probe(`from other import *\n${C}${body}`, [py("other.py", "def type(x):\n    pass\n")]);
		expect(star.sites).toEqual([]);
		expect(star.delta).toEqual(REFUSED);
	});

	test("the shadowed-type twin: self.__class__ does not read type, so a shadowed type does not refuse it", async () => {
		const { delta } = await probe(`type = None\n${inMethod("k = self.__class__")}`);
		expect(delta).toEqual(RESOLVED);
	});

	test("a rebound receiver refuses", async () => {
		const rebound = await probe(
			`${C}    def run(self):\n        self = other()\n        k = type(self)\n        CALL\n`,
		);
		expect(rebound.sites).toEqual([]);
		expect(rebound.delta).toEqual(REFUSED);
		const deleted = await probe(`${C}    def run(self):\n        k = type(self)\n        del self\n        CALL\n`);
		expect(deleted.sites).toEqual([]);
		expect(deleted.delta).toEqual(REFUSED);
	});

	test("a classmethod's type(cls) is its metaclass and refuses; its self-like twin in an instance method resolves", async () => {
		const meta = await probe(`${C}    @classmethod\n    def run(cls):\n        k = type(cls)\n        CALL\n`);
		expect(meta.sites).toEqual([]);
		expect(meta.delta).toEqual(REFUSED);
		const metaClass = await probe(`${C}    @classmethod\n    def run(cls):\n        k = cls.__class__\n        CALL\n`);
		expect(metaClass.sites).toEqual([]);
		expect(metaClass.delta).toEqual(REFUSED);
	});

	test("a staticmethod or a module function has no receiver and refuses", async () => {
		const stat = await probe(`${C}    @staticmethod\n    def run(x):\n        k = type(x)\n        CALL\n`);
		expect(stat.sites).toEqual([]);
		expect(stat.delta).toEqual(REFUSED);
		const fn = await probe(`${C}def run(self):\n    k = type(self)\n    CALL\n`);
		expect(fn.sites).toEqual([]);
		expect(fn.delta).toEqual(REFUSED);
	});

	test("an unknown method on the class stays unresolved, in the same bin as self.unknown() (negative control)", async () => {
		const unknown = async (rhs: string, call: string, base = "") => {
			const withCall = await analyze([
				py(
					"app.py",
					`${base}class C${base === "" ? "" : "(B)"}:\n    def run(self):\n        k = ${rhs}\n        ${call}\n`,
				),
			]);
			const without = await analyze([
				py(
					"app.py",
					`${base}class C${base === "" ? "" : "(B)"}:\n    def run(self):\n        k = ${rhs}\n        pass\n`,
				),
			]);
			const bins = (r: PythonCallsResult) => r.callBins;
			const d = (key: "resolvedInRepo" | "resolvedExternal" | "receiverNeedsInference" | "nameNotBound") =>
				bins(withCall)[key] - bins(without)[key];
			expect(withCall.sites.filter((x) => x.calleeId !== null && x.line === 4)).toEqual([]);
			return { inRepo: d("resolvedInRepo"), external: d("resolvedExternal"), receiver: d("receiverNeedsInference") };
		};
		for (const base of ["", "class B:\n    pass\n", "class B(dict):\n    pass\n", "from nowhere import B\n"]) {
			const viaLocal = await unknown("type(self)", "k.unknown()", base);
			const viaSelf = await unknown("type(self)", "self.unknown()", base);
			expect(viaLocal, JSON.stringify(base)).toEqual(viaSelf);
		}
		// pinned shapes: no base is an instance attribute (receiver bin); a builtin base resolves external (the bin move)
		expect(await unknown("type(self)", "k.unknown()")).toMatchObject({ inRepo: 0, receiver: 1 });
		expect(await unknown("type(self)", "k.unknown()", "class B(dict):\n    pass\n")).toMatchObject({
			inRepo: 0,
			external: 1,
			receiver: 0,
		});
	});

	test("a local at module level or in a class body is not rule TS's (the function-scope guard is an equivalent mutant: receiverOf is null there)", async () => {
		const modLevel = await probe(`${C}x = C()\nk = type(x)\nCALL\n`);
		expect(modLevel.sites).toEqual([]);
		expect(modLevel.delta).toEqual(REFUSED);
		const modClass = await probe(`${C}x = C()\nk = x.__class__\nCALL\n`);
		expect(modClass.sites).toEqual([]);
		expect(modClass.delta).toEqual(REFUSED);
		const inClassBody = await probe(
			"class C:\n    def meth(self):\n        pass\n    x = 1\n    k = type(x)\n    CALL\n",
		);
		expect(inClassBody.sites).toEqual([]);
		expect(inClassBody.delta).toEqual(REFUSED);
	});

	test("a nested def's own parameter shadowing self: the read resolves, a binding inside it refuses", async () => {
		const readsOuter = await probe(inMethod("k = type(self)\ndef g(self):\n    CALL\ng(1)"));
		expect(readsOuter.delta).toEqual(RESOLVED);
		const bindsInner = await probe(inMethod("def g(self):\n    k = type(self)\n    CALL\ng(1)"));
		expect(bindsInner.sites).toEqual([]);
		expect(bindsInner.delta).toEqual(REFUSED);
	});

	test("a method of a class nested in a function resolves; a del-only second binding refuses", async () => {
		const nested = await probe(
			"def f():\n    class C:\n        def meth(self):\n            pass\n        def run(self):\n            k = type(self)\n            CALL\n",
		);
		expect(nested.delta).toEqual(RESOLVED);
		expect(nested.sites.map((s) => s.calleeId)).toEqual([
			nested.result.symbols.find((x) => x.qualname.endsWith("C.meth"))?.id ?? null,
		]);
		const delOnly = await probe(inMethod("k = type(self)\ndel k\nCALL"));
		expect(delOnly.sites).toEqual([]);
		expect(delOnly.delta).toEqual(REFUSED);
	});

	test("an MRO that does not compute refuses self.__class__ (the reason, not the bin, is what the check moves)", async () => {
		const bad = "class A:\n    pass\nclass B(A):\n    pass\nclass C(A, B):\n    def meth(self):\n        pass\n";
		const { delta, sites } = await probe(`${bad}    def run(self):\n        k = self.__class__\n        CALL\n`);
		expect(sites).toEqual([]);
		expect(delta).toEqual(REFUSED);
	});
});

// GCLI-119 round 1, B1: `k = type(x)` keeps the right-hand side every pre-TS reader saw (a call whose callee is
// `type`), so an in-repo class named `type` resolves exactly as it did before TS: rules 6d, R4, M1 and N3.
describe("TS — an in-repo class named type: the pre-TS readers still see the call", () => {
	const typeClass = "class type:\n    def meth(self):\n        pass\n    def __call__(self):\n        pass\n";
	const wantMeth = (r: Awaited<ReturnType<typeof probe>>) =>
		expect(r.sites.map((s) => s.calleeId)).toEqual([idOf(r.result, "type.meth")]);

	test("6d, function scope: a single k = type(a) is a construction of the in-repo class", async () => {
		const r = await probe(`${typeClass}def f(a):\n    k = type(a)\n    CALL\n`);
		expect(r.delta).toEqual(RESOLVED);
		wantMeth(r);
	});

	test("6d, module scope", async () => {
		const r = await probe(`${typeClass}a = 1\nk = type(a)\nCALL\n`);
		expect(r.delta).toEqual(RESOLVED);
		wantMeth(r);
	});

	test("R4: two k = type(a) bindings", async () => {
		const r = await probe(`${typeClass}def f(a):\n    k = type(a)\n    k = type(a)\n    CALL\n`);
		expect(r.delta).toEqual(RESOLVED);
		wantMeth(r);
	});

	test("M1: an imported module-level instance k = type(a)", async () => {
		const r = await probe("from m import k\nCALL\n", [py("m.py", `${typeClass}a = 1\nk = type(a)\n`)]);
		expect(r.delta).toEqual(RESOLVED);
		wantMeth(r);
	});

	test("N3: x = type(a); x() calls the in-repo __call__", async () => {
		const withCall = await analyze([py("app.py", `${typeClass}def f(a):\n    x = type(a)\n    x()\n`)]);
		expect(withCall.sites.map((s) => s.calleeId)).toContain(idOf(withCall, "type.__call__"));
	});

	test("an in-repo `type` from a from-import", async () => {
		const r = await probe("from m import type\ndef f(a):\n    k = type(a)\n    CALL\n", [py("m.py", typeClass)]);
		expect(r.delta).toEqual(RESOLVED);
		wantMeth(r);
	});
});

// DEC-303 (a55) item 3: a class that defines `__class__` leaves `self.__class__` unresolved; `type(self)`
// does not consult `__class__`, so it still resolves.
describe("TS — a class that defines __class__ leaves self.__class__ unresolved", () => {
	const defs: Record<string, string> = {
		"an attribute": "    __class__ = int\n",
		"a property": "    @property\n    def __class__(self):\n        return int\n",
		"a method": "    def __class__(self):\n        return int\n",
	};
	const run = (rhs: string): string => `    def run(self):\n        k = ${rhs}\n        CALL\n`;
	for (const [label, def] of Object.entries(defs)) {
		test(`the enclosing class defines __class__ as ${label}: self.__class__ refuses, type(self) resolves`, async () => {
			const refused = await probe(`class C:\n${def}    def meth(self):\n        pass\n${run("self.__class__")}`);
			expect(refused.sites).toEqual([]);
			expect(refused.delta).toEqual(REFUSED);
			const resolved = await probe(`class C:\n${def}    def meth(self):\n        pass\n${run("type(self)")}`);
			expect(resolved.delta).toEqual(RESOLVED);
			expect(resolved.sites.map((s) => s.calleeId)).toEqual([idOf(resolved.result, "C.meth")]);
		});

		test(`an in-repo base on the MRO defines __class__ as ${label}: self.__class__ refuses, type(self) resolves`, async () => {
			const base = `class B:\n${def}class C(B):\n    def meth(self):\n        pass\n`;
			const refused = await probe(`${base}${run("self.__class__")}`);
			expect(refused.sites).toEqual([]);
			expect(refused.delta).toEqual(REFUSED);
			const resolved = await probe(`${base}${run("type(self)")}`);
			expect(resolved.delta).toEqual(RESOLVED);
			expect(resolved.sites.map((s) => s.calleeId)).toEqual([idOf(resolved.result, "C.meth")]);
		});
	}

	test("(a56) item 2: an external or opaque base refuses self.__class__ (fail closed); type(self) still resolves", async () => {
		const run2 = (rhs: string): string => `    def meth(self):\n        pass\n${run(rhs)}`;
		const heads: Record<string, string> = {
			"an external import": "from unittest.mock import Mock\nclass C(Mock):\n",
			"an unresolved import": "from nowhere import Base\nclass C(Base):\n",
			"a call-expression base": "class C(make_base()):\n",
			"a rebound in-repo name": "class B:\n    pass\nB = something\nclass C(B):\n",
			"a shadowed builtin name": "dict = something\nclass C(dict):\n",
		};
		for (const [label, head] of Object.entries(heads)) {
			const refused = await probe(`${head}${run2("self.__class__")}`);
			expect(refused.sites, label).toEqual([]);
			expect(refused.delta, label).toEqual(REFUSED);
		}
		// the type(self) twin of the external base resolves, callee pinned (the lookup already did before the rule)
		const twin = await probe(`${heads["an external import"]}${run2("type(self)")}`);
		expect(twin.delta).toEqual(RESOLVED);
		expect(twin.sites.map((s) => s.calleeId)).toEqual([idOf(twin.result, "C.meth")]);
	});

	test("(a56) item 2: an unshadowed builtin base (object, dict, an exception) does not refuse self.__class__", async () => {
		for (const base of ["object", "dict", "int", "Exception"]) {
			const { delta, sites, result } = await probe(
				`class C(${base}):\n${"    def meth(self):\n        pass\n"}${run("self.__class__")}`,
			);
			expect(delta, base).toEqual(RESOLVED);
			expect(
				sites.map((s) => s.calleeId),
				base,
			).toEqual([idOf(result, "C.meth")]);
		}
	});

	test("a base off the MRO, or a __class__ read rather than defined, does not refuse (positive twins)", async () => {
		const unrelated = await probe(
			`class Z:\n    __class__ = int\nclass C:\n    def meth(self):\n        pass\n${run("self.__class__")}`,
		);
		expect(unrelated.delta).toEqual(RESOLVED);
		const read = await probe(
			`class C:\n    def meth(self):\n        pass\n    def other(self):\n        return self.__class__\n${run("self.__class__")}`,
		);
		expect(read.delta).toEqual(RESOLVED);
	});
});
