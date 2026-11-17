/**
 * The pure layer of `glyph code-map`: text extraction, diff parsing and range
 * arithmetic, with no git, no process and no I/O.
 *
 * This is a port, not a design (DEC-216 (a6), GCLI-12 Q1 ruled A): glyph carries
 * the deterministic producer's tiers 1, 2 and 4 so it can emit all four tiers of
 * the CodeMapProducer seam's `{ pointers, omissions }` itself. The rules below
 * are those of opum-cli's `src/context/code-map.ts` at
 * {@link OPUM_CLI_PIN}, and `estimateTokens` is opum-cli's
 * `src/adapters/instruction-blocks.ts:122-124` at the commit recorded beside it.
 * When opum-cli changes a rule, the pin moves in the same change, or the parity
 * test (GCLI-41) fails.
 */

/** The opum-cli commit whose `src/context/code-map.ts` these rules are ported from. */
export const OPUM_CLI_PIN = "91542f4ccf2da3574f34c2377c6a6e2b3abd1102";
/** The opum-cli commit whose `estimateTokens` is ported. */
export const OPUM_CLI_ESTIMATOR_PIN = "093b0e9";

/** The pack contract's bound on the code map: files and tokens. */
export const CODE_MAP_MAX_FILES = 20;
export const CODE_MAP_MAX_TOKENS = 2000;
/** How many distinctive identifiers one task text may send to `git grep`. */
export const CODE_MAP_MAX_IDENTIFIERS = 12;
/** How many files one identifier's `git grep -l` may contribute. */
export const CODE_MAP_MAX_FILES_PER_IDENTIFIER = 10;
/** How many line ranges one pointer may show before a "+N more" summary. */
export const CODE_MAP_MAX_RANGES_PER_POINTER = 5;
/** How many path-shaped tokens one task text may try to resolve. */
export const CODE_MAP_MAX_PATH_CANDIDATES = 50;
/** How much of the task text the extractors read. */
export const CODE_MAP_MAX_TASK_TEXT = 20_000;

/**
 * The sources the producer's INPUT bounds and its definitive file cap report
 * under. Deliberately NOT `code-map:<path>` shaped: every per-file row uses that
 * form, so a root file named after a bound could otherwise produce the identical
 * source. No candidate path can yield a `#`-joined source, because the per-path
 * form always joins with `:`.
 */
export const READ_BOUND_SOURCE = "code-map#read-bounds";
export const FILE_CAP_SOURCE = "code-map#file-cap";

/** Path prefixes that are never code: product storage and VCS metadata. */
export const NON_CODE_PREFIXES: readonly string[] = [".quest/", ".lore/", ".git/", "node_modules/"];

export function isNonCodePath(path: string): boolean {
	return NON_CODE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The token estimate every cap is measured in: `Math.ceil(text.length / 4)`.
 * `.length` counts UTF-16 code units, not code points, so a character outside
 * the Basic Multilingual Plane counts as two.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Repo-relative path-shaped tokens in free text: two or more slash-separated
 * segments. Existence at the source ref is checked by the caller, so a false
 * positive here costs one git read and cannot reach the pack.
 *
 * `./src/a.ts` is accepted as `src/a.ts`. A URL host, an absolute path and a
 * token with an INNER `.` or `..` segment (`a/../b`) are dropped. A LEADING `../`
 * is not: the match starts at the first letter after it, so `../src/a.ts` yields
 * `src/a.ts`, exactly as in the producer (pinned as a parity quirk, not a fix).
 * The same pattern ends a `https://host:8080/a/b` match at `8080/a/b`.
 */
export function pathsNamedIn(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(/[A-Za-z0-9_@][A-Za-z0-9_.@+-]*(?:\/[A-Za-z0-9_.@+-]+)+/g)) {
		let token = match[0];
		// A URL's host-and-path is not a repo path, and an absolute path is not
		// repo-relative: both are recognised by what precedes the match. A `./`
		// prefix is the ordinary way a person writes a repo path, so it is the one
		// slash that is allowed.
		const before = text.slice(Math.max(0, (match.index ?? 0) - 3), match.index ?? 0);
		if (before.includes("//") || (before.endsWith("/") && !before.endsWith("./"))) continue;
		// Trailing sentence punctuation is not part of the path. The pattern can
		// only end a match in `.` from this set (the rest are never matched), so the
		// other characters here are dead code kept for parity. So are the guards just
		// below: a match cannot start with `/`, contain `://` (no `:`), or trim to
		// empty (it starts with a letter, digit, `_` or `@`).
		while (token.length > 0 && ".,;:!?)]}'\"".includes(token.at(-1) ?? "")) {
			token = token.slice(0, -1);
		}
		if (token.length === 0 || token.startsWith("/") || token.includes("://")) continue;
		const segments = token.split("/");
		if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
			continue;
		}
		if (isNonCodePath(token) || seen.has(token)) continue;
		seen.add(token);
		found.push(token);
	}
	return found;
}

