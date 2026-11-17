import { join } from "node:path";
import ts from "typescript";
import { loadCompilerOptions } from "./discover.ts";
import { notFoundError } from "./errors.ts";
import {
	INDEX_FORMAT,
	type GlyphIndex,
	type SiteEntry,
	type SymbolEntry,
	type SymbolKind,
	type UnresolvedByKind,
} from "./types.ts";

/**
 * The indexer walks the repository's sources twice with one TypeScript
 * program: once to build the symbol table, once to record the call, import and
 * heritage sites resolved
 * through the type checker.
 *
 * The checker is the whole point of DEC-66's choice: `import { helper as h }`
 * followed by `h()` resolves to the declaration of `helper`, which is a fact
 * about types, not about the letters at the call site. Sites whose callee is
 * dynamic (`x[key]()`, an IIFE) resolve to nothing by construction and are
 * counted in `unresolvedSites` rather than guessed at.
 */

/** Declaration kinds the symbol table carries. Object-literal properties are
 * deliberately absent: they are values, not declarations, and including every
 * one of them would drown the diff query in noise. */
function declarationKind(node: ts.Node): SymbolKind | null {
	if (ts.isFunctionDeclaration(node)) return "function";
	if (ts.isMethodDeclaration(node)) return "method";
	if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return "method";
	if (ts.isPropertyDeclaration(node)) return "property";
	if (ts.isClassDeclaration(node)) return "class";
	if (ts.isInterfaceDeclaration(node)) return "interface";
	if (ts.isTypeAliasDeclaration(node)) return "type";
	if (ts.isEnumDeclaration(node)) return "enum";
	if (ts.isVariableDeclaration(node)) return "variable";
	return null;
}

function declarationName(node: ts.Node): ts.Identifier | null {
	const named = node as { name?: ts.Node };
	const name = named.name;
	return name !== undefined && ts.isIdentifier(name) ? name : null;
}

function isFunctionLike(node: ts.Node): boolean {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node)
	);
}

/** The entry a function-like node belongs to: itself, or the variable/property
 * it is the initializer of (arrows and function expressions have no name). */
function frameFor(node: ts.Node, entries: Map<ts.Node, SymbolEntry>): SymbolEntry | null {
	const direct = entries.get(node);
	if (direct !== undefined) return direct;
	const parent = node.parent;
	if (parent !== undefined) {
		if ((ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === node) {
			return entries.get(parent) ?? null;
		}
	}
	return null;
}

function firstMappedDeclaration(symbol: ts.Symbol, entries: Map<ts.Node, SymbolEntry>): SymbolEntry | null {
	for (const declaration of symbol.getDeclarations() ?? []) {
		const entry = entries.get(declaration);
		if (entry !== undefined) return entry;
	}
	return null;
}

/** A blank line between snippets. */
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * Where a declaration's span starts for the diff query.
 *
 * Deliberately NOT `getFullStart()`: that reaches back through all trivia,
 * including the blank line separating this declaration from the previous one,
 * so inserting any code above a symbol would report the symbol below it as
 * touched (measured on the first smoke run). The span instead starts at the
 * declaration itself, extended upward only across a comment block that is
 * directly attached — no blank line inside the block, none between the block
 * and the declaration. A comment-only edit above a function therefore touches
 * it; a file-section header separated by a blank line does not.
 */
function spanStart(sourceFile: ts.SourceFile, node: ts.Node): number {
	const nodeStart = node.getStart(sourceFile);
	const comments = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
	const last = comments[comments.length - 1];
	if (last === undefined) return nodeStart;
	let first = last;
	for (let index = comments.length - 1; index > 0; index -= 1) {
		const earlier = comments[index - 1];
		if (earlier === undefined || BLANK_LINE.test(sourceFile.text.slice(earlier.end, first.pos))) break;
		first = earlier;
	}
	if (BLANK_LINE.test(sourceFile.text.slice(first.end, nodeStart))) return nodeStart;
	return first.pos;
}

function collectSymbols(
	sourceFile: ts.SourceFile,
	file: string,
	symbols: SymbolEntry[],
	entries: Map<ts.Node, SymbolEntry>,
): void {
	const containers: string[] = [];
	let functionDepth = 0;

	const visit = (node: ts.Node): void => {
		const kind = declarationKind(node);
		const name = kind !== null ? declarationName(node) : null;
		// Function-local variables are deliberately not symbols: a local `const x`
		// shadows the enclosing function in the diff query (every body change would
		// report `x` and hide `render`), and it is not the unit anyone means when
		// asking what a diff touched. Module-scope variables, class properties and
		// nested function declarations stay in the table.
		const isLocalVariable = kind === "variable" && functionDepth > 0;
		if (kind !== null && name !== null && !isLocalVariable) {
			const nameAt = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile));
			const startAt = sourceFile.getLineAndCharacterOfPosition(spanStart(sourceFile, node));
			const endAt = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
			const entry: SymbolEntry = {
				id: `${file}:${nameAt.line + 1}:${nameAt.character + 1}`,
				name: name.text,
				container: containers.length > 0 ? (containers[containers.length - 1] ?? null) : null,
				kind,
				file,
				startLine: startAt.line + 1,
				line: nameAt.line + 1,
				column: nameAt.character + 1,
				endLine: endAt.line + 1,
			};
			symbols.push(entry);
			entries.set(node, entry);
		}
		const entersFunction = isFunctionLike(node);
		const pushesContainer = kind === "class" || kind === "interface" || kind === "enum";
		if (pushesContainer && name !== null) containers.push(name.text);
		if (entersFunction) functionDepth += 1;
		node.forEachChild(visit);
		if (entersFunction) functionDepth -= 1;
		if (pushesContainer) containers.pop();
	};

	visit(sourceFile);
}

