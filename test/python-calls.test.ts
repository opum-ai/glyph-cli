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

// Every fixture the suite analyses, for the four-bin sweep (rule 16).
const FIXTURES: {
	name: string;
	files: PythonModuleInput[];
	options?: { roots?: readonly string[] };
	expectedBins: {
		resolvedInRepo: number;
		resolvedExternal: number;
		receiverNeedsInference: number;
		nameNotBound: number;
	};
}[] = [
	{
		name: "calls, decorators and an error region",
		files: [
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "from .mod import target\n@target\ndef a():\n    pass\n@target()\ndef b():\n    target()\n"),
			py("pkg/broken.py", "def f():\n    x = g() ]\n"),
		],
		expectedBins: { resolvedInRepo: 2, resolvedExternal: 0, receiverNeedsInference: 0, nameNotBound: 0 },
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
		expectedBins: { resolvedInRepo: 4, resolvedExternal: 0, receiverNeedsInference: 0, nameNotBound: 0 },
	},
	{
		name: "exit seven carried",
		files: [py("src/a.py", "import foo\nfoo.bar()\n"), py("lib/foo/__init__.py", "")],
		options: { roots: ["src"] },
		expectedBins: { resolvedInRepo: 0, resolvedExternal: 0, receiverNeedsInference: 1, nameNotBound: 0 },
	},
	{
		name: "local imports, external receivers, literals and receivers by decorator",
		files: [
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py(
				"pkg/use.py",
				[
					"from os import path",
					"class C:",
					"    def helper(self):",
					"        pass",
					"    @classmethod",
					"    def make(klass):",
					"        return klass()",
					"    def m(this):",
					"        this.helper()",
					"def f():",
					"    from .mod import target",
					"    target()",
					"    path.join('a', 'b')",
					"    [].append(1)",
				].join("\n"),
			),
		],
		expectedBins: { resolvedInRepo: 3, resolvedExternal: 2, receiverNeedsInference: 0, nameNotBound: 0 },
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

	// DEC-303 (a23) item 1: Python binds no name through an attribute or subscript
	// target. Fixtures are written from that language rule, not from any repository.
	test("rule 5: an attribute target (self.x = v) binds no name, so self.m() still resolves", async () => {
		const result = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self):\n        self.x = 1\n        self.target()\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(0);
		expect(linesTo(result, symbolId(result, "C.target"))).toEqual([6]);
	});

	test("rule 5: a tuple of attribute targets (self.a, self.b = ...) binds no name", async () => {
		const result = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self):\n        self.a, self.b = 1, 2\n        self.target()\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(0);
		expect(linesTo(result, symbolId(result, "C.target"))).toEqual([6]);
	});

	test("rule 5: a subscript target (d[k] = v) binds no name, so a known-class local still resolves", async () => {
		const result = await one(
			"class K:\n    def target(self):\n        pass\ndef f(c):\n    pass\ndef g():\n    k = K()\n    k.items = 1\n    k[0] = 2\n    k.target()\n",
		);
		expect(linesTo(result, symbolId(result, "K.target"))).toEqual([10]);
	});

	test("rule 5: an attribute target in a for statement binds no name", async () => {
		const result = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self, xs):\n        for self.i in xs:\n            pass\n        self.target()\n",
		);
		expect(linesTo(result, symbolId(result, "C.target"))).toEqual([7]);
	});

	test("rule 5: bare-name, starred and tuple-of-names targets still bind (negative)", async () => {
		const bare = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self):\n        self = other\n        self.target()\n",
		);
		expect(linesTo(bare, symbolId(bare, "C.target"))).toEqual([]);
		const tuple = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self):\n        self, y = other\n        self.target()\n",
		);
		expect(linesTo(tuple, symbolId(tuple, "C.target"))).toEqual([]);
		const starred = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self):\n        *self, y = other\n        self.target()\n",
		);
		expect(linesTo(starred, symbolId(starred, "C.target"))).toEqual([]);
		const loop = await one(
			"class C:\n    def target(self):\n        pass\n    def m(self, xs):\n        for self in xs:\n            pass\n        self.target()\n",
		);
		expect(linesTo(loop, symbolId(loop, "C.target"))).toEqual([]);
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

	test("rule 6f / rule 29c: a call result and a builtin value need inference; a literal receiver is external", async () => {
		const result = await one(
			"def make():\n    return None\ndef f(items):\n    make().m()\n    'x'.join([])\n    items.append(1)\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(2);
		expect(result.callBins.resolvedExternal).toBe(1);
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

	test("rule 16: each fixture's four bins are pinned, and they sum to the call count", async () => {
		for (const fixture of FIXTURES) {
			const result = await analyzePythonCalls(fixture.files, fixture.options ?? {});
			// The four bins are asserted, not only their sum: a regression that moves
			// two bins in opposite directions keeps the sum and still fails here.
			expect({ fixture: fixture.name, bins: result.callBins }).toEqual({
				fixture: fixture.name,
				bins: fixture.expectedBins,
			});
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
	test("rule 18: the result carries exactly the S5 surface plus S3's first-party count", async () => {
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
				"parseErrorFiles",
				"polymorphicCount",
				"sites",
				"symbols",
				"unresolvedByKind",
				"unresolvedFirstPartyImports",
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

// --- rule 23 ---------------------------------------------------------------

describe("rule 23 — local imports", () => {
	test("rule 23: a function-local first-party import resolves like a module-level one", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "def f():\n    from .mod import target\n    target()\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([3]);
	});

	test("rule 23: a class-body local import binds in the class body's own scope", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "class C:\n    from .mod import target\n    x = target()\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([3]);
	});

	test("rule 23: a local import of an external module is resolved external", async () => {
		const result = await one("def f():\n    import os\n    os.getcwd()\n");
		expect(result.callBins.resolvedExternal).toBe(1);
	});

	test("rule 23: an unresolved local import carries S3's reason, not a new one", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/use.py", "def f():\n    from .missing import target\n    target()\n"),
		]);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toContain("module-not-found");
	});

	test("rule 23: a nested function's local import binds in its own scope (LEGB)", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "def outer():\n    def inner():\n        from .mod import target\n        target()\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([4]);
	});

	test("rule 23: a function-local import shadows a module-level one", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/other.py", "def target():\n    pass\n"),
			py("pkg/use.py", "from .mod import target\ndef f():\n    from .other import target\n    target()\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/other.py"))).toEqual([4]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([]);
	});

	test("rule 23: a local `import a.b` binds the top package a", async () => {
		const result = await one("def f():\n    import os.path\n    os.getcwd()\n");
		expect(result.callBins.resolvedExternal).toBe(1);
	});
});

// --- rule 24 ---------------------------------------------------------------

describe("rule 24 — from-imported external names as receivers", () => {
	test("rule 24: an external from-import of a module resolves attribute calls external", async () => {
		const result = await one("from os import path\ndef f():\n    path.join('a', 'b')\n");
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(result.sites).toEqual([]);
	});

	test("rule 24: an external from-import of a class resolves attribute calls external", async () => {
		const result = await one("from os import PathLike\ndef f():\n    PathLike.register(int)\n");
		expect(result.callBins.resolvedExternal).toBe(1);
	});

	test("rule 24: an alias of an external name stays unresolved-receiver", async () => {
		const result = await one("from os import path\np = path\ndef f():\n    p.join('a', 'b')\n");
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(result.callBins.resolvedExternal).toBe(0);
	});

	test("rule 24: a value computed from an external name stays unresolved-receiver", async () => {
		const result = await one("from pathlib import Path\ndef f():\n    p = Path()\n    p.exists()\n");
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(result.sites).toEqual([]);
	});
});

// --- rule 25 ---------------------------------------------------------------

describe("rule 25 — multiply-bound class alternatives", () => {
	test("rule 25: each class alternative is a construction with a class and an __init__ edge, all flagged", async () => {
		const result = await one(
			[
				"try:",
				"    class K:",
				"        def __init__(self):",
				"            pass",
				"except Exception:",
				"    class K:",
				"        def __init__(self):",
				"            pass",
				"def f():",
				"    K()",
			].join("\n"),
		);
		expect(result.callBins.resolvedInRepo).toBe(1);
		expect(result.multiplyBoundCount).toBe(1);
		expect(result.sites).toHaveLength(4);
		expect(result.sites.every((site) => site.multiplyBound === true)).toBe(true);
		expect(result.sites.every((site) => site.kind === "new")).toBe(true);
	});
});

// --- rule 26 ---------------------------------------------------------------

describe("rule 26 — the first parameter of a method is the receiver by decorator", () => {
	test("rule 26: a plain method's receiver works renamed `this`", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    def m(this):\n        this.helper()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([5]);
	});

	test("rule 26: a @classmethod's receiver works renamed `klass` (lookup and construction)", async () => {
		const lookup = await one(
			"class C:\n    def helper(self):\n        pass\n    @classmethod\n    def m(klass):\n        klass.helper()\n",
		);
		expect(linesTo(lookup, symbolId(lookup, "C.helper"))).toEqual([6]);
		const build = await one("class C:\n    @classmethod\n    def m(klass):\n        return klass()\n");
		expect(linesTo(build, symbolId(build, "C"))).toEqual([4]);
	});

	test("rule 26: a @staticmethod's first parameter is not a receiver", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    @staticmethod\n    def m(self):\n        self.helper()\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
	});

	test("rule 26: @classmethod shadowed by a local name is not recognised", async () => {
		const result = await one(
			"class C:\n    classmethod = None\n    @classmethod\n    def m(cls):\n        return cls()\n",
		);
		expect(result.sites).toEqual([]);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("rule 26: a nested def and a lambda use the enclosing method's receiver via LEGB", async () => {
		const nested = await one(
			"class C:\n    def helper(self):\n        pass\n    def m(self):\n        def inner():\n            self.helper()\n        return inner\n",
		);
		expect(linesTo(nested, symbolId(nested, "C.helper"))).toEqual([6]);
		const lambda = await one(
			"class C:\n    def helper(self):\n        pass\n    def m(self):\n        return lambda: self.helper()\n",
		);
		expect(linesTo(lambda, symbolId(lambda, "C.helper"))).toEqual([5]);
	});

	test("rule 26: a nested function that rebinds the receiver name is not the receiver", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    def m(self):\n        def inner(self):\n            self.helper()\n        return inner\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
	});

	test("rule 26: the implicit classmethods __new__ and __init_subclass__ take the class", async () => {
		const newer = await one(
			"class C:\n    def helper(self):\n        pass\n    def __new__(cls):\n        return cls.helper()\n",
		);
		expect(linesTo(newer, symbolId(newer, "C.helper"))).toEqual([5]);
		const subclass = await one(
			"class C:\n    @staticmethod\n    def helper():\n        pass\n    def __init_subclass__(cls):\n        cls.helper()\n",
		);
		expect(linesTo(subclass, symbolId(subclass, "C.helper"))).toEqual([6]);
	});

	test("rule 26: the implicit classmethod __class_getitem__ takes the class", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    def __class_getitem__(cls):\n        return cls.helper()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([5]);
	});

	test("rule 26: @staticmethod shadowed by a local name is not recognised", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    staticmethod = None\n    @staticmethod\n    def m(self):\n        self.helper()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([7]);
	});

	test("rule 26: @classmethod shadowed by an enclosing parameter is not recognised", async () => {
		const result = await one(
			"def make(classmethod):\n    class D:\n        @classmethod\n        def m(cls):\n            return cls()\n",
		);
		expect(result.callBins.resolvedInRepo).toBe(0);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("rule 26: @classmethod shadowed by a module import is not recognised", async () => {
		const result = await one("import classmethod\nclass C:\n    @classmethod\n    def m(cls):\n        return cls()\n");
		expect(result.callBins.resolvedInRepo).toBe(0);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("rule 26: a plain method whose first parameter is named cls does not construct", async () => {
		const result = await one("class C:\n    def m(cls):\n        return cls()\n");
		expect(result.callBins.resolvedInRepo).toBe(0);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("rule 26: @staticmethod on __new__ wins over the implicit classmethod", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    @staticmethod\n    def __new__(cls):\n        return cls.helper()\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
	});
});

// --- rule 27 ---------------------------------------------------------------

describe("rule 27 — property attribute calls stay unresolved", () => {
	test("rule 27: calling a @property attribute is unresolved-receiver, with no edge", async () => {
		const result = await one("class C:\n    @property\n    def p(self):\n        return 1\ndef f(c: C):\n    c.p()\n");
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(result.sites).toEqual([]);
	});
});

// --- rule 28 ---------------------------------------------------------------

describe("rule 28 — MRO failure keeps the class edge", () => {
	test("rule 28: a class that cannot be linearised keeps its class edge with an mro-failed note", async () => {
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
				"def f():",
				"    E()",
			].join("\n"),
		);
		expect(result.callBins.resolvedInRepo).toBe(1);
		expect(sitesTo(result, symbolId(result, "E"))).toHaveLength(1);
		expect(result.constructorNotes.map((note) => note.reasons)).toEqual([["mro-failed"]]);
	});
});

// --- rule 32 ---------------------------------------------------------------

describe("rule 32 — only a plain first parameter is a receiver", () => {
	test("rule 32: a *args first parameter is not a receiver under an in-repo base", async () => {
		const result = await one(
			"class C:\n    def index(self):\n        pass\n    def m(*args):\n        args.index(1)\n",
		);
		// GCLI-108 (K1): the splat is a tuple, so the call is the builtin's, not unresolved
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(linesTo(result, symbolId(result, "C.index"))).toEqual([]);
	});

	test("rule 32: a **kwargs first parameter is not a receiver under an in-repo base", async () => {
		const result = await one(
			"class C:\n    def get(self, key):\n        pass\n    def m(**kwargs):\n        kwargs.get(1)\n",
		);
		// GCLI-108 (K1): the splat is a dict, so the call is the builtin's
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(linesTo(result, symbolId(result, "C.get"))).toEqual([]);
	});

	test("rule 32: a *args first parameter is not a receiver under an opaque external base", async () => {
		const result = await one(
			"class C(Unknown):\n    def index(self):\n        pass\n    def m(*args):\n        args.index(1)\n",
		);
		// GCLI-108 (K1): resolved-external as the tuple's method, whatever the opaque base
		expect(result.callBins.receiverNeedsInference).toBe(0);
		expect(result.callBins.resolvedExternal).toBe(1);
	});

	test("rule 32: @classmethod with *args is not a construction", async () => {
		const result = await one("class C:\n    @classmethod\n    def m(*args):\n        return args()\n");
		expect(result.callBins.resolvedInRepo).toBe(0);
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["run-time-bound"]);
	});

	test("rule 32: a plain first parameter is still the receiver", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    def m(this):\n        this.helper()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([5]);
	});
});

