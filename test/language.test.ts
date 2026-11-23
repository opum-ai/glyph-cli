import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverSources } from "../src/discover.ts";
import { GlyphError } from "../src/errors.ts";
import { buildIndex } from "../src/indexer.ts";
import {
	detectLanguages,
	indexWith,
	isDefaultLanguage,
	languageOfPath,
	registeredLanguages,
	selectLanguage,
} from "../src/language.ts";
import { makeScratchRepo, type ScratchRepo } from "./helpers.ts";

/**
 * The language seam and `--language` (ADR 0008, GCLI-70).
 *
 * One language per run, selected by detection or requested by `--language`;
 * TypeScript is the only registered indexer, so Python is detected and named
 * but never silently dropped (the "never a silent empty answer" rule, ADR
 * 0008's ruled item 4). A Python-only repository is not_found naming the
 * language and its count until a later slice registers Python indexing.
 */

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[]): CliResult {
	const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
		cwd,
		env: { ...process.env, GLYPH_CACHE_DIR: mkdtempSync(join(tmpdir(), "glyph-lang-cache-")) },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function errorOf(result: CliResult): { error_type: string; message: string } {
	return JSON.parse(result.stderr) as { error_type: string; message: string };
}

const TS_FILES = {
	"src/util.ts": "export function helper(n: number): number {\n  return n + 1;\n}\n",
	"src/main.ts": 'import { helper } from "./util";\nexport function main(): number {\n  return helper(1);\n}\n',
};
const PYTHON_FILE = { "src/tool.py": "def greet(name):\n    return name\n" };

function committed(files: Record<string, string>): ScratchRepo {
	const repo = makeScratchRepo(files);
	repo.commit("base");
	return repo;
}

/** A plain directory (no git), so discovery takes its walk fallback. */
function plainDir(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "glyph-lang-walk-"));
	for (const [relPath, content] of Object.entries(files)) {
		const absolute = join(root, relPath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}
	return root;
}

describe("the language seam", () => {
	test("typescript is the only registered language, and the seam returns the existing index unchanged", () => {
		const repo = committed(TS_FILES);
		expect(registeredLanguages()).toEqual(["typescript"]);

		const files = discoverSources(repo.root);
		expect(files.length).toBeGreaterThan(0);
		const viaSeam = indexWith("typescript", repo.root, files);
		const direct = buildIndex(repo.root, files);
		// `createdAt` is the only field that differs between two builds; everything
		// the queries read is identical, which is the "no behaviour change" claim.
		expect({
			repo: viaSeam.repo,
			files: viaSeam.files,
			symbols: viaSeam.symbols,
			sites: viaSeam.sites,
			unresolvedSites: viaSeam.unresolvedSites,
			unresolvedByKind: viaSeam.unresolvedByKind,
		}).toEqual({
			repo: direct.repo,
			files: direct.files,
			symbols: direct.symbols,
			sites: direct.sites,
			unresolvedSites: direct.unresolvedSites,
			unresolvedByKind: direct.unresolvedByKind,
		});

		expect(() => indexWith("python", repo.root, files)).toThrow(/no indexer is registered/);
	});

	test("a path is claimed by its language, and mixed detection keeps the preference order", () => {
		expect(languageOfPath("src/a.ts")).toBe("typescript");
		expect(languageOfPath("src/a.mjs")).toBe("typescript");
		expect(languageOfPath("src/a.py")).toBe("python");
		expect(languageOfPath("README.md")).toBeNull();

		const repo = committed({ ...TS_FILES, ...PYTHON_FILE });
		const present = detectLanguages(repo.root);
		expect(present.map((entry) => entry.id)).toEqual(["typescript", "python"]);
		expect(present.find((entry) => entry.id === "python")?.files).toEqual(["src/tool.py"]);
	});

	test("detection honours excluded paths: an ignored Python file is not counted", () => {
		const repo = committed({
			...TS_FILES,
			".gitignore": "ignored.py\n",
			"ignored.py": "def hidden():\n    return 1\n",
			...PYTHON_FILE,
		});
		const python = detectLanguages(repo.root).find((entry) => entry.id === "python");
		expect(python?.files).toEqual(["src/tool.py"]);
	});

	test("the non-git walk skips an environment or cache directory when counting Python", () => {
		const root = plainDir({
			"pkg/tool.py": "def greet(name):\n    return name\n",
			".venv/lib/site.py": "def vendored():\n    return 1\n",
			"venv/lib/other.py": "def vendored():\n    return 2\n",
			"__pycache__/cached.py": "x = 1\n",
			".tox/tox.py": "y = 2\n",
			"node_modules/dep/index.js": "export const n = 1;\n",
		});
		const python = detectLanguages(root).find((entry) => entry.id === "python");
		expect(python?.files).toEqual(["pkg/tool.py"]);
	});

	test("selection: TypeScript-only is the default; mixed names Python not-indexed", () => {
		const tsOnly = committed(TS_FILES);
		const defaultSelection = selectLanguage(tsOnly.root, undefined);
		expect(defaultSelection.id).toBe("typescript");
		expect(isDefaultLanguage(defaultSelection)).toBe(true);
		expect(defaultSelection.notIndexed).toEqual([]);

		const mixed = committed({ ...TS_FILES, ...PYTHON_FILE });
		const mixedSelection = selectLanguage(mixed.root, undefined);
		expect(mixedSelection.id).toBe("typescript");
		expect(isDefaultLanguage(mixedSelection)).toBe(false);
		expect(mixedSelection.notIndexed).toEqual([{ language: "python", files: 1 }]);
	});

	test("a Python-only selection is not_found naming the language and its count", () => {
		const repo = committed(PYTHON_FILE);
		try {
			selectLanguage(repo.root, undefined);
			throw new Error("expected selectLanguage to refuse");
		} catch (error) {
			expect(error).toBeInstanceOf(GlyphError);
			expect((error as GlyphError).code).toBe(3);
			expect((error as GlyphError).message).toBe(
				"no TypeScript or JavaScript sources; python (1 file) not indexed yet",
			);
		}
	});
});

