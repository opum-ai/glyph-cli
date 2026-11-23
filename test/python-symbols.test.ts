import { describe, expect, test } from "bun:test";
import { parsePython } from "../src/python/parse.ts";
import {
	buildPythonSymbols,
	collectPythonSymbols,
	type PythonSymbol,
	type PythonSymbolTable,
} from "../src/python/symbols.ts";

/** Parse and collect a fixture, with the file path given once. */
async function collect(source: string, path = "sample.py"): Promise<PythonSymbolTable> {
	return buildPythonSymbols(source, path);
}

function byQualname(table: PythonSymbolTable, qualname: string): PythonSymbol {
	const found = table.symbols.find((symbol) => symbol.qualname === qualname);
	if (found === undefined) throw new Error(`no symbol ${qualname}; have ${table.symbols.map((s) => s.qualname)}`);
	return found;
}

describe("rule 1 — identity", () => {
	test("line is the def line, startLine includes the decorators, id columns are 1-based", async () => {
		const table = await collect("@deco\n@click.command(help='x')\ndef foo():\n    pass\n");
		expect(table.symbols).toHaveLength(1);
		const foo = table.symbols[0] as PythonSymbol;
		expect(foo.line).toBe(3);
		expect(foo.startLine).toBe(1);
		expect(foo.endLine).toBe(4);
		expect(foo.id).toBe("sample.py:3:5");
		expect(foo.column).toBe(5);
	});

	test("startLine includes contiguous leading comments and stops at a blank line", async () => {
		const source = "# lead\ndef foo():\n    pass\n\n# detached\n\nbar = 1\ndef baz():\n    pass\n";
		const table = await collect(source);
		expect(byQualname(table, "foo").startLine).toBe(1);
		// The comment is separated from baz by a blank line and an assignment.
		expect(byQualname(table, "baz").startLine).toBe(8);
	});

	test("a decorated async def takes the async/def line, not the decorator line", async () => {
		const table = await collect("@d\nasync def go():\n    pass\n");
		const go = table.symbols[0] as PythonSymbol;
		expect(go.line).toBe(2);
		expect(go.startLine).toBe(1);
	});
});

describe("rule 2 — qualname", () => {
	test("a method's nested function carries the full dotted path; container is the class name", async () => {
		const source = "class Parameter:\n    def type_cast_value(self):\n        def _convert(v):\n            return v\n";
		const table = await collect(source);
		const convert = byQualname(table, "Parameter.type_cast_value._convert");
		expect(convert.container).toBe("Parameter");
		expect(convert.name).toBe("_convert");
		expect(byQualname(table, "Parameter.type_cast_value").container).toBe("Parameter");
	});

	test("a function's nested function carries the function path and has no container", async () => {
		const source = "def wrap_text(text):\n    def _flush_par():\n        pass\n    return _flush_par\n";
		const table = await collect(source);
		const flush = byQualname(table, "wrap_text._flush_par");
		expect(flush.container).toBeNull();
	});

	test("a nested class gets the full path and members take the nearest class name", async () => {
		const source = "class Outer:\n    class Inner:\n        def m(self):\n            pass\n";
		const table = await collect(source);
		expect(byQualname(table, "Outer.Inner").kind).toBe("class");
		const m = byQualname(table, "Outer.Inner.m");
		expect(m.container).toBe("Inner");
	});

	test("no <locals> segment is ever emitted", async () => {
		const table = await collect("def outer():\n    def inner():\n        pass\n");
		expect(table.symbols.map((symbol) => symbol.qualname)).toEqual(["outer", "outer.inner"]);
	});
});