// --- rule 29 ---------------------------------------------------------------

describe("rule 29a — metaclass=type", () => {
	test("rule 29a: an explicit metaclass=type is not a constructor-note trigger", async () => {
		const result = await one("class C(metaclass=type):\n    def __init__(self):\n        pass\ndef f():\n    C()\n");
		expect(result.constructorNotes).toEqual([]);
		expect(result.callBins.resolvedInRepo).toBe(1);
		expect(result.sites).toHaveLength(2);
	});

	test("rule 29a: an inherited non-type metaclass still keeps the note", async () => {
		const result = await one(
			[
				"class Meta(type):",
				"    def __init__(self):",
				"        pass",
				"class B(metaclass=Meta):",
				"    pass",
				"class C(B):",
				"    pass",
				"def f():",
				"    C()",
			].join("\n"),
		);
		expect(result.constructorNotes.map((note) => note.reasons)).toEqual([["metaclass"]]);
	});
});

describe("rule 29b — builtin versus a star import", () => {
	test("rule 29b: a partial or unknown star import blocks the builtin", async () => {
		const result = await one("from os import *\ndef f():\n    len([])\n");
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "star-import", count: 1, firstSites: [{ file: "app.py", line: 3, column: 5 }] },
		]);
	});
});

describe("rule 33 — a name supplied by a complete star import", () => {
	test("rule 33: a builtin-named def supplied by a complete star resolves in the repository", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def open():\n    pass\n"),
			py("pkg/use.py", "from .mod import *\ndef f():\n    open()\n"),
		]);
		expect(linesTo(result, symbolId(result, "open", "pkg/mod.py"))).toEqual([3]);
		expect(result.callBins.resolvedExternal).toBe(0);
	});

	test("rule 33: a builtin name re-exported by the star target resolves in the repository", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/compat.py", "def open():\n    pass\n"),
			py("pkg/mod.py", "from .compat import open\n"),
			py("pkg/use.py", "from .mod import *\ndef f():\n    open()\n"),
		]);
		expect(linesTo(result, symbolId(result, "open", "pkg/compat.py"))).toEqual([3]);
		expect(result.callBins.resolvedExternal).toBe(0);
	});

	test("rule 33: a name in a complete set the target does not bind is star-bound", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", '__all__ = ["ghost"]\n'),
			py("pkg/use.py", "from .mod import *\ndef f():\n    ghost()\n"),
		]);
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["star-bound"]);
	});

	test("rule 33: a single alias assignment in the star target is followed", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\nalias = target\n"),
			py("pkg/use.py", "from .mod import *\ndef f():\n    alias()\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([3]);
	});

	test("rule 33: any other assignment in the star target is run-time-bound", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "value = 1\n"),
			py("pkg/use.py", "from .mod import *\ndef f():\n    value()\n"),
		]);
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["run-time-bound"]);
	});

	test("rule 33: a complete set that lacks a builtin leaves the builtin", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def starred():\n    pass\n"),
			py("pkg/use.py", "from .mod import *\ndef f():\n    starred()\n    len([])\n"),
		]);
		expect(linesTo(result, symbolId(result, "starred", "pkg/mod.py"))).toEqual([3]);
		expect(result.callBins.resolvedExternal).toBe(1);
		expect(result.callBins.nameNotBound).toBe(0);
	});
});

describe("rule 29c — literal receivers", () => {
	test("rule 29c: a string literal receiver is resolved external", async () => {
		const result = await one("def f():\n    'x'.join([])\n");
		expect(result.callBins.resolvedExternal).toBe(1);
	});

	test("rule 29c: list, dict, set, tuple and f-string literal receivers are external", async () => {
		const result = await one(
			"def f():\n    [].append(1)\n    {}.keys()\n    {1}.add(2)\n    (1, 2).count(1)\n    f'{1}'.upper()\n",
		);
		expect(result.callBins.resolvedExternal).toBe(5);
	});

	test("rule 29c: a name bound to a literal stays unresolved-receiver", async () => {
		const result = await one("items = []\ndef f():\n    items.append(1)\n");
		expect(result.callBins.receiverNeedsInference).toBe(1);
	});
});

describe("rule 29g — an unaliased dotted import binds the top package", () => {
	test("rule 29g: import os.path binds os, so os.getcwd() is external", async () => {
		const result = await one("import os.path\ndef f():\n    os.getcwd()\n");
		expect(result.callBins.resolvedExternal).toBe(1);
	});
});

// --- rule 36 ---------------------------------------------------------------

describe("rule 36 — a rebound or bare-used def yields no receiver", () => {
	test("rule 36: a class-scope rebinding helper = staticmethod(helper) yields no receiver", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    helper = staticmethod(helper)\n    def m(self):\n        self.helper()\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
	});

	test("rule 36/43: a def used as @_deco in its own class body still takes calls to it", async () => {
		const result = await one(
			"class C:\n    def _deco(self):\n        pass\n    @_deco\n    def target(self):\n        pass\ndef f(c: C):\n    c._deco()\n",
		);
		// Rule 43: a decorator use does not rebind the name, so the call resolves.
		const deco = symbolId(result, "C._deco");
		expect(
			result.sites.filter((site) => site.kind === "call" && site.calleeId === deco).map((site) => site.line),
		).toEqual([8]);
		expect(result.callBins.receiverNeedsInference).toBe(0);
	});

	test("rule 36: a def used by that bare name only inside a method body keeps its receiver", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    def m(self):\n        helper()\n    def use(self):\n        self.helper()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([7]);
		expect(result.callBins.nameNotBound).toBe(1);
	});
});

// --- rule 37 ---------------------------------------------------------------

describe("rule 37 — one shadow rule for every builtin test", () => {
	test("rule 37: a partial star import blocks @classmethod recognition", async () => {
		const result = await one("from os import *\nclass C:\n    @classmethod\n    def m(cls):\n        return cls()\n");
		expect(result.callBins.resolvedInRepo).toBe(0);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("rule 37/46: a partial star import leaves @staticmethod unknown, so no receiver", async () => {
		const result = await one(
			"from os import *\nclass C:\n    def helper(self):\n        pass\n    @staticmethod\n    def m(self):\n        self.helper()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
		expect(result.callBins.receiverNeedsInference).toBe(1);
	});

	test("rule 37: a partial star import blocks the rule 4c builtin", async () => {
		const result = await one("from os import *\ndef f():\n    len([])\n");
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.callBins.resolvedExternal).toBe(0);
	});

	test("rule 37: a partial star import blocks metaclass=type, keeping the note", async () => {
		const result = await one("from os import *\nclass C(metaclass=type):\n    pass\ndef f():\n    C()\n");
		expect(result.constructorNotes.map((note) => note.reasons)).toEqual([["metaclass"]]);
	});

	test("rule 37: a module binding of type keeps the constructor note", async () => {
		const result = await one("type = object\nclass C(metaclass=type):\n    pass\ndef f():\n    C()\n");
		expect(result.constructorNotes.map((note) => note.reasons)).toEqual([["metaclass"]]);
	});

	test("rule 37: an unshadowed metaclass=type is not a note", async () => {
		const result = await one("class C(metaclass=type):\n    pass\ndef f():\n    C()\n");
		expect(result.constructorNotes).toEqual([]);
	});
});

// --- rule 38 ---------------------------------------------------------------

describe("rule 38 — class-body imports are order-aware", () => {
	test("rule 38: a use before a class-body import takes the module binding, after it the import", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "def target():\n    pass\nclass C:\n    target()\n    from .mod import target\n    target()\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/use.py"))).toEqual([4]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([6]);
	});

	test("rule 38: a function body stays flow-insensitive — a later import is local throughout", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", "def target():\n    pass\n"),
			py("pkg/use.py", "def target():\n    pass\ndef f():\n    target()\n    from .mod import target\n"),
		]);
		expect(linesTo(result, symbolId(result, "target", "pkg/mod.py"))).toEqual([4]);
		expect(linesTo(result, symbolId(result, "target", "pkg/use.py"))).toEqual([]);
	});

	test("rule 38: a class-body attribute call before the import takes the enclosing binding", async () => {
		const result = await one("class C:\n    path.join('a', 'b')\n    from os import path\n");
		expect(result.callBins.resolvedExternal).toBe(0);
		expect(result.callBins.receiverNeedsInference).toBe(1);
	});

	test("rule 38: a class-body attribute call after the import resolves external", async () => {
		const result = await one("class C:\n    from os import path\n    path.join('a', 'b')\n");
		expect(result.callBins.resolvedExternal).toBe(1);
	});
});

// --- rule 40 ---------------------------------------------------------------

describe("rule 40 — star lookup is bounded", () => {
	test("rule 40: a two-module mutual star cycle terminates and reports import-cycle", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/a.py", '__all__ = ["x"]\nfrom .b import *\n'),
			py("pkg/b.py", '__all__ = ["x"]\nfrom .a import *\n'),
			py("pkg/use.py", "from .a import *\ndef f():\n    x()\n"),
		]);
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.unresolvedNameReasons).toEqual([
			{ reason: "import-cycle", count: 1, firstSites: [{ file: "pkg/use.py", line: 3, column: 5 }] },
		]);
	});

	test("rule 40/45: a path cut by a cycle does not stop an earlier star that exports the name", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/a.py", '__all__ = ["x"]\nfrom .b import *\n'),
			py("pkg/b.py", '__all__ = ["x"]\nfrom .a import *\nfrom .c import *\n'),
			py("pkg/c.py", '__all__ = ["x"]\ndef x():\n    pass\n'),
			py("pkg/use.py", "from .b import *\ndef f():\n    x()\n"),
		]);
		// Rule 45 walks b's stars last to first, so c (which defines x) is read
		// before a (which cycles); the cycle still terminates the a path.
		expect(linesTo(result, symbolId(result, "x", "pkg/c.py"))).toEqual([3]);
		expect(result.callBins.nameNotBound).toBe(0);
	});
});

// --- rule 41 ---------------------------------------------------------------

describe("rule 41 — rule 36 and the typed splat are pinned", () => {
	test("rule 41a: a def rebound by staticmethod has no receiver for its own first parameter", async () => {
		const result = await one(
			"class C:\n    def other(self):\n        pass\n    def helper(self):\n        self.other()\n    helper = staticmethod(helper)\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.other"))).toEqual([]);
	});

	test("rule 41b: a def used as @_deco in its own class body has no receiver for its own first parameter", async () => {
		const result = await one(
			"class C:\n    def other(self):\n        pass\n    def _deco(f):\n        f.other()\n    @_deco\n    def target(self):\n        pass\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.other"))).toEqual([]);
	});

	test("rule 41c: a def used by bare name only inside a method body keeps its receiver", async () => {
		const result = await one(
			"class C:\n    def other(self):\n        pass\n    def helper(self):\n        self.other()\n    def use(self):\n        helper()\n",
		);
		expect(linesTo(result, symbolId(result, "C.other"))).toEqual([5]);
		expect(result.callBins.receiverNeedsInference).toBe(0);
	});

	test("rule 41d: a typed splat first parameter is no receiver; typed and defaulted plain ones are", async () => {
		const result = await one(
			"class C:\n    def other(self):\n        pass\n    def m(*args: Any):\n        args.other()\n    def p(self: Any):\n        self.other()\n    def q(self=None):\n        self.other()\n",
		);
		expect(linesTo(result, symbolId(result, "C.other"))).toEqual([7, 9]);
		// GCLI-108 (K1): `args.other()` is the tuple's, resolved-external
		expect(result.callBins.resolvedExternal).toBe(1);
	});
});

// --- rule 43 ---------------------------------------------------------------

describe("rule 43 — calls to a bare-used def still resolve", () => {
	test("rule 43: self._deco() resolves when _deco is also used as @_deco in its own class body", async () => {
		const result = await one(
			"class C:\n    def _deco(self):\n        pass\n    @_deco\n    def target(self):\n        pass\n    def m(self):\n        self._deco()\n",
		);
		const deco = symbolId(result, "C._deco");
		expect(
			result.sites.filter((site) => site.kind === "call" && site.calleeId === deco).map((site) => site.line),
		).toEqual([8]);
		expect(result.callBins.resolvedInRepo).toBe(1);
	});

	test("rule 43: a class-scope rebinding still makes calls to the def unresolved", async () => {
		const result = await one(
			"class C:\n    def helper(self):\n        pass\n    helper = staticmethod(helper)\n    def m(self):\n        self.helper()\n",
		);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
	});
});

