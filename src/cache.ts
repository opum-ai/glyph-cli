import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitRun } from "./git.ts";
import { INDEX_FORMAT, type GlyphIndex } from "./types.ts";

/**
 * The local cache is the only state Glyph keeps, and it is disposable: every
 * entry is re-derivable from the repository (ADR 0001, Consequences). Location:
 * `$GLYPH_CACHE_DIR`, else `$XDG_CACHE_HOME/glyph`, else `~/.cache/glyph`,
 * under a directory keyed by the repository's absolute path.
 */

/** How many revisions of one repository to retain before pruning the oldest. */
const RETAINED_REVISIONS = 5;

export function cacheRoot(): string {
	const override = process.env.GLYPH_CACHE_DIR;
	if (override !== undefined && override !== "") return override;
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".cache");
	return join(base, "glyph");
}

export function cacheDir(repoRoot: string): string {
	const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
	return join(cacheRoot(), hash);
}

/**
 * The key covers everything the index is derived from: the index format, the
 * commit when there is one, and every source file's path, size and mtime.
 *
 * Per-file stats rather than the commit alone, deliberately: a dirty working
 * tree IS what the index describes, so keying on HEAD alone would serve a stale
 * index after an edit — and a directory with no git at all still gets a key
 * that changes when its files do.
 */
export function computeKey(repoRoot: string, files: string[]): string {
	const hash = createHash("sha1");
	hash.update(`glyph-index-format:${INDEX_FORMAT}\n`);
	const head = gitRun(repoRoot, ["rev-parse", "HEAD"]);
	hash.update(`head:${head.code === 0 ? head.stdout.trim() : "none"}\n`);
	for (const file of files) {
		let size = -1;
		let mtime = -1;
		try {
			const stat = statSync(join(repoRoot, file));
			size = stat.size;
			mtime = stat.mtimeMs;
		} catch {
			// A file listed but vanished mid-key: sentinels keep the key unique-enough.
		}
		hash.update(`${file}:${size}:${mtime}\n`);
	}
	return hash.digest("hex").slice(0, 24);
}

/**
 * The cache key for an index of one commit's tree. That tree is immutable, so
 * the commit SHA and the index format determine the derived index; the file
 * list is mixed in as well so two different trees can never collide even if a
 * format bump ever fails to reach this line. Deliberately not stat-based: a
 * `--ref` answer must not move when the checkout does.
 */
export function computeRefKey(sha: string, files: readonly string[]): string {
	const hash = createHash("sha1");
	hash.update(`glyph-index-format:${INDEX_FORMAT}\n`);
	hash.update(`ref:${sha}\n`);
	for (const file of files) hash.update(`${file}\n`);
	return hash.digest("hex").slice(0, 24);
}

export function readCachedIndex(repoRoot: string, key: string): GlyphIndex | null {
	const path = join(cacheDir(repoRoot), `${key}.json`);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as GlyphIndex;
		return parsed.schemaVersion === INDEX_FORMAT ? parsed : null;
	} catch {
		// Missing or corrupt: a miss, never an error — the cache may be deleted at any time.
		return null;
	}
}

export function writeCachedIndex(repoRoot: string, key: string, index: GlyphIndex): void {
	const dir = cacheDir(repoRoot);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${key}.json`), `${JSON.stringify(index)}\n`);
	pruneOldRevisions(dir, `${key}.json`);
}

function pruneOldRevisions(dir: string, keepName: string): void {
	let entries: { name: string; mtimeMs: number }[];
	try {
		entries = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
	} catch {
		return;
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const entry of entries.slice(RETAINED_REVISIONS)) {
		if (entry.name === keepName) continue;
		try {
			rmSync(join(dir, entry.name), { force: true });
		} catch {
			// Best-effort pruning; a failed delete costs disk, never correctness.
		}
	}
}

export function clearCache(repoRoot: string): number {
	const dir = cacheDir(repoRoot);
	if (!existsSync(dir)) return 0;
	const count = readdirSync(dir).filter((name) => name.endsWith(".json")).length;
	rmSync(dir, { recursive: true, force: true });
	return count;
}
