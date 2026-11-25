import { describe, expect, test } from "bun:test";
import { analyzePythonCalls, type PythonCallSite, type PythonCallsResult } from "../src/python/calls.ts";
import type { PythonModuleInput } from "../src/python/modules.ts";

const encoder = new TextEncoder();

function py(path: string, source: string): PythonModuleInput {
	return { path, bytes: encoder.encode(source) };
}

/** Run the analyzer and assert the bin-sum invariant on every fixture (rule 16). */
async function analyze(
	files: PythonModuleInput[],
	options?: { roots?: readonly string[]; excludedDirs?: readonly string[] },
): Promise<PythonCallsResult> {
	const result = await analyzePythonCalls(files, options);
	const summed =
		result.callBins.resolvedInRepo +
		result.callBins.resolvedExternal +
		result.callBins.receiverNeedsInference +
		result.callBins.nameNotBound;
	expect(summed).toBe(result.callExpressionCount);
	return result;
}

function one(source: string, path = "app.py", options?: { roots?: readonly string[] }): Promise<PythonCallsResult> {
	return analyze([py(path, source)], options);
}

function symbolId(result: PythonCallsResult, qualname: string, file?: string): string {
	const found = result.symbols.find(
		(symbol) => symbol.qualname === qualname && (file === undefined || symbol.file === file),
	);
	if (found === undefined) {
		throw new Error(
			`no symbol ${qualname}${file === undefined ? "" : ` in ${file}`}; have ${result.symbols.map((s) => `${s.file}:${s.qualname}`)}`,
		);
	}
	return found.id;
}

function sitesTo(result: PythonCallsResult, calleeId: string): PythonCallSite[] {
	return result.sites.filter((site) => site.calleeId === calleeId);
}

function linesTo(result: PythonCallsResult, calleeId: string): number[] {
	return sitesTo(result, calleeId)
		.map((site) => site.line)
		.sort((a, b) => a - b);
}

// Every fixture the suite analyses, for the sum-invariant sweep (rule 16).
const FIXTURES: { name: string; files: PythonModuleInput[]; options?: { roots?: readonly string[] } }[] = [
	{
		name: "calls, decorators and an error region",
		files: [
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "from .mod import target\n@target\ndef a():\n    pass\n@target()\ndef b():\n    target()\n"),
			py("pkg/broken.py", "def f():\n    x = g() ]\n"),
		],
	},
	{
		name: "classes, inheritance and constructions",
		files: [
			py(
				"pkg/classes.py",
				[
					"class A:",
					"    def __init__(self):",
					"        pass",
					"    def m(self):",
					"        pass",
					"class B(A):",
					"    def m(self):",
					"        pass",
					"def use():",
					"    b = B()",
					"    b.m()",
					"    A().m()",
				].join("\n"),
			),
		],
	},
	{
		name: "exit seven carried",
		files: [py("src/a.py", "import foo\nfoo.bar()\n"), py("lib/foo/__init__.py", "")],
		options: { roots: ["src"] },
	},
];

// --- rule 1 ----------------------------------------------------------------

describe("rule 1 — site enumeration", () => {
	test("rule 1: every call expression is one site, and its line is the call's first token", async () => {
		const result = await one("def f():\n    a()\n    b(\n        )\n");
		expect(result.callExpressionCount).toBe(2);
		expect(result.sites).toEqual([]);
		expect(result.unresolvedNameReasons).toEqual([
			{
				reason: "unbound",
				count: 2,
				firstSites: [
					{ file: "app.py", line: 2, column: 5 },
					{ file: "app.py", line: 3, column: 5 },
				],
			},
		]);
	});

	test("rule 1: a call inside an ERROR region is dropped and the file named", async () => {
		const result = await one("def f():\n    x = g() ]\n", "broken.py");
		expect(result.callExpressionCount).toBe(0);
		expect(result.droppedCalls).toBe(1);
		expect(result.errorFiles).toEqual(["broken.py"]);
		expect(result.exact).toBe(false);
	});

	test("rule 1: a bare @d is a decorator site, never a call site", async () => {
		const result = await one("def d(x):\n    return x\n@d\ndef f():\n    pass\n");
		const d = symbolId(result, "d");
		expect(result.callExpressionCount).toBe(0);
		expect(result.counts.decoratorSites).toBe(1);
		expect(sitesTo(result, d)).toHaveLength(1);
		expect((sitesTo(result, d)[0] as PythonCallSite).kind).toBe("decorator");
	});

	test("rule 1: a call in a class body has callerId null", async () => {
		const result = await one("def t():\n    pass\nclass C:\n    t()\n");
		const t = symbolId(result, "t");
		expect(sitesTo(result, t).map((site) => site.callerId)).toEqual([null]);
	});
});

