import {
	CODE_MAP_MAX_FILES,
	CODE_MAP_MAX_FILES_PER_IDENTIFIER,
	CODE_MAP_MAX_IDENTIFIERS,
	CODE_MAP_MAX_PATH_CANDIDATES,
	CODE_MAP_MAX_RANGES_PER_POINTER,
	CODE_MAP_MAX_TASK_TEXT,
	CODE_MAP_TIME_BUDGET_MS,
	CODE_MAP_MAX_TOKENS,
	collectIdentifiers,
	estimateTokens,
	FILE_CAP_SOURCE,
	formatRange,
	isNonCodePath,
	mergeRanges,
	parseHunkRanges,
	parseNumstat,
	pathsNamedIn,
	READ_BOUND_SOURCE,
	TIME_BUDGET_SOURCE,
} from "./codemap-text.ts";
import { loadRefIndex, symbolHits } from "./codemap-tier3.ts";
import { GlyphError, indeterminateError, notFoundError, usageError } from "./errors.ts";
import { BudgetExpired, currentGitBudget, setGitBudget, spawnLimits, stopIfBudgetSpent } from "./git.ts";
import { spawnResult } from "./spawn.ts";
import type { GlyphIndex } from "./types.ts";

/**
 * `glyph code-map`: the CodeMapProducer seam's `{ pointers, omissions }`.
 *
 * Tiers 1, 2 and 4 of DEC-216 (a4) are a port of opum-cli's deterministic
 * producer (`src/context/code-map.ts`, pinned in `codemap-text.ts`): named
 * paths, files the branch changed, and `git grep -l` for the task text's
 * distinctive identifiers. Tier 3 (`codemap-tier3.ts`, GCLI-37) sits between
 * the second and the last: symbols the text names, resolved through the index.
 * With the index absent or failing, tier 3 contributes nothing and the output
 * is the producer's, byte for byte. The output is POINTERS, never file bodies, bounded to
 * CODE_MAP_MAX_FILES files and CODE_MAP_MAX_TOKENS tokens, deduplicated by path
 * and ranked by a total order, so the same task text, source ref and repository
 * state give byte-identical output.
 */

/** One pointer: a file, the ranges within it, and why. Never the file's bytes. */
export interface CodeMapPointer {
	path: string;
	/** `lines 12-18` / `line 40`, at most five, then a `+N more ranges` summary. Empty means the whole file. */
	lineRanges: string[];
	reason: string;
}

/** One pointer the producer dropped, in the compiler's own `{ source, reason }` row shape. */
export interface CodeMapOmission {
	source: string;
	reason: string;
}

export interface CodeMapOutput {
	pointers: CodeMapPointer[];
	omissions: CodeMapOmission[];
}

export interface CodeMapInput {
	repositoryPath: string;
	/** The ref every read resolves against, and the ref the branch's own diff is taken against. */
	sourceRef: string;
	taskText: string;
	/** Tier 3 on (the default) or off. Off is the deterministic producer's output exactly. */
	symbols?: boolean;
	/** Where tier 3 gets the commit's index; a seam for tests. Null means no index. */
	loadIndex?: (repositoryPath: string, commit: string) => GlyphIndex | null;
	/** The wall-time budget in ms; defaults to CODE_MAP_TIME_BUDGET_MS. A seam for tests. */
	timeBudgetMs?: number;
	/** The clock, in ms; defaults to `performance.now`. A seam for tests. */
	now?: () => number;
}

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Every diff the code map reads is pinned against the user's git config. Hunk
 * boundaries (and so the `lines N-M` strings) move with `diff.algorithm`,
 * `diff.indentHeuristic`, `diff.interHunkContext` and a `textconv` attribute,
 * and the numstat churn that ranks branch files moves with the algorithm too;
 * the same branch must read the same on two machines. `--no-renames` makes a
 * rename arrive as a delete plus an add. These are the producer's pins.
 */
export const DIFF_PINS = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-renames",
	"--diff-algorithm=myers",
	"--no-indent-heuristic",
	"--inter-hunk-context=0",
] as const;

