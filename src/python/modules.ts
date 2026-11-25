import type { Node, Tree } from "@vscode/tree-sitter-wasm";
import { parsePython } from "./parse.ts";

/**
 * Python module graph and import resolution (slice S3, ADR 0008).
 *
 * Pure functions over parse results: the caller hands in `{ path, bytes }` and
 * this module parses each `.py` with `parsePython`, builds the module table and
 * resolves every module-level import binding. It touches no filesystem, no
 * cache and no CLI surface; a later slice wires it up.
 *
 * The rule-per-case list this implements is committed empty on this branch as
 * "docs(GCLI-75): S3 rules per case, written before the code". Comments below
 * name the rule they enforce. Anything the rules leave open is counted and
 * named here rather than silently dropped.
 */

/** Default source roots, in resolution order (rule 1). `packages/<name>/src` is discovered. */
export const DEFAULT_PYTHON_ROOTS: readonly string[] = ["", "src", "lib"];

/**
 * Directory names excluded at any depth (rule 3; DEC-303 (a7), NB11): version
 * control, environments and caches. These are never first-party packages.
 */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
	".git",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".nox",
	"site-packages",
];

/**
 * Build-output directory names (DEC-303 (a7), NB11; list fixed by DEC-303
 * (a8)): excluded only as a direct child of the repository root, and only when
 * the directory is not a package. So `src/build/` and a root `coverage/` holding
 * `__init__.py` are indexed; a root `build/` output directory without
 * `__init__.py` stays excluded. `vendor` is not listed: vendored source is
 * indexed (DEC-303 (a8)).
 */
export const DEFAULT_BUILD_OUTPUT_DIRS: readonly string[] = ["build", "dist", "coverage", "out", ".next", ".nuxt"];

/**
 * Directory names that are never package roots (DEC-303 (a7) clause 1, names
 * fixed by DEC-303 (a8)); matched case-insensitively. A stated limit: a
 * top-level package named `testing/` (or any test-named directory) is never a
 * guard root.
 */
export const TEST_DIR_NAMES: ReadonlySet<string> = new Set(["test", "tests", "testing", "unittests"]);

/**
 * The `PythonModuleRecord.root` label for a file no declared root covers
 * (DEC-303 (a7) clause 3). Distinct from "" so a consumer can tell an
 * outside-root file from one under the repository root.
 */
export const OUTSIDE_ROOTS_ROOT = "<outside-roots>";

export interface PythonModuleInput {
	/** Repository-relative POSIX path of the file. */
	path: string;
	bytes: Uint8Array;
}

export interface ModuleGraphOptions {
	/** Declared roots, replacing the defaults literally (no glob); used for an unusual layout. */
	roots?: readonly string[];
	/**
	 * Explicit excluded-directory names, replacing the defaults. A name in
	 * `DEFAULT_BUILD_OUTPUT_DIRS` stays root-only and package-exempt; every other
	 * declared name is excluded at any depth.
	 */
	excludedDirs?: readonly string[];
	/**
	 * Repository-relative directories (POSIX, below the repository root) that hold
	 * a Python project marker (`pyproject.toml`, `setup.py` or `setup.cfg`),
	 * supplied by the caller's listing (S8a, DEC-303 (a18)). Each is a nested
	 * project root; the nearest enclosing one is consulted first for a file
	 * beneath it. Absent or empty means no nested roots and today's behaviour. A
	 * marker in an excluded path is ignored (rule 6), so the caller may pass the
	 * listing unfiltered.
	 */
	markerDirs?: readonly string[];
}

export type ImportKind = "import" | "from" | "relative" | "future" | "star";
export type ImportOutcome = "resolved" | "external" | "unresolved";

/** One module-level import binding, resolved or binned (rules 4-13). */
export interface ImportBinding {
	/** Importing file. */
	path: string;
	/** One-based line of the import statement's first token. */
	line: number;
	kind: ImportKind;
	/** Dotted module as written, without relative dots; "" for `from . import x`. */
	module: string;
	/** Number of leading dots on a relative import; 0 otherwise. */
	dots: number;
	/** The imported name in a from-import; null for a plain import; "*" for a star. */
	name: string | null;
	/** The `as` alias, if any. */
	alias: string | null;
	/** The module or name as written, for a census (`a.b`, `Box`, `*`). */
	original: string;
	/** The name bound in the importing file; "" for a star import. */
	boundName: string;
	/** The defining module file a resolved binding points at; null otherwise. */
	target: string | null;
	outcome: ImportOutcome;
	/** Unresolved reason, or "multiply-bound" when alternatives disagree. */
	reason: string | null;
	/** All distinct resolved targets when a name is multiply bound (rule 10). */
	alternatives: string[];
	/** Branch condition text for a conditional import; null at the top level (rule 10). */
	condition: string | null;
	/** Names a star import brings in, when it resolves (rule 9). */
	starNames: string[];
}

export interface PythonModuleRecord {
	path: string;
	/** Dotted module name under its root (rule 2). */
	module: string;
	/** The root the file belongs to ("" is the repository root). */
	root: string;
	/** True for `<dir>/__init__.py`. */
	isPackage: boolean;
	/** The package containing this file ("" at the top level). */
	package: string;
	/** True when an earlier root provides the same top-level name (rules 1, 15). */
	shadowed: boolean;
	/**
	 * True when no declared root covers this file: it is parsed and indexed but
	 * not resolvable through the roots (DEC-303 (a7) clause 3). Its `root` is
	 * `OUTSIDE_ROOTS_ROOT`, not "".
	 */
	outsideRoots: boolean;
}

export interface UnresolvedImport {
	path: string;
	line: number;
	module: string;
	dots: number;
	name: string | null;
	reason: string;
	/** False only for a star import of a non-first-party module (rule 9). */
	firstParty: boolean;
}

/** One `indeterminate` trigger: a first-party package root no source root resolves (rule 12). */
export interface Exit7Trigger {
	path: string;
	line: number;
	/** The imported first component that names a package directory. */
	name: string;
	original: string;
	/** Every package directory in the tree carrying that basename. */
	directories: string[];
}

export interface DynamicImport {
	path: string;
	line: number;
	callee: string;
	text: string;
}

export interface NameCollision {
	/** The top-level name two or more roots provide. */
	name: string;
	/** Providing roots, in root order. */
	roots: string[];
	winner: string;
	shadowedPaths: string[];
}

export interface IgnoredInput {
	path: string;
	reason: "stub" | "non-python" | "excluded-path" | "duplicate";
}

export interface ParseIssue {
	path: string;
	hasError: boolean;
	errorCount: number;
	missingCount: number;
	decodeReplacements: number;
	exact: boolean;
}

export interface DroppedImport {
	path: string;
	line: number;
	text: string;
}

export interface LocalImport {
	path: string;
	line: number;
	text: string;
}

export interface ModuleFileBindings {
	path: string;
	module: string;
	imports: ImportBinding[];
}

export interface ModuleGraphCounts {
	files: number;
	modules: number;
	packages: number;
	imports: number;
	resolved: number;
	external: number;
	unresolved: number;
	unresolvedFirstParty: number;
	dynamic: number;
	exit7: number;
	collisions: number;
	shadowed: number;
	ignored: number;
	parseIssueFiles: number;
	decodeReplacementFiles: number;
	droppedImports: number;
	localImports: number;
	duplicates: number;
}

export interface ModuleGraph {
	/** True only when no file had an ERROR/MISSING or a decode replacement (rule 14). */
	exact: boolean;
	modules: PythonModuleRecord[];
	files: ModuleFileBindings[];
	bindings: ImportBinding[];
	unresolved: UnresolvedImport[];
	exit7: Exit7Trigger[];
	dynamic: DynamicImport[];
	collisions: NameCollision[];
	shadowed: string[];
	ignored: IgnoredInput[];
	parseIssues: ParseIssue[];
	droppedByError: DroppedImport[];
	localImports: LocalImport[];
	counts: ModuleGraphCounts;
}