// --- rule 2 ----------------------------------------------------------------

describe("rule 2 — caller", () => {
	test("rule 2: the innermost def is the caller, and a nested def's call belongs to it", async () => {
		const result = await one(
			"def outer():\n    def inner():\n        target()\n    target()\ndef target():\n    pass\n",
		);
		const inner = symbolId(result, "outer.inner");
		const outer = symbolId(result, "outer");
		expect(
			sitesTo(result, symbolId(result, "target"))
				.map((site) => site.callerId)
				.sort(),
		).toEqual([inner, outer].sort());
	});

	test("rule 2: module-scope calls have callerId null", async () => {
		const result = await one("def target():\n    pass\ntarget()\n");
		expect(sitesTo(result, symbolId(result, "target")).map((site) => site.callerId)).toEqual([null]);
	});

	test("rule 2: lambdas and comprehensions are transparent — their calls belong to the enclosing def", async () => {
		const result = await one(
			"def target():\n    pass\ndef outer():\n    f = lambda: target()\n    g = [target() for _ in range(1)]\n",
		);
		const outer = symbolId(result, "outer");
		expect(sitesTo(result, symbolId(result, "target")).every((site) => site.callerId === outer)).toBe(true);
	});

	test("rule 2: a call in a default value belongs to the enclosing scope, not the def", async () => {
		const result = await one("def target():\n    pass\ndef f(x=target()):\n    pass\n");
		expect(sitesTo(result, symbolId(result, "target")).map((site) => site.callerId)).toEqual([null]);
	});
});

// --- rule 3 ----------------------------------------------------------------

describe("rule 3 — scopes and name lookup", () => {
	test("rule 3: a local def shadows the module def (LEGB innermost wins)", async () => {
		const result = await one("def target():\n    pass\ndef f():\n    def target():\n        pass\n    target()\n");
		expect(linesTo(result, symbolId(result, "f.target"))).toEqual([6]);
		expect(linesTo(result, symbolId(result, "target"))).toEqual([]);
	});

	test("rule 3: an enclosing function scope binds for a nested def (closure)", async () => {
		const result = await one("def outer():\n    def target():\n        pass\n    def inner():\n        target()\n");
		expect(linesTo(result, symbolId(result, "outer.target"))).toEqual([5]);
	});

	test("rule 3: a class body is not an enclosing scope for its methods", async () => {
		const result = await one(
			[
				"def helper():",
				"    pass",
				"class C:",
				"    def helper(self):",
				"        pass",
				"    def m(self):",
				"        helper()",
			].join("\n"),
		);
		// The method body sees the module helper, never the class attribute helper.
		expect(linesTo(result, symbolId(result, "helper"))).toEqual([7]);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
	});

	test("rule 3: global redirects a binding to module scope", async () => {
		const result = await one(
			[
				"def target():",
				"    pass",
				"def setter():",
				"    global ALIAS",
				"    ALIAS = target",
				"setter()",
				"ALIAS()",
			].join("\n"),
		);
		expect(linesTo(result, symbolId(result, "target"))).toEqual([7]);
	});

	test("rule 3: nonlocal redirects a binding to the enclosing function scope", async () => {
		const result = await one(
			[
				"def outer():",
				"    def target():",
				"        pass",
				"    def setter():",
				"        nonlocal ALIAS",
				"        ALIAS = target",
				"    setter()",
				"    ALIAS()",
			].join("\n"),
		);
		expect(linesTo(result, symbolId(result, "outer.target"))).toEqual([8]);
	});

	test("rule 3: a comprehension variable binds in the enclosing scope", async () => {
		const result = await one("def f():\n    g = [x for x in range(3)]\n    x()\n");
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "run-time-bound", count: 1, firstSites: [{ file: "app.py", line: 3, column: 5 }] },
		]);
	});

	test("rule 3: a name bound later in the same scope is still bound (compile-time rule)", async () => {
		const result = await one("def f():\n    later()\n    def later():\n        pass\n");
		expect(linesTo(result, symbolId(result, "f.later"))).toEqual([2]);
	});
});

