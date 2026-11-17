import { describe, expect, test } from "bun:test";
import {
	CODE_MAP_MAX_FILES,
	CODE_MAP_MAX_FILES_PER_IDENTIFIER,
	CODE_MAP_MAX_IDENTIFIERS,
	CODE_MAP_MAX_PATH_CANDIDATES,
	CODE_MAP_MAX_RANGES_PER_POINTER,
	CODE_MAP_MAX_TASK_TEXT,
	CODE_MAP_MAX_TOKENS,
	collectIdentifiers,
	distinctiveIdentifiers,
	estimateTokens,
	FILE_CAP_SOURCE,
	formatRange,
	isNonCodePath,
	mergeRanges,
	NON_CODE_PREFIXES,
	OPUM_CLI_ESTIMATOR_PIN,
	OPUM_CLI_PIN,
	parseHunkRanges,
	parseNumstat,
	pathsNamedIn,
	READ_BOUND_SOURCE,
} from "../src/codemap-text.ts";

/**
 * The pure layer of `glyph code-map` (GCLI-40). Every rule here is a port of
 * opum-cli's deterministic producer; the cases are drawn from that producer's own
 * tests (test/code-map.test.ts at the pinned commit) and from the rules its source
 * states.
 */

describe("the pins and caps", () => {
	test("the ported rules name the opum-cli commits they come from", () => {
		expect(OPUM_CLI_PIN).toBe("91542f4ccf2da3574f34c2377c6a6e2b3abd1102");
		expect(OPUM_CLI_ESTIMATOR_PIN).toBe("093b0e9");
	});

	test("the caps equal the producer caps, and the bound sources cannot collide with a per-file source", () => {
		expect([
			CODE_MAP_MAX_FILES,
			CODE_MAP_MAX_TOKENS,
			CODE_MAP_MAX_IDENTIFIERS,
			CODE_MAP_MAX_FILES_PER_IDENTIFIER,
			CODE_MAP_MAX_RANGES_PER_POINTER,
			CODE_MAP_MAX_PATH_CANDIDATES,
			CODE_MAP_MAX_TASK_TEXT,
		]).toEqual([20, 2000, 12, 10, 5, 50, 20_000]);
		expect(READ_BOUND_SOURCE).toBe("code-map#read-bounds");
		expect(FILE_CAP_SOURCE).toBe("code-map#file-cap");
		expect(READ_BOUND_SOURCE.startsWith("code-map:")).toBe(false);
		expect(FILE_CAP_SOURCE.startsWith("code-map:")).toBe(false);
	});
});

describe("estimateTokens", () => {
	test("is Math.ceil(length / 4) over UTF-16 code units", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("a")).toBe(1);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
		expect(estimateTokens("x".repeat(8000))).toBe(2000);
	});

	test("a character outside the Basic Multilingual Plane counts as two units, not one code point", () => {
		const emoji = "\u{1F600}";
		expect(emoji.length).toBe(2);
		expect([...emoji].length).toBe(1);
		// Four of them are 8 code units = 2 tokens; counted by code point it would be 1.
		expect(estimateTokens(emoji.repeat(4))).toBe(2);
		expect(estimateTokens(emoji)).toBe(1);
		expect(estimateTokens(`${emoji}ab`)).toBe(1);
		expect(estimateTokens(`${emoji}abc`)).toBe(2);
	});
});

describe("isNonCodePath", () => {
	test("product storage and VCS metadata are never code", () => {
		expect(NON_CODE_PREFIXES).toEqual([".quest/", ".lore/", ".git/", "node_modules/"]);
		for (const path of [".quest/tasks/X.json", ".lore/schemas/a.json", ".git/config", "node_modules/pkg/index.js"]) {
			expect(isNonCodePath(path)).toBe(true);
		}
		for (const path of ["src/a.ts", "docs/adr/0001.md", "lib/node_modules/x.js", ".questions/a.md"]) {
			expect(isNonCodePath(path)).toBe(false);
		}
	});
});

