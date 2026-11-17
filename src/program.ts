import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { cacheDir, clearCache, computeKey, computeRefKey, readCachedIndex, writeCachedIndex } from "./cache.ts";
import {
	buildManifest,
	COMMANDS,
	type CommandName,
	type EnvelopeErrorType,
	errorEnvelope,
	globalKindOf,
	kindOf,
	successEnvelope,
} from "./contract.ts";
import { discoverSources } from "./discover.ts";
import { exitCodeFor, GlyphError, notFoundError, usageError } from "./errors.ts";
import { parseDiff, repoRootFor, resolveCommit, resolveDiffRefs } from "./git.ts";
import type { ImpactCaller } from "./impact.ts";
import { impactOf } from "./impact.ts";
import { buildIndex } from "./indexer.ts";
import { callersOf, display, resolveSymbol, touchedSymbols } from "./queries.ts";
import { indexSnapshot, snapshotAtRef, sourceFilesAtRef } from "./snapshot.ts";
import type { GlyphIndex, IndexInfo, SymbolEntry } from "./types.ts";

/**
 * Glyph's command surface and machine contract.
 *
 * Contract, stated once here because scripts branch on it:
 * - stdout carries exactly one success envelope (JSON under --json, human text
 *   otherwise); on failure stdout stays EMPTY and stderr carries the message —
 *   under --json, an `{error_type, message, principal}` object.
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
	return { repoRoot: repoRootFor(dir) ?? dir, json: scanned.json };
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
 */
function loadIndex(context: Context, ref?: string): LoadedIndex {
	if (ref !== undefined) {
		const sha = resolveCommit(context.repoRoot, ref);
		if (sha === null) {
			throw notFoundError(`could not resolve '${ref}' to a commit in ${context.repoRoot}`);
		}
		// The listing alone is enough to key the cache; the blobs are read only
		// on a miss, so a hit does not pay for the tree it already holds.
		const files = sourceFilesAtRef(context.repoRoot, sha);
		if (files.length === 0) {
			throw notFoundError(`no TypeScript or JavaScript sources at ${ref} (${shortSha(sha)}) in ${context.repoRoot}`);
		}
		const key = computeRefKey(sha, files);
		const cached = readCachedIndex(context.repoRoot, key);
		if (cached !== null) return { index: cached, info: infoOf(cached, "hit"), ref: { ref, sha } };
		const index = indexSnapshot(snapshotAtRef(context.repoRoot, sha));
		writeCachedIndex(context.repoRoot, key, index);
		return { index, info: infoOf(index, "miss"), ref: { ref, sha } };
	}
	const files = discoverSources(context.repoRoot);
	if (files.length === 0) {
		throw notFoundError(`no TypeScript or JavaScript sources found under ${context.repoRoot}`);
	}
	const key = computeKey(context.repoRoot, files);
	const cached = readCachedIndex(context.repoRoot, key);
	if (cached !== null) return { index: cached, info: infoOf(cached, "hit"), ref: null };
	const index = buildIndex(context.repoRoot, files);
	writeCachedIndex(context.repoRoot, key, index);
	return { index, info: infoOf(index, "miss"), ref: null };
}

function infoOf(index: GlyphIndex, cache: "hit" | "miss"): IndexInfo {
	return { cache, files: index.files.length, symbols: index.symbols.length, sites: index.sites.length };
}

function emit(json: boolean, kind: string, data: unknown, renderHuman: () => string): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(successEnvelope(kind, data), null, 2)}\n`);
	} else {
		process.stdout.write(`${renderHuman()}\n`);
	}
}

function indexLine(info: IndexInfo): string {
	return `index: ${info.files} files, ${info.symbols} symbols, ${info.sites} sites (cache ${info.cache})`;
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

export interface ScannedArgs {
	/** The first bare token: the command the user asked for, if any. */
	commandToken?: string;
	/** The directory `--repo <dir>` or `--repo=<dir>` names, if either is present. */
	repo?: string;
	json: boolean;
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
	let json = false;
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
	return { commandToken, repo, json, help, version, onlyKnownGlobals };
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
		.option("--json", "emit the machine-readable JSON envelope")
		.exitOverride()
		.configureOutput({ writeErr: () => {} }) // Errors are re-printed by the single handler in run().
		.helpCommand(false); // `help` is a real command below, so `--json` reaches it.
	program.addHelpText("after", HELP_EPILOGUE);

	program
		.command("callers <name>")
		.description("what calls this symbol")
		.option("--file <pattern>", "narrow to symbols whose file path contains <pattern>")
		.action((name: string, options: { file?: string }) => {
			const context = contextOf(scanned);
			const { index, info } = loadIndex(context);
			const symbol = resolveSymbol(index, name, options.file);
			const callers = callersOf(index, symbol);
			const files = new Set(callers.map((site) => site.file)).size;
			const data = {
				symbol,
				callers: callers.map((site) => ({
					file: site.file,
					line: site.line,
					column: site.column,
					kind: site.kind,
					caller:
						site.caller === null
							? null
							: {
									id: site.caller.id,
									name: site.caller.name,
									container: site.caller.container,
									kind: site.caller.kind,
									file: site.caller.file,
									line: site.caller.line,
								},
				})),
				totals: { callers: callers.length, files },
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
		.action((name: string, options: { depth?: string; all?: boolean; ref?: string }) => {
			const depth = depthOf(options.depth, options.all === true);
			const context = contextOf(scanned);
			const { index, info, ref } = loadIndex(context, options.ref);
			const symbol = resolveSymbol(index, name, undefined, "impact has no file filter, so the name must be unique");
			const result = impactOf(index, symbol, depth);
			const byId = new Map(index.symbols.map((entry) => [entry.id, entry]));
			const data = {
				symbol,
				ref,
				depth: { bound: depth, all: depth === null },
				callers: result.callers,
				cycle: result.cycle,
				truncated: result.truncated,
				unexplored: result.unexplored,
				total: result.total,
				resolvedSites: index.sites.length,
				unresolvedSites: index.unresolvedSites,
				totals: { callers: result.callers.length, byDepth: byDepth(result.callers) },
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
					`  coverage (index-wide): ${index.sites.length} resolved call site(s); ${index.unresolvedSites} call-shaped site(s) did not resolve; an empty answer is not proof of no impact`,
				);
				lines.push(indexLine(info));
				return lines.join("\n");
			});
		});

	program
		.command("diff <base> [head]")
		.description("which symbols the diff between base and head (default HEAD) touches")
		.action((base: string, head: string | undefined) => {
			const context = contextOf(scanned);
			const { index, info } = loadIndex(context);
			const resolved = resolveDiffRefs(context.repoRoot, base, head ?? "HEAD");
			const changes = parseDiff(context.repoRoot, resolved.baseSha, resolved.headSha);
			const touched = touchedSymbols(index, changes);
			const data = {
				base: { ref: base, sha: resolved.baseSha },
				head: { ref: head ?? "HEAD", sha: resolved.headSha },
				filesChanged: touched.filesChanged,
				symbols: touched.symbols,
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
