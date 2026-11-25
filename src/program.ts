import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { cacheDir, clearCache, computeKey, computeRefKey, readCachedIndex, writeCachedIndex } from "./cache.ts";
import {
	buildManifest,
	COMMANDS,
	type CommandName,
	type EnvelopeErrorType,
	errorEnvelope,
	globalKindOf,
	itemKindOf,
	kindOf,
	languageFlagSummary,
	STREAMING_COMMANDS,
	successEnvelope,
} from "./contract.ts";
import { exitCodeFor, GlyphError, notFoundError, usageError } from "./errors.ts";
import { parseDiff, repoRootFor, resolveCommit, resolveDiffRefs } from "./git.ts";
import type { ImpactCaller, ImpactResult } from "./impact.ts";
import { impactOf } from "./impact.ts";
import { produceCodeMap } from "./codemap.ts";
import {
	cacheScopeOf,
	fileCountLabel,
	indexRefWith,
	indexWith,
	isDefaultLanguage,
	type LanguageSelection,
	registeredLanguages,
	selectFromPresence,
	selectLanguage,
} from "./language.ts";
import {
	type CallerSite,
	callerSymbolRow,
	callerSites,
	callersOf,
	display,
	resolveSymbol,
	symbolRow,
	touchedSymbols,
} from "./queries.ts";
import { languageFilesAtRef } from "./snapshot.ts";
import { codeMapStreamResultData, createStreamWriter, streamResultData } from "./stream.ts";
import type { GlyphIndex, IndexInfo, SymbolEntry, UnresolvedByKind } from "./types.ts";

/**
 * Glyph's command surface and machine contract.
 *
 * Contract, stated once here because scripts branch on it:
 * - stdout carries exactly one success envelope (JSON under --json, human text
 *   otherwise); on failure stdout carries no result envelope (under --stream the
 *   item lines already written stay) and stderr carries the error — under --json
 *   and --stream, an `{error_type, message, principal}` object.
 * - every JSON payload carries `principal: null` as its last top-level key.
 * - exit codes are the frozen Opum family (see src/errors.ts), and the `kind`
 *   registry is the live source `glyph help --json` publishes.
 *
 * `buildProgram` lives here rather than beside the entry point so a test can
 * walk the registered commands without running the CLI.
 */

const HELP_EPILOGUE = `
Examples:
  glyph callers buildReport
  glyph callers parseDiff --file src/git.ts
  glyph impact buildIndex
  glyph impact buildIndex --depth 3
  glyph impact buildIndex --all --ref main
  glyph diff main
  glyph diff v0.1.0 HEAD
  glyph cache path
  glyph help --json
`;

/** The depth `glyph impact` answers at when neither --depth nor --all is given. */
const DEFAULT_IMPACT_DEPTH = 5;

interface Context {
	repoRoot: string;
	json: boolean;
	/** `--stream`: the NDJSON variant of `--json` (§1a). */
	stream: boolean;
	/** `--language <id>`: index this language instead of the detected one. */
	language?: string;
}

function readVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function contextOf(scanned: ScannedArgs): Context {
	const dir = resolve(scanned.repo ?? process.cwd());
	return {
		repoRoot: repoRootFor(dir) ?? dir,
		json: scanned.json,
		stream: scanned.stream,
		...(scanned.language === undefined ? {} : { language: scanned.language }),
	};
}

interface LoadedIndex {
	index: GlyphIndex;
	info: IndexInfo;
	/** Set only under `impact --ref`: the ref as written and the commit it named. */
	ref: { ref: string; sha: string } | null;
}

/**
 * The index a command answers from: the working tree by default, or the tree
 * of `--ref`'s commit, read without a checkout (DEC-216 Q4). The two sources
 * share the cache directory but never a key — the ref key is addressed by the
 * commit rather than by file stats, so a dirty checkout cannot answer for it.
 *
 * Asynchronous because the registered Python indexer loads its grammar through
 * wasm; every caller awaits it (S7 rule 1). A Python key adds the language
 * scope, so a change of language, analyzer version or grammar version misses
 * (rule 6); TypeScript passes no scope, so its key is unchanged.
 */