// --- rule 4 ----------------------------------------------------------------

describe("rule 4 — bare-name binding kinds", () => {
	test("rule 4a: a def resolves in-repo; a class constructs", async () => {
		const result = await one(
			"def target():\n    pass\nclass C:\n    def __init__(self):\n        pass\ndef f():\n    target()\n    C()\n",
		);
		expect(linesTo(result, symbolId(result, "target"))).toEqual([7]);
		expect(linesTo(result, symbolId(result, "C"))).toEqual([8]);
	});

	test("rule 4b: a first-party import resolves to the symbol it names", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "from .mod import target\ndef f():\n    target()\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([3]);
	});

	test("rule 4b: an external import is resolved external", async () => {
		const result = await one("from os import getcwd\ndef f():\n    getcwd()\n");
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(result.callBins.nameNotBound).toBe(0);
	});

	test("rule 4b: an unresolved first-party import carries S3's reason", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/use.py", "from .missing import target\ndef f():\n    target()\n"),
		]);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toContain("module-not-found");
	});

	test("rule 4c: a builtin is resolved external, but a shadowed builtin is not", async () => {
		const globalCall = await one("def f():\n    len([])\n");
		expect(globalCall.callBins.resolvedExternal).toBe(1);
		const shadowed = await one("def f():\n    len = 1\n    len()\n");
		expect(shadowed.callBins.resolvedExternal).toBe(0);
		expect(shadowed.unresolvedNameReasons).toEqual([
			{ reason: "run-time-bound", count: 1, firstSites: [{ file: "app.py", line: 3, column: 5 }] },
		]);
	});

	test("rule 4d: a parameter, loop target or plain assignment is run-time-bound", async () => {
		const result = await one("def f(p):\n    p()\n    for q in []:\n        q()\n    r = 1\n    r()\n");
		expect(result.unresolvedNameReasons).toEqual([
			{
				reason: "run-time-bound",
				count: 3,
				firstSites: [
					{ file: "app.py", line: 2, column: 5 },
					{ file: "app.py", line: 4, column: 9 },
					{ file: "app.py", line: 6, column: 5 },
				],
			},
		]);
	});

	test("rule 4e: a single alias assignment is followed, up to two hops", async () => {
		const result = await one("def target():\n    pass\na = target\nb = a\ndef f():\n    b()\n");
		expect(linesTo(result, symbolId(result, "target"))).toEqual([6]);
	});

	test("rule 4e: an alias cycle stops at the depth limit with reason alias-depth", async () => {
		const result = await one("x = y\ny = x\ndef f():\n    x()\n");
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "alias-depth", count: 1, firstSites: [{ file: "app.py", line: 4, column: 5 }] },
		]);
	});

	test("rule 4f: an unbound name is name-not-bound", async () => {
		const result = await one("def f():\n    nope()\n");
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "unbound", count: 1, firstSites: [{ file: "app.py", line: 2, column: 5 }] },
		]);
	});

	test("rule 4f: a name in a complete star set resolves; a partial star set is star-import", async () => {
		const complete = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def starred():\n    pass\n"),
			py("pkg/use.py", "from .mod import *\ndef f():\n    starred()\n"),
		]);
		expect(linesTo(complete, symbolId(complete, "starred", "pkg/mod.py"))).toEqual([3]);
		const partial = await one("from os import *\ndef f():\n    environ()\n");
		expect(partial.unresolvedNameReasons).toEqual([
			{ reason: "star-import", count: 1, firstSites: [{ file: "app.py", line: 3, column: 5 }] },
		]);
	});
});

// --- rule 5 ----------------------------------------------------------------

describe("rule 5 — rebound names", () => {
	test("rule 5: a def plus an assignment to the same name is rebound", async () => {
		const result = await one("def f():\n    pass\nf = 1\ndef g():\n    f()\n");
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "rebound", count: 1, firstSites: [{ file: "app.py", line: 5, column: 5 }] },
		]);
	});

	test("rule 5: two defs only are multiply-bound (rule 20), never rebound", async () => {
		const result = await one(
			"try:\n    def f():\n        pass\nexcept Exception:\n    def f():\n        pass\ndef g():\n    f()\n",
		);
		expect(result.unresolvedNameReasons).toEqual([]);
		expect(result.multiplyBoundCount).toBe(1);
	});
});

