/**
 * Python symbol collection: definitions, classes, methods, nested defs and the
 * qualified names the gate scorer reads.
 *
 * This slice is pure analysis over a parse tree. It is built on the S2b parse
 * wrapper (`./parse.ts`), is not wired to the CLI, keeps no cache and adds no
 * dependency. The rules it implements case by case are stated in the GCLI-76
 * rules commit, written before this file existed; `test/python-symbols.test.ts`
 * pins each one.
 *
 * A Python symbol is `SymbolEntry`-shaped plus the Python-only data later
 * slices need: `qualname` (required here), the decorator applications, and the
 * overload stubs collapsed into it.
 */

import type { Node } from "@vscode/tree-sitter-wasm";
import type { SymbolEntry, SymbolKind } from "../types.ts";
import { type PythonParseResult, parsePython } from "./parse.ts";

/** One decorator application on a definition. */
export interface PythonDecorator {
	/** The expression without the leading `@`: `property`, `click.command`. */
	name: string;
	/** 1-based line of the decorator expression. */
	line: number;
	/** 1-based column of the decorator expression, in UTF-16 code units (as TypeScript's). */
	column: number;
	/** True for `@d(...)`, false for a bare `@d`. */
	call: boolean;
}

/** A Python declaration, with the Python-only fields beside `SymbolEntry`. */
export interface PythonSymbol extends SymbolEntry {
	/** Full enclosing dotted path without a `<locals>` segment; no leading dot. */
	qualname: string;
	/** Decorator applications in source order; empty when undecorated. */
	decorators: PythonDecorator[];
	/**
	 * True when at least one decorator is applied. Recorded because a decorator
	 * may replace the name with another object (click's `@command`); such a
	 * symbol is flagged, never dropped. The decorator SITE kind is S7's.
	 */
	decorated: boolean;
	/** Lines of the `@overload` stubs this implementation replaced. */
	collapsedOverloadStubs?: number[];
}

/** A `global`/`nonlocal` declaration, kept as a hint for the scope slice (S5). */
export interface PythonScopeHint {
	file: string;
	/** Qualname of the function whose own body carries the declaration. */
	function: string;
	/** 1-based line of that function's `def`. */
	line: number;
	/** Names declared `global` in that function's own body. */
	global: string[];
	/** Names declared `nonlocal` in that function's own body. */
	nonlocal: string[];
}

/** An `@overload` group with no implementation: its last stub was kept. */
export interface PythonOverloadNote {
	file: string;
	qualname: string;
	/** 1-based line of the stub that was kept. */
	line: number;
	/** 1-based lines of every stub in the group. */
	stubs: number[];
}

/** A definition the builder refused to emit. */
export interface PythonDroppedDefinition {
	file: string;
	reason: "error-region" | "missing-name";
	nodeType: "function_definition" | "class_definition";
	/** 1-based line of the dropped definition's `def`/`class` node start. */
	line: number;
}

/** What one file's symbol collection produces. */
export interface PythonSymbolTable {
	symbols: PythonSymbol[];
	/** How many `@overload` stubs were collapsed away (not emitted). */
	overloadStubsCollapsed: number;
	/** Groups that had stubs and no implementation, each with the kept stub. */
	overloadGroupsWithoutImplementation: PythonOverloadNote[];
	droppedDefinitions: PythonDroppedDefinition[];
	/** Files that lost a definition to an ERROR region. */
	errorFiles: string[];
	/** Files whose parse needed UTF-8 decode replacements. */
	decodeReplacementFiles: string[];
	scopeHints: PythonScopeHint[];
}

const OVERLOAD_NAME = "overload";
const PROPERTY_DECORATOR_NAMES = new Set(["property", "setter", "getter", "deleter"]);

type EnclosingScope = "module" | "class" | "function";

interface WalkContext {
	/** Enclosing definition names, for the qualified name. */
	scopeNames: string[];
	/** Nearest enclosing class NAME only (not dotted), or null. */
	nearestClass: string | null;
	/** What immediately encloses the next definition: module, class body or function body. */
	enclosing: EnclosingScope;
	/** True inside an ERROR subtree, where definitions are dropped. */
	underError: boolean;
}