async function loadIndex(context: Context, ref?: string): Promise<LoadedIndex> {
	// An explicit language is validated before either source, so a `--ref` run
	// cannot silently ignore an unregistered id the working-tree path would reject.
	if (context.language !== undefined && !registeredLanguages().includes(context.language)) {
		throw usageError(
			`cannot index language '${context.language}'; registered languages: ${registeredLanguages().join(", ")}`,
		);
	}
	if (ref !== undefined) {
		const sha = resolveCommit(context.repoRoot, ref);
		if (sha === null) {
			throw notFoundError(`could not resolve '${ref}' to a commit in ${context.repoRoot}`);
		}
		// The ref's tree is listed once for both the cache key and the language
		// coverage: the selection carries the files to index and any recognised
		// language this run does not index, exactly as the working-tree path does.
		const present = languageFilesAtRef(context.repoRoot, sha);
		const selection = selectFromPresence(present, context.language, {
			where: `at ${ref} (${shortSha(sha)}) in ${context.repoRoot}`,
			emptyMessage: `no TypeScript or JavaScript sources at ${ref} (${shortSha(sha)}) in ${context.repoRoot}`,
		});
		const files = selection.files;
		const key = computeRefKey(sha, files, cacheScopeOf(selection.id));
		const cached = readCachedIndex(context.repoRoot, key);
		if (cached !== null) return { index: cached, info: infoOf(cached, "hit", selection), ref: { ref, sha } };
		const index = await indexRefWith(selection.id, context.repoRoot, sha, files);
		writeCachedIndex(context.repoRoot, key, index);
		return { index, info: infoOf(index, "miss", selection), ref: { ref, sha } };
	}
	const selection = selectLanguage(context.repoRoot, context.language);
	const files = selection.files;
	const key = computeKey(context.repoRoot, files, cacheScopeOf(selection.id));
	const cached = readCachedIndex(context.repoRoot, key);
	if (cached !== null) return { index: cached, info: infoOf(cached, "hit", selection), ref: null };
	const index = await indexWith(selection.id, context.repoRoot, files);
	writeCachedIndex(context.repoRoot, key, index);
	return { index, info: infoOf(index, "miss", selection), ref: null };
}

function infoOf(index: GlyphIndex, cache: "hit" | "miss", selection?: LanguageSelection): IndexInfo {
	const info: IndexInfo = {
		cache,
		files: index.files.length,
		symbols: index.symbols.length,
		sites: index.sites.length,
	};
	// The additive language entries are ABSENT on the plain TypeScript answer, so
	// a repository with no recognised non-TypeScript source keeps its exact bytes.
	if (selection !== undefined && !isDefaultLanguage(selection)) {
		info.language = selection.id;
		if (selection.notIndexed.length > 0) info.notIndexed = selection.notIndexed;
	}
	return info;
}

/**
 * code-map's tier-3 index, prebuilt through the seam when the source ref's
 * selected language needs an asynchronous build (Python; the Python grammar
 * loads through wasm). TypeScript returns undefined, so its deterministic
 * synchronous path is byte-for-byte unchanged. A ref that does not resolve, or
 * one with no indexable source, returns undefined: tiers 1, 2 and 4 still
 * answer, and `produceCodeMap` reports an unresolvable ref itself.
 */
async function codeMapRefIndex(
	context: Context,
	sourceRef: string,
): Promise<{ commit: string; index: GlyphIndex } | undefined> {
	const sha = resolveCommit(context.repoRoot, sourceRef);
	if (sha === null) return undefined;
	let selection: LanguageSelection;
	try {
		selection = selectFromPresence(languageFilesAtRef(context.repoRoot, sha), undefined, {
			where: `at ${sourceRef} (${shortSha(sha)}) in ${context.repoRoot}`,
			emptyMessage: `no TypeScript or JavaScript sources at ${sourceRef} (${shortSha(sha)}) in ${context.repoRoot}`,
		});
	} catch (error) {
		if (error instanceof GlyphError && error.code === 3) return undefined;
		throw error;
	}
	if (cacheScopeOf(selection.id) === undefined) return undefined;
	const index = await indexRefWith(selection.id, context.repoRoot, sha, selection.files);
	return { commit: sha, index };
}