// --- rule 6 ----------------------------------------------------------------

describe("rule 6 — attribute call receivers", () => {
	test("rule 6a: self and cls look the method up in the enclosing class's MRO", async () => {
		const result = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self):\n        self.target()\n    @classmethod\n    def k(cls):\n        cls.target()\n",
		);
		expect(linesTo(result, symbolId(result, "C.target"))).toEqual([5, 8]);
	});

	test("rule 6a: a rebound self is not self", async () => {
		const result = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self):\n        self = other\n        self.target()\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.target"))).toEqual([]);
	});

	test("rule 6b: a first-party module chain resolves link by link; a missing attribute is name-not-bound", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/sub.py", "def leaf():\n    pass\n"),
			py("pkg/use.py", "from . import sub\ndef f():\n    sub.leaf()\n    sub.missing()\n"),
		]);
		expect(linesTo(result, symbolId(result, "leaf", "pkg/sub.py"))).toEqual([3]);
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "attribute-not-found", count: 1, firstSites: [{ file: "pkg/use.py", line: 4, column: 5 }] },
		]);
	});

	test("rule 6b: an external module receiver is resolved external", async () => {
		const result = await one("import os\ndef f():\n    os.path.join('a', 'b')\n");
		expect(result.callBins.resolvedExternal).toBe(1);
	});

	test("rule 6c: a name bound to a class looks the method up in its MRO", async () => {
		const result = await one("class C:\n    def m(self):\n        pass\ndef f():\n    C.m\n");
		expect(linesTo(result, symbolId(result, "C.m"))).toEqual([]);
		const call = await one("class C:\n    def m(self):\n        pass\ndef f():\n    C.m()\n");
		expect(linesTo(call, symbolId(call, "C.m"))).toEqual([5]);
	});

	test("rule 6d: a single constructor binding is a known class", async () => {
		const result = await one("class C:\n    def m(self):\n        pass\ndef f():\n    c = C()\n    c.m()\n");
		expect(linesTo(result, symbolId(result, "C.m"))).toEqual([6]);
	});

	test("rule 6d: an annotation naming a resolvable class, with Optional and Union-with-None unwrapped", async () => {
		const result = await one(
			"from typing import Optional\nclass C:\n    def m(self):\n        pass\ndef f(a: C, b: Optional[C], c: C | None):\n    a.m()\n    b.m()\n    c.m()\n",
		);
		expect(linesTo(result, symbolId(result, "C.m"))).toEqual([6, 7, 8]);
	});

	test("rule 6d: a return annotation is not followed", async () => {
		const result = await one(
			"class C:\n    def m(self):\n        pass\ndef make() -> C:\n    return C()\ndef f():\n    make().m()\n",
		);
		expect(linesTo(result, symbolId(result, "C.m"))).toEqual([]);
		expect(result.callBins.receiverNeedsInference).toBe(1);
	});

	test("rule 6d: self.x.m() is unresolved-receiver and counted", async () => {
		const result = await one("class C:\n    def m(self):\n        self.x.m()\n");
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(result.unresolvedReceiverReasons.map((entry) => entry.reason)).toContain("needs-inference");
	});

	test("rule 6d: a generic or otherwise non-class annotation is unresolved-receiver", async () => {
		const result = await one("class C:\n    def m(self):\n        pass\ndef f(p: list[C]):\n    p.m()\n");
		expect(result.callBins.receiverNeedsInference).toBe(1);
	});

	test("rule 6f: a call result, a literal and a builtin value need inference, never guessed", async () => {
		const result = await one(
			"def make():\n    return None\ndef f(items):\n    make().m()\n    'x'.join([])\n    items.append(1)\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(3);
	});
});

// --- rule 7 ----------------------------------------------------------------

describe("rule 7 — attribute not found on a known class", () => {
	test("rule 7: every base in-repo and no method is unresolved-receiver instance-attribute", async () => {
		const result = await one("class A:\n    pass\nclass B(A):\n    pass\ndef f(b: B):\n    b.missing()\n");
		expect(result.unresolvedReceiverReasons).toEqual([
			{ reason: "instance-attribute", count: 1, firstSites: [{ file: "app.py", line: 6, column: 5 }] },
		]);
	});
});