function lastSegment(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? name : name.slice(dot + 1);
}

function isOverloadDecorator(decorator: PythonDecorator): boolean {
	return decorator.name === OVERLOAD_NAME || decorator.name.endsWith(`.${OVERLOAD_NAME}`);
}

function isPropertyDecorator(decorator: PythonDecorator): boolean {
	return PROPERTY_DECORATOR_NAMES.has(lastSegment(decorator.name));
}

/** The decorator expressions of a `decorated_definition`, in source order. */
function collectDecorators(wrapper: Node): PythonDecorator[] {
	const decorators: PythonDecorator[] = [];
	for (const child of wrapper.namedChildren) {
		if (child === null || child.type !== "decorator") continue;
		const expression = child.namedChildren[0];
		if (expression === null || expression === undefined) continue;
		const callee = expression.type === "call" ? expression.childForFieldName("function") : expression;
		decorators.push({
			name: callee?.text ?? expression.text,
			line: expression.startPosition.row + 1,
			column: expression.startPosition.column + 1,
			call: expression.type === "call",
		});
	}
	return decorators;
}

/**
 * The span's 1-based start line: the definition (or its first decorator) plus
 * any comment lines directly above it with no blank line between.
 */
function leadingStartLine(node: Node): number {
	let startRow = node.startPosition.row;
	let sibling = node.previousNamedSibling;
	while (sibling !== null && sibling.type === "comment" && sibling.endPosition.row + 1 === startRow) {
		startRow = sibling.startPosition.row;
		sibling = sibling.previousNamedSibling;
	}
	return startRow + 1;
}

function functionKind(enclosing: EnclosingScope, decorators: PythonDecorator[]): SymbolKind {
	if (enclosing === "class") {
		return decorators.some(isPropertyDecorator) ? "property" : "method";
	}
	// Module level and nested inside a function are both `function`; a nested
	// def inside a method is a nested function too.
	return "function";
}

/** Collect `global`/`nonlocal` from a function's own body, not nested definitions. */
function collectScopeHints(definition: Node, qualname: string, file: string, table: PythonSymbolTable): void {
	const body = definition.childForFieldName("body");
	if (body === null) return;
	const global: string[] = [];
	const nonlocal: string[] = [];
	const visit = (node: Node): void => {
		// A nested definition owns its own declarations; do not descend into it.
		if (
			node.type === "function_definition" ||
			node.type === "class_definition" ||
			node.type === "decorated_definition"
		) {
			return;
		}
		if (node.type === "global_statement" || node.type === "nonlocal_statement") {
			const target = node.type === "global_statement" ? global : nonlocal;
			for (const child of node.namedChildren) {
				if (child !== null && child.type === "identifier") target.push(child.text);
			}
			return;
		}
		for (const child of node.namedChildren) {
			if (child !== null) visit(child);
		}
	};
	visit(body);
	if (global.length > 0 || nonlocal.length > 0) {
		table.scopeHints.push({ file, function: qualname, line: definition.startPosition.row + 1, global, nonlocal });
	}
}

function recordDropped(
	node: Node,
	file: string,
	reason: PythonDroppedDefinition["reason"],
	table: PythonSymbolTable,
): void {
	table.droppedDefinitions.push({
		file,
		reason,
		nodeType: node.type === "class_definition" ? "class_definition" : "function_definition",
		line: node.startPosition.row + 1,
	});
}