// --- rule 44 ---------------------------------------------------------------

describe("rule 44 — super and type are builtin tests", () => {
	test("rule 44: a module binding of super makes super().m() an ordinary call", async () => {
		const result = await one(
			"def super():\n    pass\nclass B:\n    def m(self):\n        pass\nclass C(B):\n    def m(self):\n        super().m()\n",
		);
		// The inner super() resolves to the module def; the outer call must not
		// reach the base method the builtin super() would find.
		expect(linesTo(result, symbolId(result, "super"))).toEqual([8]);
		expect(linesTo(result, symbolId(result, "B.m"))).toEqual([]);
		expect(result.callBins.receiverNeedsInference).toBe(1);
	});

	test("rule 44: a module binding of type makes type(x)(...) an ordinary call", async () => {
		const result = await one("def type(x):\n    pass\nclass C:\n    def m(self):\n        type(self)()\n");
		expect(result.callBins.resolvedInRepo).toBe(2);
		expect(result.callBins.receiverNeedsInference).toBe(0);
		const builtin = await one("class C:\n    def m(self):\n        type(self)()\n");
		expect(builtin.callBins.resolvedExternal).toBe(1);
		expect(builtin.callBins.receiverNeedsInference).toBe(1);
	});

	test("rule 44: a partial star makes super star-bound even when a complete star exports it", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", '__all__ = ["super"]\ndef super():\n    pass\n'),
			py("pkg/use.py", "from .mod import *\nfrom os import *\nclass C:\n    def m(self):\n        super().m()\n"),
		]);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["star-bound"]);
		expect(result.callBins.receiverNeedsInference).toBe(1);
	});
});

// --- rule 45 ---------------------------------------------------------------

describe("rule 45 — several star imports, last wins", () => {
	test("rule 45: the last star import that exports the name wins", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/a.py", "def x():\n    pass\n"),
			py("pkg/b.py", "def x():\n    pass\n"),
			py("pkg/c.py", "def x():\n    pass\n"),
			py("pkg/use.py", "from .a import *\nfrom .b import *\nfrom .c import *\ndef f():\n    x()\n"),
		]);
		expect(linesTo(result, symbolId(result, "x", "pkg/c.py"))).toEqual([5]);
	});

	test("rule 45: a later complete star that does not export the name is skipped", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/a.py", "def x():\n    pass\n"),
			py("pkg/b.py", "def y():\n    pass\n"),
			py("pkg/use.py", "from .a import *\nfrom .b import *\ndef f():\n    x()\n"),
		]);
		expect(linesTo(result, symbolId(result, "x", "pkg/a.py"))).toEqual([4]);
	});

	test("rule 45: a later partial star makes the name star-bound even over an earlier complete exporter", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/a.py", "def x():\n    pass\n"),
			py("pkg/use.py", "from .a import *\nfrom os import *\ndef f():\n    x()\n"),
		]);
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["star-bound"]);
	});
});

// --- rule 46 ---------------------------------------------------------------

describe("rule 46 — staticmethod and classmethod under a partial star", () => {
	test("rule 46: @staticmethod under a partial star gives no receiver but calls to it resolve", async () => {
		const result = await one(
			"from os import *\nclass C:\n    def helper(self):\n        pass\n    @staticmethod\n    def m(self):\n        self.helper()\n    def use(self):\n        C.m()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(linesTo(result, symbolId(result, "C.m"))).toEqual([9]);
	});

	test("rule 46: @classmethod under a partial star gives no receiver and no construction", async () => {
		const result = await one(
			"from os import *\nclass C:\n    def helper(self):\n        pass\n    @classmethod\n    def m(cls):\n        cls.helper()\n        cls()\n    def use(self):\n        C.m()\n",
		);
		expect(linesTo(result, symbolId(result, "C.helper"))).toEqual([]);
		expect(linesTo(result, symbolId(result, "C"))).toEqual([]);
		expect(result.callBins.receiverNeedsInference).toBe(1);
		expect(result.callBins.nameNotBound).toBe(1);
		expect(linesTo(result, symbolId(result, "C.m"))).toEqual([10]);
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

// DEC-303 (a26) item 1: the flask-shaped case. The base class lives in a module
// reached through a directory with no __init__.py, so the base must resolve in
// repository rather than leaving Flask with an opaque (external-base) base.
describe("DEC-303 (a26) — a base reached through a namespace directory", () => {
	const scaffold = "class Scaffold:\n    def helper(self):\n        pass\n";
	const base = "from .scaffold import Scaffold\n\nclass App(Scaffold):\n    def m(self):\n        pass\n";

	test("a relative from-import through a namespace directory: self.m() resolves to the in-repo base", async () => {
		const files = [
			py("pkg/__init__.py", ""),
			py("pkg/sansio/scaffold.py", scaffold),
			py("pkg/sansio/app.py", base),
			py(
				"pkg/app.py",
				"from .sansio.app import App\n\nclass Flask(App):\n    def go(self):\n        self.m()\n        self.helper()\n",
			),
		];
		const result = await analyze(files);
		expect(result.callBins.resolvedExternal).toBe(0);
		expect(linesTo(result, symbolId(result, "App.m", "pkg/sansio/app.py"))).toEqual([5]);
		expect(linesTo(result, symbolId(result, "Scaffold.helper", "pkg/sansio/scaffold.py"))).toEqual([6]);
	});

	test("the absolute from-import form resolves the same way", async () => {
		const files = [
			py("src/pkg/__init__.py", ""),
			py("src/pkg/sansio/scaffold.py", scaffold),
			py("src/pkg/sansio/app.py", base),
			py(
				"src/pkg/app.py",
				"from pkg.sansio.app import App\n\nclass Flask(App):\n    def go(self):\n        self.m()\n",
			),
		];
		const result = await analyze(files);
		expect(linesTo(result, symbolId(result, "App.m", "src/pkg/sansio/app.py"))).toEqual([5]);
	});

	test("negative control: __path__ manipulation in the ancestor keeps the base opaque", async () => {
		const files = [
			py("pkg/__init__.py", "import pkgutil\n__path__ = pkgutil.extend_path(__path__, __name__)\n"),
			py("pkg/sansio/scaffold.py", scaffold),
			py("pkg/sansio/app.py", base),
			py("pkg/app.py", "from .sansio.app import App\n\nclass Flask(App):\n    def go(self):\n        self.m()\n"),
		];
		const result = await analyze(files);
		expect(linesTo(result, symbolId(result, "App.m", "pkg/sansio/app.py"))).toEqual([]);
		expect(result.callBins.resolvedExternal).toBeGreaterThan(0);
	});

	// DEC-303 (a27) Q2: a dotted attribute chain through a single-portion namespace
	// directory resolves by (a26) item 1, as it does when the directory has an __init__.py.
	const mod = "class Base:\n    def m(self):\n        pass\n\ndef helper():\n    pass\n";

	test("Q2: class C(pkg.ns.mod.Base) after import pkg.ns.mod resolves self.m()", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", mod),
			py("src/use.py", "import pkg.ns.mod\n\nclass C(pkg.ns.mod.Base):\n    def go(self):\n        self.m()\n"),
		]);
		expect(linesTo(result, symbolId(result, "Base.m", "src/pkg/ns/mod.py"))).toEqual([5]);
	});

	test("Q2: a call pkg.ns.mod.helper() through the chain resolves, and so does a two-level chain", async () => {
		const one = await analyze([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", mod),
			py("src/use.py", "import pkg.ns.mod\n\npkg.ns.mod.helper()\n"),
		]);
		expect(linesTo(one, symbolId(one, "helper", "src/pkg/ns/mod.py"))).toEqual([3]);
		const two = await analyze([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/a/b/mod.py", mod),
			py("src/use.py", "import pkg.a.b.mod\n\npkg.a.b.mod.helper()\n"),
		]);
		expect(linesTo(two, symbolId(two, "helper", "src/pkg/a/b/mod.py"))).toEqual([3]);
	});

	test("Q2 negative controls: a top-level namespace chain and a manipulated ancestor stay unresolved", async () => {
		const top = await analyze([py("src/ns/mod.py", mod), py("src/use.py", "import ns.mod\n\nns.mod.helper()\n")]);
		expect(linesTo(top, symbolId(top, "helper", "src/ns/mod.py"))).toEqual([]);
		const manipulated = await analyze([
			py("src/pkg/__init__.py", "__path__ = []\n"),
			py("src/pkg/ns/mod.py", mod),
			py("src/use.py", "import pkg.ns.mod\n\npkg.ns.mod.helper()\n"),
		]);
		expect(linesTo(manipulated, symbolId(manipulated, "helper", "src/pkg/ns/mod.py"))).toEqual([]);
		// the chain is walked from a bare `import pkg`, so the ancestor check must hold there too
		const bare = await analyze([
			py("src/pkg/__init__.py", "__path__ = []\n"),
			py("src/pkg/ns/mod.py", mod),
			py("src/use.py", "import pkg\n\npkg.ns.mod.helper()\n"),
		]);
		expect(linesTo(bare, symbolId(bare, "helper", "src/pkg/ns/mod.py"))).toEqual([]);
	});

	test("Q2: a bare import pkg then pkg.ns.mod.helper() resolves under an empty and a non-empty anchor (positive)", async () => {
		const bareOk = await analyze([
			py("src/pkg/__init__.py", 'from .app import Flask\n\n__all__ = ["Flask"]\n__version__ = "1"\n'),
			py("src/pkg/app.py", "class Flask:\n    pass\n"),
			py("src/pkg/ns/mod.py", mod),
			py("src/use.py", "import pkg\n\npkg.ns.mod.helper()\n"),
		]);
		expect(linesTo(bareOk, symbolId(bareOk, "helper", "src/pkg/ns/mod.py"))).toEqual([3]);
		const emptyAnchor = await analyze([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", mod),
			py("src/use.py", "import pkg\n\npkg.ns.mod.helper()\n"),
		]);
		expect(linesTo(emptyAnchor, symbolId(emptyAnchor, "helper", "src/pkg/ns/mod.py"))).toEqual([3]);
	});

	test("Q1 at the call level: from pkg.ns import mod then mod.helper(), and from . import mod inside the directory", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", 'from .app import Flask\n\n__version__ = "1"\n'),
			py("src/pkg/app.py", "class Flask:\n    pass\n"),
			py("src/pkg/ns/mod.py", mod),
			py("src/pkg/ns/sib.py", "from . import mod\n\nmod.helper()\n"),
			py("src/use.py", "from pkg.ns import mod\n\nmod.helper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/ns/mod.py"))).toEqual([3, 3]);
	});
});