/** What one file's edge walk needs; built once per program. */
interface EdgeContext {
	program: ts.Program;
	checker: ts.TypeChecker;
	entries: Map<ts.Node, SymbolEntry>;
	/** The repository-relative path of every indexed source file. */
	fileOf: Map<ts.SourceFile, string>;
	sites: SiteEntry[];
	unresolved: UnresolvedByKind;
}

/** `getResolvedModuleFromModuleSpecifier` is on the Program at runtime but not in the public typings. */
interface ModuleResolvingProgram {
	getResolvedModuleFromModuleSpecifier?: (
		specifier: ts.StringLiteralLike,
		containingFile: ts.SourceFile,
	) => { resolvedModule?: { resolvedFileName: string } } | undefined;
}

/** The declaration a name resolves to, following alias and re-export chains to the original. */
function resolveEntry(ctx: EdgeContext, node: ts.Node): SymbolEntry | null {
	let symbol = ctx.checker.getSymbolAtLocation(node);
	if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
		symbol = ctx.checker.getAliasedSymbol(symbol);
	}
	return symbol !== undefined ? firstMappedDeclaration(symbol, ctx.entries) : null;
}

/** The in-repo file a module specifier resolves to, or null (external, missing, in node_modules). */
function resolveModuleFile(ctx: EdgeContext, specifier: ts.StringLiteralLike, from: ts.SourceFile): string | null {
	const resolved = (ctx.program as unknown as ModuleResolvingProgram).getResolvedModuleFromModuleSpecifier?.(
		specifier,
		from,
	)?.resolvedModule?.resolvedFileName;
	let target = resolved !== undefined ? ctx.program.getSourceFile(resolved) : undefined;
	if (target === undefined) {
		target = ctx.checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
	}
	return target !== undefined ? (ctx.fileOf.get(target) ?? null) : null;
}

function pushSite(
	ctx: EdgeContext,
	sourceFile: ts.SourceFile,
	file: string,
	at: ts.Node,
	site: Omit<SiteEntry, "file" | "line" | "column">,
): void {
	const position = sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile));
	ctx.sites.push({ ...site, file, line: position.line + 1, column: position.character + 1 });
}

