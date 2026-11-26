/**
 * Python call resolution (slice S5, ADR 0008, GCLI-81).
 *
 * Pure analysis over the S3 module graph and the S4 symbol table: the caller
 * hands in `{ path, bytes }` files and options, and this module parses each file
 * once (through the S2b wrapper), collects its S4 symbols, walks it for scopes,
 * bindings, classes and call sites, frees the tree, and then resolves every call
 * expression against the completed cross-file symbol table and module graph.
 *
 * It touches no filesystem, no cache and no CLI surface: a later slice wires it
 * up. The rule-per-case list this implements is the GCLI-81 rules commits
 * (part 1 `ea40d01`, part 2 `b925c2e`, part 3 `bea0b64`, rules 1-31). Comments
 * below name the rule they enforce. Every call expression outside an ERROR region
 * lands in exactly one of the four bins (`callBins`), and the four counts sum to
 * the number of such call expressions; `test/python-calls.test.ts` pins both.
 *
 * Construction is the one place a call expression yields more than one edge
 * (rule 8): a resolved class is one site in `resolvedInRepo` with an edge to the
 * class and an edge to its resolved `__init__`. Multiply-bound callees (rule 20)
 * yield one edge per in-repository alternative, each flagged; a multiply-bound
 * class alternative is a construction, so it yields its class and `__init__` edges
 * (rule 25).
 */

import type { Node } from "@vscode/tree-sitter-wasm";
import type { ParseErrorFile, UnresolvedByKind } from "../types.ts";
import {
	buildModuleGraph,
	type DynamicImport,
	type Exit7Trigger,
	type ImportBinding,
	isSinglePortionNamespace,
	type ModuleGraph,
	type ModuleGraphOptions,
	type PythonModuleInput,
	resolveLocalImportNode,
} from "./modules.ts";
import { parsePython } from "./parse.ts";
import { collectPythonSymbols, type PythonSymbol } from "./symbols.ts";

// --- public result shapes --------------------------------------------------

/** The four bins (ADR "What exact covers"; names fixed by the S5 rules). */
export interface CallBinCounts {
	resolvedInRepo: number;
	resolvedExternal: number;
	receiverNeedsInference: number;
	nameNotBound: number;
}

/** One emitted edge. `SiteEntry`-compatible, plus the S5 flags and `decorator`. */
export interface PythonCallSite {
	calleeId: string | null;
	callerId: string | null;
	file: string;
	line: number;
	column: number;
	kind: "call" | "new" | "decorator";
	/** Rule 20: one of several alternatives of a multiply-bound callee name. */
	multiplyBound?: boolean;
	/** Rule 12: a subclass overrides the same method name; reported, not guessed. */
	polymorphic?: boolean;
	/** Rule 22: an opaque external base preceded the matched in-repo class. */
	externalBaseBefore?: boolean;
	/** Rule 10: the target definition carries a decorator (S4's flag, carried). */
	decorated?: boolean;
}

/** A named site, for the "first sites" beside an unresolved reason count. */
export interface NamedSite {
	file: string;
	line: number;
	column: number;
}

/** A per-reason count with the first sites named (rule 16). */
export interface ReasonCount {
	reason: string;
	count: number;
	firstSites: NamedSite[];
}

/** A constructor note (rule 8): why `__init__` is not what runs, or its absence. */
export interface ConstructorNote {
	file: string;
	line: number;
	column: number;
	classId: string;
	reasons: string[];
}

export interface PythonCallsCounts {
	/** Call expressions outside ERROR regions: the denominator of the bin sum. */
	callExpressions: number;
	/** Emitted edges (constructions and multiply-bound callees contribute more than one). */
	edges: number;
	/** Bare `@d` decorator sites (not call expressions, in no call bin). */
	decoratorSites: number;
	/** Call expressions with at least one `multiplyBound` edge (rule 20). */
	multiplyBoundSites: number;
	/** Call expressions with at least one `polymorphic` edge (rule 12). */
	polymorphicSites: number;
	constructorNotes: number;
	files: number;
	errorFiles: number;
	droppedCalls: number;
}

export interface PythonCallsResult {
	sites: PythonCallSite[];
	symbols: PythonSymbol[];
	callBins: CallBinCounts;
	callExpressionCount: number;
	unresolvedNameReasons: ReasonCount[];
	unresolvedReceiverReasons: ReasonCount[];
	polymorphicCount: number;
	multiplyBoundCount: number;
	constructorNotes: ConstructorNote[];
	/** Files whose parse holds at least one ERROR node (rule 1). */
	errorFiles: string[];
	/**
	 * One entry per file in `errorFiles`, ordered by path, with the call
	 * expressions dropped inside its own ERROR regions (DEC-303 (a15) 19). An
	 * empty list for a run whose parses hold no ERROR node.
	 */
	parseErrorFiles: ParseErrorFile[];
	/** Call expressions dropped inside ERROR regions (rule 1). */
	droppedCalls: number;
	/** S3's indeterminate triggers, carried (rule 15). */
	exit7: Exit7Trigger[];
	dynamic: DynamicImport[];
	unresolvedByKind: UnresolvedByKind;
	/**
	 * S3's unresolved-first-party import count, distinct from `unresolvedByKind`
	 * (which counts every unresolved import): a failed first-party import is the
	 * one S7 publishes beside the call bins (DEC-303 (a14) 3).
	 */
	unresolvedFirstPartyImports: number;
	exact: boolean;
	counts: PythonCallsCounts;
}

// --- internal model --------------------------------------------------------

type CalleeDesc =
	| { kind: "name"; name: string }
	| { kind: "attr"; base: BaseDesc; segments: string[] }
	| { kind: "dynamic"; typeInstance?: boolean };

type BaseDesc =
	| { kind: "name"; name: string }
	| { kind: "super"; argCount: number; firstArg: CalleeDesc | null }
	| { kind: "constructed"; callee: CalleeDesc }
	| { kind: "literal" }
	| { kind: "dynamic" };

type BindingRhs =
	| { kind: "alias"; name: string }
	| { kind: "call"; callee: CalleeDesc }
	/** ALIAS: the right-hand side is a dotted attribute `B.attr` (one segment after a name). */
	| { kind: "attr"; callee: CalleeDesc }
	/** LIT: the right-hand side is a literal or comprehension of one builtin type. */
	| { kind: "literal"; type: string }
	/** TS (DEC-303 (a22) item 3): the right-hand side is `type(x)` (`viaType`) or `x.__class__` for a bare name `x`. */
	| { kind: "classof"; receiver: string; viaType: boolean }
	| { kind: "other" };

/** A source position (one-based) for rule 38's order-aware class-body imports. */
interface UsePosition {
	line: number;
	column: number;
}

type AnnotationDesc =
	| { kind: "name"; name: string }
	| { kind: "dotted"; segments: string[] }
	| { kind: "optional"; inner: AnnotationDesc }
	| { kind: "union"; members: AnnotationDesc[] }
	| { kind: "none" }
	| { kind: "other" };

interface RawBinding {
	kind: "def" | "class" | "import" | "localimport" | "param" | "assign" | "rebound";
	/** K1: a `*args` parameter is a tuple and a `**kwargs` parameter a dict. */
	splat?: "tuple" | "dict";
	symbolId?: string;
	importBinding?: ImportBinding | null;
	rhs?: BindingRhs;
	annotation?: AnnotationDesc | null;
	annotationScope?: Scope | null;
	/** Rule 38: the statement's start, so a class-body import binds only later uses. */
	position?: UsePosition;
	/**
	 * A comprehension target: the walker records it in the enclosing function (the analyzer counts it, which
	 * only makes a read refuse), but Python binds it in the comprehension's own scope, so it is not a binding
	 * `nonlocal` can name and `applyScopeRedirects` does not stop at it.
	 */
	comprehension?: true;
	/** R4: the scope whose text holds this binding, set when `applyScopeRedirects` moves it onto an enclosing scope. */
	origin?: Scope;
	/**
	 * GCLI-116 (DEC-303 (a44) item 4): the assignment sits in an `if` or `try` arm, so it is an alternative
	 * of the name (Q2's platform arms and try/except fallbacks), not an unconditional rebinding.
	 */
	conditional?: true;
	/** GCLI-116: moved onto the module scope by a `global` in a function or class body, so not a module-level statement. */
	viaGlobal?: true;
	/** GCLI-116 (N4): a bare annotation `f: T` with no value, which binds no name at module scope (PEP 526). */
	bare?: true;
}

interface Scope {
	uid: number;
	kind: "module" | "function" | "class" | "lambda";
	parent: Scope | null;
	file: string;
	qualname: string;
	symbolId: string | null;
	bindings: Map<string, RawBinding[]>;
	globalNames: Set<string>;
	nonlocalNames: Set<string>;
	firstParam: string | null;
	/** Rule 26: the function's own name, for the implicit classmethods `__init_subclass__`, `__class_getitem__`, `__new__`. */
	functionName: string | null;
	/** Rule 26/36: the def's line, so a class-body import after it does not shadow it (rule 38). */
	line: number;
	decorators: string[];
	classInfo: ClassInfo | null;
	enclosingClass: ClassInfo | null;
}

interface BaseRef {
	callee: CalleeDesc | null;
	text: string;
}

type MroEntry =
	| { kind: "class"; info: ClassInfo; key: string }
	/** `rebound`: the base is an in-repo name that is rebound, not an external base (DEC-303 (a47) item 2 (i)). */
	| { kind: "opaque"; name: string; key: string; rebound?: true };

type MroResult = { ok: true; entries: MroEntry[] } | { ok: false };

type DecoratorSlots = "absent" | "false" | "other";

interface ClassInfo {
	id: string;
	name: string;
	qualname: string;
	file: string;
	line: number;
	/** The class-body scope; set just after construction from the walk. */
	scope?: Scope;
	parentScope: Scope;
	bases: BaseRef[];
	/**
	 * Rule 29a/37: the `metaclass=` keyword — "none" when absent, "type-name" when
	 * written `metaclass=type`, "other" for any other expression. Whether
	 * `metaclass=type` is the default is decided at resolution under the rule 37
	 * shadow rule, not here.
	 */
	metaclassValue: "none" | "type-name" | "other";
	decorators: string[];
	/** The callee of each decorator (the function of `@d(...)`), in source order; parallel to `decorators`. */
	decoratorCallees: CalleeDesc[];
	/**
	 * How each decorator spells `slots`, parallel to `decorators`: "absent" (a bare
	 * decorator, or a call with no arguments), "false" (exactly `slots=False` and
	 * nothing else that could carry it), or "other" (any other value, a positional
	 * argument, or a `**` splat).
	 */
	decoratorSlots: DecoratorSlots[];
	/** Whether each decorator is written as a call `@d(...)`, parallel to `decorators`. */
	decoratorCalled: boolean[];
	methods: Map<string, string[]>;
	/** Rule 36(ii): bare names used in this class body as a decorator or call. */
	classBodyBareUses: Set<string>;
	mro?: MroResult;
}

interface RawCall {
	file: string;
	line: number;
	column: number;
	callerId: string | null;
	scope: Scope;
	callee: CalleeDesc;
}

interface RawDecoratorSite {
	file: string;
	line: number;
	column: number;
	callerId: string | null;
	scope: Scope;
	callee: CalleeDesc;
}

type EdgeSpec = {
	calleeId: string;
	kind: "call" | "new" | "decorator";
	multiplyBound?: boolean;
	polymorphic?: boolean;
	externalBaseBefore?: boolean;
	decorated?: boolean;
};

type CallResolution =
	| { bin: "inRepo"; edges: EdgeSpec[]; polymorphic: boolean; multiplyBound: boolean }
	| { bin: "external"; reason: string }
	| { bin: "receiver"; reason: string }
	| { bin: "name"; reason: string };

type NameOutcome =
	| { kind: "symbol"; symbol: PythonSymbol }
	| { kind: "module"; path: string | null }
	| { kind: "external" }
	| { kind: "unresolved"; reason: string }
	| { kind: "runtime"; reason: string }
	| { kind: "multiply"; symbols: PythonSymbol[] };

/** Rule 40: state carried across one name's whole star lookup. */
type StarLookupContext = { visited: Set<string>; hops: number; cycle: boolean };

/** Rule 40: `cycle` is true when the path was cut by a revisit or the hop bound. */
type StarBoundResult = { outcome: NameOutcome; cycle: boolean };

type ModuleAttrOutcome =
	| { kind: "symbol"; symbol: PythonSymbol }
	| { kind: "multiply"; symbols: PythonSymbol[] }
	| { kind: "module"; path: string }
	| { kind: "external" }
	| { kind: "unresolved"; reason: string };

/**
 * Builtin CLASSES whose constructor returns an instance of the subclass being
 * constructed, for every subtype (DEC-303 (a29) Q2, (a30)). `reversed` is absent:
 * its `__new__` returns `seq.__reversed__()` when the sequence defines it. Final
 * classes (`bool`, `range`, `slice`, `memoryview`) cannot be subclassed and are
 * not listed. `type` is deliberately absent: a class with `type`
 * in its MRO is a metaclass, and calling it creates a class. Builtin functions
 * (`print`, `len`) are not classes. Exception classes are matched by name below.
 */
const BUILTIN_INSTANCE_CLASSES: ReadonlySet<string> = new Set([
	"object",
	"int",
	"float",
	"complex",
	"str",
	"bytes",
	"bytearray",
	"list",
	"tuple",
	"dict",
	"set",
	"frozenset",
	"property",
	"staticmethod",
	"classmethod",
	"enumerate",
	"zip",
	"map",
	"filter",
]);

/** A builtin CLASS whose constructor returns an instance of the subclass being constructed (BUILTIN_INSTANCE_CLASSES or a builtin exception class). */
function isBuiltinInstanceClassName(name: string): boolean {
	return (
		BUILTIN_INSTANCE_CLASSES.has(name) ||
		(BUILTINS.has(name) &&
			/(Error|Exception|Warning)$|^(StopIteration|StopAsyncIteration|GeneratorExit|KeyboardInterrupt|SystemExit)$/.test(
				name,
			))
	);
}

/**
 * K1: every builtin class that may be a receiver. The final classes and `reversed`
 * are builtin too, and a method named on one is the builtin's whichever way it is
 * constructed; `type` stays out ((a30) item 2), and so does every builtins name that is not a class.
 */
const BUILTIN_RECEIVER_ONLY_CLASSES: ReadonlySet<string> = new Set([
	"bool",
	"range",
	"slice",
	"memoryview",
	"reversed",
]);

function isBuiltinClassName(name: string): boolean {
	return isBuiltinInstanceClassName(name) || BUILTIN_RECEIVER_ONLY_CLASSES.has(name);
}

/**
 * Names a builtin CLASS in BUILTIN_INSTANCE_CLASSES itself defines that a lookup
 * through an in-repo subclass must not skip (DEC-303 (a31) item 5). `staticmethod`
 * has had `__call__` since Python 3.10; `classmethod` has none. Deliberately the
 * one entry: a name is added only when the builtin is known to define it.
 */
const BUILTIN_CLASS_DEFINED_NAMES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["staticmethod", new Set(["__call__"])],
]);

/**
 * Class decorators documented to return the class they are given, so a decorated
 * class still names the same definition (DEC-303 (a31) Q2). Keyed by module, then
 * decorator name. A decorator reached any other way (not an unshadowed import of
 * one of these, or any other callee shape) may replace the class.
 */
const NON_REPLACING_CLASS_DECORATORS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["dataclasses", new Set(["dataclass"])],
	["functools", new Set(["total_ordering"])],
	["typing", new Set(["final", "runtime_checkable"])],
	["enum", new Set(["unique"])],
]);

/** The listed decorators that are factories: the only ones a called form `@d(...)` may use (DEC-303 (a33)). */
const NON_REPLACING_CLASS_DECORATOR_FACTORIES: ReadonlySet<string> = new Set(["dataclasses.dataclass"]);

/** Python 3 builtins: a name bound nowhere else in the scope chain (rule 4c). */
const BUILTINS: ReadonlySet<string> = new Set([
	"abs",
	"aiter",
	"all",
	"anext",
	"any",
	"ascii",
	"bin",
	"bool",
	"breakpoint",
	"bytearray",
	"bytes",
	"callable",
	"chr",
	"classmethod",
	"compile",
	"complex",
	"delattr",
	"dict",
	"dir",
	"divmod",
	"enumerate",
	"eval",
	"exec",
	"filter",
	"float",
	"format",
	"frozenset",
	"getattr",
	"globals",
	"hasattr",
	"hash",
	"help",
	"hex",
	"id",
	"input",
	"int",
	"isinstance",
	"issubclass",
	"iter",
	"len",
	"list",
	"locals",
	"map",
	"max",
	"memoryview",
	"min",
	"next",
	"object",
	"oct",
	"open",
	"ord",
	"pow",
	"print",
	"property",
	"range",
	"repr",
	"reversed",
	"round",
	"set",
	"setattr",
	"slice",
	"sorted",
	"staticmethod",
	"str",
	"sum",
	"super",
	"tuple",
	"type",
	"vars",
	"zip",
	"__import__",
	"__build_class__",
	"__debug__",
	"__name__",
	"__doc__",
	"__package__",
	"__loader__",
	"__spec__",
	"__file__",
	"__builtins__",
	"None",
	"True",
	"False",
	"NotImplemented",
	"Ellipsis",
	"BaseException",
	"Exception",
	"ArithmeticError",
	"AssertionError",
	"AttributeError",
	"BaseExceptionGroup",
	"BlockingIOError",
	"BrokenPipeError",
	"BufferError",
	"BytesWarning",
	"ChildProcessError",
	"ConnectionAbortedError",
	"ConnectionError",
	"ConnectionRefusedError",
	"ConnectionResetError",
	"DeprecationWarning",
	"EOFError",
	"EncodingWarning",
	"EnvironmentError",
	"ExceptionGroup",
	"FileExistsError",
	"FileNotFoundError",
	"FloatingPointError",
	"FutureWarning",
	"GeneratorExit",
	"IOError",
	"ImportError",
	"ImportWarning",
	"IndentationError",
	"IndexError",
	"InterruptedError",
	"IsADirectoryError",
	"KeyError",
	"KeyboardInterrupt",
	"LookupError",
	"MemoryError",
	"ModuleNotFoundError",
	"NameError",
	"NotADirectoryError",
	"NotImplementedError",
	"OSError",
	"OverflowError",
	"PendingDeprecationWarning",
	"PermissionError",
	"ProcessLookupError",
	"RecursionError",
	"ReferenceError",
	"ResourceWarning",
	"RuntimeError",
	"RuntimeWarning",
	"StopAsyncIteration",
	"StopIteration",
	"SyntaxError",
	"SyntaxWarning",
	"SystemError",
	"SystemExit",
	"TabError",
	"TimeoutError",
	"TypeError",
	"UnboundLocalError",
	"UnicodeDecodeError",
	"UnicodeEncodeError",
	"UnicodeError",
	"UnicodeTranslateError",
	"UnicodeWarning",
	"UserWarning",
	"ValueError",
	"Warning",
	"ZeroDivisionError",
	"exit",
	"quit",
	"copyright",
	"credits",
	"license",
]);

const MAX_ALIAS_HOPS = 8;
const MAX_MODULE_DEPTH = 64;
/** Rule 40: a star lookup may take at most this many hops before the path is cut. */
const MAX_STAR_HOPS = 16;
const FIRST_SITES_LIMIT = 5;

