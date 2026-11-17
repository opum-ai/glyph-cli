import {
	CODE_MAP_MAX_FILES,
	CODE_MAP_MAX_FILES_PER_IDENTIFIER,
	CODE_MAP_MAX_IDENTIFIERS,
	CODE_MAP_MAX_PATH_CANDIDATES,
	CODE_MAP_MAX_RANGES_PER_POINTER,
	CODE_MAP_MAX_TASK_TEXT,
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
} from "./codemap-text.ts";
import { GlyphError, indeterminateError, notFoundError } from "./errors.ts";

/**
 * `glyph code-map`: the CodeMapProducer seam's `{ pointers, omissions }`.
 *
 * Tiers 1, 2 and 4 of DEC-216 (a4) are a port of opum-cli's deterministic
 * producer (`src/context/code-map.ts`, pinned in `codemap-text.ts`): named
 * paths, files the branch changed, and `git grep -l` for the task text's
 * distinctive identifiers. Tier 3 (symbols resolved through the index) is
 * GCLI-37. The output is POINTERS, never file bodies, bounded to
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

type SourceKind = "task-text-path" | "changed-on-branch" | "identifier";

const SOURCE_RANK: Readonly<Record<SourceKind, number>> = {
	"task-text-path": 0,
	"changed-on-branch": 1,
	identifier: 2,
};

interface Candidate {
	path: string;
	/** The best (lowest) rank any source gave this path. */
	rank: number;
	/** The best score any source gave it: churn, or identifiers matched. */
	score: number;
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
	try {
		const proc = Bun.spawnSync(["git", "--literal-pathspecs", ...args], {
			cwd: repositoryPath,
			env: { ...process.env, NO_COLOR: "1" },
			stdout: "pipe",
			stderr: "pipe",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
		});
		if (proc.exitCode === null) {
			throw indeterminateError(`git ${args[0] ?? ""} did not report an exit status (timeout or signal)`);
		}
		return { status: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
	} catch (error) {
		if (error instanceof GlyphError) throw error;
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
 * `git grep -l` at the source commit: every file containing the literal token,
 * before the per-identifier read bound. The caller slices and reports the bound.
 */
function grepFiles(repositoryPath: string, commit: string, identifier: string): string[] {
	const result = git(repositoryPath, ["grep", "-l", "-F", "-e", identifier, commit, "--"]);
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
	const result = git(repositoryPath, ["grep", "-n", "-F", "-e", identifier, commit, "--", path]);
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

/** The pointer's line in the pack body and in its token measure. */
export function codeMapPointerLine(pointer: CodeMapPointer): string {
	const range = pointer.lineRanges.length > 0 ? ` (${pointer.lineRanges.join(", ")})` : "";
	return `${pointer.path}${range} — ${pointer.reason}`;
}

/** Tiers 1, 2 and 4 of the code map: named paths, changed files, identifier matches. */
export function produceCodeMap(input: CodeMapInput): CodeMapOutput {
	const commit = resolveSourceRef(input.repositoryPath, input.sourceRef);
	const text = input.taskText.slice(0, CODE_MAP_MAX_TASK_TEXT);
	const omissions: CodeMapOmission[] = [];

	const candidates = new Map<string, Candidate>();
	const add = (candidate: {
		path: string;
		kind: SourceKind;
		detail: string;
		score?: number;
		fromBranch?: boolean;
		identifier?: string;
	}): void => {
		if (isNonCodePath(candidate.path)) return;
		const existing = candidates.get(candidate.path);
		const target: Candidate = existing ?? {
			path: candidate.path,
			rank: SOURCE_RANK[candidate.kind],
			score: 0,
			reasons: new Map(),
			fromBranch: false,
			identifiers: [],
		};
		target.rank = Math.min(target.rank, SOURCE_RANK[candidate.kind]);
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
		if (!isBlobAt(input.repositoryPath, commit, path)) continue;
		add({ path, kind: "task-text-path", detail: "path named in the task text" });
	}

	// Tier 2: files this branch changed against the source ref. The diff's ranges
	// are fetched later, for the files that survive the cap only.
	const change = branchChange(input.repositoryPath, commit);
	for (const [path, changedLines] of change.files) {
		add({
			path,
			kind: "changed-on-branch",
			detail: `changed on this branch against ${input.sourceRef} (${changedLines} line${changedLines === 1 ? "" : "s"})`,
			score: changedLines,
			fromBranch: true,
		});
	}

	// Tier 4: distinctive identifiers, `git grep -l` at the source ref, capped per
	// identifier so one common name cannot fill the whole map. Both read bounds
	// are reported: the identifier cap and the per-identifier file cap.
	const identifiers = collectIdentifiers(text);
	if (identifiers.length > CODE_MAP_MAX_IDENTIFIERS) {
		omissions.push({
			source: READ_BOUND_SOURCE,
			reason: `over the code-map read bound: ${identifiers.length} identifiers found, ${CODE_MAP_MAX_IDENTIFIERS} grepped`,
		});
	}
	for (const identifier of identifiers.slice(0, CODE_MAP_MAX_IDENTIFIERS)) {
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
	}

	// The identifier score is the count of DISTINCT identifiers a file matched.
	for (const candidate of candidates.values()) {
		if (candidate.identifiers.length > 0) {
			candidate.score = Math.max(candidate.score, new Set(candidate.identifiers).size);
		}
	}

	// Rank: by source (paths, then branch, then identifiers), then the best
	// relevance score, then path. A total order over immutable inputs is what
	// makes the list stable.
	const ranked = [...candidates.values()].sort((left, right) => {
		if (left.rank !== right.rank) return left.rank - right.rank;
		if (left.score !== right.score) return right.score - left.score;
		return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
	});

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
		const branchRanges =
			candidate.fromBranch && change.base !== undefined
				? diffRanges(input.repositoryPath, change.base, candidate.path)
				: undefined;
		const ranges =
			branchRanges !== undefined
				? branchRanges
				: mergeRanges(
						candidate.identifiers.flatMap((identifier) =>
							grepLines(input.repositoryPath, commit, identifier, candidate.path),
						),
					);
		const shown = ranges.slice(0, CODE_MAP_MAX_RANGES_PER_POINTER).map(formatRange);
		if (ranges.length > CODE_MAP_MAX_RANGES_PER_POINTER) {
			shown.push(`+${ranges.length - CODE_MAP_MAX_RANGES_PER_POINTER} more ranges`);
		}

		const pointer: CodeMapPointer = {
			path: candidate.path,
			lineRanges: shown,
			reason: [...candidate.reasons.values()].map((entry) => entry.detail).join("; "),
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
	if (overFileCap > 0) {
		omissions.push({
			source: FILE_CAP_SOURCE,
			reason: `${overFileCap} more over the code-map file cap of ${CODE_MAP_MAX_FILES}`,
		});
	}

	return { pointers, omissions };
}