// DEC-303 (a22) item 3, group A4: `from m import m` where the source is a module FILE
// m.py that defines `m`. Fixtures are written from Python semantics, not from a repository.
describe("A4 — from m import m for a module file", () => {
	const helperDef = "def helper():\n    pass\n";

	test("from .helper import helper resolves the call to the function in helper.py", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/helper.py", helperDef),
			py("pkg/use.py", "from .helper import helper\n\ndef f():\n    helper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "pkg/helper.py"))).toEqual([4]);
		expect(result.callBins.nameNotBound).toBe(0);
	});

	test("the absolute form and an alias resolve too", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/helper.py", helperDef),
			py("src/use.py", "from pkg.helper import helper\nfrom pkg.helper import helper as h\n\nhelper()\nh()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/helper.py"))).toEqual([4, 5]);
	});

	test("a class in the same-named module resolves as a construction", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/widget.py", "class widget:\n    pass\n"),
			py("pkg/use.py", "from .widget import widget\n\nwidget()\n"),
		]);
		expect(linesTo(result, symbolId(result, "widget", "pkg/widget.py"))).toEqual([3]);
	});

	test("a re-export from a differently named file is followed (never reaches the A4 gate)", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/impl.py", helperDef),
			py("pkg/helper.py", "from .impl import helper\n"),
			py("pkg/use.py", "from .helper import helper\n\nhelper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "pkg/impl.py"))).toEqual([3]);
	});

	test("the name reached as a module attribute (mod.helper()) resolves the same way", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/helper.py", helperDef),
			py("pkg/reexport.py", "from .helper import helper\n"),
			py("pkg/use.py", "from . import reexport\n\nreexport.helper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "pkg/helper.py"))).toEqual([3]);
	});

	test("negative: a package source with a same-named submodule binds the submodule (absolute and relative)", async () => {
		for (const use of ["from pkg.helper import helper\n\nhelper()\n", "from .helper import helper\n\nhelper()\n"]) {
			for (const init of ["", "x = 1\n"]) {
				const result = await analyze([
					py("pkg/__init__.py", ""),
					py("pkg/helper/__init__.py", init),
					py("pkg/helper/helper.py", helperDef),
					py("pkg/use.py", use),
				]);
				expect(linesTo(result, symbolId(result, "helper", "pkg/helper/helper.py"))).toEqual([]);
				expect(result.callBins.nameNotBound).toBe(1);
			}
		}
	});

	test("negative: a namespace directory with a same-named submodule binds the submodule", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/ns/ns.py", "def ns():\n    pass\n"),
			py("pkg/use.py", "from pkg.ns import ns\n\nns()\n"),
		]);
		expect(linesTo(result, symbolId(result, "ns", "pkg/ns/ns.py"))).toEqual([]);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("a module file that re-exports the name from a same-named file in another package resolves", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/other/__init__.py", ""),
			py("pkg/other/helper.py", helperDef),
			py("pkg/helper.py", "from .other.helper import helper\n"),
			py("pkg/use.py", "from .helper import helper\n\nhelper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "pkg/other/helper.py"))).toEqual([3]);
	});

	test("negative: a module file that only assigns the name leaves the call unresolved", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/helper.py", "helper = make()\n"),
			py("pkg/use.py", "from .helper import helper\n\nhelper()\n"),
		]);
		expect(result.callBins.resolvedInRepo).toBe(0);
		// the gate's false branch leaves the name bound to the module (module-called)
		const reasons = result.unresolvedNameReasons.map((entry) => entry.reason);
		expect(reasons).toContain("module-called");
		expect(reasons).not.toContain("run-time-bound");
	});

	test("negative: a re-export hop through a package binds the submodule, not the function", async () => {
		for (const hop of ["from .sub import helper\n", "from pkg.sub import helper\n"]) {
			for (const use of ["from .helper import helper\n\nhelper()\n", "from pkg.helper import helper\n\nhelper()\n"]) {
				for (const init of ["", "x = 1\n"]) {
					const result = await analyze([
						py("pkg/__init__.py", ""),
						py("pkg/sub/__init__.py", init),
						py("pkg/sub/helper.py", helperDef),
						py("pkg/helper.py", hop),
						py("pkg/use.py", use),
					]);
					expect(linesTo(result, symbolId(result, "helper", "pkg/sub/helper.py"))).toEqual([]);
					expect(result.callBins.nameNotBound).toBe(1);
				}
			}
		}
	});

	test("a cycle of same-named re-exports terminates unresolved (depth guard through the gate)", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/a/__init__.py", ""),
			py("pkg/b/__init__.py", ""),
			py("pkg/a/helper.py", "from pkg.b.helper import helper\n"),
			py("pkg/b/helper.py", "from pkg.a.helper import helper\n"),
			py("pkg/use.py", "from pkg.a.helper import helper\n\nhelper()\n"),
		]);
		expect(result.callBins.resolvedInRepo).toBe(0);
	});

	test("a module file inside a single-portion namespace directory resolves (absolute and relative)", async () => {
		for (const use of [
			"from pkg.ns.helper import helper\n\nhelper()\n",
			"from .ns.helper import helper\n\nhelper()\n",
		]) {
			const result = await analyze([
				py("pkg/__init__.py", ""),
				py("pkg/ns/helper.py", helperDef),
				py("pkg/use.py", use),
			]);
			expect(linesTo(result, symbolId(result, "helper", "pkg/ns/helper.py"))).toEqual([3]);
		}
	});

	test("negatives: an aliased import from a package source, and the relative namespace form, bind the submodule", async () => {
		const aliased = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/helper/__init__.py", ""),
			py("pkg/helper/helper.py", helperDef),
			py("pkg/use.py", "from .helper import helper as h\n\nh()\n"),
		]);
		expect(linesTo(aliased, symbolId(aliased, "helper", "pkg/helper/helper.py"))).toEqual([]);
		expect(aliased.callBins.nameNotBound).toBe(1);
		const namespace = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/ns/ns.py", "def ns():\n    pass\n"),
			py("pkg/use.py", "from .ns import ns\n\nns()\n"),
		]);
		expect(linesTo(namespace, symbolId(namespace, "ns", "pkg/ns/ns.py"))).toEqual([]);
		expect(namespace.callBins.nameNotBound).toBe(1);
	});

	test("negative: a package named helper stays unresolved (an __init__ is not admitted)", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/helper/__init__.py", helperDef),
			py("pkg/use.py", "from .helper import helper\n\nhelper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "pkg/helper/__init__.py"))).toEqual([]);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("negative: from . import helper binds the submodule, so calling it stays module-called", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/helper.py", helperDef),
			py("pkg/use.py", "from . import helper\n\nhelper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "pkg/helper.py"))).toEqual([]);
		expect(result.callBins.nameNotBound).toBe(1);
	});

	test("negative: a module file that does not define the name leaves the call unresolved (never reaches the A4 gate)", async () => {
		const result = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/helper.py", "def other():\n    pass\n"),
			py("pkg/use.py", "from .helper import helper\n\nhelper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "other", "pkg/helper.py"))).toEqual([]);
		expect(result.callBins.resolvedInRepo).toBe(0);
	});
});

// DEC-303 (a22) item 3, group A1: `pkg.Name(...)` where pkg/__init__ gets Name from
// `from m import *`. Fixtures are written from Python semantics, not from a repository.
describe("A1 — star re-export read as a module attribute", () => {
	const widget = "class Widget:\n    def __init__(self):\n        pass\n";
	const helper = "def helper():\n    pass\n";

	test("pkg.helper() reads the name a star import bound in pkg/__init__ (no __all__: public names)", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", helper),
			py("src/use.py", "import pkg\n\npkg.helper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([3]);
	});

	test("a class gives its construction (class and __init__)", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", widget),
			py("src/use.py", "import pkg\n\npkg.Widget()\n"),
		]);
		expect(linesTo(result, symbolId(result, "Widget", "src/pkg/impl.py"))).toEqual([3]);
	});

	test("a literal __all__ governs: a listed name resolves, an unlisted public name does not", async () => {
		const files = [
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", `__all__ = ["helper"]\n\n${helper}\ndef other():\n    pass\n`),
		];
		const listed = await analyze([...files, py("src/use.py", "import pkg\n\npkg.helper()\n")]);
		expect(linesTo(listed, symbolId(listed, "helper", "src/pkg/impl.py"))).toEqual([3]);
		const unlisted = await analyze([...files, py("src/use.py", "import pkg\n\npkg.other()\n")]);
		expect(linesTo(unlisted, symbolId(unlisted, "other", "src/pkg/impl.py"))).toEqual([]);
		expect(unlisted.callBins.resolvedInRepo).toBe(0);
	});

	test("a private name is not exported without __all__", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", "def _hidden():\n    pass\n"),
			py("src/use.py", "import pkg\n\npkg._hidden()\n"),
		]);
		expect(linesTo(result, symbolId(result, "_hidden", "src/pkg/impl.py"))).toEqual([]);
	});

	test("a star chain through two packages resolves", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .mid import *\n"),
			py("src/pkg/mid.py", "from .impl import *\n"),
			py("src/pkg/impl.py", helper),
			py("src/use.py", "import pkg\n\npkg.helper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([3]);
	});

	test("last binding in module order wins between two stars exporting the same name", async () => {
		const files = (first: string, second: string) => [
			py("src/pkg/__init__.py", `from .${first} import *\nfrom .${second} import *\n`),
			py("src/pkg/a.py", helper),
			py("src/pkg/b.py", helper),
			py("src/use.py", "import pkg\n\npkg.helper()\n"),
		];
		const ab = await analyze(files("a", "b"));
		expect(linesTo(ab, symbolId(ab, "helper", "src/pkg/b.py"))).toEqual([3]);
		expect(linesTo(ab, symbolId(ab, "helper", "src/pkg/a.py"))).toEqual([]);
		const ba = await analyze(files("b", "a"));
		expect(linesTo(ba, symbolId(ba, "helper", "src/pkg/a.py"))).toEqual([3]);
		expect(linesTo(ba, symbolId(ba, "helper", "src/pkg/b.py"))).toEqual([]);
	});

	test("negative: an incomplete star after the complete one may override, so the call stays unresolved", async () => {
		for (const unknown of ["from somelib import *\n", "from .dyn import *\n"]) {
			const result = await analyze([
				py("src/pkg/__init__.py", `from .impl import *\n${unknown}`),
				py("src/pkg/impl.py", helper),
				py("src/pkg/dyn.py", "__all__ = make_names()\n"),
				py("src/use.py", "import pkg\n\npkg.helper()\n"),
			]);
			expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([]);
			expect(result.callBins.resolvedInRepo).toBe(0);
		}
	});

	test("an incomplete star before a complete one is overridden by it", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from somelib import *\nfrom .impl import *\n"),
			py("src/pkg/impl.py", helper),
			py("src/use.py", "import pkg\n\npkg.helper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([3]);
	});

	test("negative: a source whose __all__ is not a literal leaves the attribute unresolved", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", `__all__ = make_names()\n\n${helper}`),
			py("src/use.py", "import pkg\n\npkg.helper()\n"),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([]);
		expect(result.callBins.resolvedInRepo).toBe(0);
	});

	test("negative: a name no star exports stays attribute-not-found", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", helper),
			py("src/use.py", "import pkg\n\npkg.missing()\n"),
		]);
		expect(result.callBins.resolvedInRepo).toBe(0);
	});

	test("a star cycle terminates without resolving", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .a import *\n"),
			py("src/pkg/a.py", "from .b import *\n"),
			py("src/pkg/b.py", "from .a import *\n"),
			py("src/use.py", "import pkg\n\npkg.helper()\n"),
		]);
		expect(result.callBins.resolvedInRepo).toBe(0);
	});
});

// GCLI-95 review round 1: rebindings the star read must see, a diamond, guards that are reached.
describe("A1 — rebindings, diamond and cycle guards", () => {
	const helper = "def helper():\n    pass\n";
	const use = "import pkg\n\npkg.helper()\n";

	test("negative: a rebinding in the holder after the star keeps the call unresolved (assign, for, with, except)", async () => {
		for (const rebind of [
			"helper = make()\n",
			"for helper in items:\n    pass\n",
			"with ctx() as helper:\n    pass\n",
			"try:\n    pass\nexcept Exception as helper:\n    pass\n",
		]) {
			const result = await analyze([
				py("src/pkg/__init__.py", `from .impl import *\n${rebind}`),
				py("src/pkg/impl.py", helper),
				py("src/use.py", use),
			]);
			expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([]);
			expect(result.callBins.resolvedInRepo).toBe(0);
		}
	});

	test("negative: a rebinding in the star source keeps the call unresolved", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", `${helper}\nhelper = deco(helper)\n`),
			py("src/use.py", use),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([]);
		expect(result.callBins.resolvedInRepo).toBe(0);
	});

	test("a diamond of stars resolves: two branches that both star-import the same source", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .a import *\nfrom .b import *\n"),
			py("src/pkg/a.py", "from .c import *\n"),
			py("src/pkg/b.py", "from .c import *\n"),
			py("src/pkg/c.py", helper),
			py("src/use.py", use),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/c.py"))).toEqual([3]);
	});

	test("negative: complete stars in a cycle whose __all__ names a name nothing defines reach the guard and stay unresolved", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .a import *\n"),
			py("src/pkg/a.py", '__all__ = ["helper"]\nfrom .b import *\n'),
			py("src/pkg/b.py", '__all__ = ["helper"]\nfrom .a import *\n'),
			py("src/use.py", use),
		]);
		expect(result.callBins.resolvedInRepo).toBe(0);
		expect(result.callBins.nameNotBound).toBe(1);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["import-cycle"]);
	});

	test("a later complete star that does not export the name is skipped", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\nfrom .other import *\n"),
			py("src/pkg/impl.py", helper),
			py("src/pkg/other.py", "def unrelated():\n    pass\n"),
			py("src/use.py", use),
		]);
		expect(linesTo(result, symbolId(result, "helper", "src/pkg/impl.py"))).toEqual([3]);
	});

	test("a plain module with no star reports attribute-not-found, not rebound, for a module-level assignment", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/plain.py", "CONST = 3\n"),
			py("src/use.py", "from pkg import plain\n\nplain.CONST()\n"),
		]);
		expect(result.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["attribute-not-found"]);
	});

	test("a class base written pkg.Name resolves, so an inherited method is found through it", async () => {
		const result = await analyze([
			py("src/pkg/__init__.py", "from .impl import *\n"),
			py("src/pkg/impl.py", "class Base:\n    def run(self):\n        pass\n"),
			py("src/use.py", "import pkg\n\nclass Child(pkg.Base):\n    def go(self):\n        self.run()\n"),
		]);
		expect(linesTo(result, symbolId(result, "Base.run", "src/pkg/impl.py"))).toEqual([5]);
	});
});