/** Rule 29c: literals whose type is fixed by syntax, not by inference (`"x".join`, `[].append`). */
const LITERAL_BASE_TYPES: ReadonlySet<string> = new Set([
	"string",
	"integer",
	"float",
	"list",
	"dictionary",
	"set",
	"tuple",
	"concatenated_string",
]);

// --- small helpers ---------------------------------------------------------

function normalizeInputPath(path: string): string {
	let normalized = path;
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	return normalized.replace(/^\/+/, "");
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(list: readonly string[]): string[] {
	return [...new Set(list)].sort(compareText);
}

/** The names an import statement binds, in source order (used for the module-level map and the fallback). */
function importStatementNames(node: Node): string[] {
	const names: string[] = [];
	if (node.type === "import_statement") {
		for (const child of node.namedChildren) {
			if (child === null) continue;
			if (child.type === "aliased_import") {
				const alias = child.namedChild(1);
				if (alias !== null) names.push(alias.text);
			} else if (child.type === "dotted_name") {
				const first = child.namedChild(0);
				if (first !== null) names.push(first.text);
			}
		}
		return names;
	}
	if (node.type === "future_import_statement") {
		// A future import has no module child: every named child is an imported name.
		for (const child of node.namedChildren) {
			if (child === null) continue;
			if (child.type === "aliased_import") {
				const alias = child.namedChild(1);
				if (alias !== null) names.push(alias.text);
			} else if (child.type === "dotted_name") {
				names.push(child.text);
			}
		}
		return names;
	}
	// A from-import: the first named child is the module.
	const children = node.namedChildren.filter((child): child is Node => child !== null);
	for (let index = 1; index < children.length; index++) {
		const child = children[index] as Node;
		if (child.type === "wildcard_import") continue;
		if (child.type === "aliased_import") {
			const alias = child.namedChild(1);
			if (alias !== null) names.push(alias.text);
		} else if (child.type === "dotted_name") {
			names.push(child.text);
		}
	}
	return names;
}

/** How a decorator call spells `slots` (see ClassInfo.decoratorSlots). */
function slotsSpelling(call: Node): DecoratorSlots {
	let spelling: DecoratorSlots = "absent";
	for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
		if (arg === null || arg.type === "comment") continue;
		const key = arg.type === "keyword_argument" ? arg.childForFieldName("name") : null;
		if (key === null) return "other"; // a positional argument or a ** splat could carry it
		if (key.text !== "slots") continue;
		const value = arg.childForFieldName("value");
		spelling = value !== null && value.type === "false" ? "false" : "other";
	}
	return spelling;
}

function describeCallee(node: Node): CalleeDesc {
	if (node.type === "identifier") return { kind: "name", name: node.text };
	if (node.type === "call") {
		// Rule 8: `type(self)(...)` is an unresolved receiver, not a bare dynamic callee.
		const fn = node.childForFieldName("function");
		if (fn !== null && fn.type === "identifier" && fn.text === "type") return { kind: "dynamic", typeInstance: true };
		return { kind: "dynamic" };
	}
	if (node.type !== "attribute") return { kind: "dynamic" };
	const segments: string[] = [];
	let current: Node | null = node;
	while (current !== null && current.type === "attribute") {
		const attribute = current.childForFieldName("attribute");
		segments.unshift(attribute?.text ?? "");
		current = current.childForFieldName("object");
	}
	let base: BaseDesc;
	if (current !== null && current.type === "identifier") {
		base = { kind: "name", name: current.text };
	} else if (current !== null && LITERAL_BASE_TYPES.has(current.type)) {
		// Rule 29c: a literal written directly as the receiver has a type fixed by syntax.
		base = { kind: "literal" };
	} else if (current !== null && current.type === "call") {
		const fn = current.childForFieldName("function");
		if (fn !== null && fn.type === "identifier" && fn.text === "super") {
			const args = current.childForFieldName("arguments");
			const positional: Node[] = [];
			if (args !== null) {
				for (const child of args.namedChildren) {
					if (child === null || child.type === "comment" || child.type === "keyword_argument") continue;
					positional.push(child);
				}
			}
			base = {
				kind: "super",
				argCount: positional.length,
				firstArg: positional.length > 0 ? describeCallee(positional[0] as Node) : null,
			};
		} else {
			// E1: `Cls(...).m()` — a call whose callee is a plain or dotted name; the
			// resolver decides whether that names a class. Any other callee shape
			// (a call result, a subscript, a literal) stays a dynamic receiver.
			const callee = fn === null ? null : describeCallee(fn);
			base =
				callee !== null && (callee.kind === "name" || (callee.kind === "attr" && callee.base.kind === "name"))
					? { kind: "constructed", callee }
					: { kind: "dynamic" };
		}
	} else {
		base = { kind: "dynamic" };
	}
	return { kind: "attr", base, segments };
}

/** The annotation expression under a `type` wrapper, if any. */
function annotationExpression(node: Node): Node {
	if (node.type === "type" && node.namedChildCount > 0) {
		const inner = node.namedChild(0);
		if (inner !== null) return inner;
	}
	return node;
}

function annotationList(inner: Node): Node[] {
	const out: Node[] = [];
	for (const child of inner.namedChildren) {
		if (child === null || child.type === "comment") continue;
		out.push(annotationExpression(child));
	}
	return out;
}

function describeAnnotation(node: Node): AnnotationDesc {
	const inner = annotationExpression(node);
	switch (inner.type) {
		case "identifier":
			return inner.text === "None" ? { kind: "none" } : { kind: "name", name: inner.text };
		case "none":
			return { kind: "none" };
		case "attribute": {
			const segments: string[] = [];
			let current: Node | null = inner;
			while (current !== null && current.type === "attribute") {
				segments.unshift(current.childForFieldName("attribute")?.text ?? "");
				current = current.childForFieldName("object");
			}
			if (current !== null && current.type === "identifier") segments.unshift(current.text);
			return { kind: "dotted", segments };
		}
		case "generic_type": {
			const name = inner.namedChild(0);
			const params = inner.namedChild(1);
			if (name === null || params === null) return { kind: "other" };
			const args = annotationList(params);
			const last = name.type === "identifier" ? name.text : (name.text.split(".").pop() ?? name.text);
			if (last === "Optional" && args.length === 1)
				return { kind: "optional", inner: describeAnnotation(args[0] as Node) };
			if (last === "Union") return { kind: "union", members: args.map(describeAnnotation) };
			return { kind: "other" };
		}
		case "subscript": {
			const value = inner.namedChild(0);
			const arg = inner.namedChild(1);
			if (value === null || arg === null) return { kind: "other" };
			const last = value.type === "identifier" ? value.text : (value.text.split(".").pop() ?? value.text);
			const args =
				arg.type === "tuple" || arg.type === "type_parameter" ? annotationList(arg) : [annotationExpression(arg)];
			if (last === "Optional" && args.length === 1)
				return { kind: "optional", inner: describeAnnotation(args[0] as Node) };
			if (last === "Union") return { kind: "union", members: args.map(describeAnnotation) };
			return { kind: "other" };
		}
		case "binary_operator": {
			const members: AnnotationDesc[] = [];
			for (const child of inner.namedChildren) if (child !== null) members.push(describeAnnotation(child));
			return { kind: "union", members };
		}
		default:
			return { kind: "other" };
	}
}

// --- per-file walk ---------------------------------------------------------

interface WalkFrame {
	node: Node;
	scope: Scope;
	callerId: string | null;
	scopeNames: string[];
	decorators?: string[];
	decoratorCallees?: CalleeDesc[];
	decoratorSlots?: DecoratorSlots[];
	decoratorCalled?: boolean[];
	underError: boolean;
}

/** One parameter: its bound name, annotation descriptor and default/value node. */
interface ParamInfo {
	name: string | null;
	/** K1: `tuple` for `*args`, `dict` for `**kwargs`, else null. */
	splat: "tuple" | "dict" | null;
	annotation: AnnotationDesc | null;
	annotationNode: Node | null;
	valueNode: Node | null;
}

function parameterName(node: Node): Node | null {
	switch (node.type) {
		case "identifier":
			return node;
		case "typed_parameter":
		case "typed_default_parameter":
		case "default_parameter": {
			const named = node.childForFieldName("name");
			if (named !== null) return named;
			// `typed_parameter` (no default) carries its name as a bare child, or, for
			// `*args: T` and `**kwargs: T`, inside a splat pattern child (GCLI-108).
			for (const child of node.namedChildren) {
				if (child !== null && child.type === "identifier") return child;
				if (child !== null && (child.type === "list_splat_pattern" || child.type === "dictionary_splat_pattern")) {
					return parameterName(child);
				}
			}
			return null;
		}
		case "list_splat_pattern":
		case "dictionary_splat_pattern": {
			for (const child of node.namedChildren) if (child !== null && child.type === "identifier") return child;
			return null;
		}
		default:
			return null;
	}
}

/**
 * Rule 32: only a plain first parameter is a receiver — an identifier, a typed
 * identifier, or one with a default. `*args`, `**kwargs`, a bare `*`/`/` marker
 * (`keyword_separator`/`positional_separator`) and an absent first parameter are
 * not: Python binds the instance to `args[0]` or to nothing, never the splat.
 */
function isPlainParameter(node: Node): boolean {
	switch (node.type) {
		case "identifier":
		case "typed_default_parameter":
		case "default_parameter":
			return true;
		// `*args: T` and `**kwargs: T` are typed parameters over a splat: not a receiver.
		case "typed_parameter":
			return splatKind(node) === null;
		default:
			return false;
	}
}

/** K1: the splat kind of a parameter node, looking through a `typed_parameter`. */
function splatKind(node: Node): "tuple" | "dict" | null {
	if (node.type === "list_splat_pattern") return "tuple";
	if (node.type === "dictionary_splat_pattern") return "dict";
	if (node.type === "typed_parameter") {
		for (const child of node.namedChildren) {
			if (child !== null && child.type !== "identifier") {
				const inner = splatKind(child);
				if (inner !== null) return inner;
			}
		}
	}
	return null;
}

function parameterInfo(node: Node): ParamInfo {
	const nameNode = parameterName(node);
	let annotationNode: Node | null = null;
	let valueNode: Node | null = null;
	if (node.type === "typed_parameter" || node.type === "typed_default_parameter") {
		annotationNode = node.childForFieldName("type");
	}
	if (node.type === "default_parameter" || node.type === "typed_default_parameter") {
		valueNode = node.childForFieldName("value");
	}
	return {
		name: nameNode?.text ?? null,
		splat: splatKind(node),
		annotation: annotationNode !== null ? describeAnnotation(annotationNode) : null,
		annotationNode,
		valueNode,
	};
}

/**
 * LIT (DEC-303 (a22) item 3): the builtin type of a literal or comprehension, from its
 * syntax alone. Only the forms the task lists qualify: list, dict, set and tuple displays and
 * their comprehensions, str and bytes strings (an f-string does not, nor does a template
 * string), and integer and float numbers (an imaginary number does not). `None`, `True`,
 * `False`, a negated number, a generator expression and a conditional expression are not
 * literals here. A concatenation of strings is one str (or one bytes) when every part is.
 */
function literalType(node: Node): string | null {
	switch (node.type) {
		case "list":
		case "list_comprehension":
			return "list";
		case "dictionary":
		case "dictionary_comprehension":
			return "dict";
		case "set":
		case "set_comprehension":
			return "set";
		case "tuple":
			return "tuple";
		case "integer":
			return /[jJ]$/.test(node.text) ? null : "int";
		case "float":
			return /[jJ]$/.test(node.text) ? null : "float";
		case "string": {
			const start = node.firstChild;
			const prefix = start === null ? "" : (/^[A-Za-z]*/.exec(start.text)?.[0] ?? "").toLowerCase();
			if (prefix.includes("f") || prefix.includes("t")) return null;
			return prefix.includes("b") ? "bytes" : "str";
		}
		case "concatenated_string": {
			let type: string | null = null;
			for (const part of node.namedChildren) {
				if (part === null) continue;
				const partType = literalType(part);
				if (partType === null || (type !== null && partType !== type)) return null;
				type = partType;
			}
			return type;
		}
		default:
			return null;
	}
}

/** TS: `type(x)` with one positional bare-name argument, or `x.__class__` on a bare name. */
function classOfRhs(node: Node): BindingRhs | null {
	if (node.type === "call") {
		const fn = node.childForFieldName("function");
		const args = node.childForFieldName("arguments");
		if (fn === null || fn.type !== "identifier" || fn.text !== "type" || args === null) return null;
		if (args.type !== "argument_list" || args.namedChildCount !== 1) return null;
		const only = args.namedChildren[0];
		if (only === null || only === undefined || only.type !== "identifier") return null;
		return { kind: "classof", receiver: only.text, viaType: true };
	}
	if (node.type === "attribute") {
		const object = node.childForFieldName("object");
		const attribute = node.childForFieldName("attribute");
		if (object === null || attribute === null) return null;
		if (object.type !== "identifier" || attribute.text !== "__class__") return null;
		return { kind: "classof", receiver: object.text, viaType: false };
	}
	return null;
}

function literalRhs(node: Node): BindingRhs {
	const type = literalType(node);
	return type === null ? { kind: "other" } : { kind: "literal", type };
}

class FileWalker {
	private uid = 0;
	private readonly classes: ClassInfo[] = [];
	private readonly calls: RawCall[] = [];
	private readonly decoratorSites: RawDecoratorSite[] = [];
	private readonly scopes: Scope[] = [];
	private droppedCalls = 0;
	private readonly importBindingsByKey: Map<string, ImportBinding>;
	private readonly moduleScope: Scope;

	constructor(
		private readonly file: string,
		moduleScope: Scope,
		importBindingsByKey: Map<string, ImportBinding>,
		private readonly localImportResolver: (node: Node) => ImportBinding[],
	) {
		this.moduleScope = moduleScope;
		this.importBindingsByKey = importBindingsByKey;
		this.scopes.push(moduleScope);
	}

	get result(): {
		calls: RawCall[];
		decoratorSites: RawDecoratorSite[];
		classes: ClassInfo[];
		scopes: Scope[];
		droppedCalls: number;
	} {
		return {
			calls: this.calls,
			decoratorSites: this.decoratorSites,
			classes: this.classes,
			scopes: this.scopes,
			droppedCalls: this.droppedCalls,
		};
	}