// --- rule 8 ----------------------------------------------------------------

describe("rule 8 — construction", () => {
	test("rule 8: a construction is one site in resolvedInRepo with two edges, class and inherited __init__", async () => {
		const result = await one(
			"class B:\n    def __init__(self):\n        pass\nclass D(B):\n    pass\ndef f():\n    D()\n",
		);
		expect(result.callBins.resolvedInRepo).toBe(1);
		expect(sitesTo(result, symbolId(result, "D"))).toHaveLength(1);
		expect(sitesTo(result, symbolId(result, "B.__init__"))).toHaveLength(1);
		expect(result.sites).toHaveLength(2);
	});

	test("rule 8: a class with no __init__ has one edge", async () => {
		const result = await one("class C:\n    pass\ndef f():\n    C()\n");
		expect(result.sites).toHaveLength(1);
	});

	test("rule 8: __new__ and a metaclass each carry the constructor note", async () => {
		const newer = await one("class N:\n    def __new__(cls):\n        pass\ndef f():\n    N()\n");
		expect(newer.constructorNotes.map((note) => note.reasons)).toEqual([["__new__"]]);
		const meta = await one("class Meta(type):\n    pass\nclass C(metaclass=Meta):\n    pass\ndef f():\n    C()\n");
		expect(meta.constructorNotes.map((note) => note.reasons)).toEqual([["metaclass"]]);
	});

	test("rule 8: cls(...) in a classmethod constructs the class, flagged polymorphic when a subclass exists", async () => {
		const result = await one(
			"class B:\n    @classmethod\n    def make(cls):\n        return cls()\nclass D(B):\n    pass\n",
		);
		expect(linesTo(result, symbolId(result, "B"))).toEqual([4]);
		expect(result.polymorphicCount).toBe(1);
	});

	test("rule 8: self.__class__(...) and type(self)(...) are unresolved-receiver", async () => {
		const result = await one("class C:\n    def m(self):\n        self.__class__()\n        type(self)()\n");
		expect(result.callBins.receiverNeedsInference).toBe(2);
	});
});

// --- rule 9 ----------------------------------------------------------------

describe("rule 9 — method resolution order", () => {
	test("rule 9: C3 order over in-repo bases resolves an inherited method", async () => {
		const result = await one(
			[
				"class A:",
				"    def m(self):",
				"        pass",
				"class B(A):",
				"    pass",
				"class C(A):",
				"    pass",
				"class D(B, C):",
				"    pass",
				"def f(d: D):",
				"    d.m()",
			].join("\n"),
		);
		expect(linesTo(result, symbolId(result, "A.m"))).toEqual([11]);
	});

	test("rule 9: an opaque external base is kept and does not override an in-repo method", async () => {
		const result = await one(
			"class Mixin:\n    def m(self):\n        pass\nclass E(Unknown, Mixin):\n    pass\ndef f(e: E):\n    e.m()\n",
		);
		const site = sitesTo(result, symbolId(result, "Mixin.m"))[0] as PythonCallSite;
		expect(site.externalBaseBefore).toBe(true);
	});

	test("rule 9: an inconsistent linearisation makes every lookup through it mro-failed", async () => {
		const result = await one(
			[
				"class A:",
				"    pass",
				"class B:",
				"    pass",
				"class C(A, B):",
				"    pass",
				"class D(B, A):",
				"    pass",
				"class E(C, D):",
				"    pass",
				"def f(e: E):",
				"    e.m()",
			].join("\n"),
		);
		expect(result.unresolvedReceiverReasons).toEqual([
			{ reason: "mro-failed", count: 1, firstSites: [{ file: "app.py", line: 12, column: 5 }] },
		]);
	});
});

// --- rule 10 ---------------------------------------------------------------