type SourceKind = "task-text-path" | "changed-on-branch" | "symbol" | "identifier";

/** DEC-216 (a4)(c): glyph's symbol tier sits above the git-grep tier. */
const SOURCE_RANK: Readonly<Record<SourceKind, number>> = {
	"task-text-path": 0,
	"changed-on-branch": 1,
	symbol: 2,
	identifier: 3,
};
const SYMBOL_RANK = SOURCE_RANK.symbol;

interface Candidate {
	path: string;
	/** The best (lowest) rank any source gave this path. */
	rank: number;
	/** The rank without tier 3, or undefined for a file only tier 3 found: what displacement is measured against. */
	baseRank: number | undefined;
	/** The best score any source gave it: churn, or identifiers matched. */
	score: number;
	/** Tier 3 only: 0 when a named symbol is declared here, 1 when one is referenced. */
	distance: number;
	/** Tier 3's own line ranges, from the index at the source commit. */
	symbolRanges: Array<[number, number]>;
	/** Why this path is here, keyed by kind and detail so repeats collapse. */
	reasons: Map<string, { kind: SourceKind; detail: string }>;
	/** Changed on the branch, so the diff carries its ranges. */
	fromBranch: boolean;
	/** The identifiers that matched it, in the order they were tried. */
	identifiers: string[];
}