// --- path and root helpers -------------------------------------------------

function normalizePath(path: string): string {
	let normalized = path;
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	return normalized.replace(/^\/+/, "");
}

function normalizeRoot(root: string): string {
	let normalized = root.trim();
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	normalized = normalized.replace(/^\/+/, "");
	return normalized.replace(/\/+$/, "");
}

function joinPath(...parts: string[]): string {
	return parts.filter((part) => part !== "").join("/");
}

function dirOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? path : path.slice(index + 1);
}

function isUnder(path: string, root: string): boolean {
	return root === "" || path.startsWith(`${root}/`);
}

function rootDepth(root: string): number {
	return root === "" ? 0 : root.split("/").length;
}

function rootOrderRoots(paths: readonly string[], declared: readonly string[] | undefined): string[] {
	if (declared !== undefined) return declared.map(normalizeRoot);
	const roots = [...DEFAULT_PYTHON_ROOTS];
	const packageRoots = new Set<string>();
	for (const path of paths) {
		const match = /^packages\/([^/]+)\/src\//.exec(path);
		if (match?.[1] !== undefined) packageRoots.add(`packages/${match[1]}/src`);
	}
	return [...roots, ...[...packageRoots].sort()];
}

interface ExclusionRules {
	/** Names excluded at any depth. */
	anyDepth: ReadonlySet<string>;
	/** Build-output names excluded only as a non-package direct child of the root. */
	rootBuildOutput: ReadonlySet<string>;
}

function exclusionRules(declared: readonly string[] | undefined): ExclusionRules {
	if (declared !== undefined) {
		// A declared build-output name keeps the root-only, package-exempt rule
		// (finding 7); every other declared name is excluded at any depth, so a
		// declared venv/node_modules/.git/cache still applies below the root
		// (DEC-303 (a7) NB11, (a8) list).
		const buildOutput = new Set(DEFAULT_BUILD_OUTPUT_DIRS);
		const anyDepth = new Set<string>();
		const rootBuildOutput = new Set<string>();
		for (const name of declared) {
			if (buildOutput.has(name)) rootBuildOutput.add(name);
			else anyDepth.add(name);
		}
		return { anyDepth, rootBuildOutput };
	}
	return { anyDepth: new Set(DEFAULT_EXCLUDED_DIRS), rootBuildOutput: new Set(DEFAULT_BUILD_OUTPUT_DIRS) };
}

/**
 * A directory is excluded when a segment names an any-depth exclusion, or when
 * its repo-root-level segment names a build-output directory that is not itself a
 * package (DEC-303 (a7), NB11). Shared with {@link isExcludedPath}, and by S8a's
 * marker filter (rule 6), so a marker under an excluded path is excluded by the
 * same rule as a file under it.
 */
function isExcludedDir(dir: string, rules: ExclusionRules, packageDirs: ReadonlySet<string>): boolean {
	if (dir === "") return false;
	const segments = dir.split("/");
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index] as string;
		if (segment.endsWith(".egg-info")) return true;
		if (rules.anyDepth.has(segment)) return true;
		if (index === 0 && rules.rootBuildOutput.has(segment) && !packageDirs.has(segment)) return true;
	}
	return false;
}

/** A path is excluded when its directory is excluded. `packageDirs` holds every input directory with `__init__.py`. */
function isExcludedPath(path: string, rules: ExclusionRules, packageDirs: ReadonlySet<string>): boolean {
	return isExcludedDir(dirOf(path), rules, packageDirs);
}

/** True when any segment of `dir` is a test-named directory (DEC-303 (a7), (a8); case-insensitive). */
function isInsideTestNamedDir(dir: string): boolean {
	return dir.split("/").some((segment) => TEST_DIR_NAMES.has(segment.toLowerCase()));
}

/**
 * True when a proper ancestor of `dir` holds `__init__.py` (DEC-303 (a7)
 * clause 1). `""` (the repository root) is never a parent package (clause 2).
 */
function hasPackageAncestor(dir: string, packageDirs: ReadonlySet<string>): boolean {
	const parts = dir.split("/");
	for (let index = 1; index < parts.length; index++) {
		if (packageDirs.has(parts.slice(0, index).join("/"))) return true;
	}
	return false;
}

function selectRoot(path: string, roots: readonly string[]): number {
	let best = -1;
	let bestDepth = -1;
	for (let index = 0; index < roots.length; index++) {
		const root = roots[index] as string;
		if (!isUnder(path, root)) continue;
		const depth = rootDepth(root);
		if (depth > bestDepth) {
			best = index;
			bestDepth = depth;
		}
	}
	return best;
}

/**
 * The nested project roots the graph will honour (S8a, rules 1 and 6): supplied
 * marker directories below the repository root, normalised, deduped, sorted, and
 * with any marker under an excluded path dropped. A marker at the repository root
 * is the repository's own root, never a nested root, so "" is dropped.
 */
function nestedProjectRoots(
	markers: readonly string[] | undefined,
	rules: ExclusionRules,
	packageDirs: ReadonlySet<string>,
): string[] {
	if (markers === undefined) return [];
	const roots = new Set<string>();
	for (const marker of markers) {
		const dir = normalizeRoot(marker);
		if (dir === "") continue;
		if (isExcludedDir(dir, rules, packageDirs)) continue;
		roots.add(dir);
	}
	return [...roots].sort();
}

/**
 * A file's nested source roots, in resolution order (rules 2, 5 and 7): the
 * nearest enclosing marker's own "", `src` and `lib`, relative to it. Empty when
 * the file is beneath no nested root, so resolution and module naming fall back
 * to the repository roots exactly as today.
 */
function nestedSourceRoots(path: string, nestedRoots: readonly string[]): string[] {
	let nearest: string | null = null;
	for (const root of nestedRoots) {
		if (!isUnder(path, root)) continue;
		if (nearest === null || rootDepth(root) > rootDepth(nearest)) nearest = root;
	}
	if (nearest === null) return [];
	return [nearest, joinPath(nearest, "src"), joinPath(nearest, "lib")];
}

function moduleNameFor(path: string, root: string): string {
	const relative = root === "" ? path : path.slice(root.length + 1);
	const withoutExtension = relative.endsWith(".py") ? relative.slice(0, -3) : relative;
	const withoutInit = withoutExtension.endsWith("/__init__")
		? withoutExtension.slice(0, -"/__init__".length)
		: withoutExtension === "__init__"
			? ""
			: withoutExtension;
	return withoutInit
		.split("/")
		.filter((part) => part !== "")
		.join(".");
}

function packageNameFor(module: string, isPackage: boolean): string {
	if (isPackage) return module;
	const parts = module.split(".").filter((part) => part !== "");
	parts.pop();
	return parts.join(".");
}

function moduleComponents(module: string): string[] {
	return module.split(".").filter((part) => part !== "");
}

// --- tree-sitter extraction ------------------------------------------------

interface RawImport {
	path: string;
	line: number;
	kind: ImportKind;
	module: string;
	dots: number;
	name: string | null;
	alias: string | null;
	original: string;
	condition: string | null;
}

interface ModuleData {
	localNames: Set<string>;
	hasAll: boolean;
	allLiterals: string[];
	allNonLiteral: boolean;
	imports: RawImport[];
	localImports: LocalImport[];
	dynamic: DynamicImport[];
}

const DYNAMIC_CALLEES = new Set(["importlib.import_module", "__import__", "getattr"]);

function combineCondition(parent: string | null, condition: string): string {
	return parent === null ? condition : `${parent} && ${condition}`;
}

function countDots(text: string): number {
	let count = 0;
	for (const char of text) if (char === ".") count++;
	return count;
}

