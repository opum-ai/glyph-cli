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
	| { kind: "literal" }
	| { kind: "dynamic" };

type BindingRhs = { kind: "alias"; name: string } | { kind: "call"; callee: CalleeDesc } | { kind: "other" };

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
	symbolId?: string;
	importBinding?: ImportBinding | null;
	rhs?: BindingRhs;
	annotation?: AnnotationDesc | null;
	annotationScope?: Scope | null;
	/** Rule 38: the statement's start, so a class-body import binds only later uses. */
	position?: UsePosition;
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

type MroEntry = { kind: "class"; info: ClassInfo; key: string } | { kind: "opaque"; name: string; key: string };

type MroResult = { ok: true; entries: MroEntry[] } | { ok: false };

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
	| { kind: "module"; path: string }
	| { kind: "external" }
	| { kind: "unresolved"; reason: string };

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
			base = { kind: "dynamic" };
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
	underError: boolean;
}

/** One parameter: its bound name, annotation descriptor and default/value node. */
interface ParamInfo {
	name: string | null;
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
			// `typed_parameter` (no default) carries its name as a bare child.
			for (const child of node.namedChildren) {
				if (child !== null && child.type === "identifier") return child;
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
		case "typed_parameter":
		case "typed_default_parameter":
		case "default_parameter":
			return true;
		default:
			return false;
	}
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
		annotation: annotationNode !== null ? describeAnnotation(annotationNode) : null,
		annotationNode,
		valueNode,
	};
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
					this.handleClass(stack, frame, node, frame.decorators ?? []);
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
				case "for_statement":
					this.addTargetBindings(frame.scope, node.childForFieldName("left"));
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "for_in_clause":
					this.addTargetBindings(frame.scope, node.childForFieldName("left"));
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "as_pattern":
					this.addAsPatternBinding(frame.scope, node);
					this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
					continue;
				case "named_expression":
					this.addTargetBindings(frame.scope, node.namedChild(0));
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

	private addTargetBindings(scope: Scope, target: Node | null): void {
		if (target === null) return;
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
				for (const child of target.namedChildren) this.addTargetBindings(scope, child);
				return;
			}
			case "as_pattern_target": {
				for (const child of target.namedChildren) this.addTargetBindings(scope, child);
				return;
			}
			// DEC-303 (a23) item 1: Python binds no name through an attribute or
			// subscript target (`self.x = v`, `d[k] = v`), so the base name is not
			// rebound; the default arm below returns without recording one.
			default:
				return;
		}
	}

	private addAsPatternBinding(scope: Scope, node: Node): void {
		// `value as name`: bind the alias target; the value is walked separately.
		for (const child of node.namedChildren) {
			if (child === null) continue;
			if (child.type === "as_pattern_target") {
				for (const inner of child.namedChildren) {
					if (inner !== null && inner.type === "identifier") this.addBinding(scope, inner.text, { kind: "rebound" });
				}
			}
		}
	}

	private handleDecoratedDefinition(stack: WalkFrame[], frame: WalkFrame): void {
		const definition = frame.node.childForFieldName("definition");
		const decorators: string[] = [];
		for (const child of frame.node.namedChildren) {
			if (child === null || child.type !== "decorator") continue;
			const expression = child.namedChild(0);
			if (expression === null) continue;
			decorators.push(expression.text);
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
			if (frame.scope.kind === "class" && frame.scope.classInfo !== null) {
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

	private handleClass(stack: WalkFrame[], frame: WalkFrame, node: Node, decorators: string[]): void {
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
					: right.type === "call"
						? { kind: "call", callee: describeCallee(right.childForFieldName("function") ?? right) }
						: { kind: "other" };

		if (left !== null && left.type === "identifier") {
			this.addBinding(frame.scope, left.text, {
				kind: "assign",
				rhs,
				annotation,
				annotationScope: annotation !== null ? frame.scope : null,
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

	private handleAugmented(stack: WalkFrame[], frame: WalkFrame, node: Node): void {
		const left = node.namedChild(0);
		if (left !== null && left.type === "identifier") {
			this.addBinding(frame.scope, left.text, { kind: "rebound" });
		}
		this.pushChildren(stack, node, frame.scope, frame.callerId, frame.scopeNames, false);
	}
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
		if (scope.kind !== "function" && scope.kind !== "lambda") continue;
		for (const name of scope.globalNames) {
			const moved = scope.bindings.get(name);
			if (moved === undefined) continue;
			scope.bindings.delete(name);
			const target = moduleScopeOf(scope);
			const list = target.bindings.get(name);
			if (list === undefined) target.bindings.set(name, moved);
			else list.push(...moved);
		}
		for (const name of scope.nonlocalNames) {
			const moved = scope.bindings.get(name);
			if (moved === undefined) continue;
			scope.bindings.delete(name);
			let target: Scope | null = null;
			let current = scope.parent;
			while (current !== null) {
				if (current.kind === "function" || current.kind === "lambda") {
					target = current;
					break;
				}
				current = current.parent;
			}
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
		for (const target of targets) {
			const symbol = this.symbolInModuleOrReexport(target, importedName, 0);
			if (symbol !== null && !symbols.some((existing) => existing.id === symbol.id)) symbols.push(symbol);
		}
		if (symbols.length === 1) return { kind: "symbol", symbol: symbols[0] as PythonSymbol };
		if (symbols.length > 1) return { kind: "multiply", symbols };
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
	 * assignment, `for`, `with` or `except ... as` target) is a later or earlier
	 * rebinding the static rules cannot order, so the call stays unresolved
	 * (rule 2). Known gaps, as for bare names: a def or import in the holder
	 * wins over a star even where the star comes later, `del name` after the star
	 * is not modelled, and a star import's `condition` (try/except) is ignored.
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
				return symbol !== null && symbol.kind === "class" ? (this.classById.get(symbol.id) ?? null) : null;
			}
			return null;
		}
		if (binding.kind === "param" && binding.annotation && binding.annotationScope) {
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
					const entry: MroEntry = { kind: "opaque", name: baseRef.text, key: `opaque:${classInfo.id}:${index}` };
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
				const baseClass = this.resolveBaseClass(classInfo, base);
				if (baseClass === null) continue;
				const list = map.get(baseClass.id);
				if (list === undefined) map.set(baseClass.id, [classInfo]);
				else list.push(classInfo);
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
		for (let index = start; index < mro.entries.length; index++) {
			const entry = mro.entries[index] as MroEntry;
			if (entry.kind === "opaque") {
				sawOpaque = true;
				continue;
			}
			const ids = entry.info.methods.get(name);
			if (ids === undefined || ids.length === 0) continue;
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
			case "multiply": {
				// Rule 25: each in-repository class alternative is a full construction
				// (rule 8), so it gets an edge to the class and one to its resolved
				// `__init__`; every edge is flagged multiplyBound and the site is one.
				const edges: EdgeSpec[] = [];
				for (const symbol of outcome.symbols) {
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
		}
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
		const outcome = this.resolveBareName(base.name, scope, 0, site);
		switch (outcome.kind) {
			case "module":
				if (outcome.path === null) return { bin: "external", reason: "external-module" };
				return this.moduleCall(outcome.path, segments, site);
			case "symbol": {
				if (outcome.symbol.kind === "class" && segments.length === 1) {
					const classInfo = this.classById.get(outcome.symbol.id);
					if (classInfo !== undefined) return this.methodLookup(classInfo, lastName, false, true);
				}
				return { bin: "receiver", reason: "needs-inference" };
			}
			case "external":
			case "runtime":
			case "unresolved":
			case "multiply":
				return { bin: "receiver", reason: "needs-inference" };
		}
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