describe("rule 10 — decorated definitions", () => {
	test("rule 10: a call to a decorated def resolves to the def and carries the decorated flag", async () => {
		const result = await one("def d(x):\n    return x\n@d\ndef f():\n    pass\ndef use():\n    f()\n");
		const site = sitesTo(result, symbolId(result, "f"))[0] as PythonCallSite;
		expect(site.decorated).toBe(true);
	});

	test("rule 10: property access is not a call; calling the value is rule 6f", async () => {
		const access = await one("class C:\n    @property\n    def p(self):\n        return 1\ndef f(c: C):\n    c.p\n");
		expect(access.callBins.receiverNeedsInference).toBe(0);
		const call = await one("class C:\n    @property\n    def p(self):\n        return 1\ndef f(c: C):\n    c.p()\n");
		expect(call.callBins.receiverNeedsInference).toBe(1);
	});
});

// --- rule 11 ---------------------------------------------------------------

describe("rule 11 — branch arms", () => {
	test("rule 11: calls in if/elif/else and try arms are all attributed", async () => {
		const result = await one(
			[
				"def a():",
				"    pass",
				"def b():",
				"    pass",
				"def c():",
				"    pass",
				"def f(x):",
				"    if x:",
				"        a()",
				"    elif x == 2:",
				"        b()",
				"    else:",
				"        c()",
				"    try:",
				"        a()",
				"    except Exception:",
				"        b()",
			].join("\n"),
		);
		expect(linesTo(result, symbolId(result, "a"))).toEqual([9, 15]);
		expect(linesTo(result, symbolId(result, "b"))).toEqual([11, 17]);
		expect(linesTo(result, symbolId(result, "c"))).toEqual([13]);
	});
});

// --- rule 12 ---------------------------------------------------------------

describe("rule 12 — polymorphic sites", () => {
	test("rule 12: an overriding subclass flags the site, counts it, and draws no edge to the override", async () => {
		const result = await one(
			"class A:\n    def m(self):\n        pass\nclass B(A):\n    def m(self):\n        pass\ndef f(a: A):\n    a.m()\n",
		);
		expect(result.polymorphicCount).toBe(1);
		expect(linesTo(result, symbolId(result, "A.m"))).toEqual([8]);
		expect(linesTo(result, symbolId(result, "B.m"))).toEqual([]);
	});

	test("rule 12: no overriding subclass means no polymorphic flag", async () => {
		const result = await one("class A:\n    def m(self):\n        pass\ndef f(a: A):\n    a.m()\n");
		expect(result.polymorphicCount).toBe(0);
	});
});

// --- rule 13 ---------------------------------------------------------------

describe("rule 13 — calls the parser cannot place", () => {
	test("rule 13: getattr(o, n)(...) is name-not-bound outside and external inside", async () => {
		const result = await one("def f(o, n):\n    getattr(o, n)()\n");
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toContain("dynamic-callee");
	});

	test("rule 13: eval/exec targets are builtin calls", async () => {
		const result = await one("def f(x):\n    eval(x)\n    exec(x)\n");
		expect(result.callBins.resolvedExternal).toBe(2);
	});
});

// --- rule 14 ---------------------------------------------------------------

describe("rule 14 — files and scope", () => {
	test("rule 14: every .py file is analysed, including tests", async () => {
		const result = await analyze([py("tests/test_x.py", "def target():\n    pass\ndef test_it():\n    target()\n")]);
		expect(linesTo(result, symbolId(result, "target"))).toEqual([4]);
	});

	test("rule 14: a file that failed to parse as a whole drops its calls and is named", async () => {
		const result = await one("x = (\n    g()\n", "root-error.py");
		expect(result.errorFiles).toEqual(["root-error.py"]);
		expect(result.droppedCalls).toBe(1);
		expect(result.callExpressionCount).toBe(0);
	});
});

// --- rule 15 ---------------------------------------------------------------

describe("rule 15 — exit 7 carried", () => {
	test("rule 15: S5 carries S3's exit7 list and does not claim exact", async () => {
		const result = await analyze([py("src/a.py", "import foo\nfoo.bar()\n"), py("lib/foo/__init__.py", "")], {
			roots: ["src"],
		});
		expect(result.exit7.length).toBeGreaterThan(0);
		expect(result.exact).toBe(false);
	});
});

// --- rule 16 ---------------------------------------------------------------