// GCLI-96 (E1, DEC-303 (a22) item 3): a method called on a directly constructed instance.
describe("E1 — Cls(...).m() on a constructed instance", () => {
	const classC = "class C:\n    def m(self):\n        pass\n";

	/** One module: the class, an optional extra statement block, then the call under test at the last line. */
	function module(extra: string, call = "C().m()"): PythonModuleInput[] {
		return [py("app.py", `${classC}${extra}\n${call}\n`)];
	}

	function callLines(result: PythonCallsResult): number[] {
		return linesTo(result, symbolId(result, "C.m", "app.py"));
	}

	test("positive: the baseline reaches the branch and resolves to C.m", async () => {
		const result = await analyze(module(""));
		expect(callLines(result)).toEqual([5]);
	});

	test("positive: an imported class, a dotted module class and an inherited method resolve", async () => {
		const imported = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", classC),
			py("use.py", "from pkg.mod import C\n\nC().m()\n"),
		]);
		expect(linesTo(imported, symbolId(imported, "C.m", "pkg/mod.py"))).toEqual([3]);
		const dotted = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", classC),
			py("use.py", "import pkg.mod\n\npkg.mod.C().m()\n"),
		]);
		expect(linesTo(dotted, symbolId(dotted, "C.m", "pkg/mod.py"))).toEqual([3]);
		const inherited = await analyze([
			py("app.py", "class B:\n    def m(self):\n        pass\n\nclass C(B):\n    pass\n\nC().m()\n"),
		]);
		expect(linesTo(inherited, symbolId(inherited, "B.m", "app.py"))).toEqual([8]);
	});

	test("positive: the call inside a function and inside a method body resolves", async () => {
		const result = await analyze(module("", "def f():\n    return C().m()"));
		expect(callLines(result)).toEqual([6]);
		const method = await analyze(module("", "class D:\n    def g(self):\n        return C().m()"));
		expect(callLines(method)).toEqual([7]);
	});

	test("negative: every kind of second binding of the class name leaves the call unresolved", async () => {
		const rebinds: Record<string, string> = {
			def: "def C():\n    pass\n",
			class: "class C:\n    pass\n",
			assign: "C = make()\n",
			annotated: "C: object = make()\n",
			augassign: "C += 1\n",
			walrus: "(C := make())\n",
			for: "for C in items:\n    pass\n",
			with: "with ctx() as C:\n    pass\n",
			except: "try:\n    pass\nexcept Exception as C:\n    pass\n",
			import: "from other import C\n",
			conditional: "if flag:\n    class C:\n        pass\n",
			try: "try:\n    class C:\n        pass\nexcept Exception:\n    pass\n",
			"global in a nested function": "def rebind():\n    global C\n    C = make()\n",
		};
		for (const [kind, extra] of Object.entries(rebinds)) {
			const result = await analyze(module(extra));
			const found = result.symbols.filter((symbol) => symbol.qualname === "C.m");
			const edges = found.flatMap((symbol) => sitesTo(result, symbol.id));
			// the site is the last line, never an edge of an unresolved receiver
			expect(
				edges.filter((site) => site.kind === "call"),
				kind,
			).toEqual([]);
		}
	});

	test("a del of the class name introduces no new value, so it does not block resolution", async () => {
		// del adds no value to the name: a later read fails, or falls back to an
		// outer binding (a builtin at module scope, a global in a class body) that
		// this analysis does not model, so del is not recorded as a second binding.
		const result = await analyze([py("app.py", `${classC}\nC().m()\ndel C\n`)]);
		expect(callLines(result)).toEqual([5]);
	});

	test("negative: a __new__ in the MRO (own or inherited) leaves the call unresolved", async () => {
		const own = await analyze([
			py(
				"app.py",
				"class C:\n    def __new__(cls):\n        return object()\n\n    def m(self):\n        pass\n\nC().m()\n",
			),
		]);
		expect(linesTo(own, symbolId(own, "C.m", "app.py"))).toEqual([]);
		const inherited = await analyze([
			py(
				"app.py",
				"class B:\n    def __new__(cls):\n        return object()\n\nclass C(B):\n    def m(self):\n        pass\n\nC().m()\n",
			),
		]);
		expect(linesTo(inherited, symbolId(inherited, "C.m", "app.py"))).toEqual([]);
	});

	test("negative: a non-default metaclass (own or inherited) leaves the call unresolved", async () => {
		const own = await analyze([py("app.py", "class C(metaclass=Meta):\n    def m(self):\n        pass\n\nC().m()\n")]);
		expect(linesTo(own, symbolId(own, "C.m", "app.py"))).toEqual([]);
		const inherited = await analyze([
			py("app.py", "class B(metaclass=Meta):\n    pass\n\nclass C(B):\n    def m(self):\n        pass\n\nC().m()\n"),
		]);
		expect(linesTo(inherited, symbolId(inherited, "C.m", "app.py"))).toEqual([]);
	});

	test("positive: metaclass=type is the default and still resolves; a shadowed type does not", async () => {
		const plain = await analyze([
			py("app.py", "class C(metaclass=type):\n    def m(self):\n        pass\n\nC().m()\n"),
		]);
		expect(linesTo(plain, symbolId(plain, "C.m", "app.py"))).toEqual([5]);
		const shadowed = await analyze([
			py("app.py", "type = make()\n\nclass C(metaclass=type):\n    def m(self):\n        pass\n\nC().m()\n"),
		]);
		expect(linesTo(shadowed, symbolId(shadowed, "C.m", "app.py"))).toEqual([]);
	});

	test("negative: an inconsistent MRO, a longer chain, a function callee and an unbound callee stay unresolved", async () => {
		const mro = await analyze([
			py(
				"app.py",
				"class A:\n    pass\n\nclass B(A):\n    pass\n\nclass C(A, B):\n    def m(self):\n        pass\n\nC().m()\n",
			),
		]);
		expect(linesTo(mro, symbolId(mro, "C.m", "app.py"))).toEqual([]);
		const chain = await analyze(module("", "C().attr.m()"));
		expect(callLines(chain)).toEqual([]);
		// the first segment is a real method, so only the one-segment guard keeps this off C.m
		const methodChain = await analyze(module("", "C().m.x()"));
		expect(callLines(methodChain)).toEqual([]);
		const func = await analyze([py("app.py", "def C():\n    pass\n\nC().m()\n")]);
		expect(func.callBins.resolvedInRepo).toBe(1);
		const unbound = await analyze([py("app.py", "Missing().m()\n")]);
		expect(unbound.callBins.resolvedInRepo).toBe(0);
	});

	test("(a29) Q2: an opaque MRO entry fails closed to receiver-needs-inference, own or inherited", async () => {
		const own = await analyze([py("app.py", "class C(Ext):\n    def m(self):\n        pass\n\nC().m()\n")]);
		expect(linesTo(own, symbolId(own, "C.m", "app.py"))).toEqual([]);
		expect(own.callBins.receiverNeedsInference).toBe(1);
		const absent = await analyze([py("app.py", "class C(Ext):\n    pass\n\nC().m()\n")]);
		expect(absent.callBins.receiverNeedsInference).toBe(1);
		expect(absent.callBins.resolvedExternal).toBe(0);
		const inherited = await analyze([
			py("app.py", "class B(Ext):\n    pass\n\nclass C(B):\n    def m(self):\n        pass\n\nC().m()\n"),
		]);
		expect(linesTo(inherited, symbolId(inherited, "C.m", "app.py"))).toEqual([]);
		// the construction C() resolves; the .m() call is counted receiver-needs-inference
		expect(inherited.callBins.receiverNeedsInference).toBe(1);
		expect(inherited.callBins.resolvedInRepo).toBe(1);
	});

	test("(a29) Q2: an unshadowed builtin base is not opaque; a shadowed one is", async () => {
		const body = "    def m(self):\n        pass\n\nC().m()\n";
		for (const base of ["Exception", "object", "dict"]) {
			const result = await analyze([py("app.py", `class C(${base}):\n${body}`)]);
			expect(linesTo(result, symbolId(result, "C.m", "app.py")), base).toEqual([7 - 2]);
		}
		const shadowed = await analyze([py("app.py", `Exception = make()\n\nclass C(Exception):\n${body}`)]);
		expect(linesTo(shadowed, symbolId(shadowed, "C.m", "app.py"))).toEqual([]);
	});

	test("(a30) the builtin exemption: an inherited builtin base resolves; type, a metaclass MRO and a builtin function do not", async () => {
		const body = "    def m(self):\n        pass\n\nC().m()\n";
		const inherited = await analyze([py("app.py", `class B(Exception):\n    pass\n\nclass C(B):\n${body}`)]);
		expect(linesTo(inherited, symbolId(inherited, "C.m", "app.py"))).toEqual([8]);
		// `type` makes C a metaclass: calling it builds a class, so the site fails closed
		const typed = await analyze([py("app.py", `class C(type):\n${body}`)]);
		expect(linesTo(typed, symbolId(typed, "C.m", "app.py"))).toEqual([]);
		expect(typed.callBins.receiverNeedsInference).toBe(1);
		const throughBase = await analyze([py("app.py", `class M(type):\n    pass\n\nclass C(M):\n${body}`)]);
		expect(linesTo(throughBase, symbolId(throughBase, "C.m", "app.py"))).toEqual([]);
		expect(throughBase.callBins.receiverNeedsInference).toBe(1);
		// reversed.__new__ may return seq.__reversed__(), not the subclass
		const reversed = await analyze([py("app.py", `class C(reversed):\n${body}`)]);
		expect(linesTo(reversed, symbolId(reversed, "C.m", "app.py"))).toEqual([]);
		expect(reversed.callBins.receiverNeedsInference).toBe(1);
		// an exception-looking name that is not a builtin stays opaque
		const notBuiltin = await analyze([py("app.py", `class C(MyError):\n${body}`)]);
		expect(linesTo(notBuiltin, symbolId(notBuiltin, "C.m", "app.py"))).toEqual([]);
		// the non-Error/Exception/Warning builtin exceptions resolve
		for (const name of ["StopIteration", "SystemExit", "KeyboardInterrupt", "GeneratorExit", "StopAsyncIteration"]) {
			const result = await analyze([py("app.py", `class C(${name}):\n${body}`)]);
			expect(linesTo(result, symbolId(result, "C.m", "app.py")), name).toEqual([5]);
		}
		// a builtin function is not a class
		const func = await analyze([py("app.py", `class C(print):\n${body}`)]);
		expect(linesTo(func, symbolId(func, "C.m", "app.py"))).toEqual([]);
		// a metaclass call builds X, then .m(): at runtime that reaches Meta.m, so this empty
		// expectation is a fail-closed miss the (a30) ruling accepts, not ground truth
		const meta = await analyze([
			py("app.py", "class Meta(type):\n    def m(self):\n        pass\n\nMeta('X', (object,), {}).m()\n"),
		]);
		expect(linesTo(meta, symbolId(meta, "Meta.m", "app.py"))).toEqual([]);
		expect(meta.callBins.receiverNeedsInference).toBe(1);
		// a positive twin proves the same shape resolves without `type`
		const twin = await analyze([py("app.py", `class C(object):\n${body}`)]);
		expect(linesTo(twin, symbolId(twin, "C.m", "app.py"))).toEqual([5]);
	});

	test("(a30) the builtin base is checked in the owner's scope, not the call site's", async () => {
		const shadowedInOwner = await analyze([
			py("base.py", "Exception = make()\n\nclass B(Exception):\n    def m(self):\n        pass\n"),
			py("use.py", "from base import B\n\nclass C(B):\n    pass\n\nC().m()\n"),
		]);
		expect(linesTo(shadowedInOwner, symbolId(shadowedInOwner, "B.m", "base.py"))).toEqual([]);
		const shadowedAtCallSite = await analyze([
			py("base.py", "class B(Exception):\n    def m(self):\n        pass\n"),
			py("use.py", "from base import B\n\nException = make()\n\nclass C(B):\n    pass\n\nC().m()\n"),
		]);
		expect(linesTo(shadowedAtCallSite, symbolId(shadowedAtCallSite, "B.m", "base.py"))).toEqual([8]);
	});

	test("(a29) Q3: a dotted callee must be rooted at a module; a nested class or an object attribute stays unresolved", async () => {
		const nested = await analyze([
			py("app.py", "class Outer:\n    class Inner:\n        def m(self):\n            pass\n\nOuter.Inner().m()\n"),
		]);
		expect(linesTo(nested, symbolId(nested, "Outer.Inner.m", "app.py"))).toEqual([]);
		// both the construction and the method call are counted, neither resolved
		expect(nested.callBins.receiverNeedsInference).toBe(2);
		expect(nested.callBins.resolvedInRepo).toBe(0);
		const object = await analyze([py("app.py", `${classC}\nobj = make()\nobj.C().m()\n`)]);
		expect(callLines(object)).toEqual([]);
	});

	test("(a29) Q1: E1 keeps the polymorphic flag when a subclass overrides the method", async () => {
		const result = await analyze([
			py(
				"app.py",
				"class C:\n    def m(self):\n        pass\n\nclass D(C):\n    def m(self):\n        pass\n\nC().m()\n",
			),
		]);
		const sites = sitesTo(result, symbolId(result, "C.m", "app.py"));
		expect(sites.map((site) => site.line)).toEqual([9]);
		expect(sites[0]?.polymorphic).toBe(true);
		expect(result.polymorphicCount).toBe(1);
	});
});

