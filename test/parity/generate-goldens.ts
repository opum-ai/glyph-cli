import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, makeFixtureRepo } from "./fixtures.ts";

/**
 * Regenerate the parity goldens (GCLI-41, DEC-216 (a7)):
 *
 *   bun run test/parity/generate-goldens.ts
 *
 * It fetches opum-cli at the pinned SHA by ref (a tarball, through `gh`) into a
 * scratch directory, builds each fixture repository there, runs opum-cli's own
 * `DeterministicCodeMapProducer` over it read-only, and writes the producer's
 * output to `goldens.json` under a header carrying the pin. Anyone can re-run it
 * and get the same bytes. CI never runs it: glyph's tests compare against the
 * committed goldens, so there is no cross-repository dependency in glyph's CI.
 *
 * A pin moves only by re-running this script in the same change as the new
 * `OPUM_CLI_SHA` below: the parity test fails when a golden's header pin differs
 * from this constant, and when this constant differs from `OPUM_CLI_PIN`.
 */

/** The opum-cli commit the goldens are generated from (opum-cli dev at the time of the pin). */
export const OPUM_CLI_SHA = "91542f4ccf2da3574f34c2377c6a6e2b3abd1102";
export const GOLDENS_PATH = join(import.meta.dir, "goldens.json");

export interface GoldenFile {
	pin: string;
	generator: string;
	fixtures: Record<string, { sourceRef: string; taskText: string; output: unknown }>;
}

function fetchOpumCli(scratch: string): string {
	const archive = join(scratch, "opum-cli.tgz");
	const tarball = execFileSync("gh", ["api", `repos/opum-ai/opum-cli/tarball/${OPUM_CLI_SHA}`], {
		maxBuffer: 256 * 1024 * 1024,
	});
	writeFileSync(archive, tarball);
	const source = join(scratch, "opum-cli");
	mkdirSync(source);
	execFileSync("tar", ["-xzf", archive, "-C", source, "--strip-components=1"]);
	return source;
}

async function main(): Promise<void> {
	const scratch = mkdtempSync(join(tmpdir(), "glyph-goldens-"));
	const source = fetchOpumCli(scratch);
	const { DeterministicCodeMapProducer } = (await import(join(source, "src/context/code-map.ts"))) as {
		DeterministicCodeMapProducer: new () => {
			produce(input: { repositoryPath: string; sourceRef: string; taskText: string }): unknown;
		};
	};
	const producer = new DeterministicCodeMapProducer();

	const fixtures: GoldenFile["fixtures"] = {};
	for (const fixture of FIXTURES) {
		const root = join(scratch, "repos", fixture.name);
		mkdirSync(root, { recursive: true });
		fixture.build(makeFixtureRepo(root));
		const output = producer.produce({ repositoryPath: root, sourceRef: fixture.sourceRef, taskText: fixture.taskText });
		fixtures[fixture.name] = { sourceRef: fixture.sourceRef, taskText: fixture.taskText, output };
	}

	const golden: GoldenFile = { pin: OPUM_CLI_SHA, generator: "test/parity/generate-goldens.ts", fixtures };
	writeFileSync(GOLDENS_PATH, `${JSON.stringify(golden, null, 2)}\n`);
	process.stdout.write(`wrote ${GOLDENS_PATH} from opum-cli ${OPUM_CLI_SHA} (${FIXTURES.length} fixtures)\n`);
}

if (import.meta.main) await main();