	walk(root: Node): void {
		const stack: WalkFrame[] = [
			{ node: root, scope: this.moduleScope, callerId: null, scopeNames: [], underError: false },
		];
		while (stack.length > 0) {
			const frame = stack.pop() as WalkFrame;
			const node = frame.node;
			if (frame.underError) {
				if (node.type === "call") this.droppedCalls++;
				this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, true);
				continue;
			}
			switch (node.type) {
				case "ERROR":
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, true);
					continue;
				case "decorated_definition":
					this.handleDecoratedDefinition(stack, frame);
					continue;
				case "function_definition":
					this.handleFunction(stack, frame, node, frame.decorators ?? []);
					continue;
				case "class_definition":
					this.handleClass(
						stack,
						frame,
						node,
						frame.decorators ?? [],
						frame.decoratorCallees ?? [],
						frame.decoratorSlots ?? [],
						frame.decoratorCalled ?? [],
					);
					continue;
				case "lambda":
					this.handleLambda(stack, frame, node);
					continue;
				case "call": {
					const callee = describeCallee(node.childForFieldName("function") ?? node);
					// Rule 36(ii): a bare name called in its own class body runs as a
					// plain function, so that def yields no receiver.
					if (callee.kind === "name" && frame.scope.kind === "class" && frame.scope.classInfo !== null) {
						frame.scope.classInfo.classBodyBareUses.add(callee.name);
					}
					this.calls.push({
						file: this.file,
						line: node.startPosition.row + 1,
						column: node.startPosition.column + 1,
						callerId: frame.callerId,
						scope: frame.scope,
						callee,
					});
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				}
				case "import_statement":
				case "import_from_statement":
				case "future_import_statement":
					this.handleImport(frame.scope, node);
					continue;
				case "assignment":
					this.handleAssignment(stack, frame, node);
					continue;
				case "augmented_assignment":
					this.handleAugmented(stack, frame, node);
					continue;
				case "delete_statement":
					// GCLI-115 (DEC-303 (a40) item 1): a `del` target is a binding for scope purposes
					// (Python language reference, Execution model, binding of names).
					this.addDeleteBindings(frame.scope, node);
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "for_statement":
					this.addTargetBindings(frame.scope, node.childForFieldName("left"));
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "for_in_clause":
					this.addTargetBindings(frame.scope, node.childForFieldName("left"), true);
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "as_pattern":
					this.addAsPatternBinding(frame.scope, node);
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "type_alias_statement": {
					// GCLI-107: PEP 695 `type m = ...` binds `m` (the left is `type > identifier`,
					// or `type > generic_type > identifier` when it takes type parameters).
					let name: Node | null = node.childForFieldName("left");
					while (name !== null && name.type !== "identifier") name = name.namedChild(0);
					if (name !== null) this.addBinding(frame.scope, name.text, { kind: "rebound" });
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				}
				case "named_expression":
					this.addTargetBindings(frame.scope, node.namedChild(0));
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "case_clause":
					// GCLI-101 (3): a capture pattern binds a name in the enclosing scope.
					for (const child of node.namedChildren) {
						if (child !== null && child.type === "case_pattern") this.addMatchCaptures(frame.scope, child);
					}
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "global_statement":
					for (const child of node.namedChildren) {
						if (child !== null && child.type === "identifier") frame.scope.globalNames.add(child.text);
					}
					continue;
				case "nonlocal_statement":
					for (const child of node.namedChildren) {
						if (child !== null && child.type === "identifier") frame.scope.nonlocalNames.add(child.text);
					}
					continue;
				default:
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
			}
		}
	}

	private pushChildren(
		stack: WalkFrame[],
		node: Node,
		scope: Scope,
		callerId: string | null,
		scopeNames: string[],
		underError: boolean,
	): void {
		const children = node.namedChildren;
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (child === null || child === undefined) continue;
			stack.push({ node: child, scope, callerId, scopeNames, underError });
		}
	}

	private newScope(
		kind: Scope["kind"],
		parent: Scope,
		qualname: string,
		symbolId: string | null,
		firstParam: string | null,
		decorators: string[],
		classInfo: ClassInfo | null,
		enclosingClass: ClassInfo | null,
	): Scope {
		this.uid++;
		const scope: Scope = {
			uid: this.uid,
			kind,
			parent,
			file: this.file,
			qualname,
			symbolId,
			bindings: new Map(),
			globalNames: new Set(),
			nonlocalNames: new Set(),
			firstParam,
			functionName: null,
			line: 0,
			decorators,
			classInfo,
			enclosingClass,
		};
		this.scopes.push(scope);
		return scope;
	}

	private addBinding(scope: Scope, name: string, binding: RawBinding): void {
		const list = scope.bindings.get(name);
		if (list === undefined) scope.bindings.set(name, [binding]);
		else list.push(binding);
	}

	private addTargetBindings(scope: Scope, target: Node | null, comprehension = false): void {
		if (target === null) return;
		switch (target.type) {
			case "identifier":
				this.addBinding(
					scope,
					target.text,
					comprehension ? { kind: "rebound", comprehension: true } : { kind: "rebound" },
				);
				return;
			case "pattern_list":
			case "tuple_pattern":
			case "list_pattern":
			case "tuple":
			case "list":
			case "list_splat_pattern":
			// GCLI-107: a `with ... as (a, *m)` target spells the star `list_splat`.
			case "list_splat":
			// GCLI-107: `with ctx() as (m):` and `as (a, (m))` parenthesise a single name.
			case "parenthesized_expression": {
				for (const child of target.namedChildren) this.addTargetBindings(scope, child, comprehension);
				return;
			}
			case "as_pattern_target": {
				for (const child of target.namedChildren) this.addTargetBindings(scope, child, comprehension);
				return;
			}
			// DEC-303 (a23) item 1: Python binds no name through an attribute or
			// subscript target (`self.x = v`, `d[k] = v`), so the base name is not
			// rebound; the default arm below returns without recording one.
			default:
				return;
		}
	}

	/**
	 * The names a `case` pattern binds (tree-sitter-python shapes, probed for GCLI-101):
	 * a `dotted_name` with ONE identifier is a capture (a dotted one is a value pattern),
	 * `splat_pattern > identifier` is a star or `**` capture, an `as_pattern` carries its
	 * alias as a direct identifier child, the first child of a `class_pattern` is the class
	 * and the first child of a `keyword_pattern` is the keyword, neither a binding. `_` is
	 * a wildcard and binds nothing: a bare `_` parses as an empty `case_pattern` and `*_` as
	 * an empty `splat_pattern`, so neither reaches a binding here.
	 */
	private addMatchCaptures(scope: Scope, node: Node): void {
		switch (node.type) {
			case "dotted_name": {
				const first = node.namedChild(0);
				if (node.namedChildCount === 1 && first !== null) {
					this.addBinding(scope, first.text, { kind: "rebound" });
				}
				return;
			}
			case "splat_pattern": {
				const first = node.namedChild(0);
				if (first !== null && first.type === "identifier") {
					this.addBinding(scope, first.text, { kind: "rebound" });
				}
				return;
			}
			case "as_pattern": {
				for (const child of node.namedChildren) {
					if (child === null) continue;
					if (child.type === "identifier") {
						this.addBinding(scope, child.text, { kind: "rebound" });
					} else {
						this.addMatchCaptures(scope, child);
					}
				}
				return;
			}
			case "class_pattern":
			case "keyword_pattern": {
				const children = node.namedChildren;
				for (let index = 1; index < children.length; index++) {
					const child = children[index];
					if (child !== null && child !== undefined) this.addMatchCaptures(scope, child);
				}
				return;
			}
			default:
				for (const child of node.namedChildren) {
					if (child !== null) this.addMatchCaptures(scope, child);
				}
		}
	}

	private addAsPatternBinding(scope: Scope, node: Node): void {
		// `value as name`: bind the alias target; the value is walked separately.
		for (const child of node.namedChildren) {
			if (child === null) continue;
			if (child.type === "as_pattern_target") {
				// GCLI-107: the target may be a tuple, a list, nested or starred, not only a name.
				for (const inner of child.namedChildren) this.addTargetBindings(scope, inner);
			}
		}
	}

	private handleDecoratedDefinition(stack: WalkFrame[], frame: WalkFrame): void {
		const definition = frame.node.childForFieldName("definition");
		const decorators: string[] = [];
		const decoratorCallees: CalleeDesc[] = [];
		const decoratorSlots: DecoratorSlots[] = [];
		const decoratorCalled: boolean[] = [];
		for (const child of frame.node.namedChildren) {
			if (child === null || child.type !== "decorator") continue;
			const expression = child.namedChild(0);
			if (expression === null) continue;
			decorators.push(expression.text);
			const decoratorFunction = expression.type === "call" ? expression.childForFieldName("function") : expression;
			decoratorCalled.push(expression.type === "call");
			decoratorSlots.push(expression.type === "call" ? slotsSpelling(expression) : "absent");
			decoratorCallees.push(decoratorFunction === null ? { kind: "dynamic" } : describeCallee(decoratorFunction));
			if (expression.type === "call") {
				// Rule 21: `@d(args)` is one call site at the decorator line, no decorator site.
				stack.push({
					node: expression,
					scope: frame.scope,
					callerId: frame.callerId,
					scopeNames: frame.scopeNames,
					underError: frame.underError,
				});
			} else {
				// Rule 1: a bare `@d` is a decorator site to d.
				// Rule 36(ii): a bare decorator name in its own class body runs the
				// def as a plain function, so that def yields no receiver.
				if (expression.type === "identifier" && frame.scope.kind === "class" && frame.scope.classInfo !== null) {
					frame.scope.classInfo.classBodyBareUses.add(expression.text);
				}
				this.decoratorSites.push({
					file: this.file,
					line: expression.startPosition.row + 1,
					column: expression.startPosition.column + 1,
					callerId: frame.callerId,
					scope: frame.scope,
					callee: describeCallee(expression),
				});
				stack.push({
					node: expression,
					scope: frame.scope,
					callerId: frame.callerId,
					scopeNames: frame.scopeNames,
					underError: frame.underError,
				});
			}
		}
		if (definition === null) return;
		// The inner definition keeps the decorator names; push it as a definition frame.
		stack.push({
			node: definition,
			scope: frame.scope,
			callerId: frame.callerId,
			scopeNames: frame.scopeNames,
			decorators,
			decoratorCallees,
			decoratorSlots,
			decoratorCalled,
			underError: frame.underError,
		});
	}

	private pushDefinitionErrors(stack: WalkFrame[], node: Node, frame: WalkFrame): void {
		for (const child of node.namedChildren) {
			if (child !== null && child.type === "ERROR") {
				stack.push({
					node: child,
					scope: frame.scope,
					callerId: frame.callerId,
					scopeNames: frame.scopeNames,
					underError: true,
				});
			}
		}
	}

	private handleFunction(stack: WalkFrame[], frame: WalkFrame, node: Node, decorators: string[]): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode !== null && !nameNode.isMissing ? nameNode.text : null;
		const symbolId =
			nameNode !== null && !nameNode.isMissing
				? `${this.file}:${nameNode.startPosition.row + 1}:${nameNode.startPosition.column + 1}`
				: null;
		const qualname = name !== null ? [...frame.scopeNames, name].join(".") : frame.scope.qualname;
		if (name !== null && symbolId !== null) {
			this.addBinding(frame.scope, name, { kind: "def", symbolId });
			// GCLI-101: a def after `global` or `nonlocal` in a class body binds outside the class,
			// so it is no method of the class (the declaration must precede the def in Python).
			if (
				frame.scope.kind === "class" &&
				frame.scope.classInfo !== null &&
				!frame.scope.globalNames.has(name) &&
				!frame.scope.nonlocalNames.has(name)
			) {
				const classInfo = frame.scope.classInfo;
				const ids = classInfo.methods.get(name);
				if (ids === undefined) classInfo.methods.set(name, [symbolId]);
				else ids.push(symbolId);
			}
		}

		const paramsNode = node.childForFieldName("parameters");
		const params: ParamInfo[] = [];
		let firstParamNode: Node | null = null;
		if (paramsNode !== null) {
			for (const child of paramsNode.namedChildren) {
				if (child === null || child.type === "comment") continue;
				if (child.type === "ERROR") {
					stack.push({
						node: child,
						scope: frame.scope,
						callerId: frame.callerId,
						scopeNames: frame.scopeNames,
						underError: true,
					});
					continue;
				}
				if (firstParamNode === null) firstParamNode = child;
				params.push(parameterInfo(child));
			}
		}
		// Rule 32: only a plain first parameter is a receiver; a splat or marker
		// first parameter (or none) yields none.
		const firstParam =
			firstParamNode !== null && isPlainParameter(firstParamNode)
				? (parameterName(firstParamNode)?.text ?? null)
				: null;

		const fnScope = this.newScope(
			"function",
			frame.scope,
			qualname,
			symbolId,
			firstParam,
			decorators,
			null,
			frame.scope.kind === "class" ? frame.scope.classInfo : null,
		);
		// Rule 26: the name is needed for the implicit classmethods.
		fnScope.functionName = name;
		fnScope.line = node.startPosition.row + 1;
		for (const param of params) {
			if (param.name !== null) {
				this.addBinding(fnScope, param.name, {
					kind: "param",
					...(param.splat !== null ? { splat: param.splat } : {}),
					annotation: param.annotation,
					annotationScope: frame.scope,
				});
			}
			// Defaults and annotations are evaluated in the enclosing scope (rule 2).
			if (param.annotationNode !== null) this.pushOuter(stack, param.annotationNode, frame);
			if (param.valueNode !== null) this.pushOuter(stack, param.valueNode, frame);
		}
		const returnType = node.childForFieldName("return_type");
		if (returnType !== null) this.pushOuter(stack, returnType, frame);

		const body = node.childForFieldName("body");
		if (body !== null) {
			stack.push({
				node: body,
				scope: fnScope,
				callerId: symbolId,
				scopeNames: name !== null ? [...frame.scopeNames, name] : frame.scopeNames,
				underError: frame.underError,
			});
		}
		this.pushDefinitionErrors(stack, node, frame);
	}

	private handleClass(
		stack: WalkFrame[],
		frame: WalkFrame,
		node: Node,
		decorators: string[],
		decoratorCallees: CalleeDesc[],
		decoratorSlots: DecoratorSlots[],
		decoratorCalled: boolean[],
	): void {
		const nameNode = node.childForFieldName("name");
		const name = nameNode !== null && !nameNode.isMissing ? nameNode.text : null;
		const symbolId =
			nameNode !== null && !nameNode.isMissing
				? `${this.file}:${nameNode.startPosition.row + 1}:${nameNode.startPosition.column + 1}`
				: null;
		const qualname = name !== null ? [...frame.scopeNames, name].join(".") : frame.scope.qualname;
		if (name !== null && symbolId !== null) {
			this.addBinding(frame.scope, name, { kind: "class", symbolId });
		}

		const bases: BaseRef[] = [];
		let metaclassValue: ClassInfo["metaclassValue"] = "none";
		const superclasses = node.childForFieldName("superclasses");
		if (superclasses !== null) {
			for (const child of superclasses.namedChildren) {
				if (child === null || child.type === "comment") continue;
				if (child.type === "keyword_argument") {
					const key = child.childForFieldName("name");
					if (key !== null && key.text === "metaclass") {
						// Rule 29a/37: `metaclass=type` is the default metaclass only when
						// `type` is unshadowed under the one shadow rule; any other value,
						// or a shadowed/possibly-shadowed `type`, keeps the note. That
						// decision is made at resolution (rule 37 needs the module scope).
						const value = child.childForFieldName("value");
						metaclassValue =
							value !== null && value.type === "identifier" && value.text === "type" ? "type-name" : "other";
						this.pushOuter(stack, child, frame);
						continue;
					}
					this.pushOuter(stack, child, frame);
					continue;
				}
				bases.push({ callee: describeCallee(child), text: child.text });
				// Base expressions (and any call inside them) belong to the enclosing scope.
				this.pushOuter(stack, child, frame);
			}
		}

		const classInfo: ClassInfo | null =
			symbolId !== null
				? {
						id: symbolId,
						name: name ?? "",
						qualname,
						file: this.file,
						line: node.startPosition.row + 1,
						parentScope: frame.scope,
						bases,
						metaclassValue,
						decorators,
						decoratorCallees,
						decoratorSlots,
						decoratorCalled,
						methods: new Map(),
						classBodyBareUses: new Set<string>(),
					}
				: null;
		const classScope = this.newScope("class", frame.scope, qualname, symbolId, null, decorators, classInfo, classInfo);
		classScope.line = node.startPosition.row + 1;
		if (classInfo !== null) {
			classInfo.scope = classScope;
			this.classes.push(classInfo);
		}
		const body = node.childForFieldName("body");
		if (body !== null) {
			// Rule 2: a call in a class body has callerId null.
			stack.push({
				node: body,
				scope: classScope,
				callerId: null,
				scopeNames: name !== null ? [...frame.scopeNames, name] : frame.scopeNames,
				underError: frame.underError,
			});
		}
		this.pushDefinitionErrors(stack, node, frame);
	}

	private handleLambda(stack: WalkFrame[], frame: WalkFrame, node: Node): void {
		const paramsNode = node.childForFieldName("parameters");
		const params: ParamInfo[] = [];
		if (paramsNode !== null) {
			for (const child of paramsNode.namedChildren) {
				if (child === null || child.type === "comment") continue;
				params.push(parameterInfo(child));
			}
		}
		const firstParam = params.length > 0 ? (params[0] as ParamInfo).name : null;
		const lambdaScope = this.newScope(
			"lambda",
			frame.scope,
			`${frame.scope.qualname}.<lambda>`,
			null,
			firstParam,
			[],
			null,
			null,
		);
		for (const param of params) {
			if (param.name !== null) {
				this.addBinding(lambdaScope, param.name, {
					kind: "param",
					...(param.splat !== null ? { splat: param.splat } : {}),
					annotation: param.annotation,
					annotationScope: frame.scope,
				});
			}
			if (param.valueNode !== null) this.pushOuter(stack, param.valueNode, frame);
		}
		const body = node.childForFieldName("body");
		if (body !== null) {
			// Rule 2: lambdas are transparent for caller attribution.
			stack.push({
				node: body,
				scope: lambdaScope,
				callerId: frame.callerId,
				scopeNames: frame.scopeNames,
				underError: frame.underError,
			});
		}
		this.pushDefinitionErrors(stack, node, frame);
	}

	private pushOuter(stack: WalkFrame[], node: Node, frame: WalkFrame): void {
		stack.push({
			node,
			scope: frame.scope,
			callerId: frame.callerId,
			scopeNames: frame.scopeNames,
			underError: frame.underError,
		});
	}

	private handleImport(scope: Scope, node: Node): void {
		const line = node.startPosition.row + 1;
		// Rule 38: a class-body import binds only for statements after it. The
		// position is carried on the binding; a function body ignores it.
		const position: UsePosition = { line, column: node.startPosition.column + 1 };
		if (scope.kind === "module") {
			for (const name of importStatementNames(node)) {
				const binding = this.importBindingsByKey.get(`${this.file}\u0000${line}\u0000${name}`);
				if (binding !== undefined) this.addBinding(scope, name, { kind: "import", importBinding: binding, position });
				else this.addBinding(scope, name, { kind: "localimport", position });
			}
			return;
		}
		// Rule 23: a function- or class-local import binds its names in that scope
		// and resolves through S3's machinery, carrying S3's outcome and reason.
		const bindings = this.localImportResolver(node);
		if (bindings.length > 0) {
			for (const binding of bindings) {
				// A `from x import *` in a function binds no name of its own.
				if (binding.boundName === "") continue;
				this.addBinding(scope, binding.boundName, { kind: "import", importBinding: binding, position });
			}
			return;
		}
		// Fallback only for an import statement S3 could not parse into a binding.
		for (const name of importStatementNames(node)) this.addBinding(scope, name, { kind: "localimport", position });
	}

	private handleAssignment(stack: WalkFrame[], frame: WalkFrame, node: Node): void {
		const left = node.childForFieldName("left");
		const right = node.childForFieldName("right");
		let annotationNode: Node | null = null;
		for (const child of node.namedChildren) {
			if (child !== null && child.type === "type") {
				annotationNode = child;
				break;
			}
		}
		const annotation = annotationNode !== null ? describeAnnotation(annotationNode) : null;
		const rhs: BindingRhs =
			right === null
				? { kind: "other" }
				: right.type === "identifier"
					? { kind: "alias", name: right.text }
					: (classOfRhs(right) ??
						(right.type === "call"
							? { kind: "call", callee: describeCallee(right.childForFieldName("function") ?? right) }
							: right.type === "attribute"
								? { kind: "attr", callee: describeCallee(right) }
								: literalRhs(right)));

		if (left !== null && left.type === "identifier") {
			this.addBinding(frame.scope, left.text, {
				kind: "assign",
				rhs,
				annotation,
				annotationScope: annotation !== null ? frame.scope : null,
				...(isConditionalStatement(node) ? { conditional: true as const } : {}),
				...(right === null ? { bare: true as const } : {}),
			});
		} else if (left !== null) {
			// A tuple target binds run-time values; a subscript/attribute binds no name.
			this.addTargetBindingsAsRebound(frame.scope, left);
		}
		// Walk the target (calls in a subscript index) and the right-hand side.
		if (left !== null) this.pushOuter(stack, left, frame);
		if (right !== null) this.pushOuter(stack, right, frame);
		if (annotationNode !== null) this.pushOuter(stack, annotationNode, frame);
	}

	private addTargetBindingsAsRebound(scope: Scope, target: Node): void {
		switch (target.type) {
			case "identifier":
				this.addBinding(scope, target.text, { kind: "rebound" });
				return;
			case "pattern_list":
			case "tuple_pattern":
			case "list_pattern":
			case "tuple":
			case "list":
			case "list_splat_pattern": {
				for (const child of target.namedChildren) {
					if (child !== null && child !== undefined) this.addTargetBindingsAsRebound(scope, child);
				}
				return;
			}
			// DEC-303 (a23) item 1: an attribute or subscript target binds no name.
			default:
				return;
		}
	}

	/**
	 * GCLI-115: every name a `del` statement unbinds, recorded as a `rebound` binding so each
	 * single-binding rule refuses it. An identifier, a tuple, list or parenthesised target
	 * names its identifiers; an attribute or subscript target binds no name.
	 */
	private addDeleteBindings(scope: Scope, node: Node): void {
		const walk = (target: Node | null): void => {
			if (target === null) return;
			switch (target.type) {
				case "identifier":
					this.addBinding(scope, target.text, { kind: "rebound" });
					return;
				case "expression_list":
				case "tuple":
				case "list":
				case "parenthesized_expression":
					for (const child of target.namedChildren) walk(child);
					return;
				default:
					return;
			}
		};
		for (const child of node.namedChildren) walk(child);
	}

	private handleAugmented(stack: WalkFrame[], frame: WalkFrame, node: Node): void {
		const left = node.namedChild(0);
		if (left !== null && left.type === "identifier") {
			this.addBinding(frame.scope, left.text, { kind: "rebound" });
		}
		this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
	}
}

/**
 * GCLI-116: a statement inside an `if`/`elif`/`else` arm, or the body, an `except` arm or the `else` of a `try`
 * that has an `except` arm (not `finally`, and not a `try` with only `finally`), up to its enclosing def, class
 * or module. A `for` or `while` else is unconditional. `with`, loop bodies and `finally` run unconditionally
 * for this purpose, which keeps the answer the conservative one (rebound).
 */
function isConditionalStatement(node: Node): boolean {
	let current: Node | null = node.parent;
	while (current !== null) {
		switch (current.type) {
			case "function_definition":
			case "class_definition":
			case "module":
				return false;
			case "if_statement":
			case "elif_clause":
			case "except_clause":
			case "except_group_clause":
				return true;
			case "else_clause":
				// the else of an if or a try is a branch; a for or while else runs unconditionally
				if (current.parent?.type === "if_statement" || current.parent?.type === "try_statement") return true;
				current = current.parent;
				break;
			case "try_statement":
				// a try with no except arm (only finally) runs its body unconditionally
				if (
					current.namedChildren.some(
						(child) => child?.type === "except_clause" || child?.type === "except_group_clause",
					)
				) {
					return true;
				}
				current = current.parent;
				break;
			case "finally_clause":
				return false;
			default:
				current = current.parent;
		}
	}
	return false;
}

