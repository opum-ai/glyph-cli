import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitRun } from "../src/git.ts";

/** A throwaway git repository on disk for tests to own outright. */
export interface ScratchRepo {
	root: string;
	/** Write (or overwrite) a repository-relative file. */
	write(relPath: string, content: string): void;
	/** Stage everything and commit; returns the commit SHA. */
	commit(message: string): string;
}

export function makeScratchRepo(files: Record<string, string>): ScratchRepo {
	const root = mkdtempSync(join(tmpdir(), "glyph-test-"));
	const write = (relPath: string, content: string): void => {
		const absolute = join(root, relPath);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	};
	for (const [relPath, content] of Object.entries(files)) write(relPath, content);
	return {
		root,
		write,
		commit(message: string): string {
			gitRun(root, ["init", "-q"]);
			gitRun(root, ["config", "user.email", "test@opum.test"]);
			gitRun(root, ["config", "user.name", "glyph test"]);
			gitRun(root, ["add", "-A"]);
			const committed = gitRun(root, ["commit", "-qm", message]);
			if (committed.code !== 0) throw new Error(`scratch commit failed: ${committed.stderr.trim()}`);
			return gitRun(root, ["rev-parse", "HEAD"]).stdout.trim();
		},
	};
}

/** An isolated cache directory for one test, so no test can read another's index. */
export function scratchCacheDir(): string {
	return mkdtempSync(join(tmpdir(), "glyph-cache-"));
}
