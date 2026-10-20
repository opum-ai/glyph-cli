/**
 * Glyph's implementation of the frozen Opum command contract
 * (opum-doc `docs/specs/opum-command-contract.md`).
 *
 * One place fixes the success envelope, the error envelope, the exit-code
 * taxonomy and the dotted `kind` registry, so every command emits the same
 * machine contract and the manifest is built from live source rather than a
 * second hand-written list.
 */

import { EXIT_CODES, EXIT_OK, EXIT_UNCAUGHT, type GlyphErrorType } from "./errors.ts";

/** Bumped when the envelope shape changes. */
export const SCHEMA_VERSION = 1;

export interface SuccessEnvelope<T> {
	schemaVersion: typeof SCHEMA_VERSION;
	kind: string;
	data: T;
	/** Reserved by the shared contract; `null` until an identity is populated. */
	principal: null;
}

export type EnvelopeErrorType = GlyphErrorType | "uncaught";

export interface ErrorEnvelope {
	error_type: EnvelopeErrorType;
	message: string;
	/** Reserved by the shared contract; the last key, exactly as on success. */
	principal: null;
}

/** Field order is part of the contract: `principal` is last. */
export function successEnvelope<T>(kind: string, data: T): SuccessEnvelope<T> {
	return { schemaVersion: SCHEMA_VERSION, kind, data, principal: null };
}

/** Field order is part of the contract: `principal` is last. */
export function errorEnvelope(errorType: EnvelopeErrorType, message: string): ErrorEnvelope {
	return { error_type: errorType, message, principal: null };
}

/** `ok` and `uncaught` are codes, not `GlyphErrorType`s; the rest come from one map. */
export function exitCodeTaxonomy(): Record<string, number> {
	return { ok: EXIT_OK, uncaught: EXIT_UNCAUGHT, ...EXIT_CODES };
}

export interface FlagSpec {
	name: string;
	takesValue: boolean;
	summary: string;
}

export interface CommandSpec {
	/** The invocation a caller writes, e.g. `callers` or `cache clear`. */
	name: string;
	summary: string;
	args: string;
	flags: FlagSpec[];
	/** Dotted `command.payload`; one stable kind per result-bearing command. */
	kind: string;
	/** Exit codes this command can produce, taxonomy members only. */
	exitCodes: number[];
	examples: string[];
}

/** The live kind registry. `buildManifest()` reads this, never a copy. */
export const COMMANDS: readonly CommandSpec[] = Object.freeze([
	{
		name: "callers",
		summary: "What calls this symbol",
		args: "<name>",
		flags: [{ name: "file", takesValue: true, summary: "narrow to symbols whose file path contains <pattern>" }],
		kind: "callers.result",
		exitCodes: [0, 1, 2, 3, 7],
		examples: ["glyph callers buildReport", "glyph callers parseDiff --file src/git.ts"],
	},
	{
		name: "diff",
		summary: "Which symbols the diff between base and head (default HEAD) touches",
		args: "<base> [head]",
		flags: [],
		kind: "diff.result",
		exitCodes: [0, 1, 2, 3, 7],
		examples: ["glyph diff main", "glyph diff v0.1.0 HEAD"],
	},
	{
		name: "cache path",
		summary: "Show this repository's local cache directory",
		args: "",
		flags: [],
		kind: "cache.path",
		exitCodes: [0, 1, 2],
		examples: ["glyph cache path"],
	},
	{
		name: "cache clear",
		summary: "Clear this repository's cached revisions",
		args: "",
		flags: [],
		kind: "cache.clear",
		exitCodes: [0, 1, 2],
		examples: ["glyph cache clear"],
	},
	{
		name: "help",
		summary: "Show help, or the machine-readable command manifest under --json",
		args: "[command]",
		flags: [],
		kind: "help.manifest",
		exitCodes: [0, 1, 2],
		examples: ["glyph help", "glyph help --json"],
	},
]);

export interface GlobalFlagSpec extends FlagSpec {
	/** Present when the flag itself produces a JSON result under `--json`. */
	kind?: string;
}

/**
 * Global flags. `version` and `help` are result-bearing under `--json`, as the
 * reference implementation emits them: `lore --json --version` answers with a
 * `version` envelope and `lore --json --help` (and a bare `--json` run) with a
 * `help` envelope, rather than plain text.
 */
export const GLOBAL_FLAGS: readonly GlobalFlagSpec[] = Object.freeze([
	{ name: "json", takesValue: false, summary: "emit the machine-readable JSON envelope" },
	{ name: "repo", takesValue: true, summary: "repository directory to analyze (default: current directory)" },
	{ name: "version", takesValue: false, summary: "print the version and exit", kind: "version.info" },
	{ name: "help", takesValue: false, summary: "show help and exit", kind: "help.usage" },
]);

/**
 * A command handler's kind, read from the one live registry rather than typed
 * as a literal beside the handler. An unknown name is a programming error and
 * throws, so a new command cannot emit a kind the registry does not declare.
 */
export function kindOf(name: string): string {
	const command = COMMANDS.find((entry) => entry.name === name);
	if (command === undefined) throw new Error(`no command registered as '${name}'`);
	return command.kind;
}

/** The same lookup for a global flag that produces a result. */
export function globalKindOf(name: "version" | "help"): string {
	const flag = GLOBAL_FLAGS.find((entry) => entry.name === name);
	if (flag?.kind === undefined) throw new Error(`no global result kind registered for '${name}'`);
	return flag.kind;
}

/** Every kind any handler can emit, command and global flags included. */
export function allResultKinds(): string[] {
	return [
		...COMMANDS.map((command) => command.kind),
		...GLOBAL_FLAGS.flatMap((flag) => (flag.kind === undefined ? [] : [flag.kind])),
	];
}