function makeModuleScope(file: string): Scope {
	return {
		uid: 0,
		kind: "module",
		parent: null,
		file,
		qualname: "",
		symbolId: null,
		bindings: new Map(),
		globalNames: new Set(),
		nonlocalNames: new Set(),
		firstParam: null,
		functionName: null,
		line: 0,
		decorators: [],
		classInfo: null,
		enclosingClass: null,
	};
}

function moduleScopeOf(scope: Scope): Scope {
	let current: Scope = scope;
	while (current.parent !== null) current = current.parent;
	return current;
}

/** Rule 3: `global` and `nonlocal` redirect a binding to the named scope. */
function applyScopeRedirects(scopes: readonly Scope[]): void {
	const depth = (scope: Scope): number => {
		let count = 0;
		let current: Scope | null = scope;
		while (current !== null) {
			count++;
			current = current.parent;
		}
		return count;
	};
	for (const scope of [...scopes].sort((a, b) => depth(b) - depth(a))) {
		// GCLI-101 (2): a `global` or `nonlocal` in a class body redirects too.
		if (scope.kind === "module") continue;
		for (const name of scope.globalNames) {
			const moved = scope.bindings.get(name);
			if (moved === undefined) continue;
			scope.bindings.delete(name);
			// GCLI-116: a binding written by a `global` is not a module-level statement of m
			for (const binding of moved) binding.viaGlobal = true;
			const target = moduleScopeOf(scope);
			const list = target.bindings.get(name);
			if (list === undefined) target.bindings.set(name, moved);
			else list.push(...moved);
		}
		for (const name of scope.nonlocalNames) {
			const moved = scope.bindings.get(name);
			if (moved === undefined) continue;
			scope.bindings.delete(name);
			for (const binding of moved) binding.origin ??= scope;
			// GCLI-101 (1): the scope `nonlocal` names is the nearest enclosing function that
			// binds the name, which may be more than one level up. A function that only
			// declares it nonlocal too holds no binding until the deeper one is moved in, and
			// its own redirect then carries it on. With none, fall back to the nearest enclosing function.
			let target: Scope | null = null;
			let nearest: Scope | null = null;
			let current = scope.parent;
			while (current !== null) {
				if (current.kind === "function" || current.kind === "lambda") {
					nearest ??= current;
					if (current.bindings.get(name)?.some((binding) => binding.comprehension !== true) === true) {
						target = current;
						break;
					}
				}
				current = current.parent;
			}
			if (target === null) target = nearest;
			if (target === null) target = moduleScopeOf(scope);
			const list = target.bindings.get(name);
			if (list === undefined) target.bindings.set(name, moved);
			else list.push(...moved);
		}
	}
}

// --- resolution ------------------------------------------------------------

function symbolEdge(symbol: PythonSymbol, kind: "call" | "new" | "decorator", extra?: Partial<EdgeSpec>): EdgeSpec {
	return { calleeId: symbol.id, kind, decorated: symbol.decorated || undefined, ...extra };
}

/** Rule 38: is `a` strictly before `b` in source order? */
function positionBefore(a: UsePosition, b: UsePosition): boolean {
	return a.line < b.line || (a.line === b.line && a.column < b.column);
}

class Resolver {
	private readonly symbolsById = new Map<string, PythonSymbol>();
	private readonly fileSymbols = new Map<string, PythonSymbol[]>();
	private readonly classById = new Map<string, ClassInfo>();
	private readonly pathToModule = new Map<string, string>();
	private readonly pathToPackage = new Map<string, string>();
	private readonly modulePathByName = new Map<string, string>();
	/** DEC-303 (a27) Q2: a module-name prefix with no file of its own, mapped to its directory. */
	private readonly namespaceDirByName = new Map<string, string>();
	private isSinglePortionNamespace: (dir: string) => boolean = () => false;
	private readonly fileBindingsByPath = new Map<string, ImportBinding[]>();
	private readonly starBindingsByPath = new Map<string, ImportBinding[]>();
	/** Rule 33: each file's module scope, for reading a star target's bindings. */
	private readonly moduleScopesByPath: Map<string, Scope>;
	/** GCLI-116: the (module, name) lookups `moduleBindingGate` is inside, so a self-import adds nothing. */
	private readonly gateActive = new Set<string>();
	private readonly computingMro = new Set<ClassInfo>();
	private childrenMap: Map<string, ClassInfo[]> | null = null;
	private descendantsCache = new Map<string, ClassInfo[]>();
	readonly notes: ConstructorNote[] = [];

	constructor(
		graph: ModuleGraph,
		symbols: readonly PythonSymbol[],
		classes: readonly ClassInfo[],
		moduleScopes: Map<string, Scope>,
	) {
		this.moduleScopesByPath = moduleScopes;
		for (const symbol of symbols) {
			if (!this.symbolsById.has(symbol.id)) this.symbolsById.set(symbol.id, symbol);
			const list = this.fileSymbols.get(symbol.file);
			if (list === undefined) this.fileSymbols.set(symbol.file, [symbol]);
			else list.push(symbol);
		}
		for (const classInfo of classes) {
			if (!this.classById.has(classInfo.id)) this.classById.set(classInfo.id, classInfo);
		}
		for (const module of graph.modules) {
			this.pathToModule.set(module.path, module.module);
			this.pathToPackage.set(module.path, module.package);
			if (!module.shadowed && !this.modulePathByName.has(module.module)) {
				this.modulePathByName.set(module.module, module.path);
			}
		}
		this.isSinglePortionNamespace = (dir) => isSinglePortionNamespace(graph, dir);
		for (const module of graph.modules) {
			if (module.shadowed || module.module === "") continue;
			const nameParts = module.module.split(".");
			const pathParts = module.path.split("/");
			const fileParts = module.isPackage ? 1 : 0;
			for (let k = 1; k < nameParts.length; k++) {
				const name = nameParts.slice(0, k).join(".");
				if (this.modulePathByName.has(name) || this.namespaceDirByName.has(name)) continue;
				this.namespaceDirByName.set(
					name,
					pathParts.slice(0, pathParts.length - fileParts - (nameParts.length - k)).join("/"),
				);
			}
		}
		for (const file of graph.files) {
			this.fileBindingsByPath.set(file.path, file.imports);
			const stars = file.imports.filter((binding) => binding.kind === "star");
			if (stars.length > 0) this.starBindingsByPath.set(file.path, stars);
		}
	}

	// --- name lookup -------------------------------------------------------

	private lookupBindings(
		name: string,
		scope: Scope,
		use?: UsePosition,
	): { scope: Scope; bindings: RawBinding[] } | null {
		let current: Scope | null = scope;
		let first = true;
		while (current !== null) {
			// A class body is not an enclosing scope for its methods (rule 3): only
			// the starting scope may be a class body.
			if (first || current.kind !== "class") {
				let bindings: RawBinding[] | undefined = current.bindings.get(name);
				if (bindings !== undefined && bindings.length > 0) {
					// Rule 38: in the starting class body an import binds only for
					// statements that follow it; an earlier use falls through to the
					// enclosing binding. Function and module scope stay flow-insensitive.
					if (first && current.kind === "class" && use !== undefined) {
						bindings = bindings.filter(
							(binding) =>
								!(
									(binding.kind === "import" || binding.kind === "localimport") &&
									binding.position !== undefined &&
									!positionBefore(binding.position, use)
								),
						);
					}
					if (bindings.length > 0) return { scope: current, bindings };
				}
			}
			first = false;
			current = current.parent;
		}
		return null;
	}

	/**
	 * Rule 37: the one shadow rule shared by every builtin test. The name is the
	 * unshadowed builtin when it is bound nowhere in the enclosing scopes, no
	 * complete star set supplies it (rule 33), and no partial or unknown star
	 * import could supply it (a partial star shadows builtins, rule 29b).
	 */
	private isUnshadowedBuiltin(name: string, scope: Scope | null, use?: UsePosition): boolean {
		if (scope === null) return true;
		if (this.lookupBindings(name, scope, use) !== null) return false;
		const stars = this.starBindingsByPath.get(moduleScopeOf(scope).file);
		if (stars !== undefined) {
			for (const star of stars) {
				if (star.outcome === "resolved" && star.target !== null && star.reason === null) {
					if (star.starNames.includes(name)) return false;
				} else {
					// A partial or unknown star import may bind the name.
					return false;
				}
			}
		}
		return true;
	}

	/** D1: the class body binds `name` and no def of it (so `methods` has no entry for it). */
	private bindsNameWithoutDef(classInfo: ClassInfo, name: string): boolean {
		const bindings = classInfo.scope?.bindings.get(name);
		return bindings?.some((binding) => binding.kind !== "def") === true;
	}

	/**
	 * Rule 36(i)/43: the class scope rebinds the def's name by a later non-def
	 * binding, so an instance's attribute is not this def and a call to the name
	 * is unresolved (rule 5). Bindings are collected in source order, so the last
	 * one is the class attribute's value.
	 */
	private isReboundDef(classInfo: ClassInfo, functionName: string | null): boolean {
		if (functionName === null) return false;
		const bindings = classInfo.scope?.bindings.get(functionName);
		if (bindings === undefined || bindings.length === 0) return false;
		return (bindings[bindings.length - 1] as RawBinding).kind !== "def";
	}

	/**
	 * Rule 46: a decorator name `staticmethod` or `classmethod` that only a
	 * partial or unknown star import may supply cannot be claimed as the builtin,
	 * so whether the def is static or a class method is not statically known. A
	 * local, module or complete-star binding is a known non-builtin and keeps the
	 * ordinary method reading (rule 26).
	 */
	private isStarPossiblyBuiltin(name: string, scope: Scope | null, use?: UsePosition): boolean {
		if (scope === null) return false;
		if (this.lookupBindings(name, scope, use) !== null) return false;
		const stars = this.starBindingsByPath.get(moduleScopeOf(scope).file);
		if (stars === undefined) return false;
		for (const star of stars) {
			if (star.outcome === "resolved" && star.target !== null && star.reason === null) {
				if (star.starNames.includes(name)) return false;
			} else {
				return true;
			}
		}
		return false;
	}

	/**
	 * Rule 36: a def in a class body yields no receiver when (i) the class scope
	 * rebinds its name by a later non-def binding, or (ii) its name is used bare
	 * in its own class body (a decorator or call), so the def also runs as a plain
	 * function. Rule 43 withholds only the receiver in shape (ii); calls to the
	 * def still resolve.
	 */
	private isNoReceiverDef(classInfo: ClassInfo, functionName: string | null): boolean {
		if (functionName === null) return false;
		if (classInfo.classBodyBareUses.has(functionName)) return true;
		return this.isReboundDef(classInfo, functionName);
	}

	/**
	 * Rule 26: the receiver of a method scope, whatever the first parameter is
	 * called. A plain method takes the instance; `@classmethod`, `__init_subclass__`,
	 * `__class_getitem__` and `__new__` take the class; `@staticmethod` has none.
	 * Rules 32 and 36 narrow this: a splat first parameter and a rebound or
	 * bare-used def yield no receiver.
	 */
	private methodReceiver(scope: Scope): { kind: "instance" | "class"; name: string; classInfo: ClassInfo } | null {
		if (scope.kind !== "function" || scope.enclosingClass === null) return null;
		const classInfo = scope.enclosingClass;
		const name = scope.firstParam;
		if (name === null) return null;
		if (this.isNoReceiverDef(classInfo, scope.functionName)) return null;
		const decoratorScope = scope.parent;
		const use = scope.line > 0 ? { line: scope.line, column: 1 } : undefined;
		const hasStatic = scope.decorators.includes("staticmethod");
		const hasClass = scope.decorators.includes("classmethod");
		// Rule 46: a `staticmethod`/`classmethod` that only a partial or unknown star
		// may supply leaves the kind unknown, so the first parameter is no receiver
		// and a `cls(...)` under it is not a construction.
		if (hasStatic && this.isStarPossiblyBuiltin("staticmethod", decoratorScope, use)) return null;
		if (hasClass && this.isStarPossiblyBuiltin("classmethod", decoratorScope, use)) return null;
		const isStatic = hasStatic && this.isUnshadowedBuiltin("staticmethod", decoratorScope, use);
		// An explicit @staticmethod wins (there is no receiver); otherwise a
		// recognised @classmethod or an implicit classmethod takes the class.
		if (isStatic) return null;
		const isClass =
			(hasClass && this.isUnshadowedBuiltin("classmethod", decoratorScope, use)) ||
			scope.functionName === "__init_subclass__" ||
			scope.functionName === "__class_getitem__" ||
			scope.functionName === "__new__";
		return { kind: isClass ? "class" : "instance", name, classInfo };
	}

	/**
	 * Rule 26: does `name` resolve, through LEGB, to the first parameter of an
	 * enclosing method that is still receiving? A nested def, lambda or
	 * comprehension inherits the enclosing method's receiver; a name rebound on the
	 * way there does not (rule 6a).
	 */
	private receiverOf(name: string, scope: Scope): { kind: "instance" | "class"; classInfo: ClassInfo } | null {
		let current: Scope | null = scope;
		while (current !== null) {
			const receiver = this.methodReceiver(current);
			if (receiver !== null && receiver.name === name) {
				const found = this.lookupBindings(name, scope);
				if (
					found !== null &&
					found.scope === current &&
					found.bindings.length === 1 &&
					(found.bindings[0] as RawBinding).kind === "param"
				) {
					return { kind: receiver.kind, classInfo: receiver.classInfo };
				}
				return null;
			}
			current = current.parent;
		}
		return null;
	}

	/**
	 * Rule 24: true when the name is bound only by imports whose S3 outcome is
	 * external, so an attribute call on it is external without inference. An alias
	 * or call result is a run-time value and is not covered.
	 */
	private isExternalImportReceiver(name: string, scope: Scope, use?: UsePosition): boolean {
		const found = this.lookupBindings(name, scope, use);
		if (found === null) return false;
		return found.bindings.every(
			(binding) =>
				binding.kind === "import" && binding.importBinding != null && binding.importBinding.outcome === "external",
		);
	}

	resolveBareName(
		name: string,
		scope: Scope,
		hops: number,
		use?: UsePosition,
		starCtx?: StarLookupContext,
	): NameOutcome {
		const found = this.lookupBindings(name, scope, use);
		if (found === null) return this.resolveUnbound(name, scope, use, starCtx);
		const bindings = found.bindings;
		const dynamic = bindings.some(
			(binding) => binding.kind === "param" || binding.kind === "assign" || binding.kind === "rebound",
		);
		if (dynamic) {
			if (bindings.length === 1) {
				const binding = bindings[0] as RawBinding;
				if (binding.kind === "assign" && binding.rhs !== undefined && binding.rhs.kind === "alias") {
					if (hops >= MAX_ALIAS_HOPS) return { kind: "unresolved", reason: "alias-depth" };
					return this.resolveBareName(binding.rhs.name, found.scope, hops + 1, undefined, starCtx);
				}
				return { kind: "runtime", reason: "run-time-bound" };
			}
			return { kind: "unresolved", reason: "rebound" };
		}
		if (bindings.length === 1) return this.resolveStatic(bindings[0] as RawBinding);
		return this.resolveMultiply(bindings);
	}

	private resolveUnbound(name: string, scope: Scope, use?: UsePosition, starCtx?: StarLookupContext): NameOutcome {
		// Rule 33/45: when the module's star imports have a complete export set (S3)
		// and the name is in it, the name is bound by the star target and never
		// falls back to the builtin. Rule 45 walks the star imports last to first: a
		// complete star that exports the name resolves to it, a complete one that
		// does not is skipped, and a partial or unknown star reached first makes the
		// name star-bound even if an earlier complete star exports it.
		const stars = this.starBindingsByPath.get(scope.file);
		const ctx: StarLookupContext = starCtx ?? { visited: new Set<string>(), hops: 0, cycle: false };
		let partial = false;
		let cycleHit = false;
		if (stars !== undefined) {
			for (let index = stars.length - 1; index >= 0; index--) {
				const star = stars[index] as ImportBinding;
				if (star.outcome === "resolved" && star.target !== null && star.reason === null) {
					if (!star.starNames.includes(name)) continue;
					if (partial) return { kind: "unresolved", reason: "star-bound" };
					const result = this.resolveStarBound(star.target, name, ctx);
					if (result.cycle) {
						cycleHit = true;
						continue;
					}
					return result.outcome;
				}
				partial = true;
			}
		}
		// Rule 40: a name found on no path where a cycle was hit reports the cycle.
		if (cycleHit || ctx.cycle) return { kind: "unresolved", reason: "import-cycle" };
		if (partial) return { kind: "unresolved", reason: "star-import" };
		// Rule 37: use the one shadow rule for the builtin test (rule 4c / 29b).
		if (BUILTINS.has(name) && this.isUnshadowedBuiltin(name, scope, use)) return { kind: "external" };
		return { kind: "unresolved", reason: "unbound" };
	}

	/**
	 * Rule 33/40: resolve a name the star import binds in its target the way the
	 * import itself binds it — defs, classes and imports (and re-exports) through
	 * rules 4a/4b, a single alias assignment through 4e, any other assignment as
	 * run-time-bound (4d), and a name the complete set names but the target does
	 * not bind statically as star-bound. Rule 40 carries one visited set of
	 * (target, name) pairs and a hop bound through the whole lookup: a revisit or
	 * the bound ends that path as "not found here" and reports a cycle, and the
	 * caller continues with the remaining star sets.
	 */
	private resolveStarBound(target: string, name: string, ctx: StarLookupContext): StarBoundResult {
		const key = `${target}\u0000${name}`;
		if (ctx.visited.has(key) || ctx.hops >= MAX_STAR_HOPS) {
			ctx.cycle = true;
			return { outcome: { kind: "unresolved", reason: "import-cycle" }, cycle: true };
		}
		ctx.visited.add(key);
		ctx.hops += 1;
		const targetScope = this.moduleScopesByPath.get(target);
		if (targetScope === undefined) return { outcome: { kind: "unresolved", reason: "star-bound" }, cycle: false };
		const hasLocal = this.lookupBindings(name, targetScope) !== null;
		const outcome = this.resolveBareName(name, targetScope, 0, undefined, ctx);
		if (hasLocal) return { outcome, cycle: outcome.kind === "unresolved" && outcome.reason === "import-cycle" };
		if (outcome.kind === "symbol" || outcome.kind === "module" || outcome.kind === "multiply") {
			return { outcome, cycle: false };
		}
		if (outcome.kind === "runtime") return { outcome, cycle: false };
		if (outcome.kind === "unresolved" && outcome.reason !== "unbound" && outcome.reason !== "star-import") {
			return { outcome, cycle: outcome.reason === "import-cycle" };
		}
		return { outcome: { kind: "unresolved", reason: "star-bound" }, cycle: false };
	}

	private resolveStatic(binding: RawBinding): NameOutcome {
		switch (binding.kind) {
			case "def":
			case "class": {
				const symbol = binding.symbolId !== undefined ? this.symbolsById.get(binding.symbolId) : undefined;
				return symbol !== undefined ? { kind: "symbol", symbol } : { kind: "unresolved", reason: "unresolved-symbol" };
			}
			case "import":
				return this.resolveImportBinding(binding.importBinding ?? null);
			case "localimport":
				return { kind: "unresolved", reason: "local-import" };
			default:
				return { kind: "unresolved", reason: "unbound" };
		}
	}