describe("pathsNamedIn", () => {
	test("takes repo-relative paths, not URLs, and trims punctuation", () => {
		expect(pathsNamedIn("Change src/context/compiler.ts, then docs/adr/0002.md. See https://example.com/x.")).toEqual([
			"src/context/compiler.ts",
			"docs/adr/0002.md",
		]);
		expect(pathsNamedIn("No paths here, just prose.")).toEqual([]);
	});

	test("a directory, an absolute path and an inner dot segment are not paths", () => {
		expect(pathsNamedIn("a/../b and /abs/path/z and /root/x")).toEqual([]);
		expect(pathsNamedIn("a directory: src/context/")).toEqual(["src/context"]);
		expect(pathsNamedIn("see ./src/a.ts")).toEqual(["src/a.ts"]);
		expect(pathsNamedIn("a/./b")).toEqual([]);
	});

	test("a URL is excluded whether it names a host path or an http scheme", () => {
		expect(pathsNamedIn("see http://host/dir/file.ts now")).toEqual([]);
		expect(pathsNamedIn("see https://example.com/x/y.md")).toEqual([]);
		// A match that starts after a non-slash character still sits inside a `//` prefix.
		expect(pathsNamedIn("//-a/b.ts")).toEqual([]);
	});

	test("product storage is dropped, and a repeated path appears once, in first-appearance order", () => {
		expect(pathsNamedIn("node_modules/pkg/index.js and src/b.ts and src/a.ts and src/b.ts")).toEqual([
			"src/b.ts",
			"src/a.ts",
		]);
	});

	test("a leading dot is not part of a match, exactly as in the producer: .quest/x surfaces as quest/x", () => {
		// The producer's pattern starts at a letter, digit, underscore or @, so
		// `.quest/tasks/A.json` is read as `quest/tasks/A.json`, which is not under a
		// non-code prefix. Ported as is; parity, not a fix.
		expect(pathsNamedIn(".quest/tasks/A.json")).toEqual(["quest/tasks/A.json"]);
	});

	test("a leading ../ does not drop the path: the match starts at the first letter, as in the producer", () => {
		// Parity quirk, pinned. The `before` text is `../`, which ends with `./`, so
		// the path is kept as `src/a.ts` rather than dropped as a parent reference.
		expect(pathsNamedIn("../src/a.ts")).toEqual(["src/a.ts"]);
		expect(pathsNamedIn("see ../src/a.ts now")).toEqual(["src/a.ts"]);
	});

	test("a URL with a port keeps the part after the colon, as in the producer", () => {
		// Parity quirk, pinned: `https://host.com:8080/a/b` yields `8080/a/b`.
		expect(pathsNamedIn("https://host.com:8080/a/b")).toEqual(["8080/a/b"]);
	});

	test("only a trailing full stop is ever trimmed; brackets and quotes never reach the match", () => {
		// The pattern cannot match `)`, `]`, `}`, `'`, `"`, `,`, `;`, `:`, `!` or `?`, so
		// the trim loop's other guards are dead code kept for parity.
		expect(pathsNamedIn("src/a.ts.")).toEqual(["src/a.ts"]);
		expect(pathsNamedIn("(see src/a.ts), and 'src/b.ts'! then src/c.ts?")).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
	});
});

describe("collectIdentifiers and distinctiveIdentifiers", () => {
	test("take the three shapes and drop path suffixes", () => {
		const identifiers = distinctiveIdentifiers(
			"`ledgerTotals` and `--json` and the CodeMapProducer call with contract.documentation; src/alpha.ts is a path; e.g. prose.",
		);
		expect(identifiers).toContain("ledgerTotals");
		expect(identifiers).toContain("CodeMapProducer");
		expect(identifiers).toContain("contract.documentation");
		// A suffix of a named path is not its own identifier.
		expect(identifiers).not.toContain("alpha.ts");
		expect(identifiers).not.toContain("src/alpha.ts");
	});

	test("a flag's bare name is taken, dashes removed", () => {
		expect(distinctiveIdentifiers("`--json` is a flag, `--flag` too")).toEqual(["json", "flag"]);
	});

	test("a backticked phrase, a path-shaped token and a too-short name are not identifiers", () => {
		expect(distinctiveIdentifiers("`two words` and `src/a/b` and `abc` and `abcd`")).toEqual(["abcd"]);
	});

	test("CamelCase needs a lowercase first hump, so a shouted acronym is not a name", () => {
		expect(distinctiveIdentifiers("OCLI and DEC and buildReport and LedgerTotals")).toEqual([
			"buildReport",
			"LedgerTotals",
		]);
	});

	test("every backticked token precedes every bare one, each group in first-appearance order", () => {
		// Parity quirk, pinned: the backtick pass runs before the bare-token pass, so a
		// later backticked name outranks an earlier bare one. That order decides which
		// 12 survive the cap.
		expect(distinctiveIdentifiers("buildReport and `ledgerTotals`")).toEqual(["ledgerTotals", "buildReport"]);
		expect(distinctiveIdentifiers("`b4ck` bareCase `other1` anotherCase")).toEqual([
			"b4ck",
			"other1",
			"bareCase",
			"anotherCase",
		]);
	});

	test("repeats collapse and the distinct list is capped at 12 while the full list is not", () => {
		const names = Array.from({ length: 15 }, (_, index) => `thing${String.fromCharCode(65 + index)}Name`);
		const text = `${names.join(" ")} ${names[0]}`;
		expect(collectIdentifiers(text)).toEqual(names);
		expect(distinctiveIdentifiers(text)).toEqual(names.slice(0, CODE_MAP_MAX_IDENTIFIERS));
	});

	test("the cap keeps backticked names over earlier bare ones", () => {
		const bare = Array.from({ length: 12 }, (_, index) => `bare${String.fromCharCode(65 + index)}Name`);
		const kept = distinctiveIdentifiers(`${bare.join(" ")} \`lastTicked\``);
		expect(kept[0]).toBe("lastTicked");
		expect(kept).toHaveLength(CODE_MAP_MAX_IDENTIFIERS);
		expect(kept).not.toContain(bare[11]);
	});

	test("a sentence-final full stop defeats a bare name, as in the producer", () => {
		// Parity quirk, pinned: the token is `buildReport.`, which is neither CamelCase
		// nor dotted, so nothing is taken.
		expect(distinctiveIdentifiers("call buildReport.")).toEqual([]);
		expect(distinctiveIdentifiers("call buildReport, now")).toEqual(["buildReport"]);
	});

	test("a long unbroken run neither matches nor runs away, at the size of the producer's task-text bound", () => {
		// The producer slices the task text to CODE_MAP_MAX_TASK_TEXT before it
		// extracts, so that is the largest input these functions ever see. The
		// extractors are quadratic in an unbroken run (the pathsNamedIn pattern over
		// the whole text): about 0.2 s per call at this size, which the time budget
		// (GCLI-38) must account for. That cost is a measurement, not a pinned
		// behaviour: a linear rewrite would return the same bytes.
		const run = "A".repeat(CODE_MAP_MAX_TASK_TEXT);
		expect(distinctiveIdentifiers(`before ${run} after`)).toEqual([]);
	});
});