/**
 * The `namedChildren` getter is the cheapest wide-node path measured on this
 * grammar (S3 measurement (b)): ~75x faster than a `namedChild(i)` loop at
 * 50,000 children, and ~90x faster than a TreeCursor walk. The cursor walk was
 * measured and was NOT faster in @vscode/tree-sitter-wasm 0.3.1.
 */
function allElements(node: Node): Node[] {
	const elements: Node[] = [];
	for (const child of node.namedChildren) if (child !== null) elements.push(child);
	return elements;
}

function literalString(node: Node): string | null {
	if (node.type !== "string") return null;
	for (const child of allElements(node)) if (child.type === "interpolation") return null;
	for (const child of allElements(node)) if (child.type === "string_content") return child.text;
	return "";
}

function collectAllValue(value: Node | null, data: ModuleData): void {
	if (value === null) return;
	if (value.type !== "list" && value.type !== "tuple") {
		data.allNonLiteral = true;
		return;
	}
	for (const element of allElements(value)) {
		const literal = literalString(element);
		if (literal === null) data.allNonLiteral = true;
		else data.allLiterals.push(literal);
	}
}

/** `__all__.append(x)` takes one value; a literal string is a name, anything else is non-literal. */
function collectAllElement(value: Node | null, data: ModuleData): void {
	if (value === null) {
		data.allNonLiteral = true;
		return;
	}
	const literal = literalString(value);
	if (literal === null) data.allNonLiteral = true;
	else data.allLiterals.push(literal);
}

function valueAfterAssignment(node: Node): Node | null {
	let value: Node | null = null;
	for (let index = 1; index < node.namedChildCount; index++) {
		const child = node.namedChild(index);
		if (child === null || child.type === "type") continue;
		value = child;
	}
	return value;
}

function collectModuleDeclaration(node: Node, data: ModuleData): void {
	switch (node.type) {
		case "function_definition":
		case "class_definition": {
			const name = node.namedChild(0);
			if (name?.type === "identifier") data.localNames.add(name.text);
			break;
		}
		case "assignment": {
			const left = node.namedChild(0);
			if (left?.type === "identifier") {
				if (left.text === "__all__") {
					data.hasAll = true;
					collectAllValue(valueAfterAssignment(node), data);
				} else {
					data.localNames.add(left.text);
				}
			} else if (left?.type === "pattern_list" || left?.type === "tuple_pattern") {
				for (const element of allElements(left)) {
					if (element.type === "identifier") data.localNames.add(element.text);
				}
			}
			break;
		}
		case "augmented_assignment": {
			const left = node.namedChild(0);
			if (left?.type !== "identifier") break;
			if (left.text === "__all__") {
				data.hasAll = true;
				collectAllValue(node.namedChild(1), data);
			} else {
				data.localNames.add(left.text);
			}
			break;
		}
		default:
			break;
	}
}

function parseImportNode(node: Node, path: string, condition: string | null): RawImport[] {
	const line = node.startPosition.row + 1;
	const out: RawImport[] = [];
	if (node.type === "import_statement") {
		for (const child of allElements(node)) {
			if (child.type === "aliased_import") {
				const module = child.namedChild(0)?.text ?? "";
				const alias = child.namedChild(1)?.text ?? null;
				out.push({ path, line, kind: "import", module, dots: 0, name: null, alias, original: module, condition });
			} else if (child.type === "dotted_name") {
				out.push({
					path,
					line,
					kind: "import",
					module: child.text,
					dots: 0,
					name: null,
					alias: null,
					original: child.text,
					condition,
				});
			}
		}
		return out;
	}
	if (node.type === "future_import_statement") {
		for (const child of allElements(node)) {
			if (child.type === "dotted_name") {
				out.push({
					path,
					line,
					kind: "future",
					module: "__future__",
					dots: 0,
					name: child.text,
					alias: null,
					original: child.text,
					condition,
				});
			} else if (child.type === "aliased_import") {
				const name = child.namedChild(0)?.text ?? "";
				const alias = child.namedChild(1)?.text ?? null;
				out.push({ path, line, kind: "future", module: "__future__", dots: 0, name, alias, original: name, condition });
			}
		}
		return out;
	}

	const first = node.namedChild(0);
	let kind: ImportKind = "from";
	let module = "";
	let dots = 0;
	const start = 1;
	if (first?.type === "relative_import") {
		kind = "relative";
		dots = countDots(first.namedChild(0)?.text ?? "");
		module = first.namedChild(1)?.text ?? "";
	} else if (first?.type === "dotted_name") {
		module = first.text;
	} else {
		// An unexpected from-form: record nothing rather than inventing a binding.
		return out;
	}
	for (let index = start; index < node.namedChildCount; index++) {
		const child = node.namedChild(index);
		if (child === null) continue;
		if (child.type === "wildcard_import") {
			out.push({ path, line, kind: "star", module, dots, name: "*", alias: null, original: "*", condition });
		} else if (child.type === "aliased_import") {
			const name = child.namedChild(0)?.text ?? "";
			const alias = child.namedChild(1)?.text ?? null;
			out.push({ path, line, kind, module, dots, name, alias, original: name, condition });
		} else if (child.type === "dotted_name") {
			out.push({ path, line, kind, module, dots, name: child.text, alias: null, original: child.text, condition });
		}
	}
	return out;
}

function collectDroppedImports(errorNode: Node, path: string, dropped: DroppedImport[]): void {
	const stack: Node[] = [errorNode];
	while (stack.length > 0) {
		const node = stack.pop() as Node;
		if (
			node.type === "import_statement" ||
			node.type === "import_from_statement" ||
			node.type === "future_import_statement"
		) {
			dropped.push({ path, line: node.startPosition.row + 1, text: node.text });
			continue;
		}
		const children = allElements(node);
		for (let index = children.length - 1; index >= 0; index--) stack.push(children[index] as Node);
	}
}

interface WalkFrame {
	node: Node;
	condition: string | null;
	scope: "module" | "local";
}

function pushChildren(stack: WalkFrame[], node: Node, condition: string | null, scope: "module" | "local"): void {
	const children = allElements(node);
	for (let index = children.length - 1; index >= 0; index--) {
		stack.push({ node: children[index] as Node, condition, scope });
	}
}

/** Push a control-flow node's branches with their condition text (rule 10). */
function pushBranches(stack: WalkFrame[], node: Node, condition: string | null, scope: "module" | "local"): boolean {
	const children = allElements(node);
	switch (node.type) {
		case "if_statement":
		case "elif_clause": {
			const prefix = node.type === "elif_clause" ? "elif " : "";
			const branch = combineCondition(condition, `${prefix}${children[0]?.text ?? ""}`);
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index] as Node;
				// The condition expression keeps the parent condition; the body takes this
				// branch; an elif/else clause keeps the parent so its own text reads
				// "elif X" / "else" rather than "ifcond && elif X".
				const childCondition = index === 0 ? condition : child.type === "block" ? branch : condition;
				stack.push({ node: child, condition: childCondition, scope });
			}
			return true;
		}
		case "else_clause": {
			pushChildren(stack, node, combineCondition(condition, "else"), scope);
			return true;
		}
		case "try_statement": {
			// The try block takes "try"; each clause node adds its own text when popped.
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index] as Node;
				const childCondition = child.type === "block" ? combineCondition(condition, "try") : condition;
				stack.push({ node: child, condition: childCondition, scope });
			}
			return true;
		}
		case "except_clause": {
			const errorTypes = children.filter((child) => child.type !== "block").map((child) => child.text);
			const branch = combineCondition(condition, `except ${errorTypes.join(", ")}`.trimEnd());
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index] as Node;
				stack.push({ node: child, condition: child.type === "block" ? branch : condition, scope });
			}
			return true;
		}
		case "finally_clause": {
			const branch = combineCondition(condition, "finally");
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index] as Node;
				stack.push({ node: child, condition: child.type === "block" ? branch : condition, scope });
			}
			return true;
		}
		case "with_statement": {
			const clause = children[0]?.text ?? "";
			const branch = combineCondition(condition, `with ${clause}`);
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index] as Node;
				stack.push({ node: child, condition: child.type === "block" ? branch : condition, scope });
			}
			return true;
		}
		case "case_clause": {
			const branch = combineCondition(condition, `case ${children[0]?.text ?? ""}`);
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index] as Node;
				stack.push({ node: child, condition: child.type === "block" ? branch : condition, scope });
			}
			return true;
		}
		default:
			return false;
	}
}

