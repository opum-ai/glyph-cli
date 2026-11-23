import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DECODE_REPLACEMENTS_LIMIT, grammarVersion, initPythonParser, parsePython } from "../src/python/parse.ts";

const require = createRequire(import.meta.url);
const repoPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
	dependencies: Record<string, string>;
};
const installedPackage = JSON.parse(readFileSync(require.resolve("@vscode/tree-sitter-wasm/package.json"), "utf8")) as {
	version: string;
};
const fixture = readFileSync(fileURLToPath(new URL("./fixtures/python/sample.py", import.meta.url)));

describe("Python syntax probes — observed ERROR / MISSING counts", () => {
	test("PEP 634 match statement parses with 0 ERROR / 0 MISSING", async () => {
		// S2a measured 0/0 for this probe; this asserts the same through parsePython.
		const source = "match command.split():\n    case [action]:\n        pass\n    case _:\n        pass\n";
		const result = await parsePython(source, "match.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		expect(result.hasError).toBe(false);
		// Error-free is not enough: confirm it parsed as a match statement.
		expect(result.tree.rootNode.toString()).toContain("match_statement");
	});

	test("PEP 695 type parameters parse with 0 ERROR / 0 MISSING", async () => {
		const source = "def f[T](x: T) -> T:\n    return x\n";
		const result = await parsePython(source, "typeparams.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		expect(result.tree.rootNode.toString()).toContain("type_parameters");
	});

	test("PEP 701 nested-quote f-string parses with 0 ERROR / 0 MISSING", async () => {
		const source = 'print(f"{d["k"]}")\n';
		const result = await parsePython(source, "fstring.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		// The nested string is the interpolation's subscript, not an early string end.
		expect(result.tree.rootNode.toString()).toContain("interpolation");
	});

	test("Python 2 print statement parses with 0 ERROR / 0 MISSING (verified, not assumed)", async () => {
		// The grammar carries a print_statement node; a 0/0 count is asserted here
		// after observing it, and the node type proves it was accepted as the form.
		const result = await parsePython('print "hello"\n', "py2.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		expect(result.hasError).toBe(false);
		expect(result.tree.rootNode.toString()).toContain("print_statement");
	});
});

describe("decode before parse", () => {
	test("a stray 0xFF is decoded and counted, and the file still yields a tree", async () => {
		// "x = \xff\n": one invalid byte -> one replacement -> grammar ERROR regions.
		const bytes = new Uint8Array([0x78, 0x20, 0x3d, 0x20, 0xff, 0x0a]);
		const result = await parsePython(bytes, "bad-utf8.py");
		expect(result.decodeReplacements).toBe(1);
		expect(result.limit).toBe(DECODE_REPLACEMENTS_LIMIT);
		expect(result.hasError).toBe(true);
		expect(result.errorCount).toBeGreaterThan(0);
		expect(result.errors[0]?.path).toBe("bad-utf8.py");
		expect(result.tree.rootNode.type).toBe("module");
	});

	test("literal U+FFFD in valid source is not a decode replacement", async () => {
		const source = "s = '\uFFFD'\n";
		const asString = await parsePython(source, "literal.py");
		expect(asString.decodeReplacements).toBe(0);
		expect(asString.limit).toBeNull();
		expect(asString.errorCount).toBe(0);

		// The byte path must agree: valid UTF-8 holding a literal U+FFFD is 0 too.
		const asBytes = await parsePython(new TextEncoder().encode(source), "literal-bytes.py");
		expect(asBytes.decodeReplacements).toBe(0);
		expect(asBytes.errorCount).toBe(0);
	});

	test("replacement counting subtracts the source's literal U+FFFD characters", async () => {
		// EF BF BD (a literal U+FFFD) then 0xFF, newline, 0xFF: two stray bytes.
		const bytes = new Uint8Array([0xef, 0xbf, 0xbd, 0xff, 0x0a, 0xff]);
		const result = await parsePython(bytes, "mixed.py");
		expect(result.decodeReplacements).toBe(2);
		expect(result.limit).toBe(DECODE_REPLACEMENTS_LIMIT);
	});
});

describe("real syntax errors are reported, not skipped or thrown", () => {
	test("an ERROR node is counted and its span is named", async () => {
		const result = await parsePython("x = )\n", "error.py");
		expect(result.errorCount).toBe(1);
		expect(result.hasError).toBe(true);
		expect(result.errors[0]).toEqual({
			path: "error.py",
			kind: "ERROR",
			nodeType: "ERROR",
			start: { row: 0, column: 0 },
			end: { row: 0, column: 5 },
		});
	});

	test("`def f(:` yields a MISSING ')' (observed), still named, not an ERROR", async () => {
		// Observed: this input produces 0 ERROR and 1 MISSING, so an "ERROR > 0"
		// expectation would be wrong. hasError is true and the span is reported.
		const result = await parsePython("def f(:\n    return 1\n", "missing.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(1);
		expect(result.hasError).toBe(true);
		expect(result.missing[0]).toEqual({
			path: "missing.py",
			kind: "MISSING",
			nodeType: ")",
			start: { row: 0, column: 6 },
			end: { row: 0, column: 6 },
		});
	});
});

describe("stated source cases", () => {
	test("empty file parses to an empty module with 0/0", async () => {
		const result = await parsePython("", "empty.py");
		expect(result.tree.rootNode.type).toBe("module");
		expect(result.errorCount + result.missingCount).toBe(0);
	});

	test("a leading BOM is accepted with 0/0", async () => {
		const result = await parsePython("\uFEFFprint('hi')\n", "bom.py");
		expect(result.errorCount + result.missingCount).toBe(0);
	});

	test("CRLF is accepted with 0/0", async () => {
		const result = await parsePython("def f():\r\n    return 1\r\n", "crlf.py");
		expect(result.errorCount + result.missingCount).toBe(0);
	});

	test("NUL bytes are valid UTF-8 (no replacement) and surface as ERROR", async () => {
		const result = await parsePython("x = 1\u0000\ny = 2\n", "nul.py");
		expect(result.decodeReplacements).toBe(0);
		expect(result.hasError).toBe(true);
		expect(result.errorCount).toBeGreaterThan(0);
	});

	test("a very large generated file parses without error", async () => {
		const source = "def f():\n    return 1\n\n".repeat(10_000);
		const result = await parsePython(source, "large.py");
		expect(result.errorCount + result.missingCount).toBe(0);
	});
});

describe("grammarVersion", () => {
	test("equals the pinned dependency in package.json", () => {
		const pinned = repoPackage.dependencies["@vscode/tree-sitter-wasm"] ?? "";
		expect(pinned).toBe("0.3.1");
		expect(grammarVersion()).toBe(pinned);
	});

	test("equals the installed package's own version", () => {
		expect(grammarVersion()).toBe(installedPackage.version);
	});
});

describe("committed Python fixture", () => {
	test("parses with 0 ERROR / 0 MISSING and echoes its path", async () => {
		const result = await parsePython(fixture, "test/fixtures/python/sample.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		expect(result.hasError).toBe(false);
		expect(result.decodeReplacements).toBe(0);
		expect(result.path).toBe("test/fixtures/python/sample.py");
	});
});

describe("initialisation", () => {
	test("concurrent first calls share one init and each gets a working parser", () => {
		// A fresh module instance proves the shared-init path itself, not just a
		// warm one: eight calls race the very first initialisation.
		const moduleUrl = new URL("../src/python/parse.ts", import.meta.url).href;
		const script = `
			const m = await import(${JSON.stringify(moduleUrl)});
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) => m.parsePython("x = " + i + "\\n", "c" + i + ".py")),
			);
			console.log(JSON.stringify(results.map((r) => ({
				errors: r.errorCount, missing: r.missingCount, root: r.tree.rootNode.type,
			}))));
		`;
		const proc = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
		expect(proc.exitCode).toBe(0);
		const parsed = JSON.parse(proc.stdout.toString().trim()) as Array<{
			errors: number;
			missing: number;
			root: string;
		}>;
		expect(parsed).toHaveLength(8);
		for (const result of parsed) {
			expect(result.errors).toBe(0);
			expect(result.missing).toBe(0);
			expect(result.root).toBe("module");
		}
	});

	test("init failure rejects with a clear error naming the path, never an empty tree", async () => {
		const missing = "/nonexistent/glyph-tree-sitter-python.wasm";
		await expect(initPythonParser(missing)).rejects.toThrow(/could not initialise the Python grammar/);
		await expect(initPythonParser(missing)).rejects.toThrow(missing);
		// An explicit-path failure does not poison the shared instance.
		const result = await parsePython("x = 1\n", "after-failure.py");
		expect(result.errorCount).toBe(0);
	});
});