export interface Manifest {
	schemaVersion: typeof SCHEMA_VERSION;
	exitCodes: Record<string, number>;
	globalFlags: GlobalFlagSpec[];
	commands: Array<{
		name: string;
		summary: string;
		args: string;
		flags: FlagSpec[];
		json: true;
		kind: string;
		exitCodes: number[];
		examples: string[];
	}>;
}

/**
 * `glyph help --json`'s data, sourced from the live registry and taxonomy.
 * Passing names narrows it to those commands (a `cache` topic keeps both of
 * its entries); the taxonomy and global flags stay whole.
 */
export function buildManifest(commandNames?: readonly string[]): Manifest {
	const commands =
		commandNames === undefined ? COMMANDS : COMMANDS.filter((command) => commandNames.includes(command.name));
	return {
		schemaVersion: SCHEMA_VERSION,
		exitCodes: exitCodeTaxonomy(),
		globalFlags: GLOBAL_FLAGS.map((flag) => ({ ...flag })),
		commands: commands.map((command) => ({
			name: command.name,
			summary: command.summary,
			args: command.args,
			flags: command.flags,
			json: true,
			kind: command.kind,
			exitCodes: command.exitCodes,
			examples: command.examples,
		})),
	};
}

const DOTTED_KIND = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * The conformance check the repository's test suite runs. A golden map is
 * hand-transcribed from each command handler's own emitted kind; this compares
 * it to the live registry by exact equality and returns findings. Empty on
 * either side is vacuous and fails rather than passing.
 */
export function validateKindRegistry(
	golden: Record<string, string>,
	live: readonly CommandSpec[] = COMMANDS,
	dotted: RegExp = DOTTED_KIND,
): string[] {
	const findings: string[] = [];
	const liveKinds = new Map(live.map((command) => [command.name, command.kind]));
	const goldenNames = Object.keys(golden).sort();
	const liveNames = [...liveKinds.keys()].sort();

	if (goldenNames.length === 0) findings.push("VACUOUS: golden kind map is empty");
	if (liveNames.length === 0) findings.push("VACUOUS: live kind registry is empty");

	const missing = liveNames.filter((name) => !(name in golden));
	const extra = goldenNames.filter((name) => !liveKinds.has(name));
	if (missing.length > 0 || extra.length > 0) {
		findings.push(`ENUMERATION MISMATCH: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
	}
	for (const name of goldenNames) {
		const liveKind = liveKinds.get(name);
		if (liveKind === undefined) continue;
		if (golden[name] !== liveKind) {
			findings.push(
				`KIND MISMATCH on command "${name}": manifest declares kind="${liveKind}" but golden expects "${golden[name]}"`,
			);
		}
	}
	for (const command of live) {
		if (!dotted.test(command.kind)) {
			findings.push(`MALFORMED KIND on command "${command.name}": "${command.kind}" is not dotted command.payload`);
		}
	}
	return findings;
}

/**
 * The whole emitted-kind set, global flags included. Every kind is dotted and
 * the set is non-empty; this is the check the e2e test pairs with a run of each
 * command so a handler that emits a different string is caught.
 */
export function validateResultKinds(kinds: readonly string[], dotted: RegExp = DOTTED_KIND): string[] {
	const findings: string[] = [];
	if (kinds.length === 0) findings.push("VACUOUS: result-kind set is empty");
	for (const kind of kinds) {
		if (!dotted.test(kind)) findings.push(`MALFORMED KIND: "${kind}" is not dotted command.payload`);
	}
	return findings;
}

/**
 * The exit-code half of the conformance check. Exact key equality with the
 * golden taxonomy, no code outside 0-7, and no collision except the
 * documented `validation`/`drift` pair sharing 6.
 */
export function validateExitTaxonomy(
	golden: Record<string, number>,
	live: Record<string, number> = exitCodeTaxonomy(),
): string[] {
	const findings: string[] = [];
	const goldenNames = Object.keys(golden).sort();
	const liveNames = Object.keys(live).sort();

	if (goldenNames.length === 0) findings.push("VACUOUS: golden exit-code taxonomy is empty");
	if (liveNames.length === 0) findings.push("VACUOUS: live exit-code taxonomy is empty");

	const missing = liveNames.filter((name) => !(name in golden));
	const extra = goldenNames.filter((name) => !(name in live));
	if (missing.length > 0 || extra.length > 0) {
		findings.push(`ENUMERATION MISMATCH: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
	}

	for (const [label, taxonomy] of [
		["golden", golden],
		["live", live],
	] as const) {
		const byCode = new Map<number, string[]>();
		for (const [name, code] of Object.entries(taxonomy)) {
			if (!Number.isInteger(code) || code < 0 || code > 7) {
				findings.push(`OUT-OF-RANGE CODE: ${label} ${name} maps to ${code}, outside the frozen 0-7 family`);
			}
			const names = byCode.get(code) ?? [];
			names.push(name);
			byCode.set(code, names);
		}
		for (const [code, names] of byCode) {
			if (
				names.length > 1 &&
				!(code === 6 && names.length === 2 && names.includes("validation") && names.includes("drift"))
			) {
				findings.push(`UNDOCUMENTED EXIT-CODE COLLISION: ${label} ${JSON.stringify(names.sort())} all map to ${code}`);
			}
		}
	}
	for (const name of goldenNames) {
		if (live[name] !== golden[name]) {
			findings.push(`TAXONOMY MISMATCH for ${name}: live=${String(live[name])} golden=${golden[name]}`);
		}
	}
	return findings;
}