function extractModuleData(tree: Tree, path: string, dropped: DroppedImport[]): ModuleData {
	const data: ModuleData = {
		localNames: new Set(),
		hasAll: false,
		allLiterals: [],
		allNonLiteral: false,
		imports: [],
		localImports: [],
		dynamic: [],
	};
	const stack: WalkFrame[] = [{ node: tree.rootNode, condition: null, scope: "module" }];
	while (stack.length > 0) {
		const frame = stack.pop() as WalkFrame;
		const { node, condition, scope } = frame;
		if (node.type === "ERROR") {
			collectDroppedImports(node, path, dropped);
			continue;
		}
		if (
			node.type === "import_statement" ||
			node.type === "import_from_statement" ||
			node.type === "future_import_statement"
		) {
			const imports = parseImportNode(node, path, condition);
			if (scope === "module") data.imports.push(...imports);
			else {
				// Rule 23 reading: the module graph records a function- or class-local
				// import as text only (it is not an S3 exit-7 trigger and S3 does not
				// resolve it). S5 resolves it through the same machinery with
				// `resolveLocalImportNode`, so a local import still binds and resolves in
				// its own scope; only its exit-7 surfacing is withheld.
				const line = node.startPosition.row + 1;
				data.localImports.push({ path, line, text: node.text });
			}
			continue;
		}
		if (node.type === "call") {
			const callee = node.namedChild(0)?.text ?? "";
			if (callee === "__all__.append" || callee === "__all__.extend") {
				if (scope === "module") {
					data.hasAll = true;
					// The call's argument list wraps the value: `append("b")`,
					// `extend(["c", "d"])`; take the first argument.
					const args = node.namedChild(1);
					const value = args?.type === "argument_list" ? args.namedChild(0) : args;
					if (callee === "__all__.append") collectAllElement(value, data);
					else collectAllValue(value, data);
				}
			} else if (DYNAMIC_CALLEES.has(callee)) {
				data.dynamic.push({ path, line: node.startPosition.row + 1, callee, text: node.text });
			}
		}
		if (scope === "module") collectModuleDeclaration(node, data);
		if (pushBranches(stack, node, condition, scope)) continue;
		const childScope: "module" | "local" =
			node.type === "function_definition" || node.type === "class_definition" || node.type === "lambda"
				? "local"
				: scope;
		pushChildren(stack, node, condition, childScope);
	}
	return data;
}

// --- resolution ------------------------------------------------------------

interface Resolution {
	outcome: ImportOutcome;
	target: string | null;
	reason: string | null;
	exit7?: { name: string; directories: string[] };
}

interface FileIdentity {
	path: string;
	module: string;
	root: string;
	isPackage: boolean;
	packageComponents: string[];
}

interface RawResolution {
	raw: RawImport;
	outcome: ImportOutcome;
	target: string | null;
	reason: string | null;
	exit7: { name: string; directories: string[] } | null;
	id: number;
}

interface NameResolution {
	outcome: ImportOutcome;
	target: string | null;
	reason: string | null;
	/**
	 * True for a star-only fallback reason (a name that may come from a partial
	 * `import *`). It is not a real binding, so `resolveAttribute` may still try a
	 * submodule before using it (finding 1).
	 */
	starOnly?: boolean;
}

interface ExportSet {
	names: Set<string>;
	reason: string | null;
}

type TopProvider =
	| { kind: "package" | "module"; root: string }
	| { kind: "namespace" }
	| { kind: "unresolved-root"; directories: string[] }
	| { kind: "external" };

function boundNameOf(raw: RawImport): string {
	if (raw.kind === "star") return "";
	if (raw.kind === "import") return raw.alias ?? moduleComponents(raw.module)[0] ?? "";
	return raw.alias ?? raw.name ?? "";
}

function isPackageFile(path: string): boolean {
	return baseName(path) === "__init__.py";
}