	private resolveImportBinding(binding: ImportBinding | null): NameOutcome {
		if (binding === null) return { kind: "unresolved", reason: "local-import" };
		if (binding.outcome === "external") {
			// A plain `import x` binds a module; a from-import binds an unknown name,
			// so a receiver on it needs inference rather than being claimed external.
			return binding.kind === "import" ? { kind: "module", path: null } : { kind: "external" };
		}
		if (binding.outcome === "unresolved" || binding.target === null) {
			return { kind: "unresolved", reason: binding.reason ?? "unresolved" };
		}
		if (binding.kind === "import") {
			// `import a.b` binds the top package `a`, not the leaf the S3 binding
			// points at; `import a.b as c` binds the leaf. Rule 4b, "a module name".
			if (binding.alias === null && binding.module.includes(".")) {
				const top = binding.module.split(".")[0] ?? binding.module;
				const topPath = this.modulePathByName.get(top);
				if (topPath !== undefined) return { kind: "module", path: topPath };
			}
			return { kind: "module", path: binding.target };
		}
		const importedName = binding.name ?? binding.boundName;
		if (this.isModuleFileForName(binding.target, importedName) && !this.isSameNameAttribute(binding, importedName)) {
			return { kind: "module", path: binding.target };
		}
		const targets = [binding.target, ...binding.alternatives];
		const symbols: PythonSymbol[] = [];
		let forcedMultiply = false;
		for (const target of targets) {
			const gate = this.moduleBindingGate(target, importedName);
			if (gate !== null) {
				if (gate.kind === "unresolved") return gate;
				const found = gate.kind === "symbol" ? [gate.symbol] : gate.kind === "multiply" ? gate.symbols : [];
				if (gate.kind === "multiply") forcedMultiply = true;
				for (const symbol of found) if (!symbols.some((existing) => existing.id === symbol.id)) symbols.push(symbol);
				continue;
			}
			const symbol = this.symbolInModuleOrReexport(target, importedName, 0);
			if (symbol !== null && !symbols.some((existing) => existing.id === symbol.id)) symbols.push(symbol);
		}
		if (symbols.length === 1 && !forcedMultiply) return { kind: "symbol", symbol: symbols[0] as PythonSymbol };
		if (symbols.length > 0) return { kind: "multiply", symbols };
		return { kind: "unresolved", reason: "run-time-bound" };
	}

	private resolveMultiply(bindings: readonly RawBinding[]): NameOutcome {
		const symbols: PythonSymbol[] = [];
		let external = false;
		let module = false;
		const reasons: string[] = [];
		for (const binding of bindings) {
			const outcome = this.resolveStatic(binding);
			switch (outcome.kind) {
				case "symbol":
					if (!symbols.some((existing) => existing.id === outcome.symbol.id)) symbols.push(outcome.symbol);
					break;
				case "external":
					external = true;
					break;
				case "module":
					// Rule 20: a multiply-bound name whose alternatives are all external
					// (an external module included) is RESOLVED_EXTERNAL; a first-party
					// module alternative is a called module.
					if (outcome.path === null) external = true;
					else module = true;
					break;
				case "unresolved":
				case "runtime":
					reasons.push(outcome.reason);
					break;
				case "multiply":
					for (const symbol of outcome.symbols) {
						if (!symbols.some((existing) => existing.id === symbol.id)) symbols.push(symbol);
					}
					break;
			}
		}
		if (symbols.length > 0) return { kind: "multiply", symbols };
		if (external) return { kind: "external" };
		if (module) return { kind: "unresolved", reason: "module-called" };
		return { kind: "unresolved", reason: reasons[0] ?? "unbound" };
	}

	// --- module helpers ----------------------------------------------------

	/**
	 * DEC-303 (a22) item 3, group A4: `from m import m` binds that attribute, not the
	 * module, only when the SOURCE module `m` is a module FILE (`m.py`, never a package
	 * `__init__.py` or a namespace directory, whose same-named submodule is what Python
	 * binds) and it defines or re-exports the name. `from . import m` has no module part
	 * and stays a module.
	 */
	private isSameNameAttribute(binding: ImportBinding, name: string, depth = 0): boolean {
		if (binding.module === "") return false;
		const source = this.sourceModuleFile(binding);
		if (source === null || !(source === `${name}.py` || source.endsWith(`/${name}.py`))) return false;
		return this.symbolInModuleOrReexport(source, name, depth + 1) !== null;
	}

	/** The file of a from-import's source module (dots resolved against the importer's package), or null. */
	private sourceModuleFile(binding: ImportBinding): string | null {
		if (binding.dots === 0) return this.modulePathByName.get(binding.module) ?? null;
		const pkg = this.pathToPackage.get(binding.path);
		if (pkg === undefined) return null;
		const parts = pkg === "" ? [] : pkg.split(".");
		const keep = parts.length - (binding.dots - 1);
		if (keep < 0) return null;
		const name = [...parts.slice(0, keep), binding.module].filter((part) => part !== "").join(".");
		return this.modulePathByName.get(name) ?? null;
	}

	private isModuleFileForName(path: string, name: string): boolean {
		return (
			path === `${name}.py` ||
			path === `${name}/__init__.py` ||
			path.endsWith(`/${name}.py`) ||
			path.endsWith(`/${name}/__init__.py`)
		);
	}

	/**
	 * GCLI-116 (DEC-303 (a43) item 2, (a44) items 1 and 4): what module `path` binds `name` to, read from
	 * m's module-level BINDINGS (after the `global` and `nonlocal` redirects, so a `del` and a function's
	 * `global` write count) rather than from its symbol table. Null when the module has no def or class of
	 * the name (the symbol-table path then stands) or the lookup re-enters itself (a self-import such as
	 * `from .live import Live as Live` adds nothing). A `del`, a value that does not resolve to a def or
	 * class, or an unresolved import makes the name rebound (no edge). A def, a class, an import or a
	 * conditional assignment of a resolving name is an alternative: one symbol with no other alternative is
	 * (i) no alternative, a different target or an external one is (ii) Q2's multiply-bound alternatives.
	 */
	private moduleBindingGate(path: string, name: string): NameOutcome | null {
		const scope = this.moduleScopesByPath.get(path);
		const bindings = scope?.bindings.get(name);
		if (scope === undefined || bindings === undefined) return null;
		if (!bindings.some((binding) => binding.kind === "def" || binding.kind === "class")) return null;
		const key = `${path}\u0000${name}`;
		if (this.gateActive.has(key)) return null;
		this.gateActive.add(key);
		try {
			const rebound: NameOutcome = { kind: "unresolved", reason: "rebound" };
			const symbols: PythonSymbol[] = [];
			let external = false;
			for (const binding of bindings) {
				// a write through `global` (from a function or class body) is a rebinding the static rules cannot order
				if (binding.viaGlobal === true) return rebound;
				// N4: a bare annotation at module scope binds no name. N1: a comprehension's iteration target
				// lives in the comprehension's own scope, not in the module.
				if (binding.bare === true || binding.comprehension === true) continue;
				let outcome: NameOutcome;
				if (binding.kind === "def" || binding.kind === "class") {
					// an `@overload` stub has no symbol of its own (the group collapses into its implementation)
					if (binding.symbolId === undefined || !this.symbolsById.has(binding.symbolId)) continue;
					outcome = this.resolveStatic(binding);
				} else if (binding.kind === "import") outcome = this.resolveImportBinding(binding.importBinding ?? null);
				else if (
					binding.kind === "assign" &&
					binding.conditional === true &&
					binding.rhs?.kind === "alias" &&
					binding.origin === undefined
				) {
					outcome = this.resolveBareName(binding.rhs.name, scope, 1);
				} else return rebound;
				if (outcome.kind === "symbol") outcome = { kind: "multiply", symbols: [outcome.symbol] };
				if (outcome.kind === "multiply") {
					for (const symbol of outcome.symbols) {
						if (!symbols.some((existing) => existing.id === symbol.id)) symbols.push(symbol);
					}
				} else if (outcome.kind === "external") external = true;
				else return rebound;
			}
			if (symbols.length === 0) return rebound;
			if (symbols.length === 1 && !external) return { kind: "symbol", symbol: symbols[0] as PythonSymbol };
			return { kind: "multiply", symbols };
		} finally {
			this.gateActive.delete(key);
		}
	}

	private symbolInModule(path: string, name: string): PythonSymbol | null {
		const symbols = this.fileSymbols.get(path);
		if (symbols === undefined) return null;
		for (const symbol of symbols) if (symbol.qualname === name) return symbol;
		return null;
	}

	private symbolInModuleOrReexport(path: string, name: string, depth: number): PythonSymbol | null {
		if (depth > MAX_MODULE_DEPTH) return null;
		const direct = this.symbolInModule(path, name);
		if (direct !== null) return direct;
		const bindings = this.fileBindingsByPath.get(path);
		if (bindings === undefined) return null;
		for (const binding of bindings) {
			if (binding.boundName !== name) continue;
			if (binding.outcome !== "resolved" || binding.target === null) continue;
			if (binding.kind === "import") continue;
			const importedName = binding.name ?? binding.boundName;
			// A hop that binds a same-named module (not the attribute) yields no symbol;
			// the depth is threaded so a cycle through the gate terminates (DEC-303 (a22) A4).
			if (
				this.isModuleFileForName(binding.target, importedName) &&
				!this.isSameNameAttribute(binding, importedName, depth + 1)
			) {
				continue;
			}
			const nested = this.symbolInModuleOrReexport(binding.target, importedName, depth + 1);
			if (nested !== null) return nested;
		}
		return null;
	}

	private resolveModuleAttribute(path: string, name: string, visited: Set<string>, depth: number): ModuleAttrOutcome {
		if (depth > MAX_MODULE_DEPTH) return { kind: "unresolved", reason: "depth-limit" };
		const key = `${path}\u0000${name}`;
		if (visited.has(key)) return { kind: "unresolved", reason: "import-cycle" };
		visited.add(key);
		const gate = this.moduleBindingGate(path, name);
		if (gate !== null) {
			if (gate.kind === "symbol" || gate.kind === "multiply" || gate.kind === "unresolved") return gate;
		}
		const direct = this.symbolInModule(path, name);
		if (direct !== null) return { kind: "symbol", symbol: direct };
		const moduleName = this.pathToModule.get(path);
		if (moduleName !== undefined) {
			const subName = moduleName === "" ? name : `${moduleName}.${name}`;
			const subPath = this.modulePathByName.get(subName);
			if (subPath !== undefined) return { kind: "module", path: subPath };
		}
		const bindings = this.fileBindingsByPath.get(path);
		if (bindings !== undefined) {
			for (const binding of bindings) {
				if (binding.boundName !== name) continue;
				if (binding.outcome === "external") return { kind: "external" };
				if (binding.outcome === "unresolved" || binding.target === null) {
					return { kind: "unresolved", reason: binding.reason ?? "attribute-not-found" };
				}
				if (binding.kind === "import") return { kind: "module", path: binding.target };
				const importedName = binding.name ?? binding.boundName;
				if (
					this.isModuleFileForName(binding.target, importedName) &&
					!this.isSameNameAttribute(binding, importedName)
				) {
					return { kind: "module", path: binding.target };
				}
				return this.resolveModuleAttribute(binding.target, importedName, visited, depth + 1);
			}
			return this.resolveStarAttribute(path, bindings, name);
		}
		return { kind: "unresolved", reason: "attribute-not-found" };
	}

	/**
	 * DEC-303 (a22) item 3, A1: `pkg.Name` where no def, import or submodule of
	 * `pkg` carries the name reads what `from m import *` bound. Stars are read
	 * last to first, as rule 45 reads them: a complete star that does not export
	 * the name is skipped, one that does decides the answer, and an incomplete
	 * star (unresolved, external, non-literal `__all__`) may supply any name, so
	 * it leaves the call unresolved. The selected star is resolved the way a bare
	 * name bound by it is (rule 33, `resolveStarBound`), so a rebinding in the
	 * star's source is seen. Any other binding of the name in the holder (an
	 * assignment, `for`, `with` or `except ... as` target, or a `del`, GCLI-115) is a later or earlier
	 * rebinding the static rules cannot order, so the call stays unresolved
	 * (rule 2). Known gaps, as for bare names: a def or import in the holder
	 * wins over a star even where the star comes later, and a star import's
	 * `condition` (try/except) is ignored.
	 * Conservative differences from bare names: a multiply-bound result is
	 * unresolved `rebound` (no multiplyBound edges), and a cycle ends at the
	 * selected star instead of continuing to earlier ones (rule 40).
	 */
	private resolveStarAttribute(holder: string, bindings: readonly ImportBinding[], name: string): ModuleAttrOutcome {
		// No star in the holder: nothing to read here, and the holder check below would
		// only replace attribute-not-found with `rebound` for every plain module.
		if (!bindings.some((binding) => binding.kind === "star")) {
			return { kind: "unresolved", reason: "attribute-not-found" };
		}
		const holderScope = this.moduleScopesByPath.get(holder);
		if (holderScope !== undefined && this.lookupBindings(name, holderScope) !== null) {
			return { kind: "unresolved", reason: "rebound" };
		}
		for (let index = bindings.length - 1; index >= 0; index--) {
			const star = bindings[index] as ImportBinding;
			if (star.kind !== "star") continue;
			if (star.outcome !== "resolved" || star.target === null) {
				return { kind: "unresolved", reason: star.reason ?? "star-import" };
			}
			if (!star.starNames.includes(name)) continue;
			const ctx: StarLookupContext = { visited: new Set<string>(), hops: 0, cycle: false };
			const found = this.resolveStarBound(star.target, name, ctx).outcome;
			switch (found.kind) {
				case "symbol":
					return { kind: "symbol", symbol: found.symbol };
				case "module":
					return found.path === null ? { kind: "external" } : { kind: "module", path: found.path };
				case "external":
					return { kind: "external" };
				case "runtime":
					return { kind: "unresolved", reason: found.reason };
				case "multiply":
					return { kind: "unresolved", reason: "rebound" };
				case "unresolved":
					return { kind: "unresolved", reason: found.reason };
			}
		}
		return { kind: "unresolved", reason: "attribute-not-found" };
	}

	private resolveModuleChain(path: string, segments: readonly string[], fromIndex: number): ModuleAttrOutcome {
		let currentPath = path;
		let currentName = this.pathToModule.get(path) ?? "";
		let pending: string | null = null;
		for (let index = fromIndex; index < segments.length; index++) {
			const segment = segments[index] as string;
			const last = index === segments.length - 1;
			const baseName: string = pending ?? currentName;
			const subName: string = baseName === "" ? segment : `${baseName}.${segment}`;
			const subPath = this.modulePathByName.get(subName);
			if (!last) {
				if (subPath !== undefined) {
					currentPath = subPath;
					currentName = subName;
					pending = null;
				} else {
					// DEC-303 (a27) Q2: walk through a single-portion namespace directory.
					const dir = this.namespaceDirByName.get(subName);
					if (dir === undefined || !this.isSinglePortionNamespace(dir)) {
						return { kind: "unresolved", reason: "attribute-not-found" };
					}
					pending = subName;
				}
			} else if (pending !== null) {
				// A namespace package has no attributes of its own, so only a submodule binds.
				return subPath !== undefined
					? { kind: "module", path: subPath }
					: { kind: "unresolved", reason: "attribute-not-found" };
			} else {
				return this.resolveModuleAttribute(currentPath, segment, new Set(), 0);
			}
		}
		return { kind: "unresolved", reason: "attribute-not-found" };
	}

	// --- annotation and known-class resolution -----------------------------

	private resolveAnnotationClass(desc: AnnotationDesc, scope: Scope): ClassInfo | null {
		switch (desc.kind) {
			case "name": {
				const outcome = this.resolveBareName(desc.name, scope, 0);
				return outcome.kind === "symbol" && outcome.symbol.kind === "class"
					? (this.classById.get(outcome.symbol.id) ?? null)
					: null;
			}
			case "dotted": {
				const symbol = this.resolveDottedToSymbol(desc.segments, scope);
				return symbol !== null && symbol.kind === "class" ? (this.classById.get(symbol.id) ?? null) : null;
			}
			case "optional":
				return this.resolveAnnotationClass(desc.inner, scope);
			case "union": {
				const members = desc.members.filter((member) => member.kind !== "none");
				if (members.length !== 1) return null;
				return this.resolveAnnotationClass(members[0] as AnnotationDesc, scope);
			}
			default:
				return null;
		}
	}

	private resolveDottedToSymbol(segments: readonly string[], scope: Scope): PythonSymbol | null {
		if (segments.length === 0) return null;
		const base = this.resolveBareName(segments[0] as string, scope, 0);
		if (base.kind === "module" && base.path !== null) {
			const outcome = this.resolveModuleChain(base.path, segments, 1);
			return outcome.kind === "symbol" ? outcome.symbol : null;
		}
		if (base.kind === "symbol" && base.symbol.kind === "class" && segments.length === 2) {
			const wanted = `${base.symbol.qualname}.${segments[1]}`;
			const symbols = this.fileSymbols.get(base.symbol.file) ?? [];
			for (const symbol of symbols) if (symbol.qualname === wanted) return symbol;
		}
		return null;
	}

	private resolveCalleeToSymbol(desc: CalleeDesc, scope: Scope, depth: number, use?: UsePosition): PythonSymbol | null {
		if (depth > MAX_MODULE_DEPTH) return null;
		switch (desc.kind) {
			case "name": {
				const outcome = this.resolveBareName(desc.name, scope, 0, use);
				return outcome.kind === "symbol" ? outcome.symbol : null;
			}
			case "attr": {
				if (desc.base.kind !== "name") return null;
				const base = this.resolveBareName(desc.base.name, scope, 0, use);
				if (base.kind === "module" && base.path !== null) {
					const outcome = this.resolveModuleChain(base.path, desc.segments, 0);
					return outcome.kind === "symbol" ? outcome.symbol : null;
				}
				if (base.kind === "symbol" && base.symbol.kind === "class" && desc.segments.length === 1) {
					const wanted = `${base.symbol.qualname}.${desc.segments[0]}`;
					const symbols = this.fileSymbols.get(base.symbol.file) ?? [];
					for (const symbol of symbols) if (symbol.qualname === wanted) return symbol;
				}
				return null;
			}
			default:
				return null;
		}
	}

	/**
	 * DEC-303 (a31) Q2: a decorator can replace the class, so a decorated class is
	 * not known to be itself. False only when every decorator is a bare or called
	 * `d` bound by exactly one `from m import d` (alias allowed), or `m.d` with `m`
	 * bound by exactly one `import m` (alias allowed), where `m.d` is on
	 * NON_REPLACING_CLASS_DECORATORS. Relative imports, local imports, star
	 * imports, rebound names and every other callee shape count as replacing.
	 */
	private hasReplacingDecorator(classInfo: ClassInfo): boolean {
		const use = { line: classInfo.line, column: 1 };
		for (const [position, callee] of classInfo.decoratorCallees.entries()) {
			let moduleName: string;
			let decoratorName: string;
			let bindingName: string;
			let wantKind: "from" | "import";
			if (callee.kind === "name") {
				bindingName = callee.name;
				wantKind = "from";
			} else if (callee.kind === "attr" && callee.base.kind === "name" && callee.segments.length === 1) {
				bindingName = callee.base.name;
				wantKind = "import";
			} else {
				return true;
			}
			const found = this.lookupBindings(bindingName, classInfo.parentScope, use);
			if (found === null || found.bindings.length !== 1) return true;
			const binding = found.bindings[0] as RawBinding;
			const imported = binding.kind === "import" ? binding.importBinding : null;
			if (imported === null || imported === undefined || imported.kind !== wantKind) return true;
			// A repo file named like the stdlib module resolves the import in-repo: not the stdlib decorator.
			if (imported.outcome !== "external") return true;
			if (wantKind === "from") {
				moduleName = imported.module;
				decoratorName = imported.name ?? "";
			} else {
				moduleName = imported.module;
				decoratorName = (callee as { segments: string[] }).segments[0] as string;
			}
			if (NON_REPLACING_CLASS_DECORATORS.get(moduleName)?.has(decoratorName) !== true) return true;
			// (a33) only a decorator FACTORY may be called: `@total_ordering(cls=X)` applies the
			// decorator to X and decorates the class with the result, so it replaces the class.
			if (
				classInfo.decoratorCalled[position] === true &&
				!NON_REPLACING_CLASS_DECORATOR_FACTORIES.has(`${moduleName}.${decoratorName}`)
			) {
				return true;
			}
			// (a32) dataclass(slots=True) returns a NEW class: only a bare, slots-absent or
			// slots=False dataclass keeps the original, so any other spelling refuses.
			if (classInfo.decoratorSlots[position] === "other") return true;
		}
		return false;
	}

