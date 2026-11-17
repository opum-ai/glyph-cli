import { describe, expect, test } from "bun:test";
import {
	allResultKinds,
	buildManifest,
	COMMANDS,
	type CommandName,
	errorEnvelope,
	exitCodeTaxonomy,
	GLOBAL_FLAGS,
	globalKindOf,
	kindOf,
	successEnvelope,
	validateExitTaxonomy,
	validateKindRegistry,
	validateResultKinds,
} from "../src/contract.ts";
import { EXIT_CODES, exitCodeFor, GlyphError, type GlyphErrorType } from "../src/errors.ts";
import { buildProgram, scanArgv } from "../src/program.ts";

/**
 * Hand-transcribed from each command handler's own emitted kind, as the
 * frozen contract's conformance test requires. It is compared against the live
 * registry, never asserted against nothing. The handlers themselves take their
 * kind from `COMMANDS` by lookup, so this golden map checks the registry while
 * the end-to-end test checks that the handlers actually emit what it says.
 */
const GOLDEN_KINDS: Record<string, string> = {
	callers: "callers.result",
	impact: "impact.result",
	diff: "diff.result",
	"cache path": "cache.path",
	"cache clear": "cache.clear",
	help: "help.manifest",
};

const GOLDEN_GLOBAL_KINDS: Record<string, string> = {
	version: "version.info",
	help: "help.usage",
};

const GOLDEN_EXIT_CODES: Record<string, number> = {
	ok: 0,
	uncaught: 1,
	usage: 2,
	not_found: 3,
	denied: 4,
	conflict: 5,
	validation: 6,
	drift: 6,
	indeterminate: 7,
};