/** A binding that names one symbol: its dependent is the importing module (callerId null). */
function recordBinding(
	ctx: EdgeContext,
	sourceFile: ts.SourceFile,
	file: string,
	at: ts.Node,
	name: ts.Node,
	typeOnly: boolean,
): void {
	const target = resolveEntry(ctx, name);
	if (target === null) {
		ctx.unresolved.import += 1;
		return;
	}
	pushSite(ctx, sourceFile, file, at, { calleeId: target.id, callerId: null, kind: "import", typeOnly });
}

/** A namespace import, side-effect import or `export *`: binds no single symbol, so the edge is to the module. */
function recordModuleEdge(
	ctx: EdgeContext,
	sourceFile: ts.SourceFile,
	file: string,
	at: ts.Node,
	specifier: ts.StringLiteralLike,
	typeOnly: boolean,
): void {
	const moduleTarget = resolveModuleFile(ctx, specifier, sourceFile);
	if (moduleTarget === null) {
		ctx.unresolved.import += 1;
		return;
	}
	pushSite(ctx, sourceFile, file, at, { calleeId: null, callerId: null, kind: "import", typeOnly, moduleTarget });
}

function recordImport(ctx: EdgeContext, sourceFile: ts.SourceFile, file: string, node: ts.ImportDeclaration): void {
	if (!ts.isStringLiteral(node.moduleSpecifier)) return;
	const clause = node.importClause;
	if (clause === undefined) {
		recordModuleEdge(ctx, sourceFile, file, node.moduleSpecifier, node.moduleSpecifier, false);
		return;
	}
	const declarationTypeOnly = clause.isTypeOnly;
	if (clause.name !== undefined) {
		recordBinding(ctx, sourceFile, file, clause.name, clause.name, declarationTypeOnly);
	}
	const bindings = clause.namedBindings;
	if (bindings === undefined) return;
	if (ts.isNamespaceImport(bindings)) {
		recordModuleEdge(ctx, sourceFile, file, bindings, node.moduleSpecifier, declarationTypeOnly);
		return;
	}
	for (const element of bindings.elements) {
		recordBinding(ctx, sourceFile, file, element, element.name, declarationTypeOnly || element.isTypeOnly);
	}
}

/** `export { x } from` and `export * from` are import edges whose dependent is the barrel module. */
function recordReExport(ctx: EdgeContext, sourceFile: ts.SourceFile, file: string, node: ts.ExportDeclaration): void {
	const specifier = node.moduleSpecifier;
	if (specifier === undefined || !ts.isStringLiteral(specifier)) return;
	const clause = node.exportClause;
	if (clause === undefined || ts.isNamespaceExport(clause)) {
		recordModuleEdge(ctx, sourceFile, file, node, specifier, node.isTypeOnly);
		return;
	}
	for (const element of clause.elements) {
		recordBinding(ctx, sourceFile, file, element, element.name, node.isTypeOnly || element.isTypeOnly);
	}
}

/** `class B extends A`, `class C implements I`, `interface J extends I`: an edge from the carrier to the target. */
function recordHeritage(
	ctx: EdgeContext,
	sourceFile: ts.SourceFile,
	file: string,
	node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
	frame: SymbolEntry | null,
): void {
	const carrier = ctx.entries.get(node) ?? frame;
	for (const clause of node.heritageClauses ?? []) {
		const kind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
		for (const type of clause.types) {
			const expression = type.expression;
			let target: ts.Node | null = null;
			if (ts.isIdentifier(expression)) target = expression;
			else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) target = expression.name;
			const resolved = target !== null ? resolveEntry(ctx, target) : null;
			if (resolved === null || target === null) {
				ctx.unresolved[kind] += 1;
				continue;
			}
			pushSite(ctx, sourceFile, file, target, {
				calleeId: resolved.id,
				callerId: carrier !== null ? carrier.id : null,
				kind,
			});
		}
	}
}

/** `import("x")` and `require("x")`: not resolved, never followed, but counted. */
function isDynamicLoad(node: ts.CallExpression): boolean {
	const expression = node.expression;
	if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
	return ts.isIdentifier(expression) && expression.text === "require" && node.arguments.length > 0;
}