function walk(node: Node, ctx: WalkContext, file: string, table: PythonSymbolTable): void {
	if (node.type === "decorated_definition") {
		const definition = node.childForFieldName("definition");
		if (definition === null) return;
		if (ctx.underError) {
			// The definition is inside an ERROR region: drop it, name the file.
			recordDropped(definition, file, "error-region", table);
			return;
		}
		handleDefinition(definition, node, collectDecorators(node), ctx, file, table);
		return;
	}
	if (node.type === "function_definition" || node.type === "class_definition") {
		if (ctx.underError) {
			recordDropped(node, file, "error-region", table);
			return;
		}
		handleDefinition(node, null, [], ctx, file, table);
		return;
	}
	if (node.type === "ERROR") {
		const inside: WalkContext = { ...ctx, underError: true };
		for (const child of node.namedChildren) {
			if (child !== null) walk(child, inside, file, table);
		}
		return;
	}
	for (const child of node.namedChildren) {
		if (child !== null) walk(child, ctx, file, table);
	}
}

function handleDefinition(
	definition: Node,
	wrapper: Node | null,
	decorators: PythonDecorator[],
	ctx: WalkContext,
	file: string,
	table: PythonSymbolTable,
): void {
	const nameNode = definition.childForFieldName("name");
	if (nameNode === null) {
		recordDropped(definition, file, "missing-name", table);
		return;
	}
	const name = nameNode.text;
	const isClass = definition.type === "class_definition";
	const spanStart = wrapper ?? definition;
	const symbol: PythonSymbol = {
		id: `${file}:${nameNode.startPosition.row + 1}:${nameNode.startPosition.column + 1}`,
		name,
		container: ctx.nearestClass,
		qualname: [...ctx.scopeNames, name].join("."),
		kind: isClass ? "class" : functionKind(ctx.enclosing, decorators),
		file,
		startLine: leadingStartLine(spanStart),
		line: definition.startPosition.row + 1,
		column: nameNode.startPosition.column + 1,
		endLine: definition.endPosition.row + 1,
		// Filled by applyExported once the module's __all__ and the class chain are known.
		exported: false,
		decorators,
		decorated: decorators.length > 0,
	};
	table.symbols.push(symbol);

	if (!isClass) collectScopeHints(definition, symbol.qualname, file, table);

	const nested: WalkContext = isClass
		? {
				scopeNames: [...ctx.scopeNames, name],
				nearestClass: name,
				enclosing: "class",
				underError: false,
			}
		: {
				scopeNames: [...ctx.scopeNames, name],
				nearestClass: ctx.nearestClass,
				enclosing: "function",
				underError: false,
			};
	for (const child of definition.namedChildren) {
		if (child !== null) walk(child, nested, file, table);
	}
}

/**
 * Collapse `@overload` groups to their implementation (Addendum 6 item 1).
 *
 * Stubs are removed; the implementation is kept at its own line and records
 * the stub lines. A group without an implementation keeps its last stub and is
 * noted. Implementations in separate branches are all kept: a stub makes a
 * group, but branch-conditional definitions are never collapsed.
 */
function collapseOverloadGroups(table: PythonSymbolTable, file: string): void {
	const byQualname = new Map<string, PythonSymbol[]>();
	for (const symbol of table.symbols) {
		if (symbol.kind === "class") continue;
		const group = byQualname.get(symbol.qualname);
		if (group === undefined) byQualname.set(symbol.qualname, [symbol]);
		else group.push(symbol);
	}

	const removed = new Set<PythonSymbol>();
	for (const [qualname, group] of byQualname) {
		const stubs = group.filter((symbol) => symbol.decorators.some(isOverloadDecorator));
		if (stubs.length === 0) continue;
		const implementations = group.filter((symbol) => !symbol.decorators.some(isOverloadDecorator));
		const stubLines = stubs.map((symbol) => symbol.line);
		if (implementations.length > 0) {
			const keep = implementations[implementations.length - 1] as PythonSymbol;
			for (const stub of stubs) removed.add(stub);
			keep.collapsedOverloadStubs = stubLines;
			table.overloadStubsCollapsed += stubs.length;
			continue;
		}
		const keep = stubs[stubs.length - 1] as PythonSymbol;
		for (const stub of stubs) {
			if (stub !== keep) removed.add(stub);
		}
		keep.collapsedOverloadStubs = stubLines.filter((line) => line !== keep.line);
		table.overloadStubsCollapsed += stubs.length - 1;
		table.overloadGroupsWithoutImplementation.push({ file, qualname, line: keep.line, stubs: stubLines });
	}
	if (removed.size > 0) table.symbols = table.symbols.filter((symbol) => !removed.has(symbol));
}