describe("rule 3 — kinds", () => {
	test("module def is function, class-body def is method, nested def in a method is function", async () => {
		const source = [
			"def top(): pass",
			"class C:",
			"    def m(self):",
			"        def inner(): pass",
			"        return inner",
		].join("\n");
		const table = await collect(source);
		expect(byQualname(table, "top").kind).toBe("function");
		expect(byQualname(table, "C").kind).toBe("class");
		expect(byQualname(table, "C.m").kind).toBe("method");
		expect(byQualname(table, "C.m.inner").kind).toBe("function");
	});

	test("@property and @x.setter are property; staticmethod and classmethod are method", async () => {
		const source = [
			"class C:",
			"    @property",
			"    def x(self): return 1",
			"    @x.setter",
			"    def x(self, v): pass",
			"    @staticmethod",
			"    def s(): pass",
			"    @classmethod",
			"    def c(cls): pass",
		].join("\n");
		const table = await collect(source);
		const properties = table.symbols.filter((symbol) => symbol.qualname === "C.x");
		expect(properties.map((symbol) => symbol.kind)).toEqual(["property", "property"]);
		expect(byQualname(table, "C.s").kind).toBe("method");
		expect(byQualname(table, "C.c").kind).toBe("method");
	});
});

describe("rule 4 — overload groups", () => {
	test("an @overload group collapses to one symbol at the implementation line", async () => {
		const source = [
			"@overload",
			"def to_key_val_list(value: None) -> None: ...",
			"@overload",
			"def to_key_val_list(value: int) -> int: ...",
			"def to_key_val_list(value):",
			"    return value",
		].join("\n");
		const table = await collect(source);
		const symbols = table.symbols.filter((symbol) => symbol.qualname === "to_key_val_list");
		expect(symbols).toHaveLength(1);
		expect(symbols[0]?.line).toBe(5);
		expect(symbols[0]?.collapsedOverloadStubs).toEqual([2, 4]);
		expect(table.overloadStubsCollapsed).toBe(2);
	});

	test("@overload composes with @staticmethod and is still detected", async () => {
		const source = [
			"class C:",
			"    @overload",
			"    @staticmethod",
			"    def m(x: int) -> int: ...",
			"    @staticmethod",
			"    def m(x):",
			"        return x",
		].join("\n");
		const table = await collect(source);
		const symbols = table.symbols.filter((symbol) => symbol.qualname === "C.m");
		expect(symbols).toHaveLength(1);
		expect(symbols[0]?.line).toBe(6);
		expect(symbols[0]?.kind).toBe("method");
		expect(table.overloadStubsCollapsed).toBe(1);
	});

	test("a group with no implementation keeps the last stub and is noted", async () => {
		const source = ["@overload", "def f(x: int) -> int: ...", "@overload", "def f(x: str) -> str: ..."].join("\n");
		const table = await collect(source);
		const symbols = table.symbols.filter((symbol) => symbol.qualname === "f");
		expect(symbols).toHaveLength(1);
		expect(symbols[0]?.line).toBe(4);
		expect(table.overloadGroupsWithoutImplementation).toEqual([
			{ file: "sample.py", qualname: "f", line: 4, stubs: [2, 4] },
		]);
		expect(table.overloadStubsCollapsed).toBe(1);
	});

	test("implementation definitions in separate branches are all kept", async () => {
		const source = [
			"@overload",
			"def f(x: int) -> int: ...",
			"def f(x):",
			"    return x",
			"if FLAG:",
			"    def f(x):",
			"        return x",
		].join("\n");
		const table = await collect(source);
		const lines = table.symbols.filter((symbol) => symbol.qualname === "f").map((symbol) => symbol.line);
		expect(lines).toEqual([3, 6]);
		expect(table.overloadStubsCollapsed).toBe(1);
	});
});

describe("rule 5 — branch-conditional definitions", () => {
	test("definitions in both PY2 and else arms are emitted at their own lines", async () => {
		const source = [
			"if PY2:",
			"    def get_text_stdin():",
			"        return None",
			"else:",
			"    def get_text_stdin():",
			"        return 1",
		].join("\n");
		const table = await collect(source);
		const lines = table.symbols.filter((symbol) => symbol.qualname === "get_text_stdin").map((symbol) => symbol.line);
		expect(lines).toEqual([2, 5]);
	});

	test("definitions inside try/for/while are emitted", async () => {
		const source = "try:\n    def a(): pass\nexcept Exception:\n    pass\nfor _ in []:\n    def b(): pass\n";
		const table = await collect(source);
		expect(table.symbols.map((symbol) => symbol.qualname).sort()).toEqual(["a", "b"]);
	});
});