// GCLI-97 (N3, DEC-303 (a22) item 3): x = Cls(); x() dispatches to type(x).__call__.
describe("N3 — x = Cls(); x() calls type(x).__call__", () => {
	const classC = "class C:\n    def __call__(self):\n        pass\n";

	/** The class, then the body; the call under test is the last line unless the body says otherwise. */
	function module(body: string): PythonModuleInput[] {
		return [py("app.py", `${classC}\n${body}\n`)];
	}

	function callLines(result: PythonCallsResult): number[] {
		return linesTo(result, symbolId(result, "C.__call__", "app.py"));
	}

	test("positive: module-level, function-local, inherited and imported dispatch to __call__", async () => {
		expect(callLines(await analyze(module("x = C()\nx()")))).toEqual([6]);
		expect(callLines(await analyze(module("def f():\n    x = C()\n    return x()")))).toEqual([7]);
		const inherited = await analyze([
			py("app.py", "class B:\n    def __call__(self):\n        pass\n\nclass C(B):\n    pass\n\nx = C()\nx()\n"),
		]);
		expect(linesTo(inherited, symbolId(inherited, "B.__call__", "app.py"))).toEqual([9]);
		const imported = await analyze([
			py("pkg/__init__.py", ""),
			py("pkg/mod.py", classC),
			py("use.py", "from pkg.mod import C\n\nx = C()\nx()\n"),
		]);
		expect(linesTo(imported, symbolId(imported, "C.__call__", "pkg/mod.py"))).toEqual([4]);
	});

	test("negative: every kind of second binding of x leaves the call unresolved", async () => {
		const rebinds: Record<string, string> = {
			def: "def x():\n    pass\n",
			class: "class x:\n    pass\n",
			assign: "x = make()\n",
			annotated: "x: object = make()\n",
			augassign: "x += 1\n",
			walrus: "(x := make())\n",
			for: "for x in items:\n    pass\n",
			with: "with ctx() as x:\n    pass\n",
			except: "try:\n    pass\nexcept Exception as x:\n    pass\n",
			import: "from other import x\n",
			conditional: "if flag:\n    x = make()\n",
			"global in a nested function": "def rebind():\n    global x\n    x = make()\n",
		};
		for (const [kind, extra] of Object.entries(rebinds)) {
			const result = await analyze(module(`x = C()\n${extra}\nx()`));
			expect(callLines(result), kind).toEqual([]);
		}
	});

	test("negative: a rebinding of the class name, __new__ and a metaclass leave the call unresolved", async () => {
		expect(callLines(await analyze(module("C = make()\nx = C()\nx()")))).toEqual([]);
		const newer = await analyze([
			py(
				"app.py",
				"class C:\n    def __new__(cls):\n        return object()\n\n    def __call__(self):\n        pass\n\nx = C()\nx()\n",
			),
		]);
		expect(linesTo(newer, symbolId(newer, "C.__call__", "app.py"))).toEqual([]);
		const meta = await analyze([
			py("app.py", "class C(metaclass=Meta):\n    def __call__(self):\n        pass\n\nx = C()\nx()\n"),
		]);
		expect(linesTo(meta, symbolId(meta, "C.__call__", "app.py"))).toEqual([]);
	});

	test("negative: a class with no __call__ (own, inherited or behind an opaque base) gets no edge", async () => {
		const none = await analyze([py("app.py", "class C:\n    pass\n\nx = C()\nx()\n")]);
		expect(none.callBins.resolvedInRepo).toBe(1); // only the construction C()
		const opaque = await analyze([py("app.py", "class C(Ext):\n    pass\n\nx = C()\nx()\n")]);
		expect(opaque.sites.filter((site) => site.line === 5)).toEqual([]);
	});

	test("(a29)/(a30) opaque bases fail closed; builtin classes do not; type and reversed do", async () => {
		const call = "    def __call__(self):\n        pass\n\nx = C()\nx()\n";
		const opaque = await analyze([py("app.py", `class C(Ext):\n${call}`)]);
		expect(linesTo(opaque, symbolId(opaque, "C.__call__", "app.py"))).toEqual([]);
		// (a31) Q1: a refused site stays in the bin it had before N3 (name, run-time-bound):
		// the construction C() is the one in-repo call, x() is the one name-bin call.
		expect(opaque.callBins).toEqual({
			resolvedInRepo: 1,
			resolvedExternal: 0,
			receiverNeedsInference: 0,
			nameNotBound: 1,
		});
		expect(opaque.unresolvedNameReasons.map((entry) => entry.reason)).toEqual(["run-time-bound"]);
		const typed = await analyze([py("app.py", `class C(type):\n${call}`)]);
		expect(linesTo(typed, symbolId(typed, "C.__call__", "app.py"))).toEqual([]);
		expect(typed.callBins.nameNotBound).toBe(1);
		expect(typed.callBins.receiverNeedsInference).toBe(0);
		const reversed = await analyze([py("app.py", `class C(reversed):\n${call}`)]);
		expect(linesTo(reversed, symbolId(reversed, "C.__call__", "app.py"))).toEqual([]);
		expect(reversed.callBins.nameNotBound).toBe(1);
		expect(reversed.callBins.receiverNeedsInference).toBe(0);
		// a builtin base with no __call__ anywhere: no edge and not resolved-external either
		const noCall = await analyze([py("app.py", "class C(Exception):\n    pass\n\nx = C()\nx()\n")]);
		expect(noCall.callBins.resolvedExternal).toBe(0);
		expect(noCall.sites.filter((site) => site.line === 5)).toEqual([]);
		const builtin = await analyze([py("app.py", `class C(Exception):\n${call}`)]);
		expect(linesTo(builtin, symbolId(builtin, "C.__call__", "app.py"))).toEqual([6]);
	});

	// GCLI-102 (DEC-303 (a31) item 5, D4): an unshadowed builtin base earlier in the MRO
	// that defines the name wins over a later in-repo entry; staticmethod has __call__
	// since 3.10, classmethod and int do not.
	test("(a31) item 5: staticmethod earlier in the MRO defines __call__ and wins over a later in-repo base", async () => {
		const b = "class B:\n    def __call__(self):\n        pass\n\n";
		const lines = (result: PythonCallsResult) => linesTo(result, symbolId(result, "B.__call__", "app.py"));
		const wins = await analyze([py("app.py", `${b}class D(staticmethod, B):\n    pass\n\nx = D()\nx()\n`)]);
		expect(lines(wins)).toEqual([]);
		// the refused site keeps the bin it had before N3 (name, run-time-bound)
		expect(wins.callBins.nameNotBound).toBe(1);
		expect(wins.callBins.receiverNeedsInference).toBe(0);
		// positive twins reach the same branch with a base that does not define __call__
		for (const early of ["classmethod", "int", "Exception"]) {
			const twin = await analyze([py("app.py", `${b}class D(${early}, B):\n    pass\n\nx = D()\nx()\n`)]);
			expect(lines(twin), early).toEqual([9]);
		}
		// staticmethod AFTER the in-repo base does not hide it
		const after = await analyze([py("app.py", `${b}class D(B, staticmethod):\n    pass\n\nx = D()\nx()\n`)]);
		expect(lines(after)).toEqual([9]);
		// a grandparent order: the builtin base is earlier in the MRO of D through E
		const nested = await analyze([
			py("app.py", `${b}class E(staticmethod):\n    pass\n\nclass D(E, B):\n    pass\n\nx = D()\nx()\n`),
		]);
		expect(lines(nested)).toEqual([]);
	});

	test("the class's own __call__ is not the call of the class: C() still constructs", async () => {
		const result = await analyze(module("C()"));
		expect(callLines(result)).toEqual([]);
	});
});

// GCLI-105 (DEC-303 (a31) Q2): a class decorator can replace the class, so a decorated
// class is refused for E1, N3 and the constructor-bound case of rule 6d unless every
// decorator is an unshadowed import of one on the known non-replacing list.
describe("class decorators — refused unless on the non-replacing list", () => {
	/** One class with `m` and `__call__`, behind `decorators`, and the three site shapes. */
	async function sites(header: string, decorators: string, extra: PythonModuleInput[] = []) {
		const cls = `${header}${decorators}class C:\n    def m(self):\n        pass\n\n    def __call__(self):\n        pass\n\n`;
		const line = (tail: string) => cls.split("\n").length - 1 + tail.split("\n").length - 1;
		const e1Tail = "C().m()\n";
		const sixD = "x = C()\nx.m()\n";
		const n3 = "x = C()\nx()\n";
		const e1 = await analyze([...extra, py("app.py", cls + e1Tail)]);
		const six = await analyze([...extra, py("app.py", cls + sixD)]);
		const three = await analyze([...extra, py("app.py", cls + n3)]);
		const at = (result: PythonCallsResult, name: string) => linesTo(result, symbolId(result, name, "app.py"));
		return {
			e1: at(e1, "C.m"),
			e1Line: line(e1Tail),
			six: at(six, "C.m"),
			sixLine: line(sixD),
			n3: at(three, "C.__call__"),
			n3Line: line(n3),
			bins: { e1: e1.callBins, six: six.callBins, n3: three.callBins },
		};
	}

	const allowed: Record<string, [string, string]> = {
		undecorated: ["", ""],
		"from dataclasses import dataclass, bare": ["from dataclasses import dataclass\n\n", "@dataclass\n"],
		"dataclass called": ["from dataclasses import dataclass\n\n", "@dataclass(frozen=True)\n"],
		"dataclass aliased": ["from dataclasses import dataclass as dcl\n\n", "@dcl\n"],
		"import dataclasses": ["import dataclasses\n\n", "@dataclasses.dataclass\n"],
		"import dataclasses as dc, called": ["import dataclasses as dc\n\n", "@dc.dataclass(frozen=True)\n"],
		"dataclass with slots=False": ["from dataclasses import dataclass\n\n", "@dataclass(slots=False)\n"],
		"dataclass with slots=False among others": [
			"from dataclasses import dataclass\n\n",
			"@dataclass(frozen=True, slots=False)\n",
		],
		"dataclass called through an alias with a keyword": [
			"from dataclasses import dataclass as dcl\n\n",
			"@dcl(frozen=True)\n",
		],
		"dataclass called with no arguments": ["from dataclasses import dataclass\n\n", "@dataclass()\n"],
		"dataclass with an unrelated keyword after another listed decorator": [
			"from typing import final\nfrom dataclasses import dataclass\n\n",
			"@final\n@dataclass(order=True)\n",
		],
		"functools.total_ordering": ["from functools import total_ordering\n\n", "@total_ordering\n"],
		"typing.final": ["from typing import final\n\n", "@final\n"],
		"typing.runtime_checkable": ["import typing\n\n", "@typing.runtime_checkable\n"],
		"enum.unique": ["from enum import unique\n\n", "@unique\n"],
		"two listed decorators": [
			"from dataclasses import dataclass\nfrom typing import final\n\n",
			"@final\n@dataclass\n",
		],
	};

	const refused: Record<string, [string, string]> = {
		"an unknown name": ["", "@register\n"],
		"a local def": ["def mydec(cls):\n    return cls\n\n", "@mydec\n"],
		"a third-party import": ["from attrs import define\n\n", "@define\n"],
		"the right name from the wrong module": ["from mod import dataclass\n\n", "@dataclass\n"],
		"the right module with the wrong name": ["from dataclasses import field\n\n", "@field\n"],
		"a relative import": ["from .dataclasses import dataclass\n\n", "@dataclass\n"],
		"an attribute of the wrong module": ["import dataclasses\n\n", "@dataclasses.total_ordering\n"],
		"an attribute on a name that is not an import": ["", "@dataclasses.dataclass\n"],
		"a module imported and then used bare": ["import dataclasses\n\n", "@dataclasses\n"],
		"a from-imported name used as a module": ["from dataclasses import dataclass\n\n", "@dataclass.dataclass\n"],
		"a dotted decorator of two segments": ["import dataclasses\n\n", "@dataclasses.dataclass.x\n"],
		"dataclass with slots=True": ["from dataclasses import dataclass\n\n", "@dataclass(slots=True)\n"],
		"dataclass with slots=True through a module alias": ["import dataclasses as dc\n\n", "@dc.dataclass(slots=True)\n"],
		"dataclass with slots set to a variable": [
			"from dataclasses import dataclass\n\nUSE = flag()\n\n",
			"@dataclass(slots=USE)\n",
		],
		"dataclass with slots=True among others": [
			"from dataclasses import dataclass\n\n",
			"@dataclass(frozen=True, slots=True)\n",
		],
		"dataclass with a ** splat that could carry slots": [
			"from dataclasses import dataclass\n\nOPTS = {}\n\n",
			"@dataclass(**OPTS)\n",
		],
		"dataclass with a positional argument": ["from dataclasses import dataclass\n\n", "@dataclass(None)\n"],
		"a listed decorator after a slots dataclass": [
			"from dataclasses import dataclass\nfrom typing import final\n\n",
			"@final\n@dataclass(slots=True)\n",
		],
		"total_ordering called with a keyword": [
			"from functools import total_ordering\n\nX = make()\n\n",
			"@total_ordering(cls=X)\n",
		],
		"total_ordering called with a positional argument": [
			"from functools import total_ordering\n\nX = make()\n\n",
			"@total_ordering(X)\n",
		],
		"total_ordering called through its module": [
			"import functools\n\nX = make()\n\n",
			"@functools.total_ordering(cls=X)\n",
		],
		"total_ordering called with no arguments": ["from functools import total_ordering\n\n", "@total_ordering()\n"],
		"total_ordering called through an alias": [
			"from functools import total_ordering as order\n\nX = make()\n\n",
			"@order(cls=X)\n",
		],
		"final called": ["from typing import final\n\nX = make()\n\n", "@final(cls=X)\n"],
		"runtime_checkable called": ["import typing\n\nX = make()\n\n", "@typing.runtime_checkable(cls=X)\n"],
		"unique called": ["from enum import unique\n\nX = make()\n\n", "@unique(cls=X)\n"],
		"a call result": ["from dataclasses import dataclass\n\n", "@dataclass()()\n"],
		"a listed decorator plus an unlisted one": ["from dataclasses import dataclass\n\n", "@dataclass\n@register\n"],
		"a listed name rebound after the import": [
			"from dataclasses import dataclass\n\ndataclass = wrap(dataclass)\n\n",
			"@dataclass\n",
		],
		"a listed name bound by an import twice": [
			"from dataclasses import dataclass\nfrom other import dataclass\n\n",
			"@dataclass\n",
		],
		"a function-local import": ["def f():\n    from dataclasses import dataclass\n\n", "@dataclass\n"],
	};

	test("positive: a class with no decorator, or only listed ones, resolves at all three sites", async () => {
		for (const [name, [header, decorators]] of Object.entries(allowed)) {
			const result = await sites(header, decorators);
			expect(result.e1, `E1 ${name}`).toEqual([result.e1Line]);
			expect(result.six, `6d ${name}`).toEqual([result.sixLine]);
			expect(result.n3, `N3 ${name}`).toEqual([result.n3Line]);
		}
	});

	test("negative: any other decorator leaves E1, N3 and the constructor-bound 6d site unresolved", async () => {
		for (const [name, [header, decorators]] of Object.entries(refused)) {
			const result = await sites(header, decorators);
			expect(result.e1, `E1 ${name}`).toEqual([]);
			expect(result.six, `6d ${name}`).toEqual([]);
			expect(result.n3, `N3 ${name}`).toEqual([]);
		}
	});

	test("negative: a repo file named like the stdlib module is not the stdlib decorator", async () => {
		const local = (module: string, name: string) => [
			py(`${module}.py`, `def ${name}(cls):\n    return replace(cls)\n`),
		];
		const cases: [string, string, string, string][] = [
			["dataclasses", "dataclass", "from dataclasses import dataclass\n\n", "@dataclass\n"],
			["typing", "final", "from typing import final\n\n", "@final\n"],
			["enum", "unique", "import enum\n\n", "@enum.unique\n"],
			["functools", "total_ordering", "import functools\n\n", "@functools.total_ordering\n"],
		];
		for (const [module, name, header, decorators] of cases) {
			const result = await sites(header, decorators, local(module, name));
			expect(result.e1, `E1 ${module}`).toEqual([]);
			expect(result.six, `6d ${module}`).toEqual([]);
			expect(result.n3, `N3 ${module}`).toEqual([]);
		}
	});

	test("a refused site stays in the bin it had without the rule", async () => {
		const result = await sites("", "@register\n");
		// E1 and 6d: the method call needs a receiver type; N3: x() is run-time-bound. The one
		// in-repo call each is the construction C().
		expect(result.bins.e1.receiverNeedsInference).toBe(1);
		expect(result.bins.six.receiverNeedsInference).toBe(1);
		expect(result.bins.n3.nameNotBound).toBe(1);
		expect(result.bins.n3.receiverNeedsInference).toBe(0);
	});

	test("an annotated receiver is not the constructor-bound case and keeps resolving", async () => {
		const result = await analyze([
			py("app.py", "@register\nclass C:\n    def m(self):\n        pass\n\ndef f(x: C):\n    x.m()\n"),
		]);
		expect(linesTo(result, symbolId(result, "C.m", "app.py"))).toEqual([7]);
	});
});

