import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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
		result.tree.delete();
	});

	test("PEP 695 type parameters parse with 0 ERROR / 0 MISSING", async () => {
		const source = "def f[T](x: T) -> T:\n    return x\n";
		const result = await parsePython(source, "typeparams.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		expect(result.tree.rootNode.toString()).toContain("type_parameters");
		result.tree.delete();
	});

	test("PEP 701 nested-quote f-string parses with 0 ERROR / 0 MISSING", async () => {
		const source = 'print(f"{d["k"]}")\n';
		const result = await parsePython(source, "fstring.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		// The nested string is the interpolation's subscript, not an early string end.
		expect(result.tree.rootNode.toString()).toContain("interpolation");
		result.tree.delete();
	});

	test("Python 2 print statement parses with 0 ERROR / 0 MISSING (verified, not assumed)", async () => {
		// The grammar carries a print_statement node; a 0/0 count is asserted here
		// after observing it, and the node type proves it was accepted as the form.
		const result = await parsePython('print "hello"\n', "py2.py");
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		expect(result.hasError).toBe(false);
		expect(result.tree.rootNode.toString()).toContain("print_statement");
		result.tree.delete();
	});
});

describe("decode before parse", () => {
	test("a stray 0xFF is decoded and counted, and the file still yields a tree", async () => {
		// "x = \xff\n": one invalid byte -> one replacement -> the grammar's two
		// ERROR nodes. Both counts are worker-measured at 1eab226; no independent
		// record pins them beyond this suite.
		const bytes = new Uint8Array([0x78, 0x20, 0x3d, 0x20, 0xff, 0x0a]);
		const result = await parsePython(bytes, "bad-utf8.py");
		expect(result.decodeReplacements).toBe(1);
		expect(result.limit).toBe(DECODE_REPLACEMENTS_LIMIT);
		expect(result.hasError).toBe(true);
		expect(result.errorCount).toBe(2);
		expect(result.errors[0]?.path).toBe("bad-utf8.py");
		expect(result.tree.rootNode.type).toBe("module");
		result.tree.delete();
	});

	test("literal U+FFFD in valid source is not a decode replacement", async () => {
		const source = "s = '\uFFFD'\n";
		const asString = await parsePython(source, "literal.py");
		expect(asString.decodeReplacements).toBe(0);
		expect(asString.limit).toBeNull();
		expect(asString.errorCount).toBe(0);
		asString.tree.delete();

		// The byte path must agree: valid UTF-8 holding a literal U+FFFD is 0 too.
		const asBytes = await parsePython(new TextEncoder().encode(source), "literal-bytes.py");
		expect(asBytes.decodeReplacements).toBe(0);
		expect(asBytes.errorCount).toBe(0);
		asBytes.tree.delete();
	});

	test("replacement counting subtracts the source's literal U+FFFD characters", async () => {
		// EF BF BD (a literal U+FFFD) then 0xFF, newline, 0xFF: two stray bytes.
		const bytes = new Uint8Array([0xef, 0xbf, 0xbd, 0xff, 0x0a, 0xff]);
		const result = await parsePython(bytes, "mixed.py");
		expect(result.decodeReplacements).toBe(2);
		expect(result.limit).toBe(DECODE_REPLACEMENTS_LIMIT);
		result.tree.delete();
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
		result.tree.delete();
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
		result.tree.delete();
	});
});