function dedupeNameResolutions(list: readonly NameResolution[]): NameResolution[] {
	const seen = new Set<string>();
	const out: NameResolution[] = [];
	for (const item of list) {
		// starOnly is part of the key so a star-only fallback can never swallow an
		// otherwise identical real result.
		const key = `${item.outcome}|${item.target ?? ""}|${item.reason ?? ""}|${item.starOnly === true ? "star" : "real"}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

/**
 * Drop `starOnly` from results that pass through a real binding of the current
 * module (a from-import or an enumerated star export). The marker only means
 * "this module itself has no binding and no enumerated export" (finding 1).
 */
function clearStarOnly(list: readonly NameResolution[]): NameResolution[] {
	return list.map((item) =>
		item.starOnly === true ? { outcome: item.outcome, target: item.target, reason: item.reason } : item,
	);
}

function collapseNameResolutions(list: readonly NameResolution[]): {
	outcome: ImportOutcome;
	target: string | null;
	reason: string | null;
	alternatives: string[];
} {
	const resolved = [
		...new Set(
			list.filter((item) => item.outcome === "resolved" && item.target !== null).map((item) => item.target as string),
		),
	];
	const first = resolved[0];
	if (first !== undefined) {
		const alternatives = resolved.slice(1);
		const mixed = alternatives.length > 0 || list.some((item) => item.outcome !== "resolved");
		return { outcome: "resolved", target: first, reason: mixed ? "multiply-bound" : null, alternatives };
	}
	if (list.some((item) => item.outcome === "external")) {
		return { outcome: "external", target: null, reason: null, alternatives: [] };
	}
	return { outcome: "unresolved", target: null, reason: list[0]?.reason ?? "unresolved", alternatives: [] };
}

/** Map a single module resolution to a name resolution (no alternatives). */
function plainResolution(resolution: Resolution): NameResolution {
	if (resolution.outcome === "resolved" && resolution.target !== null) {
		return { outcome: "resolved", target: resolution.target, reason: null };
	}
	if (resolution.outcome === "external") return { outcome: "external", target: null, reason: null };
	return { outcome: "unresolved", target: null, reason: resolution.reason ?? "unresolved" };
}

/** The set of indexed .py paths plus every directory prefix, for O(1) existence checks. */
class FileIndex {
	private readonly files: Set<string>;
	private readonly directories: Set<string>;

	constructor(paths: Iterable<string>) {
		this.files = new Set(paths);
		this.directories = new Set();
		for (const path of this.files) {
			const parts = path.split("/");
			for (let index = 1; index < parts.length; index++) {
				this.directories.add(parts.slice(0, index).join("/"));
			}
		}
	}

	has(path: string): boolean {
		return this.files.has(path);
	}

	hasDir(dir: string): boolean {
		return dir === "" || this.directories.has(dir);
	}
}

class ModuleResolver {
	private readonly rawResolutions = new Map<string, RawResolution[]>();
	/**
	 * Completed export sets, memoized (finding 9). Only a set with `reason === null`
	 * is cached: a partial set's names depend on which modules are on the recursion
	 * stack, so caching one could return a stack-dependent answer later.
	 */
	private readonly exportCache = new Map<string, ExportSet>();

	constructor(
		private readonly index: FileIndex,
		private readonly roots: readonly string[],
		private readonly packageRootsByBase: Map<string, string[]>,
		private readonly identities: Map<string, FileIdentity>,
		private readonly data: Map<string, ModuleData>,
		/**
		 * Per-file nested project source roots, in resolution order (S8a, rule 2).
		 * Empty or absent for a file not beneath a nested root, and for every file
		 * of a repository with no marker, so resolution is exactly today's.
		 */
		private readonly nestedRootsByPath: ReadonlyMap<string, readonly string[]>,
	) {}

	resolveAll(): { bindings: ImportBinding[]; exit7: Exit7Trigger[] } {
		this.indexModules();
		const bindings: ImportBinding[] = [];
		const exit7: Exit7Trigger[] = [];
		const seenExit7 = new Set<string>();
		for (const [path, resolutions] of this.rawResolutions) {
			for (const resolution of resolutions) {
				if (resolution.exit7 !== null) {
					const key = `${path}|${resolution.raw.line}|${resolution.exit7.name}`;
					if (!seenExit7.has(key)) {
						seenExit7.add(key);
						exit7.push({
							path,
							line: resolution.raw.line,
							name: resolution.exit7.name,
							original: resolution.raw.original,
							directories: resolution.exit7.directories,
						});
					}
				}
				bindings.push(this.toBinding(resolution));
			}
		}
		return { bindings, exit7 };
	}

	private indexModules(): void {
		let id = 0;
		for (const [path, data] of this.data) {
			const resolutions = data.imports.map((raw) => {
				const resolution: Resolution = this.resolveModuleReference(path, raw);
				const entry: RawResolution = {
					raw,
					outcome: resolution.outcome,
					target: resolution.target,
					reason: resolution.reason,
					exit7: resolution.exit7 ?? null,
					id,
				};
				id++;
				return entry;
			});
			this.rawResolutions.set(path, resolutions);
		}
	}

	/** A star import with dots resolves relative, exactly like `from .x import *`. */
	private resolveModuleReference(path: string, raw: RawImport): Resolution {
		if (raw.kind === "future") return { outcome: "external", target: null, reason: null };
		if (raw.kind === "relative" || (raw.kind === "star" && raw.dots > 0)) {
			return this.resolveRelative(path, raw.dots, raw.module);
		}
		return this.resolveAbsolute(path, raw.module);
	}

	/**
	 * The roots an absolute import resolves over, in order (S8a, rule 2): the
	 * importing file's nested project roots first, then the repository roots. A
	 * file not beneath a nested root has none, so the list is exactly `this.roots`.
	 */
	private rootsFor(path: string): readonly string[] {
		const nested = this.nestedRootsByPath.get(path);
		return nested === undefined || nested.length === 0 ? this.roots : [...nested, ...this.roots];
	}

	private findTop(top: string, roots: readonly string[]): TopProvider {
		let sawNamespace = false;
		for (const root of roots) {
			const packageInit = joinPath(root, top, "__init__.py");
			if (this.index.has(packageInit)) return { kind: "package", root };
			const moduleFile = joinPath(root, `${top}.py`);
			if (this.index.has(moduleFile)) return { kind: "module", root };
			if (this.index.hasDir(joinPath(root, top))) sawNamespace = true;
		}
		if (sawNamespace) return { kind: "namespace" };
		const directories = this.packageRootsByBase.get(top);
		if (directories !== undefined && directories.length > 0) return { kind: "unresolved-root", directories };
		return { kind: "external" };
	}

	private walkFrom(startDir: string, parts: readonly string[]): Resolution {
		let currentDir = startDir;
		for (let index = 0; index < parts.length; index++) {
			const component = parts[index] as string;
			const packageInit = joinPath(currentDir, component, "__init__.py");
			const moduleFile = joinPath(currentDir, `${component}.py`);
			if (this.index.has(packageInit)) {
				if (index === parts.length - 1) return { outcome: "resolved", target: packageInit, reason: null };
				currentDir = joinPath(currentDir, component);
				continue;
			}
			if (this.index.has(moduleFile)) {
				if (index === parts.length - 1) return { outcome: "resolved", target: moduleFile, reason: null };
				return { outcome: "unresolved", target: null, reason: "module-not-a-package" };
			}
			if (this.index.hasDir(joinPath(currentDir, component))) {
				return { outcome: "unresolved", target: null, reason: "namespace-package" };
			}
			return { outcome: "unresolved", target: null, reason: "module-not-found" };
		}
		const init = joinPath(currentDir, "__init__.py");
		return this.index.has(init)
			? { outcome: "resolved", target: init, reason: null }
			: { outcome: "unresolved", target: null, reason: "namespace-package" };
	}

	private resolveAbsolute(file: string, module: string): Resolution {
		const parts = moduleComponents(module);
		if (parts.length === 0) return { outcome: "unresolved", target: null, reason: "empty-module" };
		const top = parts[0] as string;
		const provided = this.findTop(top, this.rootsFor(file));
		switch (provided.kind) {
			case "external":
				return { outcome: "external", target: null, reason: null };
			case "namespace":
				return { outcome: "unresolved", target: null, reason: "namespace-package" };
			case "unresolved-root":
				return {
					outcome: "unresolved",
					target: null,
					reason: "unresolved-package-root",
					exit7: { name: top, directories: provided.directories },
				};
			case "module": {
				const target = joinPath(provided.root, `${top}.py`);
				return parts.length === 1
					? { outcome: "resolved", target, reason: null }
					: { outcome: "unresolved", target: null, reason: "module-not-a-package" };
			}
			default:
				return this.walkFrom(joinPath(provided.root, top), parts.slice(1));
		}
	}

	private resolveRelative(file: string, dots: number, modulePart: string): Resolution {
		const identity = this.identities.get(file);
		if (identity === undefined) return { outcome: "unresolved", target: null, reason: "not-indexed" };
		const packageParts = identity.packageComponents;
		if (packageParts.length === 0) {
			if (!identity.isPackage || identity.module !== "") {
				return { outcome: "unresolved", target: null, reason: "no-package" };
			}
			if (dots > 1) return { outcome: "unresolved", target: null, reason: "too-many-dots" };
		} else if (dots - 1 >= packageParts.length) {
			return { outcome: "unresolved", target: null, reason: "too-many-dots" };
		}
		const keep = packageParts.length - (dots - 1);
		const base = packageParts.slice(0, keep);
		const baseDir = joinPath(identity.root, ...base);
		if (base.length > 0 && !this.index.has(joinPath(baseDir, "__init__.py"))) {
			return { outcome: "unresolved", target: null, reason: "namespace-package" };
		}
		if (modulePart === "") {
			const target = joinPath(baseDir, "__init__.py");
			return this.index.has(target)
				? { outcome: "resolved", target, reason: null }
				: { outcome: "unresolved", target: null, reason: "namespace-package" };
		}
		return this.walkFrom(baseDir, moduleComponents(modulePart));
	}

	private moduleBindingResolution(resolution: RawResolution): NameResolution {
		const raw = resolution.raw;
		// `import a.b` binds the name `a`, which is the package a/__init__.py, not the
		// leaf a/b.py; `import a.b as c` binds the leaf, so only the unaliased dotted
		// form is redirected to the top package (finding 4).
		if (raw.kind === "import" && raw.alias === null) {
			const parts = moduleComponents(raw.module);
			if (parts.length > 1) {
				if (resolution.outcome === "external") return { outcome: "external", target: null, reason: null };
				if (resolution.outcome === "resolved" && resolution.target !== null) {
					return plainResolution(this.resolveAbsolute(raw.path, parts[0] as string));
				}
			}
		}
		return plainResolution({
			outcome: resolution.outcome,
			target: resolution.target,
			reason: resolution.reason,
		});
	}

	/**
	 * Resolve a name's definition inside one module, following re-export chains
	 * (rule 8) and star imports (rule 9). `exclude` omits the from-import binding
	 * currently being followed, so `from . import b` in `pkg/__init__.py` reaches
	 * the submodule instead of recursing into itself.
	 */
	private resolveName(
		modulePath: string,
		name: string,
		visited: Set<string>,
		exclude: RawResolution | null,
		depth: number,
	): NameResolution[] {
		if (depth > 64) return [{ outcome: "unresolved", target: null, reason: "depth-limit" }];
		const key = `name:${modulePath}#${name}@${exclude?.id ?? "none"}`;
		if (visited.has(key)) return [{ outcome: "unresolved", target: null, reason: "import-cycle" }];
		visited.add(key);
		try {
			const moduleData = this.data.get(modulePath);
			if (moduleData === undefined) return [{ outcome: "unresolved", target: null, reason: "not-indexed" }];
			const results: NameResolution[] = [];
			const starReasons: string[] = [];
			if (moduleData.localNames.has(name)) results.push({ outcome: "resolved", target: modulePath, reason: null });
			for (const resolution of this.rawResolutions.get(modulePath) ?? []) {
				if (resolution === exclude) continue;
				const raw = resolution.raw;
				if (raw.kind === "star") {
					if (resolution.outcome === "resolved" && resolution.target !== null) {
						const exports = this.moduleExports(resolution.target, visited);
						if (exports.names.has(name)) {
							results.push(...clearStarOnly(this.resolveName(resolution.target, name, visited, null, depth + 1)));
						}
						// A partial set means `name` may come from the part we could not
						// enumerate; carry its reason instead of attribute-not-found.
						if (exports.reason !== null) starReasons.push(exports.reason);
					} else if (resolution.outcome === "external") {
						starReasons.push("star-import");
					} else {
						starReasons.push(resolution.reason ?? "unresolved");
					}
					continue;
				}
				if (boundNameOf(raw) !== name) continue;
				if (raw.kind === "import") {
					results.push(this.moduleBindingResolution(resolution));
				} else if (resolution.outcome === "external") {
					results.push({ outcome: "external", target: null, reason: null });
				} else if (resolution.outcome === "unresolved" || resolution.target === null) {
					results.push({ outcome: "unresolved", target: null, reason: resolution.reason ?? "unresolved" });
				} else if (raw.name !== null) {
					results.push(
						...clearStarOnly(this.resolveAttribute(resolution.target, raw.name, visited, resolution, depth + 1)),
					);
				}
			}
			if (results.length === 0 && starReasons.length > 0) {
				results.push({ outcome: "unresolved", target: null, reason: starReasons[0] as string, starOnly: true });
			}
			return dedupeNameResolutions(results);
		} finally {
			visited.delete(key);
		}
	}

	/** Resolve `name` against a module: its own bindings, a re-export, or a submodule. */
	private resolveAttribute(
		targetPath: string,
		name: string,
		visited: Set<string>,
		fromRaw: RawResolution | null,
		depth: number,
	): NameResolution[] {
		const direct = this.resolveName(targetPath, name, visited, fromRaw, depth);
		// From-import order is binding, then submodule, then attribute-not-found.
		// A real result (resolved, external or a binding's own unresolved reason)
		// outranks a submodule; a star-only fallback reason does not, so the
		// submodule is tried first (finding 1).
		if (direct.some((item) => item.starOnly !== true)) return direct;
		if (isPackageFile(targetPath)) {
			const dir = dirOf(targetPath);
			const packageInit = joinPath(dir, name, "__init__.py");
			if (this.index.has(packageInit)) return [{ outcome: "resolved", target: packageInit, reason: null }];
			const moduleFile = joinPath(dir, `${name}.py`);
			if (this.index.has(moduleFile)) return [{ outcome: "resolved", target: moduleFile, reason: null }];
			if (this.index.hasDir(joinPath(dir, name))) {
				return [{ outcome: "unresolved", target: null, reason: "namespace-package" }];
			}
		}
		return direct.length > 0 ? direct : [{ outcome: "unresolved", target: null, reason: "attribute-not-found" }];
	}

	/** A module's exported names for a star import (rule 9). */
	private moduleExports(modulePath: string, visited: Set<string>): ExportSet {
		const cached = this.exportCache.get(modulePath);
		if (cached !== undefined) return cached;
		const key = `exports:${modulePath}`;
		if (visited.has(key)) return { names: new Set(), reason: "import-cycle" };
		visited.add(key);
		try {
			const moduleData = this.data.get(modulePath);
			if (moduleData === undefined) return { names: new Set(), reason: "not-indexed" };
			if (moduleData.hasAll) {
				if (moduleData.allNonLiteral) return { names: new Set(), reason: "non-literal-all" };
				const complete: ExportSet = { names: new Set(moduleData.allLiterals), reason: null };
				this.exportCache.set(modulePath, complete);
				return complete;
			}
			const names = new Set<string>();
			let reason: string | null = null;
			for (const local of moduleData.localNames) {
				if (!local.startsWith("_")) names.add(local);
			}
			for (const resolution of this.rawResolutions.get(modulePath) ?? []) {
				const raw = resolution.raw;
				if (raw.kind === "star") {
					if (resolution.outcome === "resolved" && resolution.target !== null) {
						// Propagate the first nested reason so a partial set is never
						// reported as complete (finding 3); the names found so far stand.
						const nested = this.moduleExports(resolution.target, visited);
						for (const name of nested.names) names.add(name);
						if (reason === null && nested.reason !== null) reason = nested.reason;
					} else if (reason === null) {
						reason = resolution.outcome === "external" ? "star-import" : (resolution.reason ?? "unresolved");
					}
					continue;
				}
				const bound = boundNameOf(raw);
				if (bound !== "" && bound !== "*" && !bound.startsWith("_")) names.add(bound);
			}
			const result: ExportSet = { names, reason };
			if (reason === null) this.exportCache.set(modulePath, result);
			return result;
		} finally {
			visited.delete(key);
		}
	}

	private toBinding(resolution: RawResolution): ImportBinding {
		const raw = resolution.raw;
		const base = {
			path: raw.path,
			line: raw.line,
			kind: raw.kind,
			module: raw.module,
			dots: raw.dots,
			name: raw.name,
			alias: raw.alias,
			original: raw.original,
			boundName: boundNameOf(raw),
			condition: raw.condition,
		};
		if (raw.kind === "future") {
			return { ...base, target: null, outcome: "external", reason: null, alternatives: [], starNames: [] };
		}
		if (raw.kind === "import") {
			return {
				...base,
				target: resolution.target,
				outcome: resolution.outcome,
				reason: resolution.reason,
				alternatives: [],
				starNames: [],
			};
		}
		if (raw.kind === "star") {
			if (resolution.outcome === "external") {
				return { ...base, target: null, outcome: "unresolved", reason: "star-import", alternatives: [], starNames: [] };
			}
			if (resolution.outcome === "unresolved" || resolution.target === null) {
				return {
					...base,
					target: null,
					outcome: "unresolved",
					reason: resolution.reason ?? "unresolved",
					alternatives: [],
					starNames: [],
				};
			}
			const exports = this.moduleExports(resolution.target, new Set([`exports:${raw.path}`]));
			const starNames = [...exports.names].sort();
			return exports.reason === null
				? { ...base, target: resolution.target, outcome: "resolved", reason: null, alternatives: [], starNames }
				: {
						...base,
						target: resolution.target,
						outcome: "unresolved",
						reason: exports.reason,
						alternatives: [],
						starNames,
					};
		}
		if (resolution.outcome === "external") {
			return { ...base, target: null, outcome: "external", reason: null, alternatives: [], starNames: [] };
		}
		if (resolution.outcome === "unresolved" || resolution.target === null) {
			return {
				...base,
				target: null,
				outcome: "unresolved",
				reason: resolution.reason ?? "unresolved",
				alternatives: [],
				starNames: [],
			};
		}
		if (raw.name === null) {
			return {
				...base,
				target: resolution.target,
				outcome: "resolved",
				reason: null,
				alternatives: [],
				starNames: [],
			};
		}
		const collapsed = collapseNameResolutions(this.resolveAttribute(resolution.target, raw.name, new Set(), null, 0));
		return {
			...base,
			target: collapsed.target,
			outcome: collapsed.outcome,
			reason: collapsed.reason,
			alternatives: collapsed.alternatives,
			starNames: [],
		};
	}

	/**
	 * Rule 23 (S5): resolve one function- or class-local import with exactly the
	 * module-level machinery. The outcome is S3's; a local import is not a new
	 * reason. Its `exit7` is deliberately not surfaced: a lazily imported
	 * first-party package does not become an indeterminate trigger (the S3 limit
	 * stated at extraction still holds).
	 */
	resolveLocal(raw: RawImport): ImportBinding {
		const resolution: Resolution = this.resolveModuleReference(raw.path, raw);
		return this.toBinding({
			raw,
			outcome: resolution.outcome,
			target: resolution.target,
			reason: resolution.reason,
			exit7: null,
			id: -1,
		});
	}
}