describe("rule 6 — decorators", () => {
	test("every decorator application is recorded and a decorated symbol is still emitted", async () => {
		const source = "@click.command()\n@deco\n@click.option('--x')\ndef cmd():\n    pass\n";
		const table = await collect(source);
		const cmd = byQualname(table, "cmd");
		expect(cmd.decorated).toBe(true);
		expect(cmd.decorators).toEqual([
			{ name: "click.command", line: 1, column: 2, call: true },
			{ name: "deco", line: 2, column: 2, call: false },
			{ name: "click.option", line: 3, column: 2, call: true },
		]);
	});

	test("a decorated class is a class and keeps its decorators", async () => {
		const table = await collect("@dataclass\nclass C:\n    pass\n");
		const c = byQualname(table, "C");
		expect(c.kind).toBe("class");
		expect(c.decorators.map((decorator) => decorator.name)).toEqual(["dataclass"]);
	});
});

describe("rule 7 — class scope", () => {
	test("class-body assignments get no symbol; class-body defs are members", async () => {
		const source = "class C:\n    x = 1\n    def m(self): pass\n";
		const table = await collect(source);
		expect(table.symbols.map((symbol) => symbol.qualname)).toEqual(["C", "C.m"]);
	});

	test("global/nonlocal are recorded per function and nested definitions are excluded", async () => {
		const source = [
			"def setg():",
			"    global VALUE",
			"    VALUE = 1",
			"    def inner():",
			"        nonlocal VALUE",
		].join("\n");
		const table = await collect(source);
		expect(table.scopeHints).toEqual([
			{ file: "sample.py", function: "setg", line: 1, global: ["VALUE"], nonlocal: [] },
			{ file: "sample.py", function: "setg.inner", line: 4, global: [], nonlocal: ["VALUE"] },
		]);
	});
});

describe("rule 8 — lambdas and comprehensions", () => {
	test("lambdas and comprehensions produce no symbols", async () => {
		const source = "f = lambda x: x\ng = [i for i in range(3)]\nh = {k: v for k, v in []}\n";
		const table = await collect(source);
		expect(table.symbols).toEqual([]);
	});
});

describe("rule 9 — module variables, assignments and __all__", () => {
	test("assignments and imports get no symbol", async () => {
		const table = await collect("import os\nx = 1\ny: int = 2\n");
		expect(table.symbols).toEqual([]);
	});

	test("a literal module __all__ is read only for exported", async () => {
		const source = "__all__ = ('a',)\ndef a(): pass\ndef b(): pass\n";
		const table = await collect(source);
		expect(byQualname(table, "a").exported).toBe(true);
		expect(byQualname(table, "b").exported).toBe(false);
	});
});

describe("rule 10 — exported", () => {
	test("module-level names follow __all__ or the underscore convention", async () => {
		const source = "def pub(): pass\ndef _priv(): pass\nclass Pub: pass\nclass _Priv: pass\n";
		const table = await collect(source);
		expect(byQualname(table, "pub").exported).toBe(true);
		expect(byQualname(table, "_priv").exported).toBe(false);
		expect(byQualname(table, "Pub").exported).toBe(true);
		expect(byQualname(table, "_Priv").exported).toBe(false);
	});

	test("a member of an exported class is exported, underscore member included; a non-exported class's members are not", async () => {
		const source = [
			"class Pub:",
			"    def m(self): pass",
			"    def _hidden(self): pass",
			"class _Priv:",
			"    def m(self): pass",
		].join("\n");
		const table = await collect(source);
		expect(byQualname(table, "Pub.m").exported).toBe(true);
		expect(byQualname(table, "Pub._hidden").exported).toBe(true);
		expect(byQualname(table, "_Priv.m").exported).toBe(false);
	});

	test("a definition nested inside a function is never exported", async () => {
		const table = await collect("def outer():\n    def inner(): pass\n");
		expect(byQualname(table, "outer").exported).toBe(true);
		expect(byQualname(table, "outer.inner").exported).toBe(false);
	});

	test("a non-literal __all__ falls back to the underscore convention", async () => {
		const source = "__all__ = ['a']\n__all__ += ['b']\ndef a(): pass\ndef b(): pass\ndef _c(): pass\n";
		const table = await collect(source);
		expect(byQualname(table, "a").exported).toBe(true);
		// Under the fallback b is still exported (no leading underscore); _c is not.
		expect(byQualname(table, "b").exported).toBe(true);
		expect(byQualname(table, "_c").exported).toBe(false);
	});
});

