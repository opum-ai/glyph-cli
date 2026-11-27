import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { indeterminateError } from "../errors.ts";
import type { LanguageIndexer } from "../language.ts";
import { sourceBytesAtRef } from "../snapshot.ts";
import { INDEX_FORMAT, type GlyphIndex, type SiteEntry } from "../types.ts";
import { analyzePythonCalls, type PythonCallSite } from "./calls.ts";
import type { PythonModuleInput } from "./modules.ts";
import { grammarVersion } from "./parse.ts";

/**
 * The native Python indexer behind the language seam (S7, ADR 0008, DEC-303
 * (a14)).
 *
 * The S3 module graph, S4 symbol table and S5 call resolution already exist and
 * are pure over `{path, bytes}`; this adapter supplies those bytes and maps the
 * analyzer's result onto the shared `GlyphIndex` the queries read. It owns no
 * resolution semantics and adds no dependency.
 */

/**
 * The analyzer's own version, part of every Python cache key (S7 rule 6). Bump
 * it when the Python analysis changes in a way the injected grammar version and
 * `INDEX_FORMAT` do not capture. Bumped to 2 for S8a's nested project roots
 * (DEC-303 (a18)): the marker directories also enter the key, but a marker-less
 * repository still needs the new key rather than a stale pre-S8a answer. Bumped to
 * 3 for GCLI-89: an attribute or subscript assignment target no longer rebinds its
 * base name (DEC-303 (a23) item 1), which changes which calls resolve. Bumped to 4
 * for GCLI-140: an attribute write is a binding of that attribute (DEC-303 (a25)),
 * which refuses calls that resolved before. Bumped to 5 for GCLI-151: a
 * descendant's `__class__` write now refuses an instance receiver typed as its
 * base (DEC-303 (a88) note 4), which refuses calls that resolved before.
 */
export const PYTHON_ANALYZER_VERSION = "5";

/** The S5 per-site flags, carried in the cached index and never in an envelope (rule 17). */
interface SiteFlags {
	multiplyBound?: boolean;
	polymorphic?: boolean;
	externalBaseBefore?: boolean;
	decorated?: boolean;
}

/** The repository-relative POSIX path of a selected file, never its basename (rule 2). */
function repositoryPath(repoRoot: string, file: string): string {
	const rel = relative(resolve(repoRoot), resolve(repoRoot, file));
	return sep === "\\" ? rel.split("\\").join("/") : rel;
}

/** Each S5 site becomes one `SiteEntry`, kind included (`decorator` is a site kind now). */
function toSiteEntry(site: PythonCallSite): SiteEntry & SiteFlags {
	const entry: SiteEntry & SiteFlags = {
		calleeId: site.calleeId,
		callerId: site.callerId,
		file: site.file,
		line: site.line,
		column: site.column,
		kind: site.kind,
	};
	if (site.multiplyBound !== undefined) entry.multiplyBound = site.multiplyBound;
	if (site.polymorphic !== undefined) entry.polymorphic = site.polymorphic;
	if (site.externalBaseBefore !== undefined) entry.externalBaseBefore = site.externalBaseBefore;
	if (site.decorated !== undefined) entry.decorated = site.decorated;
	return entry;
}

/**
 * Rule 4: a non-empty S3 exit-7 list is indeterminate (exit 7), naming the
 * first trigger and the count. It is never an empty or partial answer, so the
 * throw happens before any index is built or cached. An ERROR/MISSING tree or a
 * decode replacement is not exit 7 by itself; S5 lowers `exact` for it.
 */
function throwIfIndeterminate(
	triggers: readonly { path: string; line: number; name: string; original: string }[],
): void {
	const first = triggers[0];
	if (first === undefined) return;
	const count = triggers.length;
	throw indeterminateError(
		`python: ${count} first-party package root${count === 1 ? "" : "s"} did not resolve to a source root; first: '${first.original}' at ${first.path}:${first.line} names '${first.name}'`,
	);
}

/** Map one analyzer result onto the shared index shape (rules 3 and 15). */
async function buildIndex(
	repoRoot: string,
	files: readonly string[],
	inputs: readonly PythonModuleInput[],
	markerDirs?: readonly string[],
): Promise<GlyphIndex> {
	const result = await analyzePythonCalls(inputs, markerDirs === undefined ? {} : { markerDirs });
	throwIfIndeterminate(result.exit7);
	const unresolvedSites =
		result.unresolvedByKind.call +
		result.unresolvedByKind.import +
		result.unresolvedByKind.extends +
		result.unresolvedByKind.implements +
		result.unresolvedByKind.dynamic;
	const index: GlyphIndex = {
		schemaVersion: INDEX_FORMAT,
		repo: repoRoot,
		createdAt: new Date().toISOString(),
		files: [...files],
		symbols: result.symbols,
		sites: result.sites.map(toSiteEntry),
		unresolvedSites,
		unresolvedByKind: result.unresolvedByKind,
		// Python only, and ABSENT for TypeScript by construction (rule 15).
		callBins: result.callBins,
		unresolvedFirstPartyImports: result.unresolvedFirstPartyImports,
		constructorNotes: result.constructorNotes.length,
	};
	// DEC-303 (a15) 19: present only when non-empty; absent, never null or `[]`,
	// for a clean Python run so no existing golden changes bytes.
	if (result.parseErrorFiles.length > 0) index.parseErrorFiles = result.parseErrorFiles;
	return index;
}

/** The working-tree source of one Python repository, read as bytes (rule 2). */
function readWorkingTreeInputs(repoRoot: string, files: readonly string[]): PythonModuleInput[] {
	return files.map((path) => ({ path, bytes: new Uint8Array(readFileSync(join(repoRoot, path))) }));
}

/** The ref's blobs through the snapshot, without a checkout (rule 7). */
function readRefInputs(repoRoot: string, sha: string, files: readonly string[]): PythonModuleInput[] {
	const sources = sourceBytesAtRef(repoRoot, sha, files);
	const byPath = new Map(sources.map((source) => [source.path, source.bytes]));
	return files.filter((path) => byPath.has(path)).map((path) => ({ path, bytes: byPath.get(path) as Uint8Array }));
}

/** A selected path, POSIX and repository-relative; the walk branch may hand a different shape. */
function posixPath(file: string): string {
	return sep === "\\" ? file.split("\\").join("/") : file;
}

/**
 * The registered Python indexer. `cacheKey` carries the two version constants a
 * Python cache key adds to the language id and the file list (rule 6); the
 * TypeScript indexer declares none, so its key is unchanged. `markerDirs` are
 * the nested project-root markers supplied by the adapter from the same listing
 * the files came from (S8a rules 2 and 8): the working tree's Git listing or the
 * commit's tree, so both sources agree.
 */
export const pythonIndexer: LanguageIndexer = {
	id: "python",
	cacheKey: { analyzerVersion: PYTHON_ANALYZER_VERSION, grammarVersion: grammarVersion() },
	index: (repoRoot: string, files: string[], markerDirs?: readonly string[]): Promise<GlyphIndex> => {
		const paths = files.map((file) => repositoryPath(repoRoot, file));
		return buildIndex(repoRoot, paths, readWorkingTreeInputs(repoRoot, paths), markerDirs);
	},
	indexRef: (repoRoot: string, sha: string, files: string[], markerDirs?: readonly string[]): Promise<GlyphIndex> => {
		const paths = files.map(posixPath);
		return buildIndex(repoRoot, paths, readRefInputs(repoRoot, sha, paths), markerDirs);
	},
};