describe("command contract", () => {
	test("the live kind registry matches the golden map exactly, and neither side is vacuous", () => {
		expect(COMMANDS.length).toBeGreaterThan(0);
		expect(Object.keys(GOLDEN_KINDS).length).toBeGreaterThan(0);
		expect(validateKindRegistry(GOLDEN_KINDS)).toEqual([]);
	});

	test("every registered commander command has a registry entry, and every entry a command", () => {
		const program = buildProgram(scanArgv([]));
		const names = program.commands.flatMap((command) =>
			command.name() === "cache" ? ["cache path", "cache clear"] : [command.name()],
		);
		expect(names.length).toBeGreaterThan(0);
		expect(names.sort()).toEqual(COMMANDS.map((command) => command.name).sort());
	});

	test("every handler's kind lookup agrees with the registry entry", () => {
		for (const command of COMMANDS) expect(kindOf(command.name)).toBe(command.kind);
		for (const [name, kind] of Object.entries(GOLDEN_GLOBAL_KINDS)) {
			expect(GLOBAL_FLAGS.find((flag) => flag.name === name)?.kind).toBe(globalKindOf(name as "version" | "help"));
			expect(globalKindOf(name as "version" | "help")).toBe(kind);
		}
	});

	test("the global result-kind registry matches the golden map in both directions", () => {
		const live = Object.fromEntries(
			GLOBAL_FLAGS.filter((flag) => flag.kind !== undefined).map((flag) => [flag.name, flag.kind]),
		);
		// Exact key equality both ways: no unlisted result flag, none missing.
		expect(Object.keys(live).sort()).toEqual(Object.keys(GOLDEN_GLOBAL_KINDS).sort());
		expect(live).toEqual(GOLDEN_GLOBAL_KINDS);
		expect(validateResultKinds(Object.values(GOLDEN_GLOBAL_KINDS))).toEqual([]);
	});

	test("the whole emitted-kind set is dotted and non-vacuous", () => {
		expect(allResultKinds().length).toBeGreaterThan(0);
		expect(validateResultKinds(allResultKinds())).toEqual([]);
	});

	test("the live exit-code taxonomy is exactly the frozen family", () => {
		expect(exitCodeTaxonomy()).toEqual(GOLDEN_EXIT_CODES);
		expect(validateExitTaxonomy(GOLDEN_EXIT_CODES)).toEqual([]);
	});

	test("the kind check rejects a vacuous golden map", () => {
		const findings = validateKindRegistry({});
		expect(findings.some((finding) => finding.startsWith("VACUOUS"))).toBe(true);
	});

	test("the kind check rejects one corrupted golden kind and names only that command", () => {
		const findings = validateKindRegistry({ ...GOLDEN_KINDS, diff: "results.diff" });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain('"diff"');
		expect(findings[0]).toContain("KIND MISMATCH");
	});

	test("the kind check rejects a corrupted LIVE kind, not only a corrupted golden one", () => {
		const live = COMMANDS.map((command) => (command.name === "diff" ? { ...command, kind: "diff.changed" } : command));
		const findings = validateKindRegistry(GOLDEN_KINDS, live);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain('"diff"');
		expect(findings[0]).toContain("KIND MISMATCH");
	});

	test("the kind check's dotted-pattern is the thing that rejects a malformed live kind", () => {
		const live = COMMANDS.map((command) => (command.name === "diff" ? { ...command, kind: "diffchanged" } : command));
		const withPattern = validateKindRegistry(GOLDEN_KINDS, live);
		expect(withPattern.some((finding) => finding.startsWith("MALFORMED KIND"))).toBe(true);
		// Mutating the CHECK — a pattern that accepts anything — removes only the
		// malformed-kind finding; the value mismatch still fails. This proves the
		// dotted assertion is not decorative.
		const withoutPattern = validateKindRegistry(GOLDEN_KINDS, live, /.*/);
		expect(withoutPattern.some((finding) => finding.startsWith("MALFORMED KIND"))).toBe(false);
		expect(withoutPattern.some((finding) => finding.includes("KIND MISMATCH"))).toBe(true);
	});

	test("the kind check rejects a missing command", () => {
		const golden = { ...GOLDEN_KINDS };
		delete golden.callers;
		const findings = validateKindRegistry(golden);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain("ENUMERATION MISMATCH");
		expect(findings[0]).toContain("callers");
	});

	test("the kind check rejects a golden command the live registry does not declare", () => {
		const findings = validateKindRegistry({ ...GOLDEN_KINDS, frobnicate: "frobnicate.result" });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain("frobnicate");
	});

	test("the exit-code check rejects a vacuous taxonomy", () => {
		const findings = validateExitTaxonomy({});
		expect(findings.some((finding) => finding.startsWith("VACUOUS"))).toBe(true);
	});

	test("the exit-code check rejects an undocumented collision", () => {
		const findings = validateExitTaxonomy({ ...GOLDEN_EXIT_CODES, usage: 3 });
		expect(findings.some((finding) => finding.includes("UNDOCUMENTED EXIT-CODE COLLISION"))).toBe(true);
		expect(findings.some((finding) => finding.includes('"usage"') && finding.includes('"not_found"'))).toBe(true);
	});

	test("the exit-code check rejects an out-of-band code", () => {
		const findings = validateExitTaxonomy({ ...GOLDEN_EXIT_CODES, indeterminate: 8 });
		expect(findings.some((finding) => finding.startsWith("OUT-OF-RANGE CODE"))).toBe(true);
	});

	test("both envelopes declare principal as the last top-level key", () => {
		expect(Object.keys(successEnvelope("help.manifest", {}))).toEqual(["schemaVersion", "kind", "data", "principal"]);
		expect(successEnvelope("help.manifest", {}).principal).toBeNull();
		expect(Object.keys(errorEnvelope("uncaught", "boom"))).toEqual(["error_type", "message", "principal"]);
		expect(errorEnvelope("uncaught", "boom").principal).toBeNull();
	});

	test("every classifiable type round-trips through its documented exit code", () => {
		for (const [type, code] of Object.entries(EXIT_CODES) as [GlyphErrorType, number][]) {
			expect(exitCodeFor(new GlyphError(type, "message"))).toBe(code);
		}
		expect(exitCodeFor(new Error("a bug"))).toBe(1);
		expect(exitCodeFor("not even an error")).toBe(1);
	});

	test("the manifest publishes every command's kind, flags and taxonomy members", () => {
		const manifest = buildManifest();
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.exitCodes).toEqual(GOLDEN_EXIT_CODES);
		expect(manifest.commands.map((command) => command.name).sort()).toEqual(
			Object.keys(GOLDEN_KINDS).sort() as CommandName[],
		);
		for (const command of manifest.commands) {
			expect(command.kind).toBe(String(GOLDEN_KINDS[command.name]));
			expect(command.json).toBe(true);
			// Every command can crash; `uncaught` must be declared, not omitted.
			expect(command.exitCodes).toContain(1);
			expect(command.exitCodes.length).toBeGreaterThan(1);
			for (const code of command.exitCodes) {
				expect(Object.values(manifest.exitCodes)).toContain(code);
			}
		}
		expect(manifest.globalFlags.find((flag) => flag.name === "version")?.kind).toBe(GOLDEN_GLOBAL_KINDS.version);
		expect(manifest.globalFlags.find((flag) => flag.name === "help")?.kind).toBe(GOLDEN_GLOBAL_KINDS.help);
	});

	test("a narrowed manifest keeps only the requested commands but the whole taxonomy", () => {
		const names: CommandName[] = ["cache path", "cache clear"];
		const manifest = buildManifest(names);
		expect(manifest.commands.map((command) => command.name)).toEqual(names);
		expect(manifest.exitCodes).toEqual(GOLDEN_EXIT_CODES);
	});
});