/**
 * The resolver behind a graph, so S5 can resolve a local import through the same
 * code path S3 uses for module-level ones (rule 23). A WeakMap keeps it off the
 * `ModuleGraph` data shape.
 */
const resolverByGraph = new WeakMap<ModuleGraph, ModuleResolver>();

/**
 * Parse and resolve the imports in one function- or class-body import statement
 * (rule 23). Returns one `ImportBinding` per imported name, resolved by S3.
 * Empty when the statement's parse yielded no import form.
 */
export function resolveLocalImportNode(graph: ModuleGraph, path: string, node: Node): ImportBinding[] {
	const resolver = resolverByGraph.get(graph);
	if (resolver === undefined) return [];
	return parseImportNode(node, path, null).map((raw) => resolver.resolveLocal(raw));
}

// --- public entry point ----------------------------------------------------

interface IndexedFile {
	path: string;
	bytes: Uint8Array;
	/** Path-math root: "" for an outside-root file, the nested project source root, or its declared root. */
	root: string;
	rootIndex: number;
	module: string;
	isPackage: boolean;
	/** True when no declared root covers the file (its record root is OUTSIDE_ROOTS_ROOT). */
	outsideRoots: boolean;
	/** True when the file's root is a nested project root (S8a); it never competes in collisions. */
	nested: boolean;
}