	private knownClassOf(name: string, scope: Scope, use?: UsePosition): ClassInfo | null {
		const found = this.lookupBindings(name, scope, use);
		if (found === null || found.bindings.length !== 1) return null;
		const binding = found.bindings[0] as RawBinding;
		if (binding.kind === "import" && binding.importBinding) {
			const outcome = this.resolveImportBinding(binding.importBinding);
			if (outcome.kind === "symbol" && outcome.symbol.kind === "class") {
				return this.classById.get(outcome.symbol.id) ?? null;
			}
			return null;
		}
		if (binding.kind === "assign") {
			if (binding.annotation && binding.annotationScope) {
				return this.resolveAnnotationClass(binding.annotation, binding.annotationScope);
			}
			if (binding.rhs !== undefined && binding.rhs.kind === "call") {
				const symbol = this.resolveCalleeToSymbol(binding.rhs.callee, found.scope, 0);
				const constructed = symbol !== null && symbol.kind === "class" ? (this.classById.get(symbol.id) ?? null) : null;
				// (a31) Q2: a decorated class may have been replaced, so `x = Cls(); x.m()` is refused.
				return constructed !== null && this.hasReplacingDecorator(constructed) ? null : constructed;
			}
			return null;
		}
		// K1: the annotation of `*args: T` or `**kw: T` types the ELEMENTS, not the tuple or dict.
		if (binding.kind === "param" && binding.splat === undefined && binding.annotation && binding.annotationScope) {
			return this.resolveAnnotationClass(binding.annotation, binding.annotationScope);
		}
		return null;
	}

	// --- inheritance -------------------------------------------------------

	private resolveBaseClass(classInfo: ClassInfo, base: BaseRef): ClassInfo | null {
		if (base.callee === null) return null;
		const symbol = this.resolveCalleeToSymbol(base.callee, classInfo.parentScope, 0);
		if (symbol === null || symbol.kind !== "class") return null;
		return this.classById.get(symbol.id) ?? null;
	}

	/**
	 * GCLI-116 (DEC-303 (a47) item 2 (i)): a base that is an in-repo name whose resolution is `rebound` is not
	 * an external base, so a method missing from the known MRO is not credited to it (the (a34) D1 pattern).
	 */
	private baseIsRebound(classInfo: ClassInfo, base: BaseRef): boolean {
		const callee = base.callee;
		if (callee === null) return false;
		if (callee.kind === "name") {
			const outcome = this.resolveBareName(callee.name, classInfo.parentScope, 0);
			return outcome.kind === "multiply" || (outcome.kind === "unresolved" && outcome.reason === "rebound");
		}
		if (callee.kind === "attr" && callee.base.kind === "name") {
			const head = this.resolveBareName(callee.base.name, classInfo.parentScope, 0);
			if (head.kind !== "module" || head.path === null) return false;
			const outcome = this.resolveModuleChain(head.path, callee.segments, 0);
			return outcome.kind === "multiply" || (outcome.kind === "unresolved" && outcome.reason === "rebound");
		}
		return false;
	}

	/**
	 * GCLI-116 (DEC-303 (a49) item 1 (a)): the in-repo classes a base may be. One resolved class is the
	 * ordinary case; a multiply-bound base (Q2 alternatives) is every alternative, so a subclass still counts
	 * as a subclass of each one and the polymorphic flag does not drop because the base became multiply.
	 */
	private baseAlternatives(classInfo: ClassInfo, base: BaseRef): ClassInfo[] {
		const single = this.resolveBaseClass(classInfo, base);
		if (single !== null) return [single];
		const callee = base.callee;
		if (callee === null) return [];
		let symbols: readonly PythonSymbol[] = [];
		if (callee.kind === "name") {
			const outcome = this.resolveBareName(callee.name, classInfo.parentScope, 0);
			if (outcome.kind === "multiply") symbols = outcome.symbols;
		} else if (callee.kind === "attr" && callee.base.kind === "name") {
			const head = this.resolveBareName(callee.base.name, classInfo.parentScope, 0);
			if (head.kind === "module" && head.path !== null) {
				const outcome = this.resolveModuleChain(head.path, callee.segments, 0);
				if (outcome.kind === "multiply") symbols = outcome.symbols;
			}
		}
		const classes: ClassInfo[] = [];
		for (const symbol of symbols) {
			if (symbol.kind !== "class") continue;
			const info = this.classById.get(symbol.id);
			if (info !== undefined) classes.push(info);
		}
		return classes;
	}

	private computeMro(classInfo: ClassInfo): MroResult {
		if (classInfo.mro !== undefined) return classInfo.mro;
		if (this.computingMro.has(classInfo)) return { ok: false };
		this.computingMro.add(classInfo);
		try {
			const sequences: MroEntry[][] = [];
			const tail: MroEntry[] = [];
			for (let index = 0; index < classInfo.bases.length; index++) {
				const baseRef = classInfo.bases[index] as BaseRef;
				const baseClass = this.resolveBaseClass(classInfo, baseRef);
				if (baseClass !== null) {
					const baseMro = this.computeMro(baseClass);
					if (!baseMro.ok) {
						classInfo.mro = { ok: false };
						return classInfo.mro;
					}
					sequences.push(baseMro.entries);
					const entry: MroEntry = { kind: "class", info: baseClass, key: baseClass.id };
					tail.push(entry);
				} else {
					const entry: MroEntry = {
						kind: "opaque",
						name: baseRef.text,
						key: `opaque:${classInfo.id}:${index}`,
						...(this.baseIsRebound(classInfo, baseRef) ? { rebound: true as const } : {}),
					};
					sequences.push([entry]);
					tail.push(entry);
				}
			}
			sequences.push(tail);
			const merged = c3merge(sequences);
			if (merged === null) {
				classInfo.mro = { ok: false };
				return classInfo.mro;
			}
			classInfo.mro = { ok: true, entries: [{ kind: "class", info: classInfo, key: classInfo.id }, ...merged] };
			return classInfo.mro;
		} finally {
			this.computingMro.delete(classInfo);
		}
	}

	private firstMethodEntry(mro: MroResult, name: string): PythonSymbol[] | null {
		if (!mro.ok) return null;
		for (const entry of mro.entries) {
			if (entry.kind !== "class") continue;
			const ids = entry.info.methods.get(name);
			if (ids === undefined || ids.length === 0) continue;
			const symbols: PythonSymbol[] = [];
			for (const id of ids) {
				const symbol = this.symbolsById.get(id);
				if (symbol !== undefined) symbols.push(symbol);
			}
			if (symbols.length > 0) return symbols;
		}
		return null;
	}

	/**
	 * Rule 29a/37: a class has a non-default metaclass when it writes any
	 * `metaclass=` other than an unshadowed `type`. A shadowed or
	 * possibly-shadowed `type` (rule 37) keeps the note.
	 */
	private hasOwnMetaclass(classInfo: ClassInfo): boolean {
		if (classInfo.metaclassValue === "none") return false;
		if (classInfo.metaclassValue === "other") return true;
		return !this.isUnshadowedBuiltin("type", classInfo.parentScope, { line: classInfo.line, column: 1 });
	}

	private effectiveMetaclass(classInfo: ClassInfo, guard: Set<string> = new Set()): boolean {
		if (this.hasOwnMetaclass(classInfo)) return true;
		if (guard.has(classInfo.id)) return false;
		guard.add(classInfo.id);
		for (const base of classInfo.bases) {
			const baseClass = this.resolveBaseClass(classInfo, base);
			if (baseClass !== null && this.effectiveMetaclass(baseClass, guard)) return true;
		}
		return false;
	}

	private buildChildrenMap(): void {
		if (this.childrenMap !== null) return;
		const map = new Map<string, ClassInfo[]>();
		for (const classInfo of this.classById.values()) {
			for (const base of classInfo.bases) {
				for (const baseClass of this.baseAlternatives(classInfo, base)) {
					const list = map.get(baseClass.id);
					if (list === undefined) map.set(baseClass.id, [classInfo]);
					else if (!list.includes(classInfo)) list.push(classInfo);
				}
			}
		}
		this.childrenMap = map;
	}

	private descendantsOf(classInfo: ClassInfo): ClassInfo[] {
		const cached = this.descendantsCache.get(classInfo.id);
		if (cached !== undefined) return cached;
		this.buildChildrenMap();
		const children = this.childrenMap as Map<string, ClassInfo[]>;
		const seen = new Set<string>([classInfo.id]);
		const queue: ClassInfo[] = [classInfo];
		const out: ClassInfo[] = [];
		while (queue.length > 0) {
			const current = queue.pop() as ClassInfo;
			for (const child of children.get(current.id) ?? []) {
				if (seen.has(child.id)) continue;
				seen.add(child.id);
				out.push(child);
				queue.push(child);
			}
		}
		this.descendantsCache.set(classInfo.id, out);
		return out;
	}

	private hasSubclassOverride(classInfo: ClassInfo, name: string): boolean {
		for (const descendant of this.descendantsOf(classInfo)) {
			if (descendant.methods.has(name)) return true;
		}
		return false;
	}

	// --- method lookup -----------------------------------------------------

	private methodLookup(
		receiver: ClassInfo,
		name: string,
		fromSuper: boolean,
		polymorphicCheck: boolean,
	): CallResolution {
		const mro = this.computeMro(receiver);
		if (!mro.ok) return { bin: "receiver", reason: "mro-failed" };
		let start = 0;
		if (fromSuper) {
			const index = mro.entries.findIndex((entry) => entry.kind === "class" && entry.info === receiver);
			start = index < 0 ? 1 : index + 1;
		}
		let sawOpaque = false;
		let sawRebound = false;
		for (let index = start; index < mro.entries.length; index++) {
			const entry = mro.entries[index] as MroEntry;
			if (entry.kind === "opaque") {
				sawOpaque = true;
				if (entry.rebound === true) sawRebound = true;
				// (a31) item 5: an unshadowed builtin base earlier in the MRO that defines
				// the name wins, so the lookup resolves external, never a later in-repo entry.
				const builtinBase = this.builtinClassBaseName(entry);
				if (builtinBase !== null && BUILTIN_CLASS_DEFINED_NAMES.get(builtinBase)?.has(name) === true) {
					return { bin: "external", reason: "external-base" };
				}
				continue;
			}
			const ids = entry.info.methods.get(name);
			if (ids === undefined || ids.length === 0) {
				// DEC-303 (a31) D1: a class-scope binding of the name that is not a def (assign,
				// annotated, import, for, with, ...) is the class attribute, and it hides a
				// base's def: the lookup ends here unresolved rather than reaching the base.
				if (this.bindsNameWithoutDef(entry.info, name)) return { bin: "receiver", reason: "needs-inference" };
				continue;
			}
			const symbols: PythonSymbol[] = [];
			for (const id of ids) {
				const symbol = this.symbolsById.get(id);
				if (symbol !== undefined) symbols.push(symbol);
			}
			if (symbols.length === 0) continue;
			// Rule 43: only a class-scope rebinding (rule 36(i)) makes a call to the
			// def unresolved; a bare-used def still resolves, with its own receiver
			// withheld (rule 36(ii)).
			if (this.isReboundDef(entry.info, name)) return { bin: "receiver", reason: "needs-inference" };
			// Rule 10: a property is not callable as a plain attribute; calling it is
			// rule 6f (receiver needs inference), never an edge to the property.
			const callables = symbols.filter((symbol) => symbol.kind !== "property");
			if (callables.length === 0) return { bin: "receiver", reason: "needs-inference" };
			const polymorphic = !fromSuper && polymorphicCheck && this.hasSubclassOverride(receiver, name);
			const edges: EdgeSpec[] = callables.map((symbol) =>
				symbolEdge(symbol, "call", {
					externalBaseBefore: sawOpaque || undefined,
					polymorphic: polymorphic || undefined,
					multiplyBound: callables.length > 1 || undefined,
				}),
			);
			return { bin: "inRepo", edges, polymorphic, multiplyBound: callables.length > 1 };
		}
		// a rebound in-repo base may define the method: not found only in an external base
		if (sawRebound) return { bin: "receiver", reason: "rebound-base" };
		if (sawOpaque) return { bin: "external", reason: "external-base" };
		return { bin: "receiver", reason: "instance-attribute" };
	}

	// --- construction ------------------------------------------------------

	private construction(
		classInfo: ClassInfo,
		site: { file: string; line: number; column: number },
		options: { polymorphic?: boolean; multiplyBound?: boolean },
	): CallResolution {
		const classSymbol = this.symbolsById.get(classInfo.id);
		if (classSymbol === undefined) return { bin: "receiver", reason: "unresolved-class" };
		const edges: EdgeSpec[] = [
			symbolEdge(classSymbol, "new", {
				multiplyBound: options.multiplyBound || undefined,
				polymorphic: options.polymorphic || undefined,
			}),
		];
		const reasons: string[] = [];
		const mro = this.computeMro(classInfo);
		if (mro.ok) {
			const init = this.firstMethodEntry(mro, "__init__");
			if (this.firstMethodEntry(mro, "__new__") !== null) reasons.push("__new__");
			if (this.effectiveMetaclass(classInfo)) reasons.push("metaclass");
			if (init !== null) {
				for (const symbol of init) {
					edges.push(
						symbolEdge(symbol, "new", {
							multiplyBound: init.length > 1 || options.multiplyBound || undefined,
							polymorphic: options.polymorphic || undefined,
						}),
					);
				}
			} else if (mro.entries.some((entry) => entry.kind === "opaque")) {
				reasons.push("external-base-init");
			}
		} else {
			reasons.push("mro-failed");
		}
		if (reasons.length > 0) {
			this.notes.push({
				file: site.file,
				line: site.line,
				column: site.column,
				classId: classInfo.id,
				reasons: [...new Set(reasons)].sort(compareText),
			});
		}
		return {
			bin: "inRepo",
			edges,
			polymorphic: options.polymorphic === true,
			multiplyBound: options.multiplyBound === true,
		};
	}

	// --- call resolution ---------------------------------------------------

	resolveCall(call: RawCall): CallResolution {
		const site = { file: call.file, line: call.line, column: call.column };
		switch (call.callee.kind) {
			case "name":
				return this.resolveBareCall(call.callee.name, call.scope, site);
			case "attr":
				return this.resolveAttributeCall(call.callee, call.scope, site);
			default:
				// Rule 44: the `type` in `type(x)(...)` is a builtin test; a shadowed or
				// possibly-shadowed name is an ordinary call of whatever it binds.
				if (call.callee.typeInstance === true) {
					if (!this.isUnshadowedBuiltin("type", call.scope, site)) {
						return this.resolveBareCall("type", call.scope, site);
					}
					return { bin: "receiver", reason: "needs-inference" };
				}
				return { bin: "name", reason: "dynamic-callee" };
		}
	}

	private resolveBareCall(
		name: string,
		scope: Scope,
		site: { file: string; line: number; column: number },
	): CallResolution {
		// Rule 26: a classmethod's first parameter is the class whatever its name;
		// calling it constructs the enclosing class (rule 8).
		const receiver = this.receiverOf(name, scope);
		if (receiver !== null && receiver.kind === "class") {
			return this.construction(receiver.classInfo, site, {
				polymorphic: this.descendantsOf(receiver.classInfo).length > 0,
			});
		}
		const instanceCall = this.resolveInstanceCall(name, scope, site);
		if (instanceCall !== null) return instanceCall;
		const aliased = this.resolveAliasCall(name, scope, site);
		if (aliased !== null) return aliased;
		const outcome = this.resolveBareName(name, scope, 0, site);
		switch (outcome.kind) {
			case "symbol": {
				if (outcome.symbol.kind === "class") {
					const classInfo = this.classById.get(outcome.symbol.id);
					if (classInfo !== undefined) return this.construction(classInfo, site, {});
					return {
						bin: "inRepo",
						edges: [symbolEdge(outcome.symbol, "new")],
						polymorphic: false,
						multiplyBound: false,
					};
				}
				return { bin: "inRepo", edges: [symbolEdge(outcome.symbol, "call")], polymorphic: false, multiplyBound: false };
			}
			case "module":
				return { bin: "name", reason: "module-called" };
			case "external":
				return { bin: "external", reason: "external" };
			case "runtime":
				return { bin: "name", reason: outcome.reason };
			case "unresolved":
				return { bin: "name", reason: outcome.reason };
			case "multiply":
				return this.multiplyCall(outcome.symbols, site);
		}
	}

	/**
	 * Rule 25: each in-repository class alternative is a full construction (rule 8), so it gets an edge to
	 * the class and one to its resolved `__init__`; every edge is flagged multiplyBound and the site is one.
	 * Shared by a bare name and a module attribute (GCLI-116).
	 */
	private multiplyCall(
		symbols: readonly PythonSymbol[],
		site: { file: string; line: number; column: number },
	): CallResolution {
		const edges: EdgeSpec[] = [];
		for (const symbol of symbols) {
			if (symbol.kind === "class") {
				const classInfo = this.classById.get(symbol.id);
				if (classInfo !== undefined) {
					const resolved = this.construction(classInfo, site, { multiplyBound: true });
					if (resolved.bin === "inRepo") edges.push(...resolved.edges);
				} else {
					edges.push(symbolEdge(symbol, "new", { multiplyBound: true }));
				}
			} else {
				edges.push(symbolEdge(symbol, "call", { multiplyBound: true }));
			}
		}
		if (edges.length > 0) return { bin: "inRepo", edges, polymorphic: false, multiplyBound: true };
		return { bin: "external", reason: "external" };
	}

