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

	test("an unknown method on the class stays refused for the reason it had (negative control)", async () => {
		const source = inMethod("k = type(self)\nk.nope()");
		const result = await analyze([py("app.py", source.replace("CALL", "pass"))]);
		expect(result.sites.filter((s) => s.calleeId !== null && s.line === 8)).toEqual([]);
	});

	test("a local at module level or in a class body is not rule TS's", async () => {
		const modLevel = await probe(`${C}k = type(C())\nCALL\n`);
		expect(modLevel.sites).toEqual([]);
		expect(modLevel.delta).toEqual(REFUSED);
	});
});
