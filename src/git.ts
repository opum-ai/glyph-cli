import { notFoundError, usageError } from "./errors.ts";

/**
 * The small slice of git Glyph needs: the repository root, resolved SHAs for
 * the diff query, and the diff's changed line ranges.
 *
 * `git` is invoked through Bun.spawnSync with an explicit `-C <root>`; every
 * function here fails closed with a typed error rather than printing git's
 * stderr into a result.
 */

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function gitRun(repoRoot: string, args: string[]): GitResult {
	const proc = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

/** The worktree root containing `dir`, or null when `dir` is not in a repository. */
export function repoRootFor(dir: string): string | null {
	const result = gitRun(dir, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return null;
	const root = result.stdout.trim();
	return root === "" ? null : root;
}

/** Resolve a single ref to a commit SHA, or null. `rev-parse --verify` takes
 * exactly ONE revision per invocation ("fatal: Needed a single revision"
 * otherwise), which is why the two refs are resolved by two calls. */
function resolveOne(repoRoot: string, ref: string): string | null {
	const result = gitRun(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	const sha = result.stdout.trim();
	return result.code === 0 && sha !== "" ? sha : null;
}

/** Resolve `base` and `head` to commit SHAs; a ref that will not resolve is not-found. */
export function resolveDiffRefs(repoRoot: string, base: string, head: string): { baseSha: string; headSha: string } {
	const baseSha = resolveOne(repoRoot, base);
	const headSha = resolveOne(repoRoot, head);
	if (baseSha === null || headSha === null) {
		throw notFoundError(`could not resolve '${base}' or '${head}' to a commit in ${repoRoot}`);
	}
	return { baseSha, headSha };
}

/** A closed line range on the new side of the diff, 1-based and inclusive. */
export interface LineRange {
	start: number;
	end: number;
}

export interface FileChange {
	file: string;
	ranges: LineRange[];
	/** Replacement markers are trivial to miss; when the file is new, every line is a change. */
	wholeFile: boolean;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --unified=0` into per-file changed line ranges on the NEW
 * side, because symbols are attributed from the working tree's source.
 *
 * Two parsing decisions worth naming:
 * - A deletion-only hunk is `+c,0`: no new line is part of the change, but the
 *   deletion happened *inside* the enclosing symbol, so line `c` (git's
 *   insertion point; clamped to >= 1) is treated as the changed line. Without
 *   this, deleting a call would report that nothing was touched.
 * - `+++ /dev/null` marks a deleted file, which contributes no new-side ranges
 *   and is skipped.
 */
export function parseDiff(repoRoot: string, baseSha: string, headSha: string): FileChange[] {
	const result = gitRun(repoRoot, ["diff", "--unified=0", "--no-color", "--no-ext-diff", baseSha, headSha, "--"]);
	if (result.code !== 0) {
		throw usageError(`git diff failed for ${baseSha}..${headSha}: ${result.stderr.trim() || "unknown error"}`);
	}
	const changes: FileChange[] = [];
	let current: FileChange | null = null;
	// `---` precedes `+++` for the same file, so the new-file marker is pending
	// state read by the very next `+++` line, never a look-back at the last entry.
	let pendingOldIsNull = false;

	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("--- ")) {
			pendingOldIsNull = line.slice(4).trim() === "/dev/null";
			continue;
		}
		if (line.startsWith("+++ ")) {
			const target = line.slice(4).trim();
			if (target === "/dev/null") {
				current = null; // Deleted file: nothing on the new side to attribute.
				pendingOldIsNull = false;
				continue;
			}
			const file = target.startsWith("b/") ? target.slice(2) : target;
			current = { file, ranges: [], wholeFile: pendingOldIsNull };
			pendingOldIsNull = false;
			changes.push(current);
			continue;
		}
		const hunk = HUNK_HEADER.exec(line);
		if (hunk && current && !current.wholeFile) {
			const start = Number.parseInt(hunk[1] ?? "0", 10);
			const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
			if (count === 0) {
				current.ranges.push({ start: Math.max(start, 1), end: Math.max(start, 1) });
			} else {
				current.ranges.push({ start, end: start + count - 1 });
			}
		}
	}
	return changes.filter((change) => change.wholeFile || change.ranges.length > 0);
}