// GCLI-100 (D1, DEC-303 (a31)): a class-scope binding of the name that is not a def hides a
// base's def, so the lookup ends unresolved instead of reaching the base.
describe("D1 — a class-scope non-def binding hides a base's def", () => {
	const base = "class B:\n    def m(self):\n        pass\n\n    def __call__(self):\n        pass\n\n";

	function lineOf(source: string, needle: string): number {
		const index = source.split("\n").findIndex((line) => line.includes(needle));
		if (index < 0) throw new Error(`no line with ${needle}`);
		return index + 1;
	}

	/** The four lookup shapes against `class C(B)` whose body is `body` with NAME replaced. */
	async function shapes(body: string, name: "m" | "__call__", mid = "") {
		const stmt = body.replaceAll("NAME", name);
		const indented = stmt
			.trimEnd()
			.split("\n")
			.map((line) => `    ${line}`)
			.join("\n");
		const parent = mid === "" ? "B" : "M";
		const head = `${base}${mid}class C(${parent}):\n${indented}\n\n`;
		const at = (result: PythonCallsResult) => linesTo(result, symbolId(result, `B.${name}`, "app.py"));
		const out: Record<string, { got: number[]; line: number }> = {};
		const tails: Record<string, string> =
			name === "m" ? { e1: "C().m()", six: "x = C()\nx.m()", cls: "C.m()" } : { n3: "x = C()\nx()" };
		for (const [key, tail] of Object.entries(tails)) {
			const source = `${head}${tail}\n`;
			const result = await analyze([py("app.py", source)]);
			out[key] = { got: at(result), line: source.split("\n").length - 1 };
		}
		const call = name === "m" ? "self.m()" : "self.__call__()";
		const selfSource = `${head}    def go(self):\n        ${call}\n`;
		const selfResult = await analyze([py("app.py", selfSource)]);
		out.self = { got: at(selfResult), line: lineOf(selfSource, "self.") };
		return out;
	}

	const hiding: Record<string, string> = {
		assign: "NAME = None",
		"assign with a value from a call": "NAME = make()",
		"annotated with a value": "NAME: object = None",
		"tuple target": "NAME, other = pair()",
		walrus: "(NAME := make())",
		import: "from other import NAME",
		for: "for NAME in items:\n    pass",
		with: "with ctx() as NAME:\n    pass",
		"nested class": "class NAME:\n    pass",
		"augmented assignment": "NAME += 1",
	};

	test("negative: every kind of class-scope binding of the name ends the lookup unresolved", async () => {
		for (const [kind, body] of Object.entries(hiding)) {
			for (const name of ["m", "__call__"] as const) {
				for (const [shape, { got }] of Object.entries(await shapes(body, name))) {
					expect(got, `${kind} / ${name} / ${shape}`).toEqual([]);
				}
			}
		}
	});

	// Conservative over-inclusions: each of these the walker records as a class-scope binding although
	// Python does not leave the name bound (or binds it elsewhere), so the lookup is refused. Each
	// loses an edge and none invents one. They pin the current behaviour, not a goal.
	test("conservative: forms the walker counts as a class binding although Python does not keep one", async () => {
		const overIncluded: Record<string, string> = {
			// `except E as NAME` ends with an implicit `del NAME`, and the clause may never run
			"except as": "try:\n    pass\nexcept Exception as NAME:\n    pass",
			// a comprehension target lives in the comprehension's own scope in Python 3
			"comprehension target": "_unused = [NAME for NAME in items]",
			// `del NAME` is not tracked, so the earlier assignment still counts
			"assign then del": "NAME = None\ndel NAME",
		};
		for (const [kind, body] of Object.entries(overIncluded)) {
			for (const name of ["m", "__call__"] as const) {
				for (const [shape, { got }] of Object.entries(await shapes(body, name))) {
					expect(got, `${kind} / ${name} / ${shape}`).toEqual([]);
				}
			}
		}
	});

	test("a class-body global declaration sends the assignment to the module, so the class keeps no binding (GCLI-101)", async () => {
		for (const name of ["m", "__call__"] as const) {
			for (const [shape, { got, line }] of Object.entries(await shapes("global NAME\nNAME = None", name))) {
				expect(got, `${name} / ${shape}`).toEqual([line]);
			}
		}
	});

	// GCLI-107: two binding kinds the walker missed. Each binds NAME in the class, so the
	// lookup ends unresolved; the `m = None` control is the shape they must match.
	test("a PEP 695 type alias and a with-as tuple, list, nested or starred target bind the name (GCLI-107)", async () => {
		const bodies: Record<string, string> = {
			"control: plain assignment": "NAME = None",
			"type alias": "type NAME = int",
			"type alias with type parameters": "type NAME[T] = list[T]",
			"with-as name": "with ctx() as NAME:\n    pass",
			"with-as tuple": "with ctx() as (NAME, n):\n    pass",
			"with-as tuple, name second": "with ctx() as (n, NAME):\n    pass",
			"with-as bare tuple after a name": "with a() as x, b() as (NAME, n):\n    pass",
			"with-as list": "with ctx() as [NAME, n]:\n    pass",
			"with-as nested": "with ctx() as (a, (NAME, b)):\n    pass",
			"with-as star in a tuple": "with ctx() as (a, *NAME):\n    pass",
			"with-as star in a list": "with ctx() as [a, *NAME]:\n    pass",
			"parenthesised with items": "with (ctx() as (NAME, n)):\n    pass",
			"with-as parenthesised single name": "with ctx() as (NAME):\n    pass",
			"with-as nested parenthesised name": "with ctx() as (a, (NAME)):\n    pass",
			"with-as doubly parenthesised name": "with ctx() as ((NAME)):\n    pass",
			"with-as parenthesised name in a list": "with ctx() as [a, (NAME)]:\n    pass",
		};
		for (const [label, body] of Object.entries(bodies)) {
			for (const name of ["m", "__call__"] as const) {
				for (const [shape, { got }] of Object.entries(await shapes(body, name))) {
					expect(got, `${label} / ${name} / ${shape}`).toEqual([]);
				}
			}
		}
	});

	test("twins: a type alias or with-as target of another name, or an attribute target, binds nothing (GCLI-107)", async () => {
		const bodies = [
			"type other = int",
			"with ctx() as (a, b):\n    pass",
			"with ctx() as [a, *b]:\n    pass",
			// an attribute or subscript target binds no name
			"with ctx() as NAME.x:\n    pass",
			"with ctx() as (a, NAME.x):\n    pass",
			"with ctx() as a[NAME]:\n    pass",
			// a type parameter binds in its own scope, never in the class
			"type other[NAME] = list[NAME]",
			"def zz[NAME](self):\n    pass",
			"with ctx() as (a, (b)):\n    pass",
		];
		for (const body of bodies) {
			for (const name of ["m", "__call__"] as const) {
				for (const [shape, { got, line }] of Object.entries(await shapes(body, name))) {
					expect(got, `${body} / ${name} / ${shape}`).toEqual([line]);
				}
			}
		}
	});

	test("positive twins: an unrelated binding, or no binding, still reaches the base", async () => {
		for (const body of ["other = None", "pass", "from other import NAME2", "def NAME(self):\n    pass"]) {
			for (const name of ["m", "__call__"] as const) {
				const results = await shapes(body, name);
				for (const [shape, { got, line }] of Object.entries(results)) {
					// a def of the same name in C is C's own method, not B's: the edge goes there
					if (body.startsWith("def NAME")) expect(got, `${body} / ${name} / ${shape}`).toEqual([]);
					else expect(got, `${body} / ${name} / ${shape}`).toEqual([line]);
				}
			}
		}
	});

	test("a binding in a middle class hides the base for the subclass below it", async () => {
		const mid = "class M(B):\n    m = None\n    __call__ = None\n\n";
		for (const name of ["m", "__call__"] as const) {
			for (const [shape, { got }] of Object.entries(await shapes("pass", name, mid))) {
				expect(got, `${name} / ${shape}`).toEqual([]);
			}
		}
	});

	test("super() stops at a class that binds the name without a def, and reaches the base past one that does not", async () => {
		const sup = (mid: string) => `${base}class M(B):\n${mid}\nclass C(M):\n    def m(self):\n        super().m()\n`;
		const hidden = await analyze([py("app.py", sup("    m = None\n"))]);
		expect(linesTo(hidden, symbolId(hidden, "B.m", "app.py"))).toEqual([]);
		const open = await analyze([py("app.py", sup("    other = None\n"))]);
		expect(linesTo(open, symbolId(open, "B.m", "app.py"))).toHaveLength(1);
	});

	test("the binding hides only its own name and only below the class that holds it", async () => {
		// B2 binds m but not __call__: __call__ still reaches B; the sibling D(B) is unaffected
		const source = `${base}class B2(B):\n    m = None\n\nclass D(B):\n    pass\n\nx = D()\nx.m()\nx()\ny = B2()\ny()\n`;
		const result = await analyze([py("app.py", source)]);
		expect(linesTo(result, symbolId(result, "B.m", "app.py"))).toEqual([lineOf(source, "x.m()")]);
		expect(linesTo(result, symbolId(result, "B.__call__", "app.py"))).toEqual([
			lineOf(source, "x()"),
			lineOf(source, "y()"),
		]);
	});
});