function emit(json: boolean, kind: string, data: unknown, renderHuman: () => string): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(successEnvelope(kind, data), null, 2)}\n`);
	} else {
		process.stdout.write(`${renderHuman()}\n`);
	}
}

/** One `callers` list element. Shared by the batch and streamed forms so they cannot drift. */
function callerRow(site: CallerSite): {
	file: string;
	line: number;
	column: number;
	kind: string;
	caller: ReturnType<typeof callerSymbolRow> | null;
} {
	return {
		file: site.file,
		line: site.line,
		column: site.column,
		kind: site.kind,
		caller: site.caller === null ? null : callerSymbolRow(site.caller),
	};
}

/**
 * The Python-only index counts, carried beside `unresolvedByKind` when the
 * index has them and ABSENT otherwise, so a TypeScript answer keeps its exact
 * bytes (DEC-303 (a14) 3).
 */
function pythonCounts(index: GlyphIndex): Record<string, unknown> {
	const counts: Record<string, unknown> = {};
	if (index.callBins !== undefined) counts.callBins = index.callBins;
	if (index.unresolvedFirstPartyImports !== undefined) {
		counts.unresolvedFirstPartyImports = index.unresolvedFirstPartyImports;
	}
	if (index.constructorNotes !== undefined) counts.constructorNotes = index.constructorNotes;
	return counts;
}

/** One reported impact caller, projected so no index-only symbol field can leak. */
function impactCallerRow(caller: ImpactCaller): Omit<ImpactCaller, "symbol"> & {
	symbol: ReturnType<typeof symbolRow> | null;
} {
	return { ...caller, symbol: caller.symbol === null ? null : symbolRow(caller.symbol) };
}

/** The human-only Python coverage line, absent (so TypeScript text is unchanged) unless the index carries the counts. */
function pythonCoverageLine(index: GlyphIndex): string | null {
	const bins = index.callBins;
	if (bins === undefined) return null;
	return `  python coverage: call bins resolved in repo ${bins.resolvedInRepo}, resolved external ${bins.resolvedExternal}, receiver needs inference ${bins.receiverNeedsInference}, name not bound ${bins.nameNotBound}; unresolved first-party imports ${index.unresolvedFirstPartyImports ?? 0}; constructor notes ${index.constructorNotes ?? 0}`;
}

/** `callers --stream`: items as the site scan finds them, then the result line. */
function streamCallers(index: GlyphIndex, symbol: SymbolEntry, info: IndexInfo): void {
	const writer = createStreamWriter();
	const files = new Set<string>();
	let count = 0;
	for (const site of callerSites(index, symbol)) {
		files.add(site.file);
		writer.item(itemKindOf("callers"), callerRow(site));
		count += 1;
	}
	writer.result(kindOf("callers"), {
		symbol: symbolRow(symbol),
		totals: { callers: count, files: files.size },
		...pythonCounts(index),
		index: info,
		itemCount: count,
	});
}

/**
 * `impact --stream`: items once the walk has finalized. The caller list cannot be
 * emitted as found, because a caller's `cycle` flag is decided by SCCs over the
 * closure after the breadth-first search completes (ADR 0006 says so plainly).
 */
function streamImpact(
	index: GlyphIndex,
	symbol: SymbolEntry,
	result: ImpactResult,
	ref: LoadedIndex["ref"],
	depth: number | null,
	info: IndexInfo,
): void {
	const writer = createStreamWriter();
	const callers = result.callers.map(impactCallerRow);
	for (const caller of callers) writer.item(itemKindOf("impact"), caller);
	writer.result(
		kindOf("impact"),
		streamResultData(
			{
				symbol: symbolRow(symbol),
				ref,
				depth: { bound: depth, all: depth === null },
				callers,
				cycle: result.cycle,
				truncated: result.truncated,
				unexplored: result.unexplored,
				total: result.total,
				resolvedSites: index.sites.length,
				unresolvedSites: index.unresolvedSites,
				unresolvedByKind: index.unresolvedByKind,
				...pythonCounts(index),
				totals: { callers: callers.length, byDepth: byDepth(result.callers) },
				index: info,
			},
			"callers",
			callers.length,
		),
	);
}

function indexLine(info: IndexInfo): string {
	const base = `index: ${info.files} files, ${info.symbols} symbols, ${info.sites} sites (cache ${info.cache})`;
	// The "language not indexed" coverage entry (ADR 0008). Absent — so the line
	// is byte-identical — when every recognised language in scope was indexable.
	if (info.notIndexed === undefined || info.notIndexed.length === 0) return base;
	const named = info.notIndexed.map((entry) => `${entry.language} (${fileCountLabel(entry.files)})`).join(", ");
	return `${base}; language not indexed: ${named}`;
}

function unresolvedLine(by: UnresolvedByKind): string {
	return `call ${by.call}, import ${by.import}, extends ${by.extends}, implements ${by.implements}, dynamic ${by.dynamic}`;
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

/** `--depth` takes a positive integer and is exclusive with `--all`. */
function depthOf(raw: string | undefined, all: boolean): number | null {
	if (all) {
		if (raw !== undefined) throw usageError("--depth and --all are mutually exclusive");
		return null;
	}
	if (raw === undefined) return DEFAULT_IMPACT_DEPTH;
	if (!/^[1-9][0-9]*$/.test(raw)) throw usageError(`--depth expects a positive integer, got '${raw}'`);
	return Number.parseInt(raw, 10);
}

function labelOf(id: string | null, byId: Map<string, SymbolEntry>): string {
	if (id === null) return "module scope";
	const symbol = byId.get(id);
	return symbol === undefined ? id : display(symbol);
}

/** The caller's chosen shortest path, rendered `caller -> ... -> target`. */
function pathLabel(caller: ImpactCaller, byId: Map<string, SymbolEntry>): string {
	const first = caller.path[0];
	if (first === undefined) return "";
	return [labelOf(first.callerId, byId), ...caller.path.map((edge) => labelOf(edge.calleeId, byId))].join(" -> ");
}

function byDepth(callers: readonly ImpactCaller[]): Record<string, number> {
	const counts = new Map<number, number>();
	for (const caller of callers) counts.set(caller.depth, (counts.get(caller.depth) ?? 0) + 1);
	return Object.fromEntries(
		[...counts.entries()].sort((a, b) => a[0] - b[0]).map(([depth, count]) => [String(depth), count]),
	);
}

/** Registry names for a command token; `cache` keeps both of its entries. */
function commandNamesFor(token: string): CommandName[] | undefined {
	const names = COMMANDS.filter((command) => command.name === token || command.name.startsWith(`${token} `)).map(
		(command) => command.name,
	);
	return names.length === 0 ? undefined : names;
}

/** The exact global flag tokens. A short cluster is a separate rule: see below. */
const GLOBAL_FLAGS = new Set(["--json", "--help", "-h", "--version", "-v"]);

/**
 * The commands whose answer is read from the shared, language-selectable index.
 * `--language` is accepted only by these; `code-map`'s tier-3 index is a
 * byte-parity contract and does not expose the seam, and help/cache read none.
 */
const INDEX_COMMANDS = new Set(["callers", "impact", "diff"]);

export interface ScannedArgs {
	/** The first bare token: the command the user asked for, if any. */
	commandToken?: string;
	/** The directory `--repo <dir>` or `--repo=<dir>` names, if either is present. */
	repo?: string;
	/** The language `--language <id>` or `--language=<id>` names, if either is present. */
	language?: string;
	json: boolean;
	/** `--stream`: implies `json` and selects the NDJSON framing (contract §1a). */
	stream: boolean;
	/** `--plain`: only read to reject `--stream --plain`; glyph has no plain mode. */
	plain: boolean;
	help: boolean;
	version: boolean;
	/** True when every argument is a known global flag or such a flag's value. */
	onlyKnownGlobals: boolean;
}

/**
 * True for a short cluster commander reads as the version: a single-dash token
 * longer than two characters whose SECOND character is `v`.
 *
 * That is commander's actual rule, measured against 15.0.0 and narrower than it
 * looks. `-v` is the only short option registered at program level (`.version`
 * registers it); the help option is built lazily and matched only as an exact
 * token, so an `h` inside a cluster never means help. The cluster branch splits
 * only while its leading short is known and the version listener exits before
 * the rest is read. So `-vh` and `-vx` are the version, while `-hv` and `-hh`
 * are unknown options — a usage error, not help.
 */
function clusterIsVersion(arg: string): boolean {
	return arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2 && arg[1] === "v";
}

/**
 * ONE scanner for the option vocabulary, shared by the pre-scan decisions and
 * the command context, so `--repo` and `--json` read identically everywhere.
 *
 * It follows commander's own rules, which are narrower than they look:
 * - Only `--repo` takes a value, and it takes the NEXT TOKEN even when that
 *   token begins with `-`. In `glyph --repo --json callers x` the repository is
 *   a directory literally named `--json` and the output mode is text.
 * - A command's own value options (`--file`, `--depth`, `--ref`) are UNKNOWN at
 *   program level, so they consume nothing here: `impact x --ref --repo /dir
 *   HEAD` still selects `/dir`, exactly as commander does.
 * - `--` ends the options; everything after it is an operand, so a token there
 *   can name the command even when it begins with `-`.
 * - A short cluster means the version only when its second character is `v`;
 *   every other cluster is an unknown option (see {@link clusterIsVersion}).
 */
export function scanArgv(argv: string[]): ScannedArgs {
	let commandToken: string | undefined;
	let repo: string | undefined;
	let language: string | undefined;
	let json = false;
	let stream = false;
	let plain = false;
	let help = false;
	let version = false;
	let onlyKnownGlobals = true;
	let optionsEnded = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (optionsEnded) {
			onlyKnownGlobals = false;
			if (commandToken === undefined) commandToken = arg;
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = equals === -1 ? arg : arg.slice(0, equals);
		if (name === "--repo") {
			repo = equals === -1 ? argv[index + 1] : arg.slice(equals + 1);
			if (repo === undefined) onlyKnownGlobals = false;
			if (equals === -1) index += 1;
			continue;
		}
		// `--language` reads its value exactly as `--repo` does — the next token,
		// even one that begins with `-` — and, like `--repo`, is not a global flag
		// that makes a bare run help.
		if (name === "--language") {
			language = equals === -1 ? argv[index + 1] : arg.slice(equals + 1);
			if (language === undefined) onlyKnownGlobals = false;
			if (equals === -1) index += 1;
			continue;
		}
		// `--stream` is declared per command, so it is recognised here for framing
		// and the command checks it; `--plain` is recognised only to reject the
		// combination. Neither is a global flag, and neither makes a bare run help.
		if (arg === "--stream") {
			stream = true;
			onlyKnownGlobals = false;
			continue;
		}
		if (arg === "--plain") {
			plain = true;
			onlyKnownGlobals = false;
			continue;
		}
		if (GLOBAL_FLAGS.has(arg)) {
			if (arg === "--json") json = true;
			else if (arg === "--version" || arg === "-v") version = true;
			else help = true;
			continue;
		}
		if (clusterIsVersion(arg)) {
			version = true;
			continue;
		}
		onlyKnownGlobals = false;
		if (!arg.startsWith("-") && commandToken === undefined) commandToken = arg;
	}
	// §1a rule 2: `--stream` implies `--json`. One scanner value keeps the
	// success and failure paths in the same framing.
	return { commandToken, repo, language, json: json || stream, stream, plain, help, version, onlyKnownGlobals };
}

function writeError(json: boolean, errorType: EnvelopeErrorType, message: string): void {
	if (json) {
		process.stderr.write(`${JSON.stringify(errorEnvelope(errorType, message))}\n`);
	} else {
		process.stderr.write(`glyph: ${message}\n`);
	}
}

export function buildProgram(scanned: ScannedArgs): Command {
	const program = new Command();
	program
		.name("glyph")
		.description(
			"Software intelligence about one repository: what calls this symbol, what its change can reach, and which symbols a diff touches.",
		)
		.version(readVersion(), "-v, --version")
		.option("--repo <dir>", "repository directory to analyze (default: current directory)")
		.option("--language <id>", languageFlagSummary())
		.option("--json", "emit the machine-readable JSON envelope")
		// Registered at program level, hidden, so commander extracts it wherever it
		// appears — exactly as it does `--json` — instead of letting a value option
		// such as `--file` swallow it. The guard in run() rejects it on any command
		// that does not declare it; the visible per-command options below carry it
		// in each streaming command's own help.
		.addOption(new Option("--stream").hideHelp())
		.exitOverride()
		.configureOutput({ writeErr: () => {} }) // Errors are re-printed by the single handler in run().
		.helpCommand(false); // `help` is a real command below, so `--json` reaches it.
	program.addHelpText("after", HELP_EPILOGUE);

	program
		.command("callers <name>")
		.description("what calls this symbol")
		.option("--file <pattern>", "narrow to symbols whose file path contains <pattern>")
		.option("--stream", "stream the answer as NDJSON: one item per line, then the result (implies --json)")
		.action(async (name: string, options: { file?: string; stream?: boolean }) => {
			const context = contextOf(scanned);
			const { index, info } = await loadIndex(context);
			const symbol = resolveSymbol(index, name, options.file);
			if (context.stream) {
				streamCallers(index, symbol, info);
				return;
			}
			const callers = callersOf(index, symbol);
			const files = new Set(callers.map((site) => site.file)).size;
			const data = {
				symbol: symbolRow(symbol),
				callers: callers.map(callerRow),
				totals: { callers: callers.length, files },
				...pythonCounts(index),
				index: info,
			};
			emit(context.json, kindOf("callers"), data, () => {
				const lines = [
					`callers of ${display(symbol)} (${symbol.kind}) at ${symbol.file}:${symbol.line}:${symbol.column} — ${callers.length} call site(s) in ${files} file(s)`,
				];
				for (const site of callers) {
					const where = `  ${site.file}:${site.line}:${site.column}`;
					const who = site.caller === null ? "at module scope" : `in ${display(site.caller)}`;
					lines.push(`${where}  ${site.kind}  ${who}`);
				}
				lines.push(indexLine(info));
				return lines.join("\n");
			});
		});

	program
		.command("impact <name>")
		.description("every caller this symbol's change can reach, to a depth (default 5)")
		.option("--depth <n>", `how many hops to report (default: ${DEFAULT_IMPACT_DEPTH})`)
		.option("--all", "report the full closure instead of a depth")
		.option("--ref <ref>", "index that commit's tree instead of the working tree")
		.option("--stream", "stream the answer as NDJSON: one item per line, then the result (implies --json)")
		.action(async (name: string, options: { depth?: string; all?: boolean; ref?: string; stream?: boolean }) => {
			const depth = depthOf(options.depth, options.all === true);
			const context = contextOf(scanned);
			const { index, info, ref } = await loadIndex(context, options.ref);
			const symbol = resolveSymbol(index, name, undefined, "impact has no file filter, so the name must be unique");
			const result = impactOf(index, symbol, depth);
			if (context.stream) {
				streamImpact(index, symbol, result, ref, depth, info);
				return;
			}
			const byId = new Map(index.symbols.map((entry) => [entry.id, entry]));
			const callers = result.callers.map(impactCallerRow);
			const data = {
				symbol: symbolRow(symbol),
				ref,
				depth: { bound: depth, all: depth === null },
				callers,
				cycle: result.cycle,
				truncated: result.truncated,
				unexplored: result.unexplored,
				total: result.total,
				resolvedSites: index.sites.length,
				unresolvedSites: index.unresolvedSites,
				unresolvedByKind: index.unresolvedByKind,
				...pythonCounts(index),
				totals: { callers: callers.length, byDepth: byDepth(result.callers) },
				index: info,
			};
			emit(context.json, kindOf("impact"), data, () => {
				const where = ref === null ? "the working tree" : `${ref.ref} (${shortSha(ref.sha)})`;
				const lines = [
					`impact of ${display(symbol)} (${symbol.kind}) at ${symbol.file}:${symbol.line}:${symbol.column} in ${where} — ${result.callers.length} caller(s) within depth ${depth === null ? "all" : String(depth)} (${result.total} found, cache ${info.cache})`,
				];
				for (const caller of result.callers) {
					const first = caller.path[0];
					const site = first === undefined ? "" : `${first.file}:${first.line}:${first.column}`;
					const who = caller.symbol === null ? "module scope" : display(caller.symbol);
					const marker = caller.cycle ? "  cycle" : "";
					lines.push(`  depth ${caller.depth}  ${who}  ${site}  ${pathLabel(caller, byId)}${marker}`);
				}
				if (result.callers.length === 0) lines.push("  (none)");
				if (result.truncated) {
					lines.push(`  ${result.unexplored} caller(s) beyond depth ${depth} not shown (--all for the full closure)`);
				}
				if (result.cycle) {
					lines.push("  cycle: at least one symbol in this closure (this symbol included) sits on a call cycle");
				}
				lines.push(
					`  coverage (index-wide): ${index.sites.length} resolved site(s); ${index.unresolvedSites} did not resolve (${unresolvedLine(index.unresolvedByKind)}); an empty answer is not proof of no impact`,
				);
				const pythonCoverage = pythonCoverageLine(index);
				if (pythonCoverage !== null) lines.push(pythonCoverage);
				lines.push(indexLine(info));
				return lines.join("\n");
			});
		});

	program
		.command("diff <base> [head]")
		.description("which symbols the diff between base and head (default HEAD) touches")
		.action(async (base: string, head: string | undefined) => {
			const context = contextOf(scanned);
			const { index, info } = await loadIndex(context);
			const resolved = resolveDiffRefs(context.repoRoot, base, head ?? "HEAD");
			const changes = parseDiff(context.repoRoot, resolved.baseSha, resolved.headSha);
			const touched = touchedSymbols(index, changes);
			const data = {
				base: { ref: base, sha: resolved.baseSha },
				head: { ref: head ?? "HEAD", sha: resolved.headSha },
				filesChanged: touched.filesChanged,
				symbols: touched.symbols.map(symbolRow),
				totals: { symbols: touched.symbols.length },
				index: info,
			};
			emit(context.json, kindOf("diff"), data, () => {
				const lines = [
					`symbols touched by ${shortSha(resolved.baseSha)}..${shortSha(resolved.headSha)} — ${touched.symbols.length} symbol(s) in ${touched.filesChanged} changed file(s)`,
				];
				for (const symbol of touched.symbols) {
					const span = symbol.startLine === symbol.endLine ? `${symbol.line}` : `${symbol.startLine}-${symbol.endLine}`;
					lines.push(`  ${symbol.file}:${span}  ${symbol.kind}  ${display(symbol)}`);
				}
				if (touched.symbols.length === 0) lines.push("  (none)");
				lines.push(indexLine(info));
				return lines.join("\n");
			});
		});

	program
		.command("code-map")
		.description("pointers into the code a task concerns; the task text is read from stdin")
		.option("--source-ref <ref>", "the ref every read resolves against (required)")
		.option("--stream", "stream the answer as NDJSON: one item per line, then the result (implies --json)")
		.action(async (options: { sourceRef?: string; stream?: boolean }) => {
			const context = contextOf(scanned);
			if (options.sourceRef === undefined || options.sourceRef === "") {
				throw usageError("code-map needs --source-ref <ref>");
			}
			// Task text on stdin. The bound is enforced by produceCodeMap, which refuses
			// text over the limit rather than truncating it.
			const taskText = readFileSync(0, "utf8");
			// A Python ref's index is built here, through the seam; TypeScript keeps the
			// synchronous loader produceCodeMap has always used (S7 rule 8).
			const prebuilt = await codeMapRefIndex(context, options.sourceRef);
			const refIndex = prebuilt === undefined ? {} : { refIndex: prebuilt };
			if (context.stream) {
				const writer = createStreamWriter();
				const streamed = produceCodeMap({
					repositoryPath: context.repoRoot,
					sourceRef: options.sourceRef,
					taskText,
					...refIndex,
					onPointer: (pointer) => writer.item(itemKindOf("code-map"), pointer),
				});
				writer.result(kindOf("code-map"), codeMapStreamResultData(streamed));
				return;
			}
			const output = produceCodeMap({
				repositoryPath: context.repoRoot,
				sourceRef: options.sourceRef,
				taskText,
				...refIndex,
			});
			emit(context.json, kindOf("code-map"), output, () => {
				const lines = [`code map for ${options.sourceRef} — ${output.pointers.length} pointer(s)`];
				for (const pointer of output.pointers) {
					const range = pointer.lineRanges.length > 0 ? ` (${pointer.lineRanges.join(", ")})` : "";
					lines.push(`  ${pointer.path}${range} — ${pointer.reason}`);
				}
				for (const omission of output.omissions) lines.push(`  omitted ${omission.source}: ${omission.reason}`);
				return lines.join("\n");
			});
		});

	program
		.command("cache <action>")
		.description("show or clear this repository's local cache (action: path | clear)")
		.action((action: string) => {
			const context = contextOf(scanned);
			if (action === "path") {
				const path = cacheDir(context.repoRoot);
				emit(context.json, kindOf("cache path"), { repo: context.repoRoot, path }, () => path);
				return;
			}
			if (action === "clear") {
				const removed = clearCache(context.repoRoot);
				emit(
					context.json,
					kindOf("cache clear"),
					{ repo: context.repoRoot, removed },
					() => `cleared ${removed} cached revision(s) for ${context.repoRoot}`,
				);
				return;
			}
			throw usageError(`unknown cache action '${action}' (expected 'path' or 'clear')`);
		});

	program
		.command("help [command]")
		.description("show help, or under --json the machine-readable command manifest")
		.action((commandName: string | undefined) => {
			const context = contextOf(scanned);
			const names = commandName === undefined ? undefined : commandNamesFor(commandName);
			if (commandName !== undefined && names === undefined) throw usageError(`unknown command '${commandName}'`);
			if (context.json) {
				emit(true, kindOf("help"), buildManifest(names), () => "");
				return;
			}
			if (commandName !== undefined) {
				const target = program.commands.find((command) => command.name() === commandName);
				if (target === undefined) throw usageError(`unknown command '${commandName}'`);
				process.stdout.write(target.helpInformation());
				return;
			}
			process.stdout.write(program.helpInformation());
		});

	return program;
}

/**
 * `argv` is the USER argument list (process.argv.slice(2)).
 *
 * Under `--json`, help and version answer with envelopes rather than text, so
 * the output-mode precedence holds for every successful invocation. Their
 * kinds are dotted per the frozen contract's §4 rule 1 (opum-doc ruling A),
 * so `version.info` and `help.usage` stay.
 */
export async function run(argv: string[]): Promise<number> {
	const scanned = scanArgv(argv);
	const program = buildProgram(scanned);
	const { json } = scanned;
	const token = scanned.commandToken;

	try {
		// `--language` names an index language; a command that reads no index
		// cannot honour it, so rejecting it is better than silently ignoring it.
		if (scanned.language !== undefined) {
			if (token === undefined || !INDEX_COMMANDS.has(token)) {
				throw usageError(
					`--language selects the language to index; it is accepted only by ${[...INDEX_COMMANDS].join(", ")}`,
				);
			}
		}

		// §1a rules 1 and 2: `--stream` is declared per command, and it is a usage
		// error on a command that does not declare it, with `--plain`, or anywhere
		// other than a streaming command's own query (global help and version too).
		if (scanned.stream) {
			if (scanned.plain) throw usageError("--stream and --plain are mutually exclusive");
			const streamToken = scanned.commandToken;
			const declared = streamToken !== undefined && (STREAMING_COMMANDS as readonly string[]).includes(streamToken);
			if (!declared || scanned.version || scanned.help) {
				throw usageError(`--stream is declared only by ${STREAMING_COMMANDS.join(", ")}; it cannot be used here`);
			}
		}

		if (json && scanned.version) {
			emit(true, globalKindOf("version"), { version: readVersion() }, () => "");
			return 0;
		}

		if (scanned.help) {
			if (json && token === undefined) {
				emit(true, globalKindOf("help"), { usage: program.helpInformation() }, () => "");
				return 0;
			}
			if (json && token !== undefined) {
				const names = commandNamesFor(token);
				// Commander answers help before it reports an unknown command, so an
				// unknown token would otherwise print text help and exit 0.
				if (names === undefined) throw usageError(`unknown command '${token}'`);
				emit(true, kindOf("help"), buildManifest(names), () => "");
				return 0;
			}
		}

		// A bare invocation answers help, like the reference implementation, rather
		// than throwing commander's "(outputHelp)" as a usage error.
		if (token === undefined && !scanned.version && !scanned.help && scanned.onlyKnownGlobals) {
			emit(json, globalKindOf("help"), { usage: program.helpInformation() }, () => program.helpInformation().trimEnd());
			return 0;
		}

		await program.parseAsync(argv, { from: "user" });
		return 0;
	} catch (error) {
		// The scanner, not a second reading of argv, decides the output mode, so a
		// failure speaks in the same mode the success path would have.
		const errorJson = scanned.json;
		if (error instanceof CommanderError) {
			if (error.exitCode === 0) return 0; // Text help or version already printed.
			const usage = usageError(error.message);
			writeError(errorJson, usage.errorType, usage.message);
			return exitCodeFor(usage);
		}
		if (error instanceof GlyphError) {
			writeError(errorJson, error.errorType, error.message);
			return exitCodeFor(error);
		}
		writeError(errorJson, "uncaught", error instanceof Error ? error.message : String(error));
		return exitCodeFor(error);
	}
}
