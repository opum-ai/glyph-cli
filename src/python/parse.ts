import { createRequire } from "node:module";
import { TextDecoder } from "node:util";
import type { Node, Parser, Tree } from "@vscode/tree-sitter-wasm";
import TS from "@vscode/tree-sitter-wasm";

/**
 * A thin, native Python parse wrapper over tree-sitter's Python grammar.
 *
 * This slice only parses and reports: the tree, every ERROR and MISSING region
 * named by file and span, and the count of decode replacements a file needed.
 * It owns no indexer semantics (module resolution, scopes, call attribution) —
 * those are later slices.
 *
 * The grammar and runtime ship together in one package (C6, DEC-303 (a4)
 * ruling 9). Only its DEFAULT import works: its UMD export object exposes no
 * ESM named bindings, so the value is imported default and the types are
 * imported type-only.
 */

/** The pinned grammar/runtime package; its version keys the future cache. */
const GRAMMAR_PACKAGE = "@vscode/tree-sitter-wasm";
const GRAMMAR_VERSION = "0.3.1";
const PYTHON_WASM_SUBPATH = `${GRAMMAR_PACKAGE}/wasm/tree-sitter-python.wasm`;

/**
 * Stable per-file limit marker: the source needed at least one UTF-8 decode
 * replacement, so byte fidelity is lost where the decode replaced bytes.
 * Coverage names files carrying this marker rather than losing them silently.
 */
export const DECODE_REPLACEMENTS_LIMIT = "invalid-utf-8-replacements";
export type PythonLimit = typeof DECODE_REPLACEMENTS_LIMIT | null;

/** Zero-based position, matching tree-sitter's own points. */
export interface PythonPoint {
	row: number;
	column: number;
}

/** One named parse region: an ERROR node or a zero-width MISSING node. */
export interface PythonRegion {
	path: string;
	kind: "ERROR" | "MISSING";
	nodeType: string;
	start: PythonPoint;
	end: PythonPoint;
}

export interface PythonParseResult {
	path: string;
	/** Caller owns the tree and must call `tree.delete()` when done. */
	tree: Tree;
	/** tree.rootNode.hasError; true when any ERROR or MISSING node exists. */
	hasError: boolean;
	errorCount: number;
	missingCount: number;
	errors: PythonRegion[];
	missing: PythonRegion[];
	/** How many UTF-8 decode replacements the file needed; 0 for valid input. */
	decodeReplacements: number;
	/** DECODE_REPLACEMENTS_LIMIT when decodeReplacements > 0, else null. */
	limit: PythonLimit;
}

const require = createRequire(import.meta.url);

/** Locate the python grammar asset inside the installed package (no absolute path). */
function resolvePythonWasm(): string {
	return require.resolve(PYTHON_WASM_SUBPATH);
}

function initError(wasmPath: string, cause: unknown): Error {
	const reason = cause instanceof Error ? cause.message : String(cause);
	return new Error(`glyph: could not initialise the Python grammar from ${wasmPath}: ${reason}`);
}

async function loadParser(wasmPath: string): Promise<Parser> {
	// Parser.init() loads the runtime wasm once; Language.load() the Python grammar.
	await TS.Parser.init();
	const language = await TS.Language.load(wasmPath);
	const parser = new TS.Parser();
	parser.setLanguage(language);
	return parser;
}

// One parser, one init promise, shared by every caller. A rejection clears the
// promise so a later call can retry instead of caching the failure forever.
let sharedParser: Parser | null = null;
let sharedInit: Promise<Parser> | null = null;

// How the shared init locates its wasm. Production always resolves the
// installed package; a test-only seam replaces it to force the failure path.
let grammarWasmResolver: () => string = resolvePythonWasm;

/**
 * Test-only seam: replace how the shared init locates its wasm. It does not
 * touch already-initialised state; production never calls it.
 */
export function __setGrammarWasmResolverForTest(resolver: (() => string) | null): void {
	grammarWasmResolver = resolver ?? resolvePythonWasm;
}

async function getParser(): Promise<Parser> {
	if (sharedParser !== null) return sharedParser;
	if (sharedInit === null) {
		let wasmPath: string;
		try {
			wasmPath = grammarWasmResolver();
		} catch (cause) {
			throw initError(PYTHON_WASM_SUBPATH, cause);
		}
		sharedInit = loadParser(wasmPath).then(
			(parser) => {
				sharedParser = parser;
				return parser;
			},
			(cause: unknown) => {
				sharedInit = null;
				throw initError(wasmPath, cause);
			},
		);
	}
	return sharedInit;
}