	private resolveAttributeCall(
		callee: { base: BaseDesc; segments: string[] },
		scope: Scope,
		site: { file: string; line: number; column: number },
	): CallResolution {
		const { base, segments } = callee;
		if (segments.length === 0) return { bin: "receiver", reason: "needs-inference" };
		const lastName = segments[segments.length - 1] as string;
		if (base.kind === "literal") {
			// Rule 29c: a literal written directly as the receiver has a type fixed by
			// syntax, so its method is a builtin (external) without inference.
			return { bin: "external", reason: "external" };
		}
		if (base.kind === "dynamic") return { bin: "receiver", reason: "needs-inference" };
		if (base.kind === "constructed") return this.resolveConstructedCall(base.callee, segments, scope, site);
		if (base.kind === "super") {
			// Rule 44: `super` is a builtin test; a shadowed or possibly-shadowed name
			// is an ordinary call, so its result is a dynamic receiver (rule 6f).
			if (!this.isUnshadowedBuiltin("super", scope, site)) {
				return { bin: "receiver", reason: "needs-inference" };
			}
			return this.resolveSuper(base, segments, scope);
		}
		// Rule 26: the first parameter of a method is the receiver whatever its name.
		const receiver = this.receiverOf(base.name, scope);
		if (receiver !== null) {
			if (segments.length > 1) return { bin: "receiver", reason: "needs-inference" };
			return this.methodLookup(receiver.classInfo, lastName, false, true);
		}
		// Rule 24: an attribute call on a name bound directly by an import of an
		// external module or name is external; a value computed from one is not.
		if (this.isExternalImportReceiver(base.name, scope, site)) return { bin: "external", reason: "external" };
		// Rule 6d: a known-class binding.
		const known = this.knownClassOf(base.name, scope, site);
		if (known !== null) {
			if (segments.length > 1) return { bin: "receiver", reason: "needs-inference" };
			return this.methodLookup(known, lastName, false, true);
		}
		// R4 (DEC-303 (a22) item 3): a local whose every binding is `Cls(...)` of one class.
		if (segments.length === 1) {
			const local = this.localConstructedClass(base.name, scope, site);
			if (local !== null) return this.methodLookup(local, lastName, false, true);
		}
		// TS (DEC-303 (a22) item 3, (a23)): a local whose one binding is `type(self)` or `self.__class__`.
		if (segments.length === 1) {
			const own = this.localClassOfReceiver(base.name, scope, site);
			if (own !== null) return this.methodLookup(own, lastName, false, true);
		}
		// M1 (DEC-303 (a22) item 3): an imported module-level instance of one in-repo class.
		if (segments.length === 1) {
			const instance = this.importedInstanceClass(base.name, scope, site);
			if (instance !== null) return this.methodLookup(instance, lastName, false, true);
		}
		// K1 (DEC-303 (a22) item 3): `*args` is a tuple and `**kwargs` a dict, so a method
		// called on one is the builtin's. The name must have exactly one binding in
		// its scope chain (a rebind, or a nonlocal write from a nested scope, is a
		// second binding and leaves the site unresolved).
		if (segments.length === 1 && this.isSplatParameter(base.name, scope, site)) {
			return { bin: "external", reason: "external" };
		}
		// LIT (DEC-303 (a22) item 3): every binding is a literal or comprehension of one builtin type.
		if (segments.length === 1 && this.isLiteralBound(base.name, scope, site)) {
			return { bin: "external", reason: "external" };
		}
		const outcome = this.resolveBareName(base.name, scope, 0, site);
		switch (outcome.kind) {
			case "module":
				if (outcome.path === null) return { bin: "external", reason: "external-module" };
				return this.moduleClassMemberCall(outcome.path, segments) ?? this.moduleCall(outcome.path, segments, site);
			case "symbol": {
				if (outcome.symbol.kind === "class" && segments.length === 1) {
					const classInfo = this.classById.get(outcome.symbol.id);
					if (classInfo !== undefined) return this.methodLookup(classInfo, lastName, false, true);
				}
				return { bin: "receiver", reason: "needs-inference" };
			}
			case "external":
				// K1: an unshadowed builtin class used as the receiver is the builtin
				// (`int.from_bytes`, `dict.fromkeys`); `type` is not on the list, and a
				// builtin function (`len`) is not a class.
				// The outcome can be external through an alias (`int = type`), so the name itself must be the unshadowed builtin.
				if (segments.length === 1 && isBuiltinClassName(base.name) && this.isUnshadowedBuiltin(base.name, scope, site))
					return { bin: "external", reason: "external" };
				return { bin: "receiver", reason: "needs-inference" };
			case "runtime":
			case "unresolved":
			case "multiply":
				return { bin: "receiver", reason: "needs-inference" };
		}
	}

	/**
	 * The bindings every use of `name` at `site` can see, when the whole set is enumerable
	 * from the text (DEC-303 (a22) item 2); null when it is not. A name bound anywhere in
	 * the starting class body is read from the class or the globals, never from an enclosing
	 * function (rule 38 would fall through past a later import). A `global name` in a scope
	 * between the use and the scope holding the bindings makes the read a module-level one,
	 * which `lookupBindings` does not consult, unless the bindings ARE the module's. Writes
	 * through `global` and `nonlocal` from other scopes were moved onto the target scope by
	 * `applyScopeRedirects`, so they are in the list.
	 */
	private enumerableBindings(name: string, scope: Scope, site: { line: number; column: number }): RawBinding[] | null {
		if (scope.kind === "class" && scope.bindings.has(name)) return null;
		const found = this.lookupBindings(name, scope, site);
		if (found === null) return null;
		// A `from m import *` at module level is a binding statement in the module's own
		// text that `importStatementNames` does not record, and its export set is not
		// enumerable here: refuse on any star import of the module.
		if (found.scope.kind === "module" && this.starMayBind(found.scope.file)) return null;
		if (found.scope.kind !== "module") {
			for (let current: Scope | null = scope; current !== null && current !== found.scope; current = current.parent) {
				if (current.globalNames.has(name)) return null;
			}
		}
		return found.bindings;
	}

	/**
	 * Any module-level star import in the module at `file` may bind `name`. The export set
	 * of a complete star is not trusted: for a target without `__all__` it is built from
	 * `collectModuleDeclaration`, which misses a `for` or with-as target, a walrus, a match
	 * capture, a list or nested or starred target and a `global` write, so "complete" does
	 * not mean every name the star can bind. Rules 37 and K1's builtin arm share that gap
	 * (a follow-up); LIT does not rely on it.
	 */
	private starMayBind(file: string): boolean {
		return (this.starBindingsByPath.get(file)?.length ?? 0) > 0;
	}

	/**
	 * M1 (DEC-303 (a22) item 3): `name` is bound exactly once in its own scope, by
	 * `from m import inst` (alias allowed) of a MODULE FILE `m` (a package `__init__`
	 * stays unresolved, A4), and `inst` is bound exactly once in `m`'s module scope, by a
	 * plain unannotated `inst = Cls(...)` whose callee resolves, from `m`, to one in-repo
	 * class that passes `instanceClassOf` (an ok MRO, no `__new__` or metaclass, not
	 * replaced by a decorator). Both enumerations are item 2's: a second binding in either
	 * module, a `global` write from a function of `m`, or a module-level star import in
	 * either module leaves the call unresolved. A write from outside `m` (`m.inst = ...`)
	 * is the accepted blind spot, as is a `globals()[...]` or `setattr` write. The constructor
	 * name is resolved by `moduleClassSymbol`, whose enumeration of `m`'s module scope refuses a
	 * module-level star import there (so a star cannot rebind `inst` either). Only a direct import
	 * (the import's source module is the defining file) and a bare-name constructor qualify. The
	 * module-attribute form `m.inst.f()` is ruled OUT (DEC-303 (a37)).
	 */
	private importedInstanceClass(name: string, scope: Scope, site: { line: number; column: number }): ClassInfo | null {
		const bindings = this.enumerableBindings(name, scope, site);
		if (bindings === null || bindings.length !== 1) return null;
		const direct = this.directFromImport(bindings[0] as RawBinding);
		if (direct === null) return null;
		const defining = this.moduleScopesByPath.get(direct.target);
		if (defining === undefined) return null;
		const defined = defining.bindings.get(direct.name);
		if (defined === undefined || defined.length !== 1) return null;
		const instance = defined[0] as RawBinding;
		if (instance.kind !== "assign" || instance.annotation || instance.rhs?.kind !== "call") return null;
		// F2, F3: a bare-name constructor only. A dotted callee (`Outer.Inner()`, `k.C()`) is
		// looked up by qualname with no binding count, so it stays unresolved here.
		if (instance.rhs.callee.kind !== "name") return null;
		const symbol = this.moduleClassSymbol(instance.rhs.callee.name, defining);
		return this.instanceClassOf(symbol);
	}

	/**
	 * R4 (DEC-303 (a22) item 3): `name` is a LOCAL (found in a function scope; a lambda can hold a walrus or a comprehension target, neither an assign with a call right-hand side, so the lambda arm would refuse anyway) whose
	 * bindings are ALL plain unannotated `name = Cls(...)` (the single-binding case is rule 6d's,
	 * which runs first and which this rule never widens), each with a callee that is a bare name
	 * resolving (`classSymbolOfName`, counting the constructor name's own bindings) to the SAME one
	 * in-repo class that passes `instanceClassOf`. A single binding is rule 6d's. The enumeration is
	 * item 2's: writes through `nonlocal` from nested scopes are in the list (each read in the
	 * scope whose text holds it, `origin`), and a `global` declaration between the use and the local
	 * refuses. Any other binding form (parameter, for, with-as, except-as, walrus, import, def,
	 * class, augmented, annotated, tuple or star target, match capture) is not an `assign` with an
	 * unannotated call right-hand side and refuses.
	 */
	private localConstructedClass(name: string, scope: Scope, site: { line: number; column: number }): ClassInfo | null {
		const found = this.lookupBindings(name, scope, site);
		if (found === null || found.scope.kind !== "function") return null;
		const bindings = this.enumerableBindings(name, scope, site);
		if (bindings === null) return null;
		let symbolId: string | null = null;
		let symbol: PythonSymbol | null = null;
		for (const binding of bindings) {
			if (binding.annotation || binding.rhs?.kind !== "call") return null;
			if (binding.rhs.callee.kind !== "name") return null;
			const constructed = this.classSymbolOfName(binding.rhs.callee.name, binding.origin ?? found.scope, {
				line: 0,
				column: 0,
			});
			if (constructed === null) return null;
			if (symbolId !== null && constructed.id !== symbolId) return null;
			symbolId = constructed.id;
			symbol = constructed;
		}
		return this.instanceClassOf(symbol);
	}

	/**
	 * TS (DEC-303 (a22) item 3, (a23)): `name` is a LOCAL with exactly ONE binding (item 2's
	 * enumeration), a plain unannotated assignment of `type(x)` or `x.__class__` where `x` is the
	 * receiver parameter of an enclosing instance method (rule 26) and, for `type(x)`, `type` is the
	 * unshadowed builtin. The local is then the receiver's class, so `name.meth()` is looked up as
	 * `cls.meth()` is, on the enclosing class's MRO with the same polymorphic flag. A classmethod's
	 * `type(cls)` is its metaclass and is refused.
	 */
	private localClassOfReceiver(name: string, scope: Scope, site: { line: number; column: number }): ClassInfo | null {
		const found = this.lookupBindings(name, scope, site);
		if (found === null || found.scope.kind !== "function") return null;
		const bindings = this.enumerableBindings(name, scope, site);
		if (bindings === null || bindings.length !== 1) return null;
		const binding = bindings[0] as RawBinding;
		if (binding.kind !== "assign" || binding.annotation) return null;
		if (binding.rhs?.kind !== "classof") return null;
		if (binding.rhs.viaType && !this.isUnshadowedBuiltin("type", found.scope)) return null;
		const receiver = this.receiverOf(binding.rhs.receiver, found.scope);
		if (receiver === null || receiver.kind !== "instance") return null;
		// (a23) item 3, (a55) item 3: a class on the MRO that defines `__class__` (an attribute, a
		// property or a method) leaves `self.__class__` unresolved; `type(self)` does not consult it.
		if (!binding.rhs.viaType) {
			const mro = this.computeMro(receiver.classInfo);
			if (!mro.ok) return null;
			for (const entry of mro.entries) {
				if (entry.kind === "class" && entry.info.scope?.bindings.has("__class__") === true) return null;
			}
		}
		return receiver.classInfo;
	}

	/**
	 * The one in-repo class symbol a module-scope name denotes (B2, review round 2): the name has
	 * exactly ONE binding in `module` (item 2's enumeration, not S3's incomplete local-name set),
	 * and that binding is either a `class` statement, or a direct from-import of a name that is
	 * itself bound exactly once, by a `class` statement, in the file the import names. A
	 * re-export hop, a conditional import and a package `__init__` are refused.
	 */
	private moduleClassSymbol(name: string, module: Scope): PythonSymbol | null {
		return this.classSymbolOfName(name, module, { line: 0, column: 0 });
	}

	/** `moduleClassSymbol` for a name read from any scope: item 2's enumeration decides the one binding. */
	private classSymbolOfName(name: string, module: Scope, site: { line: number; column: number }): PythonSymbol | null {
		const own = this.enumerableBindings(name, module, site);
		if (own === null || own.length !== 1) return null;
		const binding = own[0] as RawBinding;
		if (binding.kind === "class") {
			return binding.symbolId !== undefined ? (this.symbolsById.get(binding.symbolId) ?? null) : null;
		}
		const direct = this.directFromImport(binding);
		if (direct === null) return null;
		const sourceScope = this.moduleScopesByPath.get(direct.target);
		if (sourceScope === undefined) return null;
		const inner = this.enumerableBindings(direct.name, sourceScope, { line: 0, column: 0 });
		if (inner === null || inner.length !== 1) return null;
		const defined = inner[0] as RawBinding;
		if (defined.symbolId === undefined) return null;
		return this.symbolsById.get(defined.symbolId) ?? null;
	}

	/**
	 * A binding that is an unconditional, resolved `from m import n` (relative allowed) where `m`
	 * is the module FILE that holds `n` (no re-export hop: the hop module's own bindings are not
	 * enumerated), not a package `__init__` (A4), and `n` is not a submodule.
	 */
	private directFromImport(binding: RawBinding): { target: string; name: string } | null {
		const imported = binding.kind === "import" ? (binding.importBinding ?? null) : null;
		if (imported === null) return null;
		if (imported.outcome !== "resolved" || imported.target === null) return null;
		if (imported.name === null || imported.name === "*" || imported.condition !== null) return null;
		const target = imported.target;
		if (target.endsWith("/__init__.py") || target === "__init__.py") return null;
		// B1: when the import's source module is not the file that binds the name, S3 followed a
		// re-export hop. Also refuses `from pkg import n` where pkg/__init__.py re-exports (F4).
		if (this.sourceModuleFile(imported) !== target) return null;
		return { target, name: imported.name };
	}

	/**
	 * ALIAS (DEC-303 (a23) item 2): a bare call of a LOCAL (found in a function scope) with exactly ONE
	 * binding, a plain unannotated `name = B.attr` (a name, one segment), where `B.attr` itself resolves
	 * to an in-repo definition as it does when called directly: `B` a module bound by a plain `import`
	 * and `attr` a def or class bound exactly once in that module file, or `B` a class (`classSymbolOfName`)
	 * whose `attr` the A2 lookup (`methodLookup`) resolves. Item 2's enumeration counts the local (a
	 * nonlocal write from a nested scope is a second binding), `B` in the scope holding the alias, and
	 * `attr` in the module file that defines it; a re-export hop, a star, a conditional or from-import of
	 * the module, an external module or a chain deeper than one segment stays unresolved. null when not an alias.
	 */
	private resolveAliasCall(
		name: string,
		scope: Scope,
		site: { file: string; line: number; column: number },
	): CallResolution | null {
		const found = this.lookupBindings(name, scope, site);
		if (found === null || found.scope.kind !== "function") return null;
		const bindings = this.enumerableBindings(name, scope, site);
		if (bindings === null || bindings.length !== 1) return null;
		const binding = bindings[0] as RawBinding;
		if (binding.annotation || binding.rhs?.kind !== "attr") return null;
		const callee = binding.rhs.callee;
		if (callee.kind !== "attr" || callee.base.kind !== "name" || callee.segments.length !== 1) return null;
		// A binding moved here from a nested scope by `nonlocal` is refused (kept under DEC-303 (a40) item 4).
		// Since GCLI-115 a `del f` is a recorded binding, so it no longer alone makes this the single binding,
		// but a moved write may still not be the last one assigned (round 2 review of GCLI-113).
		if (binding.origin !== undefined) return null;
		const holder = found.scope;
		const baseName = callee.base.name;
		const attr = callee.segments[0] as string;
		const here = { line: 0, column: 0 };
		const classSymbol = this.classSymbolOfName(baseName, holder, here);
		if (classSymbol !== null) {
			const classInfo = this.classById.get(classSymbol.id);
			if (classInfo === undefined) return null;
			const resolved = this.methodLookup(classInfo, attr, false, true);
			return resolved.bin === "inRepo" ? resolved : null;
		}
		const baseBindings = this.enumerableBindings(baseName, holder, here);
		if (baseBindings === null || baseBindings.length !== 1) return null;
		const baseBinding = baseBindings[0] as RawBinding;
		const baseImport = baseBinding.kind === "import" ? (baseBinding.importBinding ?? null) : null;
		if (baseImport === null || baseImport.kind !== "import" || baseImport.condition !== null) return null;
		const imported = this.resolveImportBinding(baseImport);
		if (imported.kind !== "module" || imported.path === null) return null;
		const moduleScope = this.moduleScopesByPath.get(imported.path);
		if (moduleScope === undefined) return null;
		const defined = this.enumerableBindings(attr, moduleScope, here);
		if (defined === null || defined.length !== 1) return null;
		const definition = defined[0] as RawBinding;
		if (definition.symbolId === undefined) return null; // only a def or a class statement carries a symbol
		const symbol = this.symbolsById.get(definition.symbolId);
		if (symbol === undefined) return null;
		return this.moduleAttrToResolution({ kind: "symbol", symbol }, site);
	}

	/** K1: `name` is bound exactly once in its scope chain, by a `*args` or `**kwargs` parameter. */
	private isSplatParameter(name: string, scope: Scope, site: { line: number; column: number }): boolean {
		const bindings = this.enumerableBindings(name, scope, site);
		if (bindings === null || bindings.length !== 1) return false;
		const binding = bindings[0] as RawBinding;
		return binding.kind === "param" && binding.splat !== undefined;
	}

	/**
	 * LIT (DEC-303 (a22) item 3): every binding of `name` is a literal or comprehension of
	 * ONE builtin type, so a method called on it is the builtin's. An annotated binding is
	 * refused (an annotation can name an in-repo class), and so is any binding that is not a
	 * plain assignment of a literal: a rebind, an augmented assignment, a parameter, an
	 * import, a def or a class.
	 */
	private isLiteralBound(name: string, scope: Scope, site: { line: number; column: number }): boolean {
		const bindings = this.enumerableBindings(name, scope, site);
		if (bindings === null || bindings.length === 0) return false;
		let type: string | null = null;
		for (const binding of bindings) {
			// only a plain assignment carries a literal right-hand side; a rebind, parameter, import, def or class has none
			if (binding.annotation || binding.rhs === undefined || binding.rhs.kind !== "literal") return false;
			if (type !== null && binding.rhs.type !== type) return false;
			type = binding.rhs.type;
		}
		return true;
	}

	/**
	 * E1 (DEC-303 (a22) item 3, (a29) Q3): `Cls(...).m()` calls `m` on a fresh
	 * instance of `Cls` when the callee is a plain name, or a dotted name rooted at
	 * a MODULE (`mod.Cls(...)`), that resolves through the binding enumeration of
	 * a bare call to exactly one in-repo class. A nested-class callee
	 * (`Outer.Inner(...)`) stays unresolved, as `Outer.Inner()` alone does. The
	 * class must pass `instanceClassOf`; one segment only (`Cls().a.m()` stays
	 * unresolved).
	 */
	private resolveConstructedCall(
		callee: CalleeDesc,
		segments: readonly string[],
		scope: Scope,
		site: { file: string; line: number; column: number },
	): CallResolution {
		const unresolved: CallResolution = { bin: "receiver", reason: "needs-inference" };
		if (segments.length !== 1) return unresolved;
		let symbol: PythonSymbol | null = null;
		if (callee.kind === "name") {
			symbol = this.resolveCalleeToSymbol(callee, scope, 0, site);
		} else if (callee.kind === "attr" && callee.base.kind === "name") {
			const base = this.resolveBareName(callee.base.name, scope, 0, site);
			if (base.kind !== "module" || base.path === null) return unresolved;
			const outcome = this.resolveModuleChain(base.path, callee.segments, 0);
			symbol = outcome.kind === "symbol" ? outcome.symbol : null;
		}
		const classInfo = this.instanceClassOf(symbol);
		if (classInfo === null) return unresolved;
		return this.methodLookup(classInfo, segments[0] as string, false, true);
	}