describe("--language and detection through the CLI", () => {
	test("a TypeScript-only answer carries no language entry, on the default path and when requested", () => {
		const repo = committed(TS_FILES);
		for (const args of [
			["--json", "callers", "helper"],
			["--json", "--language", "typescript", "callers", "helper"],
		]) {
			const result = runCli(repo.root, args);
			expect(result.code).toBe(0);
			const index = (JSON.parse(result.stdout) as { data: { index: Record<string, unknown> } }).data.index;
			expect(Object.hasOwn(index, "language")).toBe(false);
			expect(Object.hasOwn(index, "notIndexed")).toBe(false);
		}

		const human = runCli(repo.root, ["callers", "helper"]);
		expect(human.code).toBe(0);
		expect(human.stdout).not.toContain("language not indexed");
	});

	test("a Python-only repository is not_found naming the count, the same with and without --ref", () => {
		const repo = committed(PYTHON_FILE);
		const direct = runCli(repo.root, ["--json", "callers", "greet"]);
		const atRef = runCli(repo.root, ["--json", "impact", "greet", "--ref", "HEAD"]);
		expect(direct.code).toBe(3);
		expect(atRef.code).toBe(3);
		expect(direct.stdout).toBe("");
		expect(atRef.stdout).toBe("");
		const directError = errorOf(direct);
		const refError = errorOf(atRef);
		expect(directError.error_type).toBe("not_found");
		expect(directError.message).toBe("no TypeScript or JavaScript sources; python (1 file) not indexed yet");
		// Identical bytes: the message carries no repository/ref location for this case.
		expect(refError.message).toBe(directError.message);
	});

	test("mixed selects TypeScript, names Python with its count, in JSON and in the coverage line", () => {
		const repo = committed({ ...TS_FILES, ...PYTHON_FILE, "src/extra.py": "def other():\n    return 2\n" });

		const result = runCli(repo.root, ["--json", "impact", "helper"]);
		expect(result.code).toBe(0);
		const index = (
			JSON.parse(result.stdout) as {
				data: { index: { language?: string; notIndexed?: { language: string; files: number }[] } };
			}
		).data.index;
		expect(index.language).toBe("typescript");
		expect(index.notIndexed).toEqual([{ language: "python", files: 2 }]);

		const human = runCli(repo.root, ["impact", "helper"]);
		expect(human.code).toBe(0);
		expect(human.stdout).toContain("language not indexed: python (2 files)");
	});

	test("mixed carries the entry through --stream and --ref, not only the batch answer", () => {
		const repo = committed({ ...TS_FILES, ...PYTHON_FILE });

		const streamed = runCli(repo.root, ["impact", "helper", "--stream"]);
		expect(streamed.code).toBe(0);
		const lines = streamed.stdout
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { kind: string; data: { index?: Record<string, unknown> } });
		const resultLine = lines[lines.length - 1];
		expect(resultLine?.kind).toBe("impact.result");
		expect(resultLine?.data.index).toMatchObject({ language: "typescript" });
		expect(resultLine?.data.index?.notIndexed).toEqual([{ language: "python", files: 1 }]);

		const atRef = runCli(repo.root, ["--json", "impact", "helper", "--ref", "HEAD"]);
		expect(atRef.code).toBe(0);
		const refIndex = (
			JSON.parse(atRef.stdout) as {
				data: { index: { language?: string; notIndexed?: { language: string; files: number }[] } };
			}
		).data.index;
		expect(refIndex.language).toBe("typescript");
		expect(refIndex.notIndexed).toEqual([{ language: "python", files: 1 }]);

		const refHuman = runCli(repo.root, ["impact", "helper", "--ref", "HEAD"]);
		expect(refHuman.code).toBe(0);
		expect(refHuman.stdout).toContain("language not indexed: python (1 file)");
	});

	test("mixed carries the entry through diff", () => {
		const repo = makeScratchRepo({ ...TS_FILES, ...PYTHON_FILE });
		const base = repo.commit("base");
		repo.write(
			"src/main.ts",
			'import { helper } from "./util";\nexport function main(): number {\n  return helper(2);\n}\n',
		);
		repo.commit("tweak main");

		const result = runCli(repo.root, ["--json", "diff", base, "HEAD"]);
		expect(result.code).toBe(0);
		const index = (
			JSON.parse(result.stdout) as {
				data: { index: { language?: string; notIndexed?: { language: string; files: number }[] } };
			}
		).data.index;
		expect(index.language).toBe("typescript");
		expect(index.notIndexed).toEqual([{ language: "python", files: 1 }]);
	});

	test("an explicit language that is not registered is a usage error naming the registered languages", () => {
		const repo = committed(TS_FILES);
		for (const args of [
			["--json", "--language", "python", "callers", "helper"],
			["--json", "--language", "ruby", "callers", "helper"],
			["--json", "impact", "helper", "--ref", "HEAD", "--language", "python"],
		]) {
			const result = runCli(repo.root, args);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			const error = errorOf(result);
			expect(error.error_type).toBe("usage");
			expect(error.message).toContain("registered languages: typescript");
		}
	});

	test("a registered language with no files is not_found naming the language", () => {
		const repo = committed(PYTHON_FILE);
		const result = runCli(repo.root, ["--json", "--language", "typescript", "callers", "greet"]);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		const error = errorOf(result);
		expect(error.error_type).toBe("not_found");
		expect(error.message).toContain("no typescript sources found");
	});

	test("--language is rejected on a command that reads no index, including help and a bare run", () => {
		const repo = committed(TS_FILES);
		for (const args of [
			["--json", "--language", "typescript", "cache", "path"],
			["--json", "--language", "typescript", "code-map", "--source-ref", "HEAD"],
			["--json", "help", "--language", "typescript"],
		]) {
			const result = runCli(repo.root, args);
			expect(result.code).toBe(2);
			expect(errorOf(result).message).toContain("accepted only by callers, impact, diff");
		}

		const bare = runCli(repo.root, ["--language", "typescript"]);
		expect(bare.code).toBe(2);
	});

	test("a repeated --language takes the last value", () => {
		const repo = committed(TS_FILES);
		const result = runCli(repo.root, [
			"--json",
			"--language",
			"python",
			"--language",
			"typescript",
			"callers",
			"helper",
		]);
		expect(result.code).toBe(0);
	});

	test("help --json publishes --language as a value-taking global flag naming the registry", () => {
		const repo = committed(TS_FILES);
		const result = runCli(repo.root, ["help", "--json"]);
		expect(result.code).toBe(0);
		const manifest = (
			JSON.parse(result.stdout) as {
				data: { globalFlags: { name: string; takesValue: boolean; summary: string }[] };
			}
		).data;
		const language = manifest.globalFlags.find((flag) => flag.name === "language");
		expect(language).toBeDefined();
		expect(language?.takesValue).toBe(true);
		expect(language?.summary).toContain("registered: typescript");
	});
});
