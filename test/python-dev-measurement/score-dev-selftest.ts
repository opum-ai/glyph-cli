/**
 * Self-test for the declaration-site matching in score-dev.ts (GCLI-168,
 * DEC-303 (a93) item 4). Runs the repository's own Python analyzer over
 * in-memory fixtures and checks the matcher directly; not a *.test.ts file, so
 * no workflow runs it and no gate depends on it. Development data only.
 *
 *   bun test/python-dev-measurement/score-dev-selftest.ts
 *
 * The refusal fixture is two same-named classes declared inside the same
 * function at different sites. The analyzer gives both the same qualname, so a
 * qualname-keyed matcher collapses them; the declaration-site matcher must pick
 * the one at the labelled site and refuse an edge that points at the other.
 */
import { analyzePythonCalls } from "../../src/python/calls.ts";
import { buildDeclarationIndex, type Target, symbolIdForTarget } from "./score-dev.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "ok" : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
}

async function analyze(files: Record<string, string>) {
	const inputs = Object.entries(files).map(([path, src]) => ({ path, bytes: new TextEncoder().encode(src) }));
	return analyzePythonCalls(inputs, { markerDirs: [] });
}

const twinResult = await analyze({
	"m.py": `def outer():
    class Twin:
        pass
    class Twin:
        pass
`,
});
const twins = twinResult.symbols.filter((symbol) => symbol.qualname === "outer.Twin");

check("two Twin declarations are indexed", twins.length === 2, twins.map((s) => s.id).join(", "));
check(
	"they share one qualname, so a qualname key collapses them",
	twins.length === 2 && twins[0]?.qualname === twins[1]?.qualname,
	twins[0]?.qualname ?? "none",
);
const [first, second] = twins;
check(
	"they are at different declaration sites",
	first !== undefined && second !== undefined && (first.line !== second.line || first.column !== second.column),
	`${first?.id} vs ${second?.id}`,
);

if (first !== undefined && second !== undefined) {
	const index = buildDeclarationIndex(twinResult.symbols);
	const targetFor = (symbol: typeof first): Target => ({
		file: symbol.file,
		line: symbol.line,
		column: symbol.column,
		qual: symbol.qualname,
		sites: [],
	});
	const firstTarget = targetFor(first);
	const secondTarget = targetFor(second);

	check("the first site resolves to the first symbol", symbolIdForTarget(index, firstTarget) === first.id, first.id);
	check(
		"the second site resolves to the second symbol",
		symbolIdForTarget(index, secondTarget) === second.id,
		second.id,
	);

	const scores = (target: Target, edgeIds: readonly string[]): boolean => {
		const symbolId = symbolIdForTarget(index, target);
		return symbolId !== undefined && edgeIds.includes(symbolId);
	};
	check("an edge to the right twin resolves", scores(firstTarget, [first.id]), first.id);
	check(
		"an edge to the wrong twin is refused",
		!scores(firstTarget, [second.id]),
		`edge ${second.id}, target ${first.id}`,
	);
	check("and symmetrically", !scores(secondTarget, [first.id]), `edge ${first.id}, target ${second.id}`);
	check("an empty edge set is refused", !scores(firstTarget, []));

	const legacyFirst = { file: first.file, line: first.line };
	check(
		"a pre-column target on a one-symbol line resolves",
		symbolIdForTarget(index, legacyFirst) === first.id,
		`${first.file}:${first.line}`,
	);
}

const sameLine = await analyze({ "n.py": "class One: pass; class Two: pass\n" });
const sameLineIndex = buildDeclarationIndex(sameLine.symbols);
check(
	"a pre-column target on a two-symbol line is refused, not guessed",
	symbolIdForTarget(sameLineIndex, { file: "n.py", line: 1 }) === undefined,
	sameLine.symbols.map((s) => s.id).join(", "),
);

if (failures > 0) {
	console.log(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("all checks passed");