// GCLI-101 (D2, DEC-303 (a31) item 3): three holes that made a name look singly bound.
describe("D2 — nonlocal two levels down, global in a class body, match capture", () => {
	const cls = "class C:\n    def __call__(self):\n        pass\n\n";

	function lineOf(source: string, needle: string): number {
		const index = source.split("\n").findIndex((line) => line.trim() === needle);
		if (index < 0) throw new Error(`no line ${needle}`);
		return index + 1;
	}

	/** The N3 call `x()` at the line `needle`; [] when the name is not provably one construction. */
	async function n3(source: string, needle = "x()"): Promise<{ got: number[]; line: number }> {
		const result = await analyze([py("app.py", source)]);
		return { got: linesTo(result, symbolId(result, "C.__call__", "app.py")), line: lineOf(source, needle) };
	}

	async function resolves(source: string, label: string, needle?: string): Promise<void> {
		const { got, line } = await n3(source, needle);
		expect(got, label).toEqual([line]);
	}

	async function refused(source: string, label: string, needle?: string): Promise<void> {
		const { got } = await n3(source, needle);
		expect(got, label).toEqual([]);
	}

	test("(1) nonlocal two levels down is credited to the function that binds the name", async () => {
		const nested = (innerBody: string, mid = "") =>
			`${cls}def outer():\n    x = C()\n    def mid():\n${mid}        def inner():\n            nonlocal x\n${innerBody}\n        inner()\n    mid()\n    x()\n`;
		await refused(nested("            x = make()"), "inner rebinds x two levels down");
		await refused(nested("            x += 1"), "inner augments x two levels down");
		await refused(nested("            for x in items:\n                pass"), "inner loops over x");
		await resolves(nested("            pass"), "twin: inner never rebinds x");
		await resolves(nested("            y = make()"), "twin: inner binds another name");
		// the middle function declares nonlocal too: still credited to outer
		await refused(nested("            x = make()", "        nonlocal x\n"), "mid declares nonlocal x as well");
		// one level down keeps working
		await refused(
			`${cls}def outer():\n    x = C()\n    def inner():\n        nonlocal x\n        x = make()\n    inner()\n    x()\n`,
			"one level down",
		);
		// the middle function binds its own x: that is the nonlocal target, outer's x stays single
		await resolves(
			`${cls}def outer():\n    x = C()\n    def mid():\n        x = make()\n        def inner():\n            nonlocal x\n            x = make()\n        inner()\n    mid()\n    x()\n`,
			"mid binds its own x",
		);
	});

	test("(2) a global or nonlocal in a class body redirects the binding out of the class", async () => {
		const withGlobal = (body: string) => `${cls}x = C()\nclass K:\n${body}\nx()\n`;
		await refused(withGlobal("    global x\n    x = make()"), "global then assign in a class body");
		await refused(withGlobal("    global x\n    for x in items:\n        pass"), "global then for");
		await resolves(withGlobal("    y = make()"), "twin: the class binds another name");
		await resolves(withGlobal("    x = make()"), "twin: no global, the class binding stays in the class");
		await refused(
			`${cls}def f():\n    x = C()\n    class K:\n        nonlocal x\n        x = make()\n    x()\n`,
			"nonlocal then assign in a class body",
		);
		await resolves(
			`${cls}def f():\n    x = C()\n    class K:\n        x = make()\n    x()\n`,
			"twin: no nonlocal in the class body",
		);
	});

	test("(2) a def after a class-body global or nonlocal is no method of the class", async () => {
		const base = "class B:\n    def m(self):\n        pass\n\n";
		const edge = async (source: string, id = "B.m"): Promise<number[]> => {
			const result = await analyze([py("app.py", source)]);
			return linesTo(result, symbolId(result, id, "app.py"));
		};
		const callLine = (source: string): number[] => [
			source.split("\n").findIndex((line) => line.trim() === "K().m()") + 1,
		];
		const g = (decl: string) => `${base}class K(B):\n${decl}    def m(self):\n        pass\n\nK().m()\n`;
		// m binds in the module, so K has no m of its own and K().m() is B.m
		const globalSource = g("    global m\n");
		expect(await edge(globalSource), "global then def").toEqual(callLine(globalSource));
		const nonlocalSource =
			"def f():\n    m = None\n    class B:\n        def m(self):\n            pass\n\n    class K(B):\n        nonlocal m\n        def m(self):\n            pass\n\n    K().m()\n";
		expect(await edge(nonlocalSource, "f.B.m"), "nonlocal then def").toEqual(callLine(nonlocalSource));
		// twin: no declaration, K.m is K's own method, so B.m gets no edge
		expect(await edge(g("")), "twin: no declaration").toEqual([]);
		// twin: the declaration names another name
		expect(await edge(g("    global other\n")), "twin: another name").toEqual([]);
	});

	test("(3) a match capture pattern binds the name", async () => {
		const matching = (cases: string, where: "module" | "function" = "module") =>
			where === "module"
				? `${cls}x = C()\nmatch v:\n${cases}\nx()\n`
				: `${cls}def f(v):\n    x = C()\n    match v:\n${cases
						.split("\n")
						.map((line) => `    ${line}`)
						.join("\n")}\n    x()\n`;
		const bodies: Record<string, string> = {
			capture: "    case x:\n        pass",
			"capture after a literal": "    case 1:\n        pass\n    case x:\n        pass",
			"star in a sequence": "    case [a, *x]:\n        pass",
			"element of a sequence": "    case [a, x]:\n        pass",
			"tuple pattern": "    case (a, x):\n        pass",
			"class keyword value": "    case P(k=x):\n        pass",
			"class positional": "    case P(x):\n        pass",
			"dict value": "    case {'k': x}:\n        pass",
			"dict rest": "    case {'k': 1, **x}:\n        pass",
			"as alias": "    case 1 | 2 as x:\n        pass",
			"nested as alias": "    case [P() as x]:\n        pass",
		};
		for (const [name, cases] of Object.entries(bodies)) {
			await refused(matching(cases), `${name} (module)`);
			await refused(matching(cases, "function"), `${name} (function)`);
		}
		const twins: Record<string, string> = {
			wildcard: "    case _:\n        pass",
			"another name": "    case y:\n        pass",
			"a value pattern is not a capture": "    case K.x:\n        pass",
			"a value pattern rooted at the name is not a capture": "    case x.K:\n        pass",
			"a class pattern names a class, not a binding": "    case x():\n        pass",
			"a keyword name is not a binding": "    case P(x=1):\n        pass",
			"a literal": "    case 1:\n        pass",
			"a star wildcard": "    case [a, *_]:\n        pass",
			"an unrelated alias": "    case 1 | 2 as y:\n        pass",
		};
		// `*_` and a bare `_` bind nothing: a prior `_ = C()` is still one construction
		await resolves(`${cls}_ = C()\nmatch v:\n    case [a, *_]:\n        pass\n_()\n`, "twin: star wildcard", "_()");
		await resolves(`${cls}_ = C()\nmatch v:\n    case _:\n        pass\n_()\n`, "twin: bare wildcard", "_()");
		for (const [name, cases] of Object.entries(twins)) {
			await resolves(matching(cases), `twin ${name} (module)`);
			await resolves(matching(cases, "function"), `twin ${name} (function)`);
		}
	});
});

// GCLI-108 (K1, DEC-303 (a22) item 3, (a29) and (a30)): `*args` is a tuple, `**kwargs` a
// dict, and an unshadowed builtin class used as a receiver is the builtin; all are
// resolved-external, and the rule is refused wherever a binding of the name is not enumerable.
describe("K1 — *args, **kwargs and an unshadowed builtin class receiver are builtin", () => {
	const cls = "class C:\n    def index(self, x):\n        pass\n\n    def get(self, x):\n        pass\n\n";

	/** The bins of the one attribute call `needle` in `source`, and whether any in-repo edge was made. */
	async function bins(source: string) {
		const result = await analyze([py("app.py", source)]);
		return {
			external: result.callBins.resolvedExternal,
			receiver: result.callBins.receiverNeedsInference,
			name: result.callBins.nameNotBound,
			inRepo: result.callBins.resolvedInRepo,
			edges: result.sites.length,
		};
	}

	async function resolvesExternal(source: string, label: string): Promise<void> {
		const got = await bins(source);
		expect(got, label).toMatchObject({ external: 1, receiver: 0, inRepo: 0, edges: 0 });
	}

	async function refused(source: string, label: string): Promise<void> {
		const got = await bins(source);
		// the one attribute call is receiver-needs-inference: not external, no edge
		expect(got.external, label).toBe(0);
		expect(got.receiver, label).toBe(1);
		expect(got.edges, label).toBe(0);
	}

	test("a method called on *args or **kwargs is the builtin's", async () => {
		await resolvesExternal("def f(*args):\n    args.index(1)\n", "*args");
		await resolvesExternal("def f(**kwargs):\n    kwargs.get(1)\n", "**kwargs");
		await resolvesExternal("def f(a, *args, b=1, **kw):\n    args.count(1)\n", "among other parameters");
		await resolvesExternal("def f(*args: int):\n    args.index(1)\n", "*args with an annotation");
		await resolvesExternal("def f(**kwargs: str):\n    kwargs.get(1)\n", "**kwargs with an annotation");
		await resolvesExternal("f = lambda *a, **k: a.index(1)\n", "a lambda *args");
		await resolvesExternal("def f(*args):\n    def g():\n        args.index(1)\n", "read from a nested function");
	});

	test("it never reaches an in-repo method of the same name, and a splat first parameter is no receiver ((a12)(a))", async () => {
		await resolvesExternal(`${cls}def f(*args):\n    args.index(1)\n`, "a module class defines index");
		await resolvesExternal(
			`${cls}class D(C):\n    def m(*args):\n        args.index(1)\n`,
			"a splat first parameter in a method",
		);
		await resolvesExternal(
			`${cls}class D(C):\n    def m(*args: int):\n        args.index(1)\n`,
			"a typed splat first parameter in a method",
		);
		// positive twin: a plain first parameter is the instance, so the lookup reaches C.index
		const plain = await analyze([py("app.py", `${cls}class D(C):\n    def m(self):\n        self.index(1)\n`)]);
		expect(linesTo(plain, symbolId(plain, "C.index", "app.py"))).toEqual([10]);
	});

	test("the annotation of a splat types its elements, never the tuple or dict (GCLI-108 review)", async () => {
		await resolvesExternal(`${cls}def f(*args: C):\n    args.index(1)\n`, "*args: C is a tuple, not a C");
		await resolvesExternal(`${cls}def f(**kw: C):\n    kw.get(1)\n`, "**kw: C is a dict, not a C");
		await resolvesExternal(
			`${cls}class D(C):\n    def m(*args: D):\n        args.index(1)\n`,
			"a typed splat first parameter in a method is no receiver",
		);
		// positive twin: an annotated plain parameter is still a C
		const plain = await analyze([py("app.py", `${cls}def f(x: C):\n    x.index(1)\n`)]);
		expect(linesTo(plain, symbolId(plain, "C.index", "app.py"))).toEqual([9]);
	});

	test("an alias of a builtin, or a class body that binds the name, does not qualify (GCLI-108 review)", async () => {
		await refused("int = type\nint.mro(C)\n", "int aliased to type");
		await refused("int = len\nint.x()\n", "int aliased to len");
		await refused("def f():\n    dict = len\n    dict.x()\n", "a local alias of a builtin function");
		// the name is bound in the class body, so it is read from the class or the globals, not the function
		await refused(
			"def f(*args):\n    class C:\n        args.index(1)\n        from m import args\n",
			"a later import in a class body",
		);
		await resolvesExternal(
			"def f(*args):\n    class C:\n        args.index(1)\n",
			"twin: the class body binds nothing",
		);
	});

	test("a second binding of the name leaves the site unresolved", async () => {
		await refused("def f(*args):\n    args = [1]\n    args.index(1)\n", "rebound in the function");
		await refused("def f(*args):\n    for args in z:\n        pass\n    args.index(1)\n", "rebound by a for");
		await refused(
			"def f(*args):\n    def g():\n        nonlocal args\n        args = make()\n    args.index(1)\n",
			"a nonlocal write in a nested function",
		);
		await refused(
			"def f(**kw):\n    def g():\n        nonlocal kw\n        kw = make()\n    kw.get(1)\n",
			"a nonlocal write to **kw",
		);
		await refused(
			"def f(*args):\n    with ctx() as (args, n):\n        pass\n    args.index(1)\n",
			"rebound by with-as",
		);
		await refused("def f(*args):\n    args: list = []\n    args.index(1)\n", "rebound by an annotated assignment");
		// positive twin: another name rebound leaves *args alone
		await resolvesExternal("def f(*args):\n    other = 1\n    args.index(1)\n", "twin: another name rebound");
	});

	test("only a splat parameter qualifies, not an ordinary one or an attribute chain", async () => {
		await refused("def f(args):\n    args.index(1)\n", "a plain parameter named args");
		await refused("def f(*args):\n    args.a.index(1)\n", "two segments");
		await refused("def f(*, a):\n    a.index(1)\n", "a keyword-only parameter after a bare star");
	});

	test("an unshadowed builtin class used as a receiver is the builtin", async () => {
		for (const call of [
			"int.from_bytes(b'x', 'big')",
			"dict.fromkeys([1])",
			"str.join(',', [])",
			"bytes.fromhex('00')",
			"float.fromhex('0x1')",
			"list.append(x, 1)",
			"OSError.with_traceback(e, None)",
			"bool.__and__(True, False)",
			"range.count(r, 1)",
		]) {
			await resolvesExternal(`${call}\n`, call);
		}
		// inside a function the name is still the builtin
		await resolvesExternal("def f():\n    int.from_bytes(b'x', 'big')\n", "inside a function");
	});

	test("a shadowed builtin class, type, a builtin function or a longer chain stays unresolved", async () => {
		await refused("int = make()\nint.from_bytes(b'x', 'big')\n", "shadowed at module level");
		await refused("def f(int):\n    int.from_bytes(b'x', 'big')\n", "shadowed by a parameter");
		await refused("def f():\n    int = make()\n    int.from_bytes(b'x', 'big')\n", "shadowed by a local");
		await refused("from lib import *\nint.from_bytes(b'x', 'big')\n", "a star import could supply it");
		await refused("type.mro(C)\n", "type is outside the exemption");
		await refused("len.x()\n", "a builtin function is not a class");
		await refused("dict.fromkeys.x()\n", "a longer chain");
		await refused("class C:\n    int = make()\n    int.from_bytes(b'x', 'big')\n", "shadowed in a class body");
	});

	test("a class with type in its MRO is still refused (a30)", async () => {
		const meta = "class Meta(type):\n    def m(self):\n        pass\n\n";
		const got = await analyze([py("app.py", `${meta}Meta('X', (), {}).m()\n`)]);
		expect(linesTo(got, symbolId(got, "Meta.m", "app.py"))).toEqual([]);
		// this clause is carried by E1's instanceClassOf, not a K1 branch; a K1 mutant cannot reach it
		// positive twin: a class on an unshadowed builtin class base is not opaque
		const ok = await analyze([py("app.py", "class D(dict):\n    def m(self):\n        pass\n\nD().m()\n")]);
		expect(linesTo(ok, symbolId(ok, "D.m", "app.py"))).toEqual([5]);
	});
});