describe("rule 11 — async def", () => {
	test("an async def is the same symbol as a def, and an async method is a method", async () => {
		const table = await collect("async def go():\n    pass\nclass C:\n    async def m(self):\n        pass\n");
		expect(byQualname(table, "go").kind).toBe("function");
		expect(byQualname(table, "go").line).toBe(1);
		expect(byQualname(table, "C.m").kind).toBe("method");
		expect(byQualname(table, "C.m").qualname).toBe("C.m");
	});
});

describe("rule 12 — ERROR and MISSING", () => {
	test("a definition inside an ERROR region is dropped and the file is named", async () => {
		// Measured: tree-sitter nests the outer def under module > ERROR here.
		const source = "def f():\n    x = ]\n        def g(): pass\n";
		const table = await collect(source, "broken.py");
		expect(table.symbols).toEqual([]);
		expect(table.errorFiles).toEqual(["broken.py"]);
		expect(table.droppedDefinitions).toEqual([
			{ file: "broken.py", reason: "error-region", nodeType: "function_definition", line: 1 },
		]);
	});

	test("an ERROR inside a valid definition's own body does not drop that definition", async () => {
		const source = "def f():\n    x = (\n        def g(): pass\n";
		const parse = await parsePython(source, "inner-error.py");
		expect(parse.errorCount).toBeGreaterThan(0);
		const table = collectPythonSymbols(parse);
		parse.tree.delete();
		expect(table.symbols.map((symbol) => symbol.qualname)).toEqual(["f", "f.g"]);
		expect(table.errorFiles).toEqual([]);
	});

	test("a MISSING node alone does not drop the definition", async () => {
		const table = await collect("def f(:\n    return 1\n", "missing.py");
		expect(table.symbols.map((symbol) => symbol.qualname)).toEqual(["f"]);
		expect(table.droppedDefinitions).toEqual([]);
	});

	test("a nameless def yields no symbol (the grammar makes it an ERROR, not a def node)", async () => {
		const parse = await parsePython("def :\n    pass\n", "nameless.py");
		expect(parse.errorCount).toBeGreaterThan(0);
		const table = collectPythonSymbols(parse);
		parse.tree.delete();
		expect(table.symbols).toEqual([]);
	});

	test("a file needing UTF-8 decode replacements is named", async () => {
		const bytes = new Uint8Array([0x78, 0x20, 0x3d, 0x20, 0xff, 0x0a]);
		const table = await buildPythonSymbols(bytes, "bad-utf8.py");
		expect(table.decodeReplacementFiles).toEqual(["bad-utf8.py"]);
	});
});

describe("purity and tree ownership", () => {
	test("collectPythonSymbols reads the tree without freeing it and is repeatable", async () => {
		const parse = await parsePython("def f():\n    pass\n", "pure.py");
		try {
			const first = collectPythonSymbols(parse);
			const second = collectPythonSymbols(parse);
			expect(first.symbols.map((symbol) => symbol.qualname)).toEqual(["f"]);
			expect(second.symbols.map((symbol) => symbol.qualname)).toEqual(["f"]);
			// Distinct result objects: the first table is not mutated by the second.
			expect(first.symbols).not.toBe(second.symbols);
		} finally {
			parse.tree.delete();
		}
	});
});
