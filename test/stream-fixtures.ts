/**
 * The repository `--stream` tests share, kept in one place so the golden capture
 * (taken from the pre-stream commit) and the tests run on byte-identical input.
 *
 * `helper` has two call sites, so every command has at least two items — enough
 * for a mid-stream failure to land after one item and before the result line.
 */
export const STREAM_FIXTURE_FILES: Record<string, string> = {
	"src/util.ts": "export function helper(n: number): number {\n  return n + 1;\n}\n",
	"src/main.ts": 'import { helper } from "./util";\nexport function main(): number {\n  return helper(1);\n}\n',
	"src/other.ts": 'import { helper } from "./util";\nexport function other(): number {\n  return helper(2);\n}\n',
};

/** code-map reads the task text from stdin; this names a path and a symbol. */
export const STREAM_CODEMAP_TASK = "fix `helper` in src/other.ts";

export interface BatchInvocation {
	args: string[];
	stdin?: string;
}

export const STREAM_BATCH_INVOCATIONS: Record<"callers" | "impact" | "code-map", BatchInvocation> = {
	callers: { args: ["--json", "callers", "helper"] },
	impact: { args: ["--json", "impact", "helper"] },
	"code-map": { args: ["--json", "code-map", "--source-ref", "HEAD"], stdin: STREAM_CODEMAP_TASK },
};