describe("parseNumstat", () => {
	test("reads -z entries, including a binary file", () => {
		expect(parseNumstat("5\t2\tsrc/a.ts\0-\t-\timg.png\0")).toEqual(
			new Map([
				["src/a.ts", 7],
				["img.png", 0],
			]),
		);
	});

	test("a rename entry would be recorded under an empty path, which the producer never sees: it passes --no-renames", () => {
		// `git diff -z --numstat` renders a rename as `N\tM\t\0old\0new\0`. The producer
		// pins `--no-renames` (its DIFF_PINS), so a rename arrives as a delete plus an
		// add and this shape does not occur. Ported as is; GCLI-41 must pass the same
		// pins and its goldens cover a renamed file.
		expect(parseNumstat("2\t3\t\0old.ts\0new.ts\0")).toEqual(new Map([["", 5]]));
	});

	test("ignores an empty entry and a malformed one, and keeps a path with a tab in its tail", () => {
		expect(parseNumstat("")).toEqual(new Map());
		expect(parseNumstat("garbage\0")).toEqual(new Map());
		expect(parseNumstat("1\t1\ta\tb.ts\0")).toEqual(new Map([["a\tb.ts", 2]]));
	});
});

describe("parseHunkRanges", () => {
	test("reads only @@ headers, never a body line", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,0 +2,2 @@",
			"+++ b/not-a-header",
			"+two",
			"@@ -9,1 +11,0 @@",
			"-removed",
			"",
		].join("\n");
		expect(parseHunkRanges(diff)).toEqual([
			[2, 3],
			[11, 11],
		]);
		expect(parseHunkRanges("")).toEqual([]);
	});

	test("a one-line hunk omits its length, and a pure deletion marks the insertion point", () => {
		expect(parseHunkRanges("@@ -3 +7 @@\n")).toEqual([[7, 7]]);
		expect(parseHunkRanges("@@ -4,2 +0,0 @@\n")).toEqual([[1, 1]]);
		expect(parseHunkRanges("@@ -4,2 +5,0 @@\n")).toEqual([[5, 5]]);
	});

	test("adjacent hunks are merged", () => {
		expect(parseHunkRanges("@@ -1 +1,2 @@\n@@ -9 +3,2 @@\n")).toEqual([[1, 4]]);
	});
});

describe("mergeRanges and formatRange", () => {
	test("coalesces adjacent and overlapping ranges", () => {
		expect(
			mergeRanges([
				[5, 6],
				[1, 2],
				[2, 3],
				[9, 9],
			]),
		).toEqual([
			[1, 3],
			[5, 6],
			[9, 9],
		]);
	});

	test("does not mutate its input, and a contained range does not shrink the outer one", () => {
		const input: Array<[number, number]> = [
			[1, 10],
			[3, 4],
		];
		expect(mergeRanges(input)).toEqual([[1, 10]]);
		expect(input).toEqual([
			[1, 10],
			[3, 4],
		]);
	});

	test("formats one line and many lines as the seam consumes them", () => {
		expect(formatRange([40, 40])).toBe("line 40");
		expect(formatRange([12, 18])).toBe("lines 12-18");
	});
});