	/**
	 * The class whose instance `Cls(...)` is, when the construction is known to
	 * return one: an ok MRO, no `__new__` in it, no non-default metaclass, and no
	 * opaque MRO entry. An opaque base can define `__new__` or carry a metaclass
	 * whose `__call__` changes what the call returns, so those two checks cannot be
	 * completed past it and the site fails closed (DEC-303 (a29) Q2). A base that
	 * is an unshadowed builtin CLASS name (BUILTIN_INSTANCE_CLASSES or a builtin
	 * exception class) whose constructor returns an instance of the subclass being
	 * constructed (not `type`, not `reversed`, not a builtin function) is not
	 * opaque for this purpose (DEC-303 (a30)). A class with a decorator that is not
	 * on NON_REPLACING_CLASS_DECORATORS is refused too: it may have been replaced
	 * (DEC-303 (a31) Q2). Decorators on a BASE class are not read (not measured).
	 */
	private instanceClassOf(symbol: PythonSymbol | null): ClassInfo | null {
		if (symbol === null || symbol.kind !== "class") return null;
		const classInfo = this.classById.get(symbol.id);
		if (classInfo === undefined) return null;
		const mro = this.computeMro(classInfo);
		if (!mro.ok) return null;
		if (this.hasReplacingDecorator(classInfo)) return null;
		if (this.firstMethodEntry(mro, "__new__") !== null || this.effectiveMetaclass(classInfo)) return null;
		for (const entry of mro.entries) {
			if (entry.kind === "opaque" && !this.isBuiltinClassBase(entry)) return null;
		}
		return classInfo;
	}

	/**
	 * An opaque MRO entry written as a plain name that is a builtin CLASS from
	 * BUILTIN_INSTANCE_CLASSES or a builtin exception class, unshadowed at the
	 * position of the class that writes it (the owner's scope, not the call site's).
	 */
	private isBuiltinClassBase(entry: MroEntry & { kind: "opaque" }): boolean {
		return this.builtinClassBaseName(entry) !== null;
	}

	/** The builtin class name behind {@link isBuiltinClassBase}, or null. */
	private builtinClassBaseName(entry: MroEntry & { kind: "opaque" }): string | null {
		const parts = entry.key.split(":");
		const index = Number(parts[parts.length - 1]);
		const owner = this.classById.get(parts.slice(1, -1).join(":"));
		const base = owner?.bases[index];
		if (owner === undefined || base === undefined || base.callee === null || base.callee.kind !== "name") return null;
		const name = base.callee.name;
		if (!isBuiltinInstanceClassName(name)) return null;
		return this.isUnshadowedBuiltin(name, owner.parentScope, { line: owner.line, column: 1 }) ? name : null;
	}

	/**
	 * N3 (DEC-303 (a22) item 3): `x = Cls(); x()` calls `type(x).__call__`,
	 * found on the MRO of `Cls`. The name must have exactly one binding anywhere
	 * it is visible, as the walker records bindings (the enumeration a bare call
	 * uses: assign, annotated, augmented, walrus, for, with, except-as, import, def,
	 * class, and a global or nonlocal write in the common shapes; the known holes
	 * are tracked in GCLI-101), and that binding is an assignment whose right-hand
	 * side is a construction. The class must pass `instanceClassOf` (ok MRO, no
	 * `__new__`, no metaclass, no opaque base past the builtin classes). A class
	 * with no `__call__` of its own or inherited is not resolved here.
	 *
	 * A refused site (DEC-303 (a31) Q1) returns `null` and keeps the bin it had
	 * before N3, name / run-time-bound, never receiver-needs-inference.
	 */
	private resolveInstanceCall(
		name: string,
		scope: Scope,
		site: { file: string; line: number; column: number },
	): CallResolution | null {
		const found = this.lookupBindings(name, scope, site);
		if (found === null || found.bindings.length !== 1) return null;
		const binding = found.bindings[0] as RawBinding;
		if (binding.kind !== "assign" || binding.rhs === undefined || binding.rhs.kind !== "call") return null;
		const classInfo = this.instanceClassOf(this.resolveCalleeToSymbol(binding.rhs.callee, found.scope, 0));
		if (classInfo === null) return null;
		const resolved = this.methodLookup(classInfo, "__call__", false, true);
		return resolved.bin === "inRepo" ? resolved : null;
	}

	/**
	 * A2 (DEC-303 (a22) item 3, GCLI-117): `m.C.meth(...)` where every segment before the last resolves,
	 * as a direct `m.C` does, to ONE in-repo class, resolves as the bare-class `C.meth(...)` lookup does
	 * (`methodLookup`). Only an in-repo edge is taken: any other outcome (an unknown attribute, a rebound
	 * class name, an opaque base, a property) returns null so the ordinary module-chain resolution and its
	 * bin stand unchanged. A chain through a submodule (`m.sub.f`) is a module, not a class, and is not this path.
	 */
	private moduleClassMemberCall(path: string, segments: readonly string[]): CallResolution | null {
		if (segments.length < 2) return null;
		const holderChain = segments.slice(0, -2);
		const holder =
			holderChain.length === 0 ? { kind: "module" as const, path } : this.resolveModuleChain(path, holderChain, 0);
		if (holder.kind !== "module" || holder.path === null) return null;
		// A submodule named like the class: the module walk (`moduleCall`) takes the submodule before
		// the attribute's own binding gate would be reached, so the old resolution stands.
		const holderName = this.pathToModule.get(holder.path);
		const classSegment = segments[segments.length - 2] as string;
		// The module walk also steps through a single-portion namespace directory (`pkg/X/foo.py` with no
		// `pkg/X/__init__.py`), which `modulePathByName` does not list; it takes the same precedence.
		const sub =
			holderName === undefined ? undefined : holderName === "" ? classSegment : `${holderName}.${classSegment}`;
		if (sub !== undefined && (this.modulePathByName.has(sub) || this.namespaceDirByName.has(sub))) return null;
		// INTERIM (DEC-303 (a52) item 1, retired by GCLI-118): `resolveModuleAttribute` takes the FIRST import
		// binding of the class name and never reads the holder's other bindings, so a rebind (`C = None`,
		// `del C`, a for, with or walrus target, a global write, a second import in a try/except, a star
		// import that may bind it) would still draw an edge here. This path therefore needs exactly ONE
		// module-scope binding of the class name, counted as item 2 counts it (`enumerableBindings`). Left to
		// the general hop reading of GCLI-118, whose (a44) rules then apply to this path too.
		const holderScope = this.moduleScopesByPath.get(holder.path);
		if (holderScope === undefined) return null;
		const own = this.enumerableBindings(classSegment, holderScope, { line: 0, column: 0 });
		// A bare annotation (N4) and a comprehension iteration target (N1) bind no module name, so they are not counted.
		if (own === null || own.filter((binding) => binding.bare !== true && binding.comprehension !== true).length !== 1) {
			return null;
		}
		const prefix = this.resolveModuleChain(path, segments.slice(0, -1), 0);
		if (prefix.kind !== "symbol" || prefix.symbol.kind !== "class") return null;
		const classInfo = this.classById.get(prefix.symbol.id);
		if (classInfo === undefined) return null;
		const resolved = this.methodLookup(classInfo, segments[segments.length - 1] as string, false, true);
		return resolved.bin === "inRepo" ? resolved : null;
	}

	private moduleCall(
		path: string,
		segments: readonly string[],
		site: { file: string; line: number; column: number },
	): CallResolution {
		const outcome = this.resolveModuleChain(path, segments, 0);
		return this.moduleAttrToResolution(outcome, site);
	}

	private moduleAttrToResolution(
		outcome: ModuleAttrOutcome,
		site: { file: string; line: number; column: number },
	): CallResolution {
		switch (outcome.kind) {
			case "symbol": {
				if (outcome.symbol.kind === "class") {
					const classInfo = this.classById.get(outcome.symbol.id);
					if (classInfo !== undefined) return this.construction(classInfo, site, {});
					return {
						bin: "inRepo",
						edges: [symbolEdge(outcome.symbol, "new")],
						polymorphic: false,
						multiplyBound: false,
					};
				}
				return { bin: "inRepo", edges: [symbolEdge(outcome.symbol, "call")], polymorphic: false, multiplyBound: false };
			}
			case "multiply":
				return this.multiplyCall(outcome.symbols, site);
			case "module":
				return { bin: "name", reason: "module-called" };
			case "external":
				return { bin: "external", reason: "external" };
			case "unresolved":
				return { bin: "name", reason: outcome.reason };
		}
	}

	private resolveSuper(base: BaseDesc & { kind: "super" }, segments: readonly string[], scope: Scope): CallResolution {
		let enclosing = scope.kind === "function" ? scope.enclosingClass : null;
		if (base.argCount === 2 && base.firstArg !== null) {
			const symbol = this.resolveCalleeToSymbol(base.firstArg, scope, 0);
			if (symbol !== null && symbol.kind === "class") {
				const classInfo = this.classById.get(symbol.id);
				if (classInfo !== undefined) enclosing = classInfo;
			}
		}
		if (enclosing === null) return { bin: "receiver", reason: "needs-inference" };
		if (segments.length !== 1) return { bin: "receiver", reason: "needs-inference" };
		return this.methodLookup(enclosing, segments[0] as string, true, false);
	}

	resolveDecoratorSite(site: RawDecoratorSite): EdgeSpec | null {
		const symbol = this.resolveCalleeToSymbol(site.callee, site.scope, 0, {
			line: site.line,
			column: site.column,
		});
		if (symbol === null) return null;
		return symbolEdge(symbol, "decorator");
	}
}

function c3merge(sequences: readonly MroEntry[][]): MroEntry[] | null {
	const lists = sequences.map((sequence) => [...sequence]).filter((list) => list.length > 0);
	const result: MroEntry[] = [];
	while (lists.some((list) => list.length > 0)) {
		let candidate: MroEntry | null = null;
		for (const list of lists) {
			const head = list[0];
			if (head === undefined) continue;
			let inTail = false;
			for (const other of lists) {
				for (let index = 1; index < other.length; index++) {
					if ((other[index] as MroEntry).key === head.key) {
						inTail = true;
						break;
					}
				}
				if (inTail) break;
			}
			if (!inTail) {
				candidate = head;
				break;
			}
		}
		if (candidate === null) return null;
		result.push(candidate);
		for (const list of lists) {
			if (list.length > 0 && (list[0] as MroEntry).key === candidate.key) list.shift();
		}
	}
	return result;
}

// --- entry point -----------------------------------------------------------

function bySite(
	a: { file: string; line: number; column: number },
	b: { file: string; line: number; column: number },
): number {
	return compareText(a.file, b.file) || a.line - b.line || a.column - b.column;
}

function compareSites(a: PythonCallSite, b: PythonCallSite): number {
	return (
		bySite(a, b) ||
		compareText(a.kind, b.kind) ||
		compareText(a.calleeId ?? "", b.calleeId ?? "") ||
		compareText(a.callerId ?? "", b.callerId ?? "")
	);
}

function compareSymbols(a: PythonSymbol, b: PythonSymbol): number {
	return compareText(a.file, b.file) || a.line - b.line || a.column - b.column || compareText(a.name, b.name);
}

interface ReasonAccumulator {
	count: number;
	firstSites: NamedSite[];
}

function addReason(map: Map<string, ReasonAccumulator>, reason: string, site: NamedSite): void {
	const existing = map.get(reason);
	if (existing === undefined) {
		map.set(reason, { count: 1, firstSites: [site] });
		return;
	}
	existing.count++;
	if (existing.firstSites.length < FIRST_SITES_LIMIT) existing.firstSites.push(site);
}

function toReasonCounts(map: Map<string, ReasonAccumulator>): ReasonCount[] {
	return [...map.entries()]
		.sort((a, b) => compareText(a[0], b[0]))
		.map(([reason, accumulator]) => ({
			reason,
			count: accumulator.count,
			firstSites: accumulator.firstSites.sort(bySite),
		}));
}

/**
 * Resolve every Python call expression over the given files (rule 1-22).
 *
 * Same inputs as S3 and S4: repository-relative `{ path, bytes }` files and the
 * module-graph options. Pure: no filesystem, cache or CLI surface. Each file is
 * parsed once, its symbols, scopes and classes are collected, and the tree is
 * freed before cross-file resolution runs.
 */
export async function analyzePythonCalls(
	files: readonly PythonModuleInput[],
	options: ModuleGraphOptions = {},
): Promise<PythonCallsResult> {
	const graph = await buildModuleGraph(files, options);

	const bytesByPath = new Map<string, Uint8Array>();
	for (const file of files) {
		const path = normalizeInputPath(file.path);
		if (!bytesByPath.has(path)) bytesByPath.set(path, file.bytes);
	}

	const allSymbols: PythonSymbol[] = [];
	const allClasses: ClassInfo[] = [];
	const allCalls: RawCall[] = [];
	const allDecoratorSites: RawDecoratorSite[] = [];
	const allScopes: Scope[] = [];
	const errorFiles: string[] = [];
	/** Per-file dropped call expressions, for `parseErrorFiles` (DEC-303 (a15) 19). */
	const droppedByPath = new Map<string, number>();
	let droppedCalls = 0;

	const paths = [...graph.modules.map((module) => module.path)].sort(compareText);
	for (const path of paths) {
		const bytes = bytesByPath.get(path);
		if (bytes === undefined) continue;
		const bindingsByKey = new Map<string, ImportBinding>();
		for (const file of graph.files) {
			if (file.path !== path) continue;
			for (const binding of file.imports) {
				if (binding.kind === "star") continue;
				bindingsByKey.set(`${path}\u0000${binding.line}\u0000${binding.boundName}`, binding);
			}
		}
		const parse = await parsePython(bytes, path);
		try {
			if (parse.errorCount > 0) errorFiles.push(path);
			allSymbols.push(...collectPythonSymbols(parse).symbols);
			const walker = new FileWalker(path, makeModuleScope(path), bindingsByKey, (node) =>
				resolveLocalImportNode(graph, path, node),
			);
			walker.walk(parse.tree.rootNode);
			const result = walker.result;
			allCalls.push(...result.calls);
			allDecoratorSites.push(...result.decoratorSites);
			allClasses.push(...result.classes);
			allScopes.push(...result.scopes);
			droppedCalls += result.droppedCalls;
			if (parse.errorCount > 0) droppedByPath.set(path, result.droppedCalls);
		} finally {
			parse.tree.delete();
		}
	}

	applyScopeRedirects(allScopes);

	// Rule 33: each file's module scope, so a star target's own bindings can be read.
	const moduleScopes = new Map<string, Scope>();
	for (const scope of allScopes) {
		if (scope.kind === "module") moduleScopes.set(scope.file, scope);
	}
	const resolver = new Resolver(graph, allSymbols, allClasses, moduleScopes);
	const binaries: CallBinCounts = {
		resolvedInRepo: 0,
		resolvedExternal: 0,
		receiverNeedsInference: 0,
		nameNotBound: 0,
	};
	const unresolvedName = new Map<string, ReasonAccumulator>();
	const unresolvedReceiver = new Map<string, ReasonAccumulator>();
	const sites: PythonCallSite[] = [];
	let polymorphicCount = 0;
	let multiplyBoundCount = 0;

	for (const call of allCalls) {
		const resolution = resolver.resolveCall(call);
		const namedSite: NamedSite = { file: call.file, line: call.line, column: call.column };
		switch (resolution.bin) {
			case "inRepo": {
				binaries.resolvedInRepo++;
				if (resolution.polymorphic) polymorphicCount++;
				if (resolution.multiplyBound) multiplyBoundCount++;
				for (const edge of resolution.edges) {
					sites.push({
						calleeId: edge.calleeId,
						callerId: call.callerId,
						file: call.file,
						line: call.line,
						column: call.column,
						kind: edge.kind,
						multiplyBound: edge.multiplyBound,
						polymorphic: edge.polymorphic,
						externalBaseBefore: edge.externalBaseBefore,
						decorated: edge.decorated,
					});
				}
				break;
			}
			case "external":
				binaries.resolvedExternal++;
				break;
			case "receiver":
				binaries.receiverNeedsInference++;
				addReason(unresolvedReceiver, resolution.reason, namedSite);
				break;
			case "name":
				binaries.nameNotBound++;
				addReason(unresolvedName, resolution.reason, namedSite);
				break;
		}
	}

	let decoratorSites = 0;
	for (const decorator of allDecoratorSites) {
		const edge = resolver.resolveDecoratorSite(decorator);
		if (edge === null) continue;
		decoratorSites++;
		sites.push({
			calleeId: edge.calleeId,
			callerId: decorator.callerId,
			file: decorator.file,
			line: decorator.line,
			column: decorator.column,
			kind: "decorator",
			decorated: edge.decorated,
		});
	}

	sites.sort(compareSites);
	const symbols = [...allSymbols].sort(compareSymbols);
	const uniqErrorFiles = sortedUnique(errorFiles);
	// One entry per file whose parse holds an ERROR node, ordered by path, with its
	// own dropped-call count (DEC-303 (a15) 19). A file with an ERROR but no dropped
	// call is still listed, with 0.
	const parseErrorFiles: ParseErrorFile[] = uniqErrorFiles.map((path) => ({
		path,
		droppedCalls: droppedByPath.get(path) ?? 0,
	}));
	const callExpressionCount = allCalls.length;
	const unresolvedByKind: UnresolvedByKind = {
		call: binaries.receiverNeedsInference + binaries.nameNotBound,
		import: graph.counts.unresolved,
		extends: 0,
		implements: 0,
		dynamic: graph.dynamic.length,
	};
	const notes = resolver.notes.sort((a, b) => bySite(a, b) || compareText(a.classId, b.classId));
	const exact = uniqErrorFiles.length === 0 && droppedCalls === 0 && graph.exact && graph.exit7.length === 0;

	return {
		sites,
		symbols,
		callBins: binaries,
		callExpressionCount,
		unresolvedNameReasons: toReasonCounts(unresolvedName),
		unresolvedReceiverReasons: toReasonCounts(unresolvedReceiver),
		polymorphicCount,
		multiplyBoundCount,
		constructorNotes: notes,
		errorFiles: uniqErrorFiles,
		parseErrorFiles,
		droppedCalls,
		exit7: graph.exit7,
		dynamic: graph.dynamic,
		unresolvedByKind,
		unresolvedFirstPartyImports: graph.counts.unresolvedFirstParty,
		exact,
		counts: {
			callExpressions: callExpressionCount,
			edges: sites.length,
			decoratorSites,
			multiplyBoundSites: multiplyBoundCount,
			polymorphicSites: polymorphicCount,
			constructorNotes: notes.length,
			files: paths.length,
			errorFiles: uniqErrorFiles.length,
			droppedCalls,
		},
	};
}