describe("rule 16 — counts", () => {
	test("rule 16: per-reason counts name their first sites, and the notes/counts are published", async () => {
		const result = await one("class C:\n    pass\ndef f():\n    unknown_a()\n    unknown_b()\n    C()\n");
		expect(result.unresolvedNameReasons).toEqual([
			{
				reason: "unbound",
				count: 2,
				firstSites: [
					{ file: "app.py", line: 4, column: 5 },
					{ file: "app.py", line: 5, column: 5 },
				],
			},
		]);
		expect(result.counts.callExpressions).toBe(3);
		expect(result.counts.edges).toBe(result.sites.length);
	});

	test("rule 16: the four bins sum to the call expression count over every fixture", async () => {
		for (const fixture of FIXTURES) {
			const result = await analyzePythonCalls(fixture.files, fixture.options ?? {});
			const summed =
				result.callBins.resolvedInRepo +
				result.callBins.resolvedExternal +
				result.callBins.receiverNeedsInference +
				result.callBins.nameNotBound;
			expect({ fixture: fixture.name, summed }).toEqual({ fixture: fixture.name, summed: result.callExpressionCount });
		}
	});
});

// --- rule 17 ---------------------------------------------------------------

describe("rule 17 — determinism and purity", () => {
	test("rule 17: permuting the input files yields an identical result", async () => {
		const files = [
			py("pkg/__init__.py", ""),
			py("pkg/a.py", "from .b import B\nclass A(B):\n    def m(self):\n        self.n()\n"),
			py("pkg/b.py", "class B:\n    def n(self):\n        pass\n"),
		];
		const forward = await analyzePythonCalls(files);
		const reversed = await analyzePythonCalls([...files].reverse());
		expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
	});

	test("rule 17: two runs over the same inputs are equal and the inputs are not mutated", async () => {
		const files = [py("app.py", "def f():\n    g()\n")];
		const before = files.map((file) => file.path);
		const first = await analyzePythonCalls(files);
		const second = await analyzePythonCalls(files);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(files.map((file) => file.path)).toEqual(before);
	});
});

// --- rule 18 ---------------------------------------------------------------

describe("rule 18 — out of scope (unwired)", () => {
	test("rule 18: the result carries exactly the S5 surface, no CLI wiring", async () => {
		const result = await one("def f():\n    pass\n");
		expect(Object.keys(result).sort()).toEqual(
			[
				"callBins",
				"callExpressionCount",
				"constructorNotes",
				"counts",
				"droppedCalls",
				"dynamic",
				"errorFiles",
				"exact",
				"exit7",
				"multiplyBoundCount",
				"polymorphicCount",
				"sites",
				"symbols",
				"unresolvedByKind",
				"unresolvedNameReasons",
				"unresolvedReceiverReasons",
			].sort(),
		);
	});
});

// --- rule 19 ---------------------------------------------------------------

describe("rule 19 — Q1: the bins into the index", () => {
	test("rule 19: a construction is one resolvedInRepo site with two edges", async () => {
		const result = await one("class C:\n    def __init__(self):\n        pass\ndef f():\n    C()\n");
		expect(result.callBins.resolvedInRepo).toBe(1);
		expect(result.sites).toHaveLength(2);
		expect(result.sites.every((site) => site.kind === "new")).toBe(true);
	});

	test("rule 19: a bare decorator site is in no call bin", async () => {
		const result = await one("def d(x):\n    return x\n@d\ndef f():\n    pass\n");
		expect(result.callExpressionCount).toBe(0);
		expect(result.callBins.resolvedInRepo).toBe(0);
		expect(result.sites).toHaveLength(1);
		expect(result.sites[0]?.kind).toBe("decorator");
	});

	test("rule 19: unresolvedByKind.call is the two unresolved bins; dynamic and import come from S3", async () => {
		const result = await one(
			"import importlib\ndef f(p):\n    p.m()\n    unknown()\n    importlib.import_module('x')\n    from . import missing\n",
		);
		expect(result.unresolvedByKind.call).toBe(result.callBins.receiverNeedsInference + result.callBins.nameNotBound);
		expect(result.unresolvedByKind.dynamic).toBe(result.dynamic.length);
		expect(result.unresolvedByKind.extends).toBe(0);
		expect(result.unresolvedByKind.implements).toBe(0);
	});
});

// --- rule 20 ---------------------------------------------------------------