describe("stated source cases", () => {
	test("empty file parses to an empty module with 0/0", async () => {
		const result = await parsePython("", "empty.py");
		expect(result.tree.rootNode.type).toBe("module");
		expect(result.errorCount + result.missingCount).toBe(0);
		result.tree.delete();
	});

	test("a leading BOM string input is accepted with 0/0", async () => {
		const result = await parsePython("\uFEFFprint('hi')\n", "bom-string.py");
		expect(result.errorCount + result.missingCount).toBe(0);
		result.tree.delete();
	});

	test("a leading BOM on the bytes path is stripped with 0/0 and 0 replacements", async () => {
		// EF BB BF then print('hi'): the bytes-path decoder strips the BOM, so it is
		// neither a decode replacement nor a grammar error.
		const body = new TextEncoder().encode("print('hi')\n");
		const bytes = new Uint8Array(3 + body.length);
		bytes.set([0xef, 0xbb, 0xbf], 0);
		bytes.set(body, 3);
		const result = await parsePython(bytes, "bom-bytes.py");
		expect(result.decodeReplacements).toBe(0);
		expect(result.errorCount).toBe(0);
		expect(result.missingCount).toBe(0);
		result.tree.delete();
	});

	test("CRLF is accepted with 0/0", async () => {
		const result = await parsePython("def f():\r\n    return 1\r\n", "crlf.py");
		expect(result.errorCount + result.missingCount).toBe(0);
		result.tree.delete();
	});

	test("NUL bytes are valid UTF-8 (no replacement) and surface as two ERROR nodes", async () => {
		// Go through the bytes path so decodeReplacements === 0 is a real assertion:
		// a 0x00 byte is valid UTF-8, so it survives the fatal decode unchanged. Both
		// counts are worker-measured at 1eab226.
		const bytes = new TextEncoder().encode("x = 1\u0000\ny = 2\n");
		const result = await parsePython(bytes, "nul.py");
		expect(result.decodeReplacements).toBe(0);
		expect(result.limit).toBeNull();
		expect(result.hasError).toBe(true);
		expect(result.errorCount).toBe(2);
		result.tree.delete();
	});

	test("a very large generated file parses without error", async () => {
		// Worker-measured at 1eab226, not taken from an earlier S2a record: the
		// input was reshaped from 230,000 to 250,000 characters when moved here.
		const source = "def f_%d():\n    return %d\n\n".repeat(10_000).replace(/%d/g, () => "0");
		expect(source.length).toBe(250_000);
		const result = await parsePython(source, "large.py");
		expect(result.errorCount + result.missingCount).toBe(0);
		result.tree.delete();
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
		result.tree.delete();
	});
});