/** The unquoted values of a literal list/tuple of strings, or null if not literal. */
function literalStringList(node: Node | null): string[] | null {
	if (node === null || (node.type !== "list" && node.type !== "tuple")) return null;
	const values: string[] = [];
	for (const element of node.namedChildren) {
		if (element === null || element.type === "comment") continue;
		if (element.type !== "string") return null;
		const content = element.namedChildren.find((child) => child !== null && child.type === "string_content");
		values.push(content?.text ?? "");
	}
	return values;
}

/**
 * The module's literal `__all__` names, or null when there is none or any
 * assignment to it is not a literal list/tuple (rule 10's fallback).
 */
function moduleAllNames(root: Node): Set<string> | null {
	let found = false;
	const names = new Set<string>();
	for (const child of root.namedChildren) {
		if (child === null || child.type !== "expression_statement") continue;
		const statement = child.namedChildren[0];
		if (statement === null || statement === undefined) continue;
		const left = statement.childForFieldName("left");
		if (left === null || left.type !== "identifier" || left.text !== "__all__") continue;
		found = true;
		if (statement.type === "augmented_assignment") return null;
		if (statement.type !== "assignment") return null;
		const values = literalStringList(statement.childForFieldName("right"));
		if (values === null) return null;
		for (const value of values) names.add(value);
	}
	return found ? names : null;
}

/**
 * Fill `exported` on every symbol. Module-level declarations follow a literal
 * `__all__` when present, else the leading-underscore convention; a member of
 * an exported class is exported (even an underscore member), and a definition
 * nested inside a function never is.
 */
function applyExported(table: PythonSymbolTable, moduleAll: Set<string> | null): void {
	const byQualname = new Map(table.symbols.map((symbol) => [symbol.qualname, symbol]));
	const shallowFirst = [...table.symbols].sort((a, b) => a.qualname.split(".").length - b.qualname.split(".").length);
	for (const symbol of shallowFirst) {
		const dot = symbol.qualname.lastIndexOf(".");
		if (dot === -1) {
			symbol.exported = moduleAll === null ? !symbol.name.startsWith("_") : moduleAll.has(symbol.name);
			continue;
		}
		const parent = byQualname.get(symbol.qualname.slice(0, dot));
		symbol.exported = parent !== undefined && parent.kind === "class" ? parent.exported : false;
	}
}

/**
 * Collect one file's Python symbols from its parse result. Pure: it reads the
 * tree and writes nothing; it does NOT free the tree (the caller owns it).
 */
export function collectPythonSymbols(parse: PythonParseResult): PythonSymbolTable {
	const table: PythonSymbolTable = {
		symbols: [],
		overloadStubsCollapsed: 0,
		overloadGroupsWithoutImplementation: [],
		droppedDefinitions: [],
		errorFiles: [],
		decodeReplacementFiles: [],
		scopeHints: [],
	};
	const file = parse.path;
	if (parse.decodeReplacements > 0) table.decodeReplacementFiles.push(file);

	walk(
		parse.tree.rootNode,
		{ scopeNames: [], nearestClass: null, enclosing: "module", underError: false },
		file,
		table,
	);
	collapseOverloadGroups(table, file);
	applyExported(table, moduleAllNames(parse.tree.rootNode));

	if (table.droppedDefinitions.some((dropped) => dropped.reason === "error-region")) {
		table.errorFiles.push(file);
	}
	return table;
}

/**
 * Parse Python bytes (or a string) and collect its symbols. The tree is parsed
 * and freed here, so the caller never sees it.
 */
export async function buildPythonSymbols(source: Uint8Array | string, path: string): Promise<PythonSymbolTable> {
	const parse = await parsePython(source, path);
	try {
		return collectPythonSymbols(parse);
	} finally {
		parse.tree.delete();
	}
}