/**
 * Initialise the parser, once and lazily. `parsePython` calls this for you.
 *
 * An explicit `wasmPath` loads and validates that asset, then frees the parser
 * it created; it does NOT populate the shared instance, so it is not a
 * pre-warm. (The runtime's Language has no delete() in 0.3.1, so only the
 * parser can be freed.) A missing or unloadable asset rejects with a clear
 * Error that names the path and the cause; it never yields an empty tree.
 */
export async function initPythonParser(wasmPath?: string): Promise<void> {
	if (wasmPath === undefined) {
		await getParser();
		return;
	}
	let parser: Parser;
	try {
		parser = await loadParser(wasmPath);
	} catch (cause) {
		throw initError(wasmPath, cause);
	}
	parser.delete();
}

/** The pinned grammar/runtime version, for a future cache key; read from the pin. */
export function grammarVersion(): string {
	return GRAMMAR_VERSION;
}

function countLiteralReplacementBytes(bytes: Uint8Array): number {
	// A literal U+FFFD in valid UTF-8 is always the byte sequence EF BF BD.
	let count = 0;
	for (let i = 0; i + 2 < bytes.length; i++) {
		if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) {
			count++;
			i += 2;
		}
	}
	return count;
}

function countReplacementChars(text: string): number {
	let count = 0;
	for (const char of text) if (char === "�") count++;
	return count;
}

/**
 * Decode before parsing: the runtime accepts JS strings only.
 *
 * If the bytes are valid UTF-8 the fatal decode succeeds and there are zero
 * replacements, however many literal U+FFFD characters the source holds. Only
 * on a fatal-decode failure are replacement characters counted, and the count
 * subtracts the input's own literal U+FFFD sequences so a valid character is
 * never miscounted as a decode replacement. On the bytes path a leading BOM is
 * stripped by the decoder (default ignoreBOM: false); a string input is used
 * verbatim and keeps any BOM.
 */
function decodeSource(source: Uint8Array | string): { text: string; replacements: number } {
	if (typeof source === "string") return { text: source, replacements: 0 };
	const fatal = new TextDecoder("utf-8", { fatal: true });
	try {
		return { text: fatal.decode(source), replacements: 0 };
	} catch {
		const text = new TextDecoder("utf-8").decode(source);
		const replacements = countReplacementChars(text) - countLiteralReplacementBytes(source);
		return { text, replacements: Math.max(0, replacements) };
	}
}

function point(node: { startPosition: PythonPoint; endPosition: PythonPoint }, side: "start" | "end"): PythonPoint {
	const position = side === "start" ? node.startPosition : node.endPosition;
	return { row: position.row, column: position.column };
}

function collectRegions(root: Node, path: string, errors: PythonRegion[], missing: PythonRegion[]): void {
	const stack: Node[] = [root];
	while (stack.length > 0) {
		const node = stack.pop() as Node;
		if (node.type === "ERROR") {
			errors.push({
				path,
				kind: "ERROR",
				nodeType: node.type,
				start: point(node, "start"),
				end: point(node, "end"),
			});
		}
		if (node.isMissing) {
			missing.push({
				path,
				kind: "MISSING",
				nodeType: node.type,
				start: point(node, "start"),
				end: point(node, "end"),
			});
		}
		// Push children reversed so popping visits them in document order.
		for (let index = node.childCount - 1; index >= 0; index--) {
			const child = node.child(index);
			if (child !== null) stack.push(child);
		}
	}
}

/**
 * Parse one Python file. Never throws on bad bytes or on syntax errors: invalid
 * UTF-8 is decoded (and counted) before parsing, and ERROR/MISSING nodes are
 * reported as named regions. It throws only when the grammar itself cannot be
 * loaded (see `initPythonParser`).
 *
 * Callers MUST pass bytes. A pre-decoded string is parsed as-is: if it already
 * contains replacement characters, `decodeReplacements` is 0 and `limit` is
 * null, because the caller owns any lossy conversion. A leading BOM is stripped
 * on the bytes path only; a string keeps it.
 *
 * The caller owns the returned tree and must call `tree.delete()`.
 */
export async function parsePython(source: Uint8Array | string, path: string): Promise<PythonParseResult> {
	const parser = await getParser();
	const { text, replacements } = decodeSource(source);
	const tree = parser.parse(text);
	if (tree === null) {
		// Not input-dependent: a language-lacking parser. Surface it, never an empty tree.
		throw new Error(`glyph: tree-sitter returned no tree for ${path}`);
	}
	const errors: PythonRegion[] = [];
	const missing: PythonRegion[] = [];
	collectRegions(tree.rootNode, path, errors, missing);
	return {
		path,
		tree,
		hasError: tree.rootNode.hasError,
		errorCount: errors.length,
		missingCount: missing.length,
		errors,
		missing,
		decodeReplacements: replacements,
		limit: replacements > 0 ? DECODE_REPLACEMENTS_LIMIT : null,
	};
}