interface Provider {
	path: string;
	module: string;
	rootIndex: number;
	isPackage: boolean;
}

function byPathThenLine(a: { path: string; line: number }, b: { path: string; line: number }): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	return a.line - b.line;
}

/**
 * Build the Python module graph and resolve every module-level import.
 *
 * Input bytes only: each `.py` is parsed with `parsePython`, and the tree is
 * freed once its bindings are extracted. A file with no imports still appears
 * in `files`; a repository with no Python files yields zeroed counts rather
 * than an empty, silent answer.
 */
export async function buildModuleGraph(
	files: readonly PythonModuleInput[],
	options: ModuleGraphOptions = {},
): Promise<ModuleGraph> {
	const ignored: IgnoredInput[] = [];
	const seenPaths = new Set<string>();
	const candidates: { path: string; bytes: Uint8Array }[] = [];
	const rules = exclusionRules(options.excludedDirs);
	const entries = files.map((file) => ({ path: normalizePath(file.path), bytes: file.bytes }));
	// Every input directory holding __init__.py, including paths that will be
	// excluded, so a root-level build-output name can tell a package from output
	// (DEC-303 (a7), NB11).
	const allPackageDirs = new Set<string>();
	for (const entry of entries) {
		if (baseName(entry.path) === "__init__.py") allPackageDirs.add(dirOf(entry.path));
	}

	for (const entry of entries) {
		const path = entry.path;
		if (seenPaths.has(path)) {
			ignored.push({ path, reason: "duplicate" });
			continue;
		}
		seenPaths.add(path);
		if (path.endsWith(".pyi")) {
			ignored.push({ path, reason: "stub" });
			continue;
		}
		if (!path.endsWith(".py")) {
			ignored.push({ path, reason: "non-python" });
			continue;
		}
		if (isExcludedPath(path, rules, allPackageDirs)) {
			ignored.push({ path, reason: "excluded-path" });
			continue;
		}
		candidates.push({ path, bytes: entry.bytes });
	}

	const roots = rootOrderRoots(
		candidates.map((candidate) => candidate.path),
		options.roots,
	);
	// DEC-303 (a7) clause 3 (ruling 10): a file outside every declared root is
	// still parsed and indexed; only resolution is restricted to the roots. It
	// takes a distinct root label (OUTSIDE_ROOTS_ROOT on the record, "" for path
	// math) and an index after every real root; it never competes in shadow
	// collisions (finding 3).
	const outsideRootIndex = roots.length;
	const rootLabels = [...roots, OUTSIDE_ROOTS_ROOT];
	// S8a (DEC-303 (a18)): nested project roots, supplied by the caller's listing.
	// A file beneath the nearest one resolves over that root's own "", src and lib
	// first, then over the repository roots; a file beneath none is unchanged.
	const nestedRoots = nestedProjectRoots(options.markerDirs, rules, allPackageDirs);
	const nestedRootsByPath = new Map<string, readonly string[]>();
	const indexed: IndexedFile[] = [];
	for (const candidate of candidates) {
		const fileNestedRoots = nestedSourceRoots(candidate.path, nestedRoots);
		let root: string;
		let rootIndex: number;
		let outsideRoots: boolean;
		let nested = false;
		if (fileNestedRoots.length > 0) {
			const found = selectRoot(candidate.path, fileNestedRoots);
			if (found < 0) {
				// Rule 7: beneath a nested root but under none of its own source roots
				// keeps the outside-every-root rules. Unreachable while "" is a nested
				// source root; kept so the reading is explicit rather than implied.
				outsideRoots = true;
				rootIndex = outsideRootIndex;
				root = "";
			} else {
				outsideRoots = false;
				nested = true;
				// Nested files' roots are local to their subtree, so they never compete
				// in the global collision/shadow computation and need no root label.
				rootIndex = roots.length;
				root = fileNestedRoots[found] as string;
				nestedRootsByPath.set(candidate.path, fileNestedRoots);
			}
		} else {
			const found = selectRoot(candidate.path, roots);
			outsideRoots = found < 0;
			rootIndex = outsideRoots ? outsideRootIndex : found;
			root = outsideRoots ? "" : (roots[found] as string);
		}
		indexed.push({
			...candidate,
			root,
			rootIndex,
			module: moduleNameFor(candidate.path, root),
			isPackage: baseName(candidate.path) === "__init__.py",
			outsideRoots,
			nested,
		});
	}
	indexed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	ignored.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const identities = new Map<string, FileIdentity>();
	for (const file of indexed) {
		identities.set(file.path, {
			path: file.path,
			module: file.module,
			root: file.root,
			isPackage: file.isPackage,
			packageComponents: file.isPackage ? moduleComponents(file.module) : moduleComponents(file.module).slice(0, -1),
		});
	}

	// Rules 1 and 15: the first root providing a top-level name wins; every
	// later provider of that name is shadowed, counted and named. Outside-root
	// files have no root and never compete (finding 3), and a nested project
	// root's files are local to their subtree (S8a rule 3), so neither competes:
	// excluding them keeps counts.collisions/counts.shadowed honest.
	const providers: Provider[] = indexed
		.filter((file) => !file.outsideRoots && !file.nested)
		.map((file) => ({
			path: file.path,
			module: file.module,
			rootIndex: file.rootIndex,
			isPackage: file.isPackage,
		}));
	const byTop = new Map<string, Provider[]>();
	for (const provider of providers) {
		const top = moduleComponents(provider.module)[0] ?? "";
		if (top === "") continue;
		const list = byTop.get(top) ?? [];
		list.push(provider);
		byTop.set(top, list);
	}
	const shadowedPaths = new Set<string>();
	const collisions: NameCollision[] = [];
	for (const [top, list] of byTop) {
		// Only a root's entry for the top-level name itself ("<top>/__init__.py"
		// or "<top>.py") competes; its submodules belong to that entry. A nested
		// pkg/sub.py beside pkg/sub/__init__.py is resolved package-first but is not
		// counted as shadowed — a stated limit, since only top-level entries compete.
		const topEntries = list.filter((provider) => provider.module === top);
		const winnerPerRoot = new Map<number, Provider>();
		const losersWithinRoot: Provider[] = [];
		for (const provider of topEntries) {
			const existing = winnerPerRoot.get(provider.rootIndex);
			if (existing === undefined) {
				winnerPerRoot.set(provider.rootIndex, provider);
				continue;
			}
			// One root offering both a package and a bare module: the package wins.
			const winner = existing.isPackage || !provider.isPackage ? existing : provider;
			const loser = winner === existing ? provider : existing;
			winnerPerRoot.set(provider.rootIndex, winner);
			losersWithinRoot.push(loser);
		}
		const rootIndexes = [...winnerPerRoot.keys()].sort((a, b) => a - b);
		const winnerIndex = rootIndexes[0];
		if (winnerIndex === undefined) continue;
		const shadowed: string[] = [];
		if (rootIndexes.length > 1) {
			for (const provider of list) {
				if (provider.rootIndex <= winnerIndex) continue;
				shadowedPaths.add(provider.path);
				shadowed.push(provider.path);
			}
			collisions.push({
				name: top,
				roots: rootIndexes.map((rootIndex) => rootLabels[rootIndex] as string),
				winner: rootLabels[winnerIndex] as string,
				shadowedPaths: [...shadowed, ...losersWithinRoot.map((provider) => provider.path)].sort(),
			});
		}
		for (const provider of losersWithinRoot) shadowedPaths.add(provider.path);
	}

	// Parse every indexed file; imports inside an ERROR region are dropped and
	// named, and any file with an ERROR/MISSING or a decode replacement is not exact.
	const data = new Map<string, ModuleData>();
	const droppedByError: DroppedImport[] = [];
	const parseIssues: ParseIssue[] = [];
	for (const file of indexed) {
		const result = await parsePython(file.bytes, file.path);
		try {
			data.set(file.path, extractModuleData(result.tree, file.path, droppedByError));
		} finally {
			result.tree.delete();
		}
		if (result.hasError || result.decodeReplacements > 0) {
			parseIssues.push({
				path: file.path,
				hasError: result.hasError,
				errorCount: result.errorCount,
				missingCount: result.missingCount,
				decodeReplacements: result.decodeReplacements,
				exact: false,
			});
		}
	}

	// DEC-303 (a7) clause 1: the guard's first-party package set comes from ALL
	// non-excluded candidates, whatever roots are declared, so declaring roots
	// never switches it off for a package outside them. A package directory is a
	// root only when NO ancestor up to the repository root holds __init__.py
	// (pkg/ns/inner is pkg.ns.inner, not topmost), it is not inside a test-named
	// directory (tests/json is not a root), and, per clause 2, "" is never a
	// parent package. So a nested stdlib-named subpackage (django/http,
	// sqlalchemy/ext/asyncio) cannot turn `import json` into exit 7.
	const packageDirs = new Set<string>();
	for (const candidate of candidates) {
		if (baseName(candidate.path) === "__init__.py") packageDirs.add(dirOf(candidate.path));
	}
	const packageRootsByBase = new Map<string, string[]>();
	for (const dir of packageDirs) {
		if (dir === "") continue;
		if (isInsideTestNamedDir(dir)) continue;
		if (hasPackageAncestor(dir, packageDirs)) continue;
		const base = baseName(dir);
		const list = packageRootsByBase.get(base) ?? [];
		list.push(dir);
		packageRootsByBase.set(base, list);
	}
	for (const list of packageRootsByBase.values()) list.sort();

	const resolver = new ModuleResolver(
		new FileIndex(indexed.map((file) => file.path)),
		roots,
		packageRootsByBase,
		identities,
		data,
		nestedRootsByPath,
	);
	const { bindings, exit7 } = resolver.resolveAll();
	bindings.sort((a, b) => byPathThenLine(a, b) || (a.original < b.original ? -1 : a.original > b.original ? 1 : 0));

	const importsByPath = new Map<string, ImportBinding[]>();
	for (const binding of bindings) {
		const list = importsByPath.get(binding.path) ?? [];
		list.push(binding);
		importsByPath.set(binding.path, list);
	}

	const modules: PythonModuleRecord[] = indexed.map((file) => ({
		path: file.path,
		module: file.module,
		root: file.outsideRoots ? OUTSIDE_ROOTS_ROOT : file.root,
		isPackage: file.isPackage,
		package: packageNameFor(file.module, file.isPackage),
		shadowed: shadowedPaths.has(file.path),
		outsideRoots: file.outsideRoots,
	}));

	const unresolved: UnresolvedImport[] = bindings
		.filter((binding) => binding.outcome === "unresolved")
		.map((binding) => ({
			path: binding.path,
			line: binding.line,
			module: binding.module,
			dots: binding.dots,
			name: binding.name,
			reason: binding.reason ?? "unresolved",
			// Rule 3: a namespace package is not first-party, so it is counted but not
			// reported as a first-party gap. A star import of an external module is the
			// other non-first-party bin.
			firstParty: binding.reason !== "star-import" && binding.reason !== "namespace-package",
		}));

	const dynamic: DynamicImport[] = [];
	const localImports: LocalImport[] = [];
	for (const moduleData of data.values()) {
		dynamic.push(...moduleData.dynamic);
		localImports.push(...moduleData.localImports);
	}
	dynamic.sort(byPathThenLine);
	localImports.sort(byPathThenLine);
	droppedByError.sort(byPathThenLine);
	parseIssues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const counts: ModuleGraphCounts = {
		files: indexed.length,
		modules: modules.length,
		packages: modules.filter((module) => module.isPackage).length,
		imports: bindings.length,
		resolved: bindings.filter((binding) => binding.outcome === "resolved").length,
		external: bindings.filter((binding) => binding.outcome === "external").length,
		unresolved: unresolved.length,
		unresolvedFirstParty: unresolved.filter((entry) => entry.firstParty).length,
		dynamic: dynamic.length,
		exit7: exit7.length,
		collisions: collisions.length,
		shadowed: shadowedPaths.size,
		ignored: ignored.length,
		parseIssueFiles: parseIssues.length,
		decodeReplacementFiles: parseIssues.filter((issue) => issue.decodeReplacements > 0).length,
		droppedImports: droppedByError.length,
		localImports: localImports.length,
		duplicates: ignored.filter((entry) => entry.reason === "duplicate").length,
	};

	const graph: ModuleGraph = {
		// Exactness (rule 14) covers parse and decode only; a non-empty exit7 is a
		// separate indeterminate signal the wiring slice must check (exit7.length)
		// rather than read `exact` alone.
		exact: parseIssues.length === 0,
		modules,
		files: indexed.map((file) => ({
			path: file.path,
			module: file.module,
			imports: importsByPath.get(file.path) ?? [],
		})),
		bindings,
		unresolved,
		exit7,
		dynamic,
		collisions,
		shadowed: [...shadowedPaths].sort(),
		ignored,
		parseIssues,
		droppedByError,
		localImports,
		counts,
	};
	resolverByGraph.set(graph, resolver);
	return graph;
}