/**
 * The identifiers worth grepping for, deduplicated, BEFORE the cap. The order is
 * every backticked token first, then every bare CamelCase or dotted token, each
 * group in order of first appearance; that order decides which 12 survive the
 * cap. The producer slices it so it can report the identifiers its
 * read bound left out. Three shapes: backticked tokens, CamelCase names and
 * dotted names.
 *
 * The bare-token regexes run over bounded tokens, but the `pathsNamedIn` pass this
 * function starts with runs its pattern over the WHOLE text and is quadratic in
 * a long unbroken run. A backticked token is filtered hard — no whitespace, no
 * path separator, no leading dash — because a flag or a phrase greps half the
 * repository. A token that is part of a path the
 * text already names is dropped too: `alpha.ts` inside `src/alpha.ts` would grep
 * every mention of the suffix and duplicate the path pointer.
 */
export function collectIdentifiers(text: string): string[] {
	const pathTokens = pathsNamedIn(text);
	const found: string[] = [];
	const seen = new Set<string>();
	const take = (token: string, minimumLength: number): void => {
		if (token.length < minimumLength || token.length > 120) return;
		if (seen.has(token) || isNonCodePath(token)) return;
		if (token.includes("/") || /\s/.test(token)) return;
		if (!/^[A-Za-z_$][\w$.-]*$/.test(token)) return;
		if (pathTokens.some((path) => path === token || path.endsWith(`/${token}`))) return;
		seen.add(token);
		found.push(token);
	};

	for (const match of text.matchAll(/`([^`\n]{1,120})`/g)) {
		const raw = (match[1] ?? "").trim();
		// A backticked phrase is prose, not an identifier. A flag's bare name
		// (`--json` -> `json`) still greps usefully, so the dashes come off.
		if (raw.length === 0 || raw.includes(" ")) continue;
		take(raw.replace(/^--?/, ""), 4);
	}

	// CamelCase and dotted names are read token by token: the split is on
	// everything a name cannot contain, so each regex runs over a bounded token
	// rather than over the whole text.
	for (const token of text.split(/[^A-Za-z0-9_$.-]+/)) {
		if (token.length === 0 || token.length > 120) continue;
		// CamelCase needs a lowercase letter in its first hump, so an acronym
		// shouted in prose (`OCLI`) is not read as a name.
		if (/^[A-Za-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token)) take(token, 5);
		if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(token)) take(token, 5);
	}

	return found;
}

/**
 * The distinct identifiers a text offers, capped at CODE_MAP_MAX_IDENTIFIERS. The
 * producer uses the uncapped list so it can report what the bound left out.
 */
export function distinctiveIdentifiers(text: string): string[] {
	return collectIdentifiers(text).slice(0, CODE_MAP_MAX_IDENTIFIERS);
}

/** `--numstat -z` entries, as `path -> changed lines`. */
export function parseNumstat(output: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of output.split("\0")) {
		if (entry.length === 0) continue;
		const firstTab = entry.indexOf("\t");
		const secondTab = entry.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		const path = entry.slice(secondTab + 1);
		const added = Number(entry.slice(0, firstTab));
		const removed = Number(entry.slice(firstTab + 1, secondTab));
		// A binary file reports `-` for both counts.
		if (!Number.isFinite(added) || !Number.isFinite(removed)) {
			counts.set(path, 0);
			continue;
		}
		counts.set(path, added + removed);
	}
	return counts;
}

/** Sort and coalesce inclusive ranges; adjacent lines become one range. */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
	const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged.at(-1);
		if (last !== undefined && start <= last[1] + 1) {
			last[1] = Math.max(last[1], end);
			continue;
		}
		merged.push([start, end]);
	}
	return merged;
}

/**
 * The new-file ranges of a `-U0` diff, from its `@@` headers only. A hunk body
 * line always starts with `+`, `-` or a space, so an added line whose content
 * begins `++ ` (or a filename that looks like a header) can never be read as
 * structure.
 */
export function parseHunkRanges(diff: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const line of diff.split("\n")) {
		if (!line.startsWith("@@")) continue;
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk === null) continue;
		const start = Number(hunk[1]);
		const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
		if (length === 0) {
			// A pure deletion has no line in the new file; it still marks the
			// insertion point as changed.
			ranges.push([Math.max(start, 1), Math.max(start, 1)]);
		} else {
			ranges.push([start, start + length - 1]);
		}
	}
	return mergeRanges(ranges);
}

export function formatRange(range: readonly [number, number]): string {
	return range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}-${range[1]}`;
}
