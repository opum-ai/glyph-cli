import { indeterminateError, notFoundError } from "./errors.ts";

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
		// A fixed locale keeps discovery's "not a git repository" test
		// independent of the caller's environment.
		env: { ...process.env, LC_ALL: "C" },
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
export function resolveCommit(repoRoot: string, ref: string): string | null {
	const result = gitRun(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	const sha = result.stdout.trim();
	return result.code === 0 && sha !== "" ? sha : null;
}

/** Resolve `base` and `head` to commit SHAs; a ref that will not resolve is not-found. */
export function resolveDiffRefs(repoRoot: string, base: string, head: string): { baseSha: string; headSha: string } {
	const baseSha = resolveCommit(repoRoot, base);
	const headSha = resolveCommit(repoRoot, head);
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

/** One entry of `git ls-tree -r`, as the ref-index source consumes it. */
export interface TreeEntry {
	mode: string;
	type: string;
	sha: string;
	/** Repository-relative, POSIX. */
	path: string;
}

/**
 * Every entry of the tree at `sha`, recursively. `--full-tree` makes the paths
 * relative to the repository root regardless of the current directory, and
 * `-z` removes quoting, so a non-ASCII or backslash-named path arrives intact.
 */
export function listTree(repoRoot: string, sha: string): TreeEntry[] {
	const result = gitRun(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", sha]);
	if (result.code !== 0) {
		throw indeterminateError(`git ls-tree failed for ${sha}: ${result.stderr.trim() || "unknown error"}`);
	}
	const entries: TreeEntry[] = [];
	for (const record of result.stdout.split("\0")) {
		if (record === "") continue;
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode, type, object] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (mode === undefined || type === undefined || object === undefined || path === "") continue;
		entries.push({ mode, type, sha: object, path });
	}
	return entries;
}

/**
 * Read the contents of `objectIds` in one `git cat-file --batch` invocation.
 * The batch protocol is a text header line (`<sha> <type> <size>`) followed by
 * exactly `size` bytes and a newline, so the reader walks bytes rather than
 * lines: a source file may contain anything, including newlines that look
 * like headers.
 */
export function readBlobs(repoRoot: string, objectIds: readonly string[]): Map<string, string> {
	const contents = new Map<string, string>();
	if (objectIds.length === 0) return contents;
	const proc = Bun.spawnSync(["git", "-C", repoRoot, "cat-file", "--batch"], {
		env: { ...process.env, LC_ALL: "C" },
		stdin: new TextEncoder().encode(`${objectIds.join("\n")}\n`),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw indeterminateError(
			`git cat-file failed for ${objectIds.length} object(s): ${proc.stderr.toString().trim() || "unknown error"}`,
		);
	}
	const bytes = proc.stdout;
	const decoder = new TextDecoder();
	let offset = 0;
	for (const id of objectIds) {
		const headerStart = offset;
		while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
		if (offset >= bytes.length) {
			throw indeterminateError(`git cat-file returned a truncated header for ${id}`);
		}
		const header = decoder.decode(bytes.subarray(headerStart, offset));
		offset += 1; // the header's newline
		const parts = header.split(" ");
		const size = Number.parseInt(parts[2] ?? "", 10);
		if (parts.length < 3 || !Number.isFinite(size)) {
			// `<name> missing` or `<name> ambiguous`: the tree listed an object it
			// will not now produce, which is an indeterminate repository, not a miss.
			continue;
		}
		if (offset + size > bytes.length) {
			throw indeterminateError(`git cat-file returned a truncated body for ${id}`);
		}
		contents.set(id, decoder.decode(bytes.subarray(offset, offset + size)));
		offset += size + 1; // the body's trailing newline
	}
	return contents;
}

const C_ESCAPES: Record<string, number> = {
	a: 0x07,
	b: 0x08,
	f: 0x0c,
	n: 0x0a,
	r: 0x0d,
	t: 0x09,
	v: 0x0b,
	"\\": 0x5c,
	'"': 0x22,
};

/**
 * Undo git's C-style path quoting in a diff header.
 *
 * Under the default `core.quotePath`, `git diff` wraps a path that contains a
 * double quote, a backslash, a control byte or any non-ASCII byte in double
 * quotes and escapes the offending bytes (`\t`, `\\`, `\303\251`, ...). A
 * quoted header has to be decoded back to the real path before it can name a
 * file the index knows; otherwise every symbol in such a file drops out of
 * `diff` silently. An unquoted header is returned unchanged, and an escape
 * this decoder does not recognise leaves the whole header as it was rather
 * than corrupting it.
 */
export function unquoteGitPath(path: string): string {
	if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
	const inner = path.slice(1, -1);
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	let index = 0;
	while (index < inner.length) {
		const char = inner[index];
		if (char === undefined) break;
		if (char !== "\\") {
			const literal = String.fromCodePoint(inner.codePointAt(index) ?? 0);
			bytes.push(...encoder.encode(literal));
			index += literal.length;
			continue;
		}
		const escaped = inner[index + 1];
		if (escaped === undefined) return path;
		const simple = C_ESCAPES[escaped];
		if (simple !== undefined) {
			bytes.push(simple);
			index += 2;
			continue;
		}
		let end = index + 1;
		while (end < inner.length && end <= index + 3) {
			const digit = inner[end];
			if (digit === undefined || digit < "0" || digit > "7") break;
			end += 1;
		}
		if (end === index + 1) return path; // An escape git never emits: leave the header alone.
		bytes.push(Number.parseInt(inner.slice(index + 1, end), 8) & 0xff);
		index = end;
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

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
 * - The `+++` path is run through {@link unquoteGitPath}: git C-quotes any name
 *   with a non-ASCII, backslash or control byte, and the quoted form names no
 *   file the index built from the tree.
 */
export function parseDiff(repoRoot: string, baseSha: string, headSha: string): FileChange[] {
	const result = gitRun(repoRoot, ["diff", "--unified=0", "--no-color", "--no-ext-diff", baseSha, headSha, "--"]);
	if (result.code !== 0) {
		// The refs resolved, so this is not the caller's usage error: Git could
		// not produce the diff (a corrupt object store, a refused repository).
		throw indeterminateError(`git diff failed for ${baseSha}..${headSha}: ${result.stderr.trim() || "unknown error"}`);
	}
	const changes: FileChange[] = [];
	let current: FileChange | null = null;
	// `---` precedes `+++` for the same file, so the new-file marker is pending
	// state read by the very next `+++` line, never a look-back at the last entry.
	let pendingOldIsNull = false;

	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("--- ")) {
			pendingOldIsNull = unquoteGitPath(line.slice(4).trim()) === "/dev/null";
			continue;
		}
		if (line.startsWith("+++ ")) {
			const target = unquoteGitPath(line.slice(4).trim());
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