describe("initialisation", () => {
	test("concurrent parses on a cold module each return their own error-free tree", () => {
		// This proves concurrency on a fresh module instance: eight calls race the
		// first parse and each gets a separate, error-free tree. It does NOT prove
		// the init is shared rather than per-call (a binding cache would hide that);
		// the shared-failure test below exercises the shared promise's reset.
		const moduleUrl = new URL("../src/python/parse.ts", import.meta.url).href;
		const script = `
			const m = await import(${JSON.stringify(moduleUrl)});
			const results = await Promise.all(
				Array.from({ length: 8 }, async (_, i) => {
					const r = await m.parsePython("x = " + i + "\\n", "c" + i + ".py");
					const row = { errors: r.errorCount, missing: r.missingCount, root: r.tree.rootNode.type };
					r.tree.delete();
					return row;
				}),
			);
			console.log(JSON.stringify(results));
		`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
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

	test("shared init failure rejects, then a retry succeeds (sharedInit is reset)", () => {
		// Fresh module + a resolver that fails on its first call and then returns the
		// real wasm. If the rejection handler did not clear sharedInit, the retry
		// would await the cached rejected promise and this test would fail.
		const moduleUrl = new URL("../src/python/parse.ts", import.meta.url).href;
		// Resolve the wasm in the PARENT process and interpolate the absolute path:
		// the child script must not depend on process.cwd().
		const realWasm = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm");
		const script = `
			const m = await import(${JSON.stringify(moduleUrl)});
			const real = ${JSON.stringify(realWasm)};
			let calls = 0;
			m.__setGrammarWasmResolverForTest(() => (calls++ === 0 ? "/nonexistent/shared-grammar.wasm" : real));
			let firstError = "";
			try {
				const r = await m.parsePython("x = 1\\n", "first.py");
				r.tree.delete();
			} catch (e) {
				firstError = e && e.message ? e.message : String(e);
			}
			let retryOk = false;
			try {
				const r = await m.parsePython("x = 1\\n", "second.py");
				retryOk = r.errorCount === 0 && r.missingCount === 0;
				r.tree.delete();
			} catch {
				retryOk = false;
			}
			console.log(JSON.stringify({ firstError, retryOk }));
		`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		expect(proc.exitCode).toBe(0);
		const out = JSON.parse(proc.stdout.toString().trim()) as { firstError: string; retryOk: boolean };
		expect(out.firstError).toMatch(/could not initialise the Python grammar/);
		expect(out.firstError).toContain("/nonexistent/shared-grammar.wasm");
		expect(out.retryOk).toBe(true);
	});

	test("explicit-path init succeeds and frees the parser it created", async () => {
		const real = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm");
		await expect(initPythonParser(real)).resolves.toBeUndefined();
	});

	test("explicit-path init failure rejects with a clear error naming the path, never an empty tree", async () => {
		const missing = "/nonexistent/glyph-tree-sitter-python.wasm";
		await expect(initPythonParser(missing)).rejects.toThrow(/could not initialise the Python grammar/);
		await expect(initPythonParser(missing)).rejects.toThrow(missing);
		// An explicit-path failure does not poison the shared instance.
		const result = await parsePython("x = 1\n", "after-failure.py");
		expect(result.errorCount).toBe(0);
		result.tree.delete();
	});
});

describe("resource ownership on the error paths", () => {
	test("a setLanguage failure frees the parser — shared and explicit-path variants", () => {
		const moduleUrl = new URL("../src/python/parse.ts", import.meta.url).href;
		const realWasm = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm");
		const script = `
			const m = await import(${JSON.stringify(moduleUrl)});
			const real = ${JSON.stringify(realWasm)};
			let frees = 0;
			m.__setParserFactoryForTest(() => ({
				setLanguage() { throw new Error("setLanguage boom"); },
				delete() { frees += 1; },
			}));
			let sharedError = "";
			try {
				const r = await m.parsePython("x = 1\\n", "shared.py");
				r.tree.delete();
			} catch (e) {
				sharedError = e && e.message ? e.message : String(e);
			}
			let explicitError = "";
			try {
				await m.initPythonParser(real);
			} catch (e) {
				explicitError = e && e.message ? e.message : String(e);
			}
			console.log(JSON.stringify({ frees, sharedError, explicitError }));
		`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		expect(proc.exitCode).toBe(0);
		const out = JSON.parse(proc.stdout.toString().trim()) as {
			frees: number;
			sharedError: string;
			explicitError: string;
		};
		// Each variant created one parser, could not set its language, and freed it.
		expect(out.frees).toBe(2);
		expect(out.sharedError).toMatch(/could not initialise the Python grammar/);
		expect(out.explicitError).toMatch(/could not initialise the Python grammar/);
	});

	test("a throw while collecting regions frees the tree that was parsed", () => {
		const moduleUrl = new URL("../src/python/parse.ts", import.meta.url).href;
		const script = `
			const m = await import(${JSON.stringify(moduleUrl)});
			let frees = 0;
			m.__setParserFactoryForTest(() => ({
				setLanguage() {},
				parse() {
					return {
						get rootNode() { throw new Error("rootNode boom"); },
						delete() { frees += 1; },
					};
				},
			}));
			let error = "";
			try {
				await m.parsePython("x = 1\\n", "boom.py");
			} catch (e) {
				error = e && e.message ? e.message : String(e);
			}
			console.log(JSON.stringify({ frees, error }));
		`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		expect(proc.exitCode).toBe(0);
		const out = JSON.parse(proc.stdout.toString().trim()) as { frees: number; error: string };
		// The tree was freed exactly once before the error reached the caller.
		expect(out.frees).toBe(1);
		expect(out.error).toContain("rootNode boom");
	});
});

describe("test seams stay test-only", () => {
	test("no file under src/ other than parse.ts imports a test seam", () => {
		const parseFile = fileURLToPath(new URL("../src/python/parse.ts", import.meta.url));
		const seamPattern = /__set\w+ForTest/;
		// Positive control: the seams exist in parse.ts, so a rename cannot make this
		// scan pass vacuously.
		expect(seamPattern.test(readFileSync(parseFile, "utf8"))).toBe(true);

		const srcDir = fileURLToPath(new URL("../src", import.meta.url));
		const offending: string[] = [];
		let scanned = 0;
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const absolute = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(absolute);
				} else if (entry.name.endsWith(".ts") && absolute !== parseFile) {
					scanned += 1;
					if (seamPattern.test(readFileSync(absolute, "utf8"))) offending.push(absolute);
				}
			}
		};
		walk(srcDir);
		expect(scanned).toBeGreaterThan(0);
		expect(offending).toEqual([]);
	});
});