function collectSites(sourceFile: ts.SourceFile, file: string, ctx: EdgeContext): void {
	const visit = (node: ts.Node, frame: SymbolEntry | null): void => {
		let nextFrame = frame;
		if (isFunctionLike(node)) {
			nextFrame = frameFor(node, ctx.entries) ?? frame;
		}
		if (ts.isImportDeclaration(node)) recordImport(ctx, sourceFile, file, node);
		else if (ts.isExportDeclaration(node)) recordReExport(ctx, sourceFile, file, node);
		else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			ctx.unresolved.dynamic += 1; // `import x = require("m")` is a require.
		} else if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node)) {
			recordHeritage(ctx, sourceFile, file, node, frame);
		}
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const expression = node.expression;
			let target: ts.Node | null = null;
			if (ts.isIdentifier(expression)) {
				target = expression;
			} else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
				target = expression.name;
			}
			const callee = target !== null ? resolveEntry(ctx, target) : null;
			if (callee !== null && target !== null) {
				pushSite(ctx, sourceFile, file, target, {
					calleeId: callee.id,
					callerId: frame !== null ? frame.id : null,
					kind: ts.isNewExpression(node) ? "new" : "call",
				});
			} else if (ts.isCallExpression(node) && isDynamicLoad(node)) {
				ctx.unresolved.dynamic += 1;
			} else {
				ctx.unresolved.call += 1;
			}
		}
		node.forEachChild((child) => visit(child, nextFrame));
	};

	visit(sourceFile, null);
}

/**
 * Build the index for `repoRoot` over `files` (repository-relative, from
 * `discoverSources`), reading the working tree. Throws `not_found` when there
 * is nothing to analyze.
 */
export function buildIndex(repoRoot: string, files: string[]): GlyphIndex {
	if (files.length === 0) {
		throw notFoundError(`no TypeScript or JavaScript sources found under ${repoRoot}`);
	}
	const options = loadCompilerOptions(repoRoot, undefined);
	const program = ts.createProgram({
		rootNames: files.map((file) => join(repoRoot, file)),
		options,
	});
	return indexProgram(repoRoot, files, program);
}

/**
 * Index an already-built program. The working-tree path builds its program
 * here; the `--ref` path builds one over an in-memory tree (see
 * `src/snapshot.ts`) and hands it to this function, so both sources produce the
 * same index from the same walk.
 */
export function indexProgram(repoRoot: string, files: string[], program: ts.Program): GlyphIndex {
	if (files.length === 0) {
		throw notFoundError(`no TypeScript or JavaScript sources found under ${repoRoot}`);
	}
	const checker = program.getTypeChecker();

	const symbols: SymbolEntry[] = [];
	const entries = new Map<ts.Node, SymbolEntry>();
	const sources: { sourceFile: ts.SourceFile; file: string }[] = [];
	for (const file of files) {
		const sourceFile = program.getSourceFile(join(repoRoot, file));
		if (sourceFile === undefined) continue;
		sources.push({ sourceFile, file });
		collectSymbols(sourceFile, file, symbols, entries);
	}

	const ctx: EdgeContext = {
		program,
		checker,
		entries,
		fileOf: new Map(sources.map(({ sourceFile, file }) => [sourceFile, file])),
		sites: [],
		unresolved: { call: 0, import: 0, extends: 0, implements: 0, dynamic: 0 },
	};
	for (const { sourceFile, file } of sources) {
		collectSites(sourceFile, file, ctx);
	}
	const { call, import: imports, extends: extended, implements: implemented, dynamic } = ctx.unresolved;

	return {
		schemaVersion: INDEX_FORMAT,
		repo: repoRoot,
		createdAt: new Date().toISOString(),
		files,
		symbols,
		sites: ctx.sites,
		unresolvedSites: call + imports + extended + implemented + dynamic,
		unresolvedByKind: ctx.unresolved,
	};
}