describe("rule 20 — Q2: multiply-bound callee", () => {
	test("rule 20: a try/except import fallback draws an edge to every alternative, each flagged", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/one.py", "def fallback():\n    pass\n"),
			py("pkg/two.py", "def fallback():\n    pass\n"),
			py(
				"pkg/use.py",
				"try:\n    from .one import fallback\nexcept ImportError:\n    from .two import fallback\ndef f():\n    fallback()\n",
			),
		]);
		expect(result.callBins.resolvedInRepo).toBe(1);
		expect(result.multiplyBoundCount).toBe(1);
		const edges = result.sites.filter((site) => site.multiplyBound === true);
		expect(edges).toHaveLength(2);
		expect(edges.every((edge) => edge.line === 6)).toBe(true);
	});

	test("rule 20: alternatives that are all external make the site resolved-external with no edge", async () => {
		const result = await one(
			"try:\n    import os as mod\nexcept ImportError:\n    import sys as mod\ndef f():\n    mod()\n",
		);
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(result.sites).toEqual([]);
	});

	test("rule 20: a multiply-bound name with a plain assignment binding is rebound (rule 5 wins)", async () => {
		const result = await one("try:\n    def f():\n        pass\nexcept Exception:\n    f = 1\ndef g():\n    f()\n");
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "rebound", count: 1, firstSites: [{ file: "app.py", line: 7, column: 5 }] },
		]);
	});
});

// --- rule 21 ---------------------------------------------------------------

describe("rule 21 — Q3: decorator with arguments", () => {
	test("rule 21: @d(args) is one call site to d at the decorator line and no decorator site", async () => {
		const result = await one("def d(x):\n    return x\n@d(1)\ndef f():\n    pass\n");
		expect(result.counts.decoratorSites).toBe(0);
		expect(result.callExpressionCount).toBe(1);
		expect(result.sites.map((site) => [site.kind, site.line])).toEqual([["call", 3]]);
	});

	test("rule 21: a bare @d is a decorator site and no call site", async () => {
		const result = await one("def d(x):\n    return x\n@d\ndef f():\n    pass\n");
		expect(result.counts.decoratorSites).toBe(1);
		expect(result.callExpressionCount).toBe(0);
		expect(result.sites.map((site) => site.kind)).toEqual(["decorator"]);
	});
});

// --- rule 22 ---------------------------------------------------------------

describe("rule 22 — Q4: method in an external base", () => {
	test("rule 22: a method found only in an external base is resolved external", async () => {
		const result = await one("class E(Unknown):\n    pass\ndef f(e: E):\n    e.m()\n");
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(result.sites).toEqual([]);
	});

	test("rule 22: an opaque base before the match sets externalBaseBefore and still resolves in-repo", async () => {
		const result = await one(
			"class Mixin:\n    def m(self):\n        pass\nclass E(Unknown, Mixin):\n    pass\ndef f(e: E):\n    e.m()\n",
		);
		const site = sitesTo(result, symbolId(result, "Mixin.m"))[0] as PythonCallSite;
		expect(site.externalBaseBefore).toBe(true);
	});

	test("rule 22: a construction with no repository __init__ but an external base is one edge and noted", async () => {
		const result = await one("class E(Unknown):\n    pass\ndef f():\n    E()\n");
		expect(result.callBins.resolvedInRepo).toBe(1);
		expect(result.sites).toHaveLength(1);
		expect(result.constructorNotes.map((note) => note.reasons)).toEqual([["external-base-init"]]);
	});

	test("rule 22: every base in the repository and no method is instance-attribute (rule 7)", async () => {
		const result = await one("class A:\n    pass\nclass B(A):\n    pass\ndef f(b: B):\n    b.missing()\n");
		expect(result.unresolvedReceiverReasons.map((entry) => entry.reason)).toEqual(["instance-attribute"]);
	});
});

// --- traversal depth -------------------------------------------------------

describe("traversal depth", () => {
	test("a 50k-term expression and 50k-deep nesting do not overflow the walk", async () => {
		const chain = `a${" + a".repeat(50000)}`;
		const lists = `x = ${"[".repeat(50000)}1${"]".repeat(50000)}`;
		const result = await one(`def target():\n    pass\ndef f():\n    target(${chain})\n${lists}\n`, "deep.py");
		expect(linesTo(result, symbolId(result, "target"))).toEqual([4]);
		expect(result.exact).toBe(true);
	});
});