interface GitOutcome {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * `--literal-pathspecs` is on every invocation: a task text, a filename or an
 * identifier is data, and no part of it may be re-read by git as a glob or as an
 * option. A read that cannot report a status (a timeout, a failed spawn) is
 * indeterminate, never an empty answer.
 */
function git(repositoryPath: string, args: readonly string[]): GitOutcome {
	// A git read never outlives the run's budget: when the time left is shorter than
	// git's own timeout, the budget cut it off. That is a stop only if the budget really
	// ran out; a read that died for another reason (a signal, a buffer overflow) is a failure.
	const { timeout, budgeted } = spawnLimits(GIT_TIMEOUT_MS);
	try {
		const proc = spawnResult("git", ["--literal-pathspecs", ...args], {
			cwd: repositoryPath,
			env: { ...process.env, NO_COLOR: "1" },
			timeout,
			maxBuffer: GIT_MAX_BUFFER,
		});
		if (proc.status === null) {
			stopIfBudgetSpent(budgeted);
			const why = proc.timedOut ? "timeout" : proc.signal === null ? "no exit status" : `signal ${proc.signal}`;
			throw indeterminateError(`git ${args[0] ?? ""} did not report an exit status (${why})`);
		}
		return { status: proc.status, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
	} catch (error) {
		if (error instanceof GlyphError || error instanceof BudgetExpired) throw error;
		throw indeterminateError(`git could not start in ${repositoryPath}: ${(error as Error).message}`);
	}
}

function failed(what: string, outcome: GitOutcome): Error {
	return indeterminateError(`${what}: ${outcome.stderr.trim().slice(0, 400) || "unknown error"}`);
}

/**
 * Resolve the source ref to the commit every read uses. Doing it once is what
 * makes `<ref>:path`, `git grep <commit>` and `merge-base <commit> HEAD` agree
 * inside one run, and it keeps a ref that starts with `-` from being read as an
 * option.
 */
function resolveSourceRef(repositoryPath: string, sourceRef: string): string {
	const resolved = git(repositoryPath, [
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${sourceRef}^{commit}`,
	]);
	const commit = resolved.stdout.trim();
	if (resolved.status !== 0 || commit.length === 0) {
		throw notFoundError(`the code map's source ref '${sourceRef}' does not resolve to a commit in ${repositoryPath}`);
	}
	return commit;
}

function isBlobAt(repositoryPath: string, commit: string, path: string): boolean {
	const result = git(repositoryPath, ["cat-file", "-t", `${commit}:${path}`]);
	return result.status === 0 && result.stdout.trim() === "blob";
}

interface BranchChange {
	/** The merge base, or undefined when the ref shares no history with HEAD. */
	base: string | undefined;
	/** Each changed path, with the number of lines the change touched. */
	files: Map<string, number>;
}

/**
 * The branch's own change set against the source commit: everything between the
 * merge base and HEAD. On the source ref itself the merge base is HEAD, so the
 * set is empty. Paths come from `--name-only -z` and churn from `--numstat -z`,
 * both with `core.quotepath=false`, so no user config can reshape a path.
 */
function branchChange(repositoryPath: string, commit: string): BranchChange {
	const mergeBase = git(repositoryPath, ["merge-base", commit, "HEAD"]);
	// `merge-base` exits 1 with NO output when the histories are unrelated.
	// Unrelated means "no branch change against that ref", not a failed read.
	if (mergeBase.status === 1 && mergeBase.stdout.trim().length === 0) {
		return { base: undefined, files: new Map() };
	}
	if (mergeBase.status !== 0) throw failed(`git merge-base ${commit} HEAD failed`, mergeBase);
	const base = mergeBase.stdout.trim();
	if (base.length === 0) return { base: undefined, files: new Map() };

	const common = ["-c", "core.quotepath=false", "diff", ...DIFF_PINS, "--diff-filter=ACMR", base, "HEAD"];
	const names = git(repositoryPath, [...common, "--name-only", "-z"]);
	if (names.status !== 0) throw failed("git diff --name-only failed", names);
	const stats = git(repositoryPath, [...common, "--numstat", "-z"]);
	if (stats.status !== 0) throw failed("git diff --numstat failed", stats);

	const churn = parseNumstat(stats.stdout);
	const files = new Map<string, number>();
	for (const path of names.stdout.split("\0")) {
		if (path.length === 0 || isNonCodePath(path)) continue;
		files.set(path, churn.get(path) ?? 0);
	}
	return { base, files };
}

/** The changed line ranges of one file, from `@@` headers only. */
function diffRanges(repositoryPath: string, base: string, path: string): Array<[number, number]> {
	const result = git(repositoryPath, [
		"-c",
		"core.quotepath=false",
		"diff",
		"--no-color",
		...DIFF_PINS,
		"--unified=0",
		base,
		"HEAD",
		"--",
		path,
	]);
	if (result.status !== 0) throw failed(`git diff failed for ${path}`, result);
	return parseHunkRanges(result.stdout);
}

/**
 * Config pins for the two `git grep` reads, so their output never depends on the
 * caller's git config: `core.quotepath=true` is git's own default and what the
 * producer's goldens were made under, and `--no-color` keeps `color.ui=always`
 * out of the paths.
 *
 * Producer quirk, ported for parity and pinned by a golden (GCLI-41): the
 * producer does NOT set `core.quotepath=false` on its grep reads, unlike its
 * diff reads, so a non-ASCII path found by identifier comes back quoted
 * (`"src/caf\303\251.ts"`). That string is emitted as a pointer path with
 * `lineRanges: []` (a whole file) for a file that does not exist; it takes a
 * file-cap slot and token budget, and the real `src/café.ts` loses the
 * identifier evidence the quoted entry absorbed. Tier 3 reads paths from the
 * index, unquoted, so its real `src/café.ts` and tier 4's quoted entry are
 * different strings and cannot dedup.
 */
const GREP_PINS = ["-c", "core.quotepath=true"] as const;

/**
 * `git grep -l` at the source commit: every file containing the literal token,
 * before the per-identifier read bound. The caller slices and reports the bound.
 */
function grepFiles(repositoryPath: string, commit: string, identifier: string): string[] {
	const result = git(repositoryPath, [...GREP_PINS, "grep", "--no-color", "-l", "-F", "-e", identifier, commit, "--"]);
	// 1 is "no matches", which is an answer; anything else is a broken read.
	if (result.status === 1) return [];
	if (result.status !== 0) throw failed(`git grep failed for \`${identifier}\``, result);
	const prefix = `${commit}:`;
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
		.filter((path) => !isNonCodePath(path))
		.sort();
}

/** The line numbers a literal identifier occupies in one file at the source commit. */
function grepLines(repositoryPath: string, commit: string, identifier: string, path: string): Array<[number, number]> {
	const result = git(repositoryPath, [
		...GREP_PINS,
		"grep",
		"--no-color",
		"-n",
		"-F",
		"-e",
		identifier,
		commit,
		"--",
		path,
	]);
	if (result.status === 1) return [];
	if (result.status !== 0) throw failed(`git grep -n failed for \`${identifier}\` in ${path}`, result);
	const prefix = `${commit}:${path}:`;
	const lines: Array<[number, number]> = [];
	for (const line of result.stdout.split("\n")) {
		if (!line.startsWith(prefix)) continue;
		const rest = line.slice(prefix.length);
		const separator = rest.indexOf(":");
		if (separator <= 0) continue;
		const number = Number(rest.slice(0, separator));
		if (!Number.isInteger(number) || number < 1) continue;
		lines.push([number, number]);
	}
	return mergeRanges(lines);
}

/**
 * DEC-216 (a7): task text over the bound is a usage error, never a silent
 * truncation. The bound is the producer's `.length` measure, UTF-16 code units,
 * kept for parity: an astral character (an emoji) counts as two, a BMP character
 * such as `é` as one regardless of its UTF-8 size.
 */
export function assertTaskTextWithinBound(taskText: string): void {
	if (taskText.length > CODE_MAP_MAX_TASK_TEXT) {
		throw usageError(
			`the task text is ${taskText.length} UTF-16 code units (JavaScript string length); the code-map limit is ${CODE_MAP_MAX_TASK_TEXT} code units`,
		);
	}
}

/** The pointer's line in the pack body and in its token measure. */
export function codeMapPointerLine(pointer: CodeMapPointer): string {
	const range = pointer.lineRanges.length > 0 ? ` (${pointer.lineRanges.join(", ")})` : "";
	return `${pointer.path}${range} — ${pointer.reason}`;
}

/** The code map: named paths, changed files, symbols resolved through the index, identifier matches. */
export function produceCodeMap(input: CodeMapInput): CodeMapOutput {
	const now = input.now ?? (() => performance.now());
	const budgetMs = input.timeBudgetMs ?? CODE_MAP_TIME_BUDGET_MS;
	const startedAt = now();
	const deadline = startedAt + budgetMs;
	assertTaskTextWithinBound(input.taskText);
	// The budget covers every git read from the first one, the source ref's included.
	setGitBudget({ expired: () => now() >= deadline, remaining: () => deadline - now() });
	const elapsedMs = (): number => Math.round(now() - startedAt);
	try {
		let commit: string;
		try {
			commit = resolveSourceRef(input.repositoryPath, input.sourceRef);
		} catch (error) {
			if (!(error instanceof BudgetExpired)) throw error;
			// Nothing can be gathered without the commit: no pointers, and the row says why.
			return { pointers: [], omissions: [timeBudgetRow(budgetMs, "source ref", elapsedMs(), 0)] };
		}
		return buildCodeMap(input, commit, budgetMs, elapsedMs);
	} finally {
		setGitBudget(null);
	}
}

function timeBudgetRow(budgetMs: number, stage: string, elapsedMs: number, rangesNotRead: number): CodeMapOmission {
	return {
		source: TIME_BUDGET_SOURCE,
		reason: `time-budget: the ${budgetMs} ms budget was spent during ${stage}, ${elapsedMs} ms elapsed when the run stopped; the pointers are what was gathered by then${rangesNotRead > 0 ? `, ${rangesNotRead} without line ranges` : ""}`,
	};
}

/**
 * DEC-216 (a4)(b): past the budget the run stops gathering and returns what it has,
 * with a `time-budget` omission naming the stage it stopped in. The deadline is
 * checked between units of work (a named path, the branch diff, the index load, one
 * identifier's grep, one pointer's range reads) and caps every git read at the time
 * left. The one unit it cannot interrupt is the synchronous index build, which a
 * repository far larger than the measured ones could overrun (DEC-216 (a10)); the
 * omission then names the stage that overran and carries the elapsed time.
 */
function buildCodeMap(input: CodeMapInput, commit: string, budgetMs: number, elapsedMs: () => number): CodeMapOutput {
	const text = input.taskText;
	const omissions: CodeMapOmission[] = [];
	let stoppedAt: string | undefined;
	let stoppedElapsedMs = 0;
	let rangesNotRead = 0;
	// The elapsed time is read when the run stops, so the row says when it stopped.
	const stop = (stage: string): void => {
		if (stoppedAt !== undefined) return;
		stoppedAt = stage;
		stoppedElapsedMs = elapsedMs();
	};
	const spent = (stage: string): boolean => {
		if (stoppedAt !== undefined) return true;
		if (currentGitBudget()?.expired() === true) stop(stage);
		return stoppedAt !== undefined;
	};
	const guarded = (stage: string, run: () => void): void => {
		if (spent(stage)) return;
		try {
			run();
		} catch (error) {
			if (!(error instanceof BudgetExpired)) throw error;
			stop(stage);
		}
	};

	const candidates = new Map<string, Candidate>();
	const add = (candidate: {
		path: string;
		kind: SourceKind;
		detail: string;
		score?: number;
		fromBranch?: boolean;
		identifier?: string;
		distance?: number;
		line?: number;
	}): void => {
		if (isNonCodePath(candidate.path)) return;
		const existing = candidates.get(candidate.path);
		const target: Candidate = existing ?? {
			path: candidate.path,
			rank: SOURCE_RANK[candidate.kind],
			baseRank: undefined,
			score: 0,
			distance: Number.POSITIVE_INFINITY,
			symbolRanges: [],
			reasons: new Map(),
			fromBranch: false,
			identifiers: [],
		};
		target.rank = Math.min(target.rank, SOURCE_RANK[candidate.kind]);
		if (candidate.kind !== "symbol") {
			target.baseRank = Math.min(target.baseRank ?? SOURCE_RANK[candidate.kind], SOURCE_RANK[candidate.kind]);
		}
		if (candidate.distance !== undefined) target.distance = Math.min(target.distance, candidate.distance);
		if (candidate.line !== undefined) target.symbolRanges.push([candidate.line, candidate.line]);
		target.score = Math.max(target.score, candidate.score ?? 0);
		target.fromBranch ||= candidate.fromBranch === true;
		if (candidate.identifier !== undefined) target.identifiers.push(candidate.identifier);
		target.reasons.set(`${candidate.kind}:${candidate.detail}`, { kind: candidate.kind, detail: candidate.detail });
		candidates.set(candidate.path, target);
	};

	// Tier 1: repo-relative paths named in the task text, when they exist at the
	// source ref as a blob. A directory or a stale path is not a pointer. The read
	// bound is reported: a text naming more paths than the bound tries cannot
	// silently lose the rest.
	const namedPaths = pathsNamedIn(text);
	if (namedPaths.length > CODE_MAP_MAX_PATH_CANDIDATES) {
		omissions.push({
			source: READ_BOUND_SOURCE,
			reason: `over the code-map read bound: ${namedPaths.length} paths named, ${CODE_MAP_MAX_PATH_CANDIDATES} tried`,
		});
	}
	for (const path of namedPaths.slice(0, CODE_MAP_MAX_PATH_CANDIDATES)) {
		guarded("named paths", () => {
			if (isBlobAt(input.repositoryPath, commit, path)) {
				add({ path, kind: "task-text-path", detail: "path named in the task text" });
			}
		});
	}

	// Tier 2: files this branch changed against the source ref. The diff's ranges
	// are fetched later, for the files that survive the cap only.
	let change: BranchChange = { base: undefined, files: new Map() };
	guarded("branch diff", () => {
		change = branchChange(input.repositoryPath, commit);
	});
	for (const [path, changedLines] of change.files) {
		add({
			path,
			kind: "changed-on-branch",
			detail: `changed on this branch against ${input.sourceRef} (${changedLines} line${changedLines === 1 ? "" : "s"})`,
			score: changedLines,
			fromBranch: true,
		});
	}

	// Tier 3: the symbols the text names (the producer's own identifier extraction,
	// matched by exact name), resolved through the commit's index. An absent or
	// failing index is a missing tier, never a failed run: the fallback is a true
	// control, so the output is then the deterministic producer's.
	const identifiers = collectIdentifiers(text);
	if (input.symbols !== false && !spent("symbol index")) {
		// Only the LOADER is fallible by design (git, the compiler, the cache). A defect in
		// the pure resolution below is a bug, and surfaces rather than reverting silently.
		let index: GlyphIndex | null = null;
		try {
			index = (input.loadIndex ?? loadRefIndex)(input.repositoryPath, commit);
		} catch (error) {
			// A git read the budget cut off (ls-tree, cat-file) is a stop at this stage.
			if (error instanceof BudgetExpired) stop("symbol index");
			index = null;
		}
		// The build cannot be interrupted, so the stage that spent the budget is named here.
		spent("symbol index");
		const hits = index === null ? [] : symbolHits(index, identifiers.slice(0, CODE_MAP_MAX_IDENTIFIERS));
		for (const hit of hits) {
			add({ path: hit.path, kind: "symbol", detail: hit.detail, distance: hit.distance, line: hit.line });
		}
	}

	// Tier 4: distinctive identifiers, `git grep -l` at the source ref, capped per
	// identifier so one common name cannot fill the whole map. Both read bounds
	// are reported: the identifier cap and the per-identifier file cap.
	if (identifiers.length > CODE_MAP_MAX_IDENTIFIERS) {
		omissions.push({
			source: READ_BOUND_SOURCE,
			reason: `over the code-map read bound: ${identifiers.length} identifiers found, ${CODE_MAP_MAX_IDENTIFIERS} grepped`,
		});
	}
	for (const identifier of identifiers.slice(0, CODE_MAP_MAX_IDENTIFIERS)) {
		guarded("identifier grep", () => {
			const matches = grepFiles(input.repositoryPath, commit, identifier);
			if (matches.length > CODE_MAP_MAX_FILES_PER_IDENTIFIER) {
				omissions.push({
					source: READ_BOUND_SOURCE,
					reason: `identifier \`${identifier}\` matched ${matches.length} files; the read bound records ${CODE_MAP_MAX_FILES_PER_IDENTIFIER}`,
				});
			}
			for (const path of matches.slice(0, CODE_MAP_MAX_FILES_PER_IDENTIFIER)) {
				add({ path, kind: "identifier", detail: `matches identifier \`${identifier}\``, score: 1, identifier });
			}
		});
	}

	// The identifier score is the count of DISTINCT identifiers a file matched.
	for (const candidate of candidates.values()) {
		if (candidate.identifiers.length > 0) {
			candidate.score = Math.max(candidate.score, new Set(candidate.identifiers).size);
		}
	}

	// Rank: by source (named paths, changed files, symbols, then identifiers), then the
	// best relevance score, then path. A total order over immutable inputs is what
	// makes the list stable.
	// Within the symbol tier a declaring file (distance 0) precedes a referencing
	// one (distance 1); every tier then breaks ties by score and path.
	const order = (rankOf: (c: Candidate) => number) => (left: Candidate, right: Candidate) => {
		const leftRank = rankOf(left);
		const rightRank = rankOf(right);
		if (leftRank !== rightRank) return leftRank - rightRank;
		if (leftRank === SYMBOL_RANK && left.distance !== right.distance) return left.distance - right.distance;
		if (left.score !== right.score) return right.score - left.score;
		return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
	};
	const ranked = [...candidates.values()].sort(order((candidate) => candidate.rank));

	const pointers: CodeMapPointer[] = [];
	let tokens = 0;
	let overFileCap = 0;
	for (const candidate of ranked) {
		// The file cap is final once reached, so every candidate behind it is
		// COUNTED and named rather than dropped in silence: one summary row, so the
		// omission list does not grow with the branch size.
		if (pointers.length >= CODE_MAP_MAX_FILES) {
			overFileCap += 1;
			continue;
		}

		// Ranges are only worth a git call for a file that will be emitted. A branch
		// diff's are HEAD's line numbers and a grep's are the source commit's, so a
		// file the branch changed carries its diff ranges alone.
		// Past the budget a file the branch changed carries NO ranges: the source commit's
		// symbol lines are not its diff's (HEAD's) line numbers.
		let ranges: Array<[number, number]> =
			candidate.fromBranch && change.base !== undefined ? [] : mergeRanges(candidate.symbolRanges);
		let rangesRead = false;
		guarded("line ranges", () => {
			const branchRanges =
				candidate.fromBranch && change.base !== undefined
					? diffRanges(input.repositoryPath, change.base, candidate.path)
					: undefined;
			ranges =
				branchRanges !== undefined
					? branchRanges
					: mergeRanges([
							...candidate.symbolRanges,
							...candidate.identifiers.flatMap((identifier) =>
								grepLines(input.repositoryPath, commit, identifier, candidate.path),
							),
						]);
			rangesRead = true;
		});
		// Past the budget a pointer is still returned, without the git reads that would
		// have given its line ranges; its reason says so, since an empty range list
		// otherwise means the whole file.
		if (!rangesRead) rangesNotRead += 1;
		const shown = ranges.slice(0, CODE_MAP_MAX_RANGES_PER_POINTER).map(formatRange);
		if (ranges.length > CODE_MAP_MAX_RANGES_PER_POINTER) {
			shown.push(`+${ranges.length - CODE_MAP_MAX_RANGES_PER_POINTER} more ranges`);
		}

		const pointer: CodeMapPointer = {
			path: candidate.path,
			lineRanges: shown,
			reason:
				[...candidate.reasons.values()].map((entry) => entry.detail).join("; ") +
				(rangesRead ? "" : "; line ranges not read (time-budget)"),
		};
		const cost = estimateTokens(codeMapPointerLine(pointer));
		// An over-budget pointer is SKIPPED, not fatal to the list, and the skip is
		// NAMED: a dropped pointer is an omission row.
		if (tokens + cost > CODE_MAP_MAX_TOKENS) {
			omissions.push({
				source: `code-map:${candidate.path}`,
				reason: `over the code-map token cap: ${tokens} of ${CODE_MAP_MAX_TOKENS} tokens already chosen`,
			});
			continue;
		}
		tokens += cost;
		pointers.push(pointer);
	}
	// A file that tier 3 pushed out of the cap is named, not only counted: it was in
	// the first CODE_MAP_MAX_FILES of the ranking without tier 3 and is not in the
	// emitted list. A file already named for the token cap keeps that row; the
	// rest are the usual one summary row. Edge: the comparison is the first
	// CODE_MAP_MAX_FILES of the ranking without tier 3 and ignores the token cap,
	// so a file that would itself have been token-skipped without tier 3 is still
	// named as displaced when tier 3 pushes it past the file cap.
	const accountedFor = new Set([
		...pointers.map((pointer) => pointer.path),
		...omissions.map((omission) => omission.source.replace(/^code-map:/, "")),
	]);
	const withoutSymbols = [...candidates.values()]
		.filter((candidate) => candidate.baseRank !== undefined)
		.sort(order((candidate) => candidate.baseRank ?? SYMBOL_RANK))
		.slice(0, CODE_MAP_MAX_FILES);
	let displaced = 0;
	for (const candidate of withoutSymbols) {
		if (accountedFor.has(candidate.path)) continue;
		displaced += 1;
		omissions.push({
			source: `code-map:${candidate.path}`,
			reason: `displaced by symbol pointers at the code-map file cap of ${CODE_MAP_MAX_FILES}`,
		});
	}
	if (overFileCap - displaced > 0) {
		omissions.push({
			source: FILE_CAP_SOURCE,
			reason: `${overFileCap - displaced} more over the code-map file cap of ${CODE_MAP_MAX_FILES}`,
		});
	}

	if (stoppedAt !== undefined) {
		omissions.push(timeBudgetRow(budgetMs, stoppedAt, stoppedElapsedMs, rangesNotRead));
	}

	return { pointers, omissions };
}
