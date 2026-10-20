import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { cacheDir, clearCache, computeKey, readCachedIndex, writeCachedIndex } from "./cache.ts";
import {
	buildManifest,
	COMMANDS,
	type EnvelopeErrorType,
	errorEnvelope,
	globalKindOf,
	kindOf,
	successEnvelope,
} from "./contract.ts";
import { discoverSources } from "./discover.ts";
import { exitCodeFor, GlyphError, notFoundError, usageError } from "./errors.ts";
import { parseDiff, repoRootFor, resolveDiffRefs } from "./git.ts";
import { buildIndex } from "./indexer.ts";
import { callersOf, display, resolveSymbol, touchedSymbols } from "./queries.ts";
import type { GlyphIndex, IndexInfo } from "./types.ts";

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
  glyph diff main
  glyph diff v0.1.0 HEAD
  glyph cache path
  glyph help --json
`;

interface Context {
	repoRoot: string;
	json: boolean;
}

interface GlobalOptions {
	repo?: string;
	json?: boolean;
}

function readVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function contextOf(program: Command): Context {
	const options = program.opts<GlobalOptions>();
	const dir = resolve(options.repo ?? process.cwd());
	return { repoRoot: repoRootFor(dir) ?? dir, json: options.json === true };
}

function loadIndex(context: Context): { index: GlyphIndex; info: IndexInfo } {
	const files = discoverSources(context.repoRoot);
	if (files.length === 0) {
		throw notFoundError(`no TypeScript or JavaScript sources found under ${context.repoRoot}`);
	}
	const key = computeKey(context.repoRoot, files);
	const cached = readCachedIndex(context.repoRoot, key);
	if (cached !== null) return { index: cached, info: infoOf(cached, "hit") };
	const index = buildIndex(context.repoRoot, files);
	writeCachedIndex(context.repoRoot, key, index);
	return { index, info: infoOf(index, "miss") };
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

/** Registry names for a command token; `cache` keeps both of its entries. */
function commandNamesFor(token: string): string[] | undefined {
	const names = COMMANDS.filter((command) => command.name === token || command.name.startsWith(`${token} `)).map(
		(command) => command.name,
	);
	return names.length === 0 ? undefined : names;
}

/** The first bare token, skipping the value of `--repo` and its `--repo=` form. */
function firstCommandToken(argv: string[]): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--repo") {
			index += 1;
			continue;
		}
		if (arg === undefined || arg.startsWith("-")) continue;
		return arg;
	}
	return undefined;
}

function wantsHelp(argv: string[]): boolean {
	return argv.includes("--help") || argv.includes("-h");
}

function wantsVersion(argv: string[]): boolean {
	return argv.includes("--version") || argv.includes("-v");
}

function writeError(json: boolean, errorType: EnvelopeErrorType, message: string): void {
	if (json) {
		process.stderr.write(`${JSON.stringify(errorEnvelope(errorType, message))}\n`);
	} else {
		process.stderr.write(`glyph: ${message}\n`);
	}
}

export function buildProgram(): Command {
	const program = new Command();
	program
		.name("glyph")
		.description(
			"Software intelligence about one repository: what calls this symbol, and which symbols a diff touches.",
		)
		.version(readVersion())
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
			const context = contextOf(program);
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
		.command("diff <base> [head]")
		.description("which symbols the diff between base and head (default HEAD) touches")
		.action((base: string, head: string | undefined) => {
			const context = contextOf(program);
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
			const context = contextOf(program);
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
			const context = contextOf(program);
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
 * Under `--json`, help and version answer with envelopes rather than text: the
 * reference implementation emits a `version` result for `--json --version` and
 * a `help` result for `--json --help` and for a bare `--json` run, so the
 * output-mode precedence holds for every successful invocation.
 */
export async function run(argv: string[]): Promise<number> {
	const program = buildProgram();
	const json = argv.includes("--json");

	if (json && wantsVersion(argv)) {
		emit(true, globalKindOf("version"), { version: readVersion() }, () => "");
		return 0;
	}

	const token = firstCommandToken(argv);

	if (wantsHelp(argv)) {
		if (json && token === undefined) {
			emit(true, globalKindOf("help"), { usage: program.helpInformation() }, () => "");
			return 0;
		}
		if (json && token !== undefined) {
			const names = commandNamesFor(token);
			if (names !== undefined) {
				emit(true, kindOf("help"), buildManifest(names), () => "");
				return 0;
			}
			// An unknown command with --help falls through to commander's usage error.
		}
	}

	// A bare invocation answers help, like the reference implementation, rather
	// than throwing commander's "(outputHelp)" as a usage error.
	if (token === undefined && !wantsVersion(argv) && !wantsHelp(argv)) {
		emit(json, globalKindOf("help"), { usage: program.helpInformation() }, () => program.helpInformation().trimEnd());
		return 0;
	}

	try {
		await program.parseAsync(argv, { from: "user" });
		return 0;
	} catch (error) {
		const errorJson = program.opts<GlobalOptions>().json === true || json;
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
