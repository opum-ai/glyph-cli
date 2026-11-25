import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleGraph, PythonModuleInput } from "../src/python/modules.ts";
import { buildModuleGraph } from "../src/python/modules.ts";

const encoder = new TextEncoder();

function py(path: string, source: string): PythonModuleInput {
	return { path, bytes: encoder.encode(source) };
}

function bindingIn(graph: ModuleGraph, path: string, original: string) {
	const found = graph.bindings.find((binding) => binding.path === path && binding.original === original);
	if (found === undefined) throw new Error(`no binding ${original} in ${path}`);
	return found;
}

function loadFixture(root: string, prefix = ""): PythonModuleInput[] {
	const out: PythonModuleInput[] = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...loadFixture(root, relative));
		else out.push({ path: relative, bytes: readFileSync(join(root, relative)) });
	}
	return out;
}

const fixtureRoot = fileURLToPath(new URL("./python-lsp-measurement/fixtures-abs", import.meta.url));

describe("rule 1 — source roots", () => {
	test("a file's module name is taken from its deepest listed root", async () => {
		const graph = await buildModuleGraph([
			py("app/x.py", ""),
			py("src/app/y.py", ""),
			py("packages/one/src/one/z.py", ""),
		]);
		const byPath = new Map(graph.modules.map((module) => [module.path, module]));
		expect(byPath.get("app/x.py")?.module).toBe("app.x");
		expect(byPath.get("app/x.py")?.root).toBe("");
		expect(byPath.get("src/app/y.py")?.module).toBe("app.y");
		expect(byPath.get("src/app/y.py")?.root).toBe("src");
		expect(byPath.get("packages/one/src/one/z.py")?.module).toBe("one.z");
		expect(byPath.get("packages/one/src/one/z.py")?.root).toBe("packages/one/src");
	});

	test("packages/*/src roots are discovered and sorted", async () => {
		const graph = await buildModuleGraph([
			py("packages/two/src/two/__init__.py", ""),
			py("packages/one/src/one/__init__.py", ""),
		]);
		expect(graph.modules.map((module) => `${module.module}@${module.root}`).sort()).toEqual([
			"one@packages/one/src",
			"two@packages/two/src",
		]);
	});

	test("packages/*/src roots are ordered, so the earlier root wins a collision", async () => {
		// Collisions record the winner by root order, so this checks the order the
		// sorted package roots are given, which sorting the module list itself cannot.
		const graph = await buildModuleGraph([
			py("packages/two/src/dup/__init__.py", ""),
			py("packages/one/src/dup/__init__.py", ""),
		]);
		expect(graph.collisions).toEqual([
			{
				name: "dup",
				roots: ["packages/one/src", "packages/two/src"],
				winner: "packages/one/src",
				shadowedPaths: ["packages/two/src/dup/__init__.py"],
			},
		]);
		expect(graph.counts.shadowed).toBe(1);
	});

	test("permuting the input files yields an identical graph", async () => {
		const inputs: PythonModuleInput[] = [
			py("src/app/__init__.py", "from .b import Box\n"),
			py("src/app/b.py", "class Box:\n    pass\n"),
			py("src/a.py", "from app import Box\nfrom . import nope\nimport os\n"),
			py("src/c.py", "from app.b import Box as B\n"),
		];
		const forward = await buildModuleGraph(inputs);
		const reversed = await buildModuleGraph([...inputs].reverse());
		expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
	});

	test("options.roots replaces the default list literally", async () => {
		const graph = await buildModuleGraph([py("src/app/a.py", "")], { roots: ["src"] });
		expect(graph.modules[0]?.module).toBe("app.a");
		expect(graph.modules[0]?.root).toBe("src");
	});

	test("a file outside every declared root is still parsed and indexed (ruling 10)", async () => {
		const graph = await buildModuleGraph([py("other/x.py", "import os\n")], { roots: ["src"] });
		expect(graph.counts.files).toBe(1);
		expect(graph.ignored).toEqual([]);
		expect(graph.modules[0]?.path).toBe("other/x.py");
		// Its own imports are parsed; resolution still uses only the declared roots.
		expect(bindingIn(graph, "other/x.py", "os").outcome).toBe("external");
	});

	test("an outside-root file has a distinct root marker and never collides with a real root (finding 3)", async () => {
		const graph = await buildModuleGraph([py("foo.py", ""), py("src/foo/__init__.py", "")], { roots: ["src"] });
		const outside = graph.modules.find((module) => module.path === "foo.py");
		expect(outside?.root).toBe("<outside-roots>");
		expect(outside?.outsideRoots).toBe(true);
		const inside = graph.modules.find((module) => module.path === "src/foo/__init__.py");
		expect(inside?.root).toBe("src");
		expect(inside?.outsideRoots).toBe(false);
		// The outside file must not inflate collision or shadowed counts.
		expect(graph.collisions).toEqual([]);
		expect(graph.counts.shadowed).toBe(0);
	});
});

describe("rule 2 — module identity", () => {
	test("a package is the directory holding __init__.py; .py is stripped", async () => {
		const graph = await buildModuleGraph([py("src/pkg/__init__.py", ""), py("src/pkg/mod.py", "")]);
		expect(graph.modules.map((module) => module.module)).toEqual(["pkg", "pkg.mod"]);
		expect(graph.modules.map((module) => module.isPackage)).toEqual([true, false]);
		expect(graph.counts.packages).toBe(1);
	});

	test("a .pyi stub beside a .py is ignored and counted; other files are named too", async () => {
		const graph = await buildModuleGraph([
			py("src/a.py", ""),
			py("src/a.pyi", ""),
			{ path: "src/notes.md", bytes: encoder.encode("") },
		]);
		expect(graph.counts.files).toBe(1);
		const reasons = new Map(graph.ignored.map((entry) => [entry.path, entry.reason]));
		expect(reasons.get("src/a.pyi")).toBe("stub");
		expect(reasons.get("src/notes.md")).toBe("non-python");
	});
});

describe("rule 3 — first-party packages", () => {
	test("a directory without __init__.py is a namespace package: unresolved, counted, not first-party", async () => {
		const graph = await buildModuleGraph([py("src/ns/inner.py", ""), py("src/a.py", "import ns.inner\n")]);
		const binding = bindingIn(graph, "src/a.py", "ns.inner");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("namespace-package");
		// Rule 3: a namespace package is not a first-party package, so it is counted
		// as unresolved but not as a first-party gap.
		expect(graph.counts.unresolved).toBe(1);
		expect(graph.counts.unresolvedFirstParty).toBe(0);
		expect(graph.unresolved[0]?.firstParty).toBe(false);
	});

	test("an excluded directory is not indexed and is named", async () => {
		const graph = await buildModuleGraph([py(".venv/lib/x.py", ""), py("src/ok.py", "")]);
		expect(graph.counts.files).toBe(1);
		expect(graph.ignored).toContainEqual({ path: ".venv/lib/x.py", reason: "excluded-path" });
	});

	test("a build-named package inside a source root is indexed, not excluded (NB11)", async () => {
		const graph = await buildModuleGraph([
			py("src/build/__init__.py", "from .impl import thing\n"),
			py("src/build/impl.py", "def thing():\n    pass\n"),
		]);
		expect(graph.ignored).toEqual([]);
		expect(graph.modules.map((module) => module.path)).toContain("src/build/__init__.py");
		expect(bindingIn(graph, "src/build/__init__.py", "thing").target).toBe("src/build/impl.py");
	});

	test("a root coverage package holding __init__.py is indexed (NB11)", async () => {
		const graph = await buildModuleGraph([
			py("coverage/__init__.py", "from .control import x\n"),
			py("coverage/control.py", "x = 1\n"),
		]);
		expect(graph.ignored).toEqual([]);
		expect(bindingIn(graph, "coverage/__init__.py", "x").target).toBe("coverage/control.py");
	});

	test("a top-level build output directory stays excluded (NB11)", async () => {
		const graph = await buildModuleGraph([py("build/output.py", ""), py("src/ok.py", "")]);
		expect(graph.ignored).toEqual([{ path: "build/output.py", reason: "excluded-path" }]);
		expect(graph.modules.map((module) => module.path)).toEqual(["src/ok.py"]);
	});

	test("an in-root absolute from-import of a build package is first-party (finding 6)", async () => {
		const graph = await buildModuleGraph([
			py("src/build/__init__.py", "from build.helpers import x\n"),
			py("src/build/helpers.py", "x = 1\n"),
		]);
		const binding = bindingIn(graph, "src/build/__init__.py", "x");
		expect(binding.outcome).toBe("resolved");
		expect(binding.target).toBe("src/build/helpers.py");
	});

	test("a declared build-output exclusion keeps the package exemption (finding 7)", async () => {
		const graph = await buildModuleGraph(
			[
				py("src/build/__init__.py", "from .impl import thing\n"),
				py("src/build/impl.py", "def thing():\n    pass\n"),
				py("build/output.py", ""),
			],
			{ excludedDirs: ["build"] },
		);
		expect(graph.modules.map((module) => module.path)).toContain("src/build/__init__.py");
		expect(graph.ignored).toEqual([{ path: "build/output.py", reason: "excluded-path" }]);
		expect(bindingIn(graph, "src/build/__init__.py", "thing").target).toBe("src/build/impl.py");
	});

	test("a declared list splits build-output names (root-only) from other names (any depth)", async () => {
		const graph = await buildModuleGraph(
			[
				py("src/build/__init__.py", "from .impl import thing\n"),
				py("src/build/impl.py", "def thing():\n    pass\n"),
				py("app/venv/lib/site-packages/requests/__init__.py", ""),
				py("src/a.py", "import requests\n"),
			],
			{ excludedDirs: ["build", "venv"] },
		);
		// build-output name: root-only and package-exempt, so src/build is kept.
		expect(graph.modules.map((module) => module.path)).toContain("src/build/__init__.py");
		expect(bindingIn(graph, "src/build/__init__.py", "thing").target).toBe("src/build/impl.py");
		// other name: excluded at any depth.
		expect(graph.ignored).toContainEqual({
			path: "app/venv/lib/site-packages/requests/__init__.py",
			reason: "excluded-path",
		});
		// requests is never seen as first-party, so it is external, not exit 7.
		expect(bindingIn(graph, "src/a.py", "requests").outcome).toBe("external");
		expect(graph.exit7).toEqual([]);
	});

	test("a declared venv is excluded below the root, so its package is not exit 7", async () => {
		const graph = await buildModuleGraph(
			[py("app/venv/lib/site-packages/requests/__init__.py", ""), py("src/a.py", "import requests\n")],
			{ excludedDirs: ["venv"] },
		);
		expect(graph.ignored).toContainEqual({
			path: "app/venv/lib/site-packages/requests/__init__.py",
			reason: "excluded-path",
		});
		expect(graph.exit7).toEqual([]);
		expect(bindingIn(graph, "src/a.py", "requests").outcome).toBe("external");
	});

	test("a vendored package is indexed and its import is guarded, not excluded (DEC-303 (a8))", async () => {
		const graph = await buildModuleGraph([py("vendor/requests/__init__.py", ""), py("src/a.py", "import requests\n")]);
		expect(graph.ignored).toEqual([]);
		expect(graph.modules.map((module) => module.path)).toContain("vendor/requests/__init__.py");
		expect(graph.exit7).toEqual([
			{ path: "src/a.py", line: 1, name: "requests", original: "requests", directories: ["vendor/requests"] },
		]);
	});

	test("a bare .py is a module, not a package: importing through it is unresolved", async () => {
		const graph = await buildModuleGraph([py("src/helper.py", ""), py("src/a.py", "import helper.sub\n")]);
		const binding = bindingIn(graph, "src/a.py", "helper.sub");
		expect(binding.reason).toBe("module-not-a-package");
	});
});

describe("rule 4 — absolute imports", () => {
	test("a first-party import resolves through the first root that provides it", async () => {
		const graph = await buildModuleGraph([
			py("src/app/__init__.py", ""),
			py("src/app/b.py", "def helper():\n    pass\n"),
			py("src/a.py", "import app.b\n"),
		]);
		expect(bindingIn(graph, "src/a.py", "app.b").target).toBe("src/app/b.py");
	});

	test("a missing submodule is unresolved, counted and named", async () => {
		const graph = await buildModuleGraph([
			py("src/app/__init__.py", ""),
			py("src/a.py", "from app.missing import x\n"),
		]);
		const binding = bindingIn(graph, "src/a.py", "x");
		expect(binding.reason).toBe("module-not-found");
		expect(graph.unresolved).toContainEqual({
			path: "src/a.py",
			line: 1,
			module: "app.missing",
			dots: 0,
			name: "x",
			reason: "module-not-found",
			firstParty: true,
		});
	});
});

describe("rule 5 — from-import names", () => {
	test("a binding in pkg/__init__.py wins over a submodule", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "from .impl import Thing\n"),
			py("src/pkg/impl.py", "class Thing:\n    pass\n"),
			py("src/pkg/Thing.py", ""),
			py("src/use.py", "from pkg import Thing\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "Thing").target).toBe("src/pkg/impl.py");
	});

	test("otherwise a submodule answers", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/sub.py", ""),
			py("src/use.py", "from pkg import sub\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "sub").target).toBe("src/pkg/sub.py");
	});

	test("a plain module answers with its own module-level definition", async () => {
		const graph = await buildModuleGraph([
			py("src/m.py", "def helper():\n    pass\n"),
			py("src/use.py", "from m import helper\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "helper").target).toBe("src/m.py");
	});

	test("from . import name inside the package __init__ reaches the submodule", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "from . import impl\n"),
			py("src/pkg/impl.py", ""),
		]);
		expect(bindingIn(graph, "src/pkg/__init__.py", "impl").target).toBe("src/pkg/impl.py");
	});

	test("a namespace directory reached through a from-import is namespace-package", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/inner.py", ""),
			py("src/use.py", "from pkg import ns\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "ns").reason).toBe("namespace-package");
	});

	test("neither binding nor submodule: attribute-not-found, counted", async () => {
		const graph = await buildModuleGraph([py("src/pkg/__init__.py", ""), py("src/use.py", "from pkg import nope\n")]);
		expect(bindingIn(graph, "src/use.py", "nope").reason).toBe("attribute-not-found");
		expect(graph.counts.unresolvedFirstParty).toBe(1);
	});

	test("a from-import reaches a submodule past an external star import (finding 1)", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "from os import *\n"),
			py("src/pkg/sub.py", ""),
			py("src/use.py", "from pkg import sub\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "sub");
		expect(binding.outcome).toBe("resolved");
		expect(binding.target).toBe("src/pkg/sub.py");
		expect(graph.counts.unresolvedFirstParty).toBe(0);
	});

	test("a from-import reaches a submodule past a one-star-hop non-literal __all__ (finding 1)", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/core.py", "__all__ = make_list()\n"),
			py("src/pkg/__init__.py", "from .core import *\n__all__ += core.__all__\nfrom . import linalg\n"),
			py("src/pkg/linalg.py", ""),
			py("src/use.py", "from pkg import linalg\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "linalg").target).toBe("src/pkg/linalg.py");
	});

	test("from . import a submodule inside the __init__ resolves past an external star (finding 1)", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "from os import *\nfrom . import sub\n"),
			py("src/pkg/sub.py", ""),
		]);
		expect(bindingIn(graph, "src/pkg/__init__.py", "sub").target).toBe("src/pkg/sub.py");
	});

	test("an explicit binding whose source ends in a star does not fall through to a submodule (finding 1, trace A)", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "from .x import foo\n"),
			py("src/pkg/x.py", "from os import *\n"),
			py("src/pkg/foo.py", ""),
			py("src/use.py", "from pkg import foo\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "foo");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("star-import");
		expect(binding.target).toBeNull();
	});

	test("an explicit binding to a package source with no submodule does not fall through (finding 1, trace A variant)", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "from .x import foo\n"),
			py("src/pkg/x/__init__.py", "from os import *\n"),
			py("src/pkg/foo.py", ""),
			py("src/use.py", "from pkg import foo\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "foo");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("star-import");
		expect(binding.target).toBeNull();
	});

	test("a star that enumerates a name does not fall through to a submodule (finding 1, trace B)", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "from .core import *\n"),
			py("src/pkg/core.py", "__all__ = ['foo']\nfrom os import *\n"),
			py("src/pkg/foo.py", ""),
			py("src/use.py", "from pkg import foo\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "foo");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("star-import");
		expect(binding.target).toBeNull();
	});
});

describe("rule 6 — relative imports", () => {
	test("one dot is the importing file's package; two dots walk up one package", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/sub/__init__.py", ""),
			py("src/pkg/sub/mod.py", "from . import sibling\nfrom .. import base\n"),
			py("src/pkg/sub/sibling.py", ""),
			py("src/pkg/base.py", ""),
		]);
		expect(bindingIn(graph, "src/pkg/sub/mod.py", "sibling").target).toBe("src/pkg/sub/sibling.py");
		expect(bindingIn(graph, "src/pkg/sub/mod.py", "base").target).toBe("src/pkg/base.py");
	});

	test("too many dots is unresolved, counted, and never exit 7", async () => {
		const graph = await buildModuleGraph([py("src/pkg/mod.py", "from .. import x\n")]);
		expect(bindingIn(graph, "src/pkg/mod.py", "x").reason).toBe("too-many-dots");
		expect(graph.counts.unresolvedFirstParty).toBe(1);
		expect(graph.exit7).toEqual([]);
	});

	test("three dots walk up two packages", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/top.py", ""),
			py("src/pkg/sub/__init__.py", ""),
			py("src/pkg/sub/deep/__init__.py", ""),
			py("src/pkg/sub/deep/mod.py", "from ... import top\n"),
		]);
		expect(bindingIn(graph, "src/pkg/sub/deep/mod.py", "top").target).toBe("src/pkg/top.py");
	});

	test("a relative import in a file with no package is no-package", async () => {
		const graph = await buildModuleGraph([py("src/script.py", "from . import x\n")]);
		expect(bindingIn(graph, "src/script.py", "x").reason).toBe("no-package");
	});
});

describe("rule 7 — aliases", () => {
	test("a plain import with an alias records original and alias", async () => {
		const graph = await buildModuleGraph([py("src/app/__init__.py", ""), py("src/a.py", "import app as other\n")]);
		const binding = bindingIn(graph, "src/a.py", "app");
		expect(binding.alias).toBe("other");
		expect(binding.boundName).toBe("other");
		expect(binding.target).toBe("src/app/__init__.py");
	});

	test("a from-import alias records the original name and the alias", async () => {
		const graph = await buildModuleGraph([
			py("src/app/__init__.py", ""),
			py("src/app/b.py", "def helper():\n    pass\n"),
			py("src/a.py", "from app.b import helper as h\n"),
		]);
		const binding = bindingIn(graph, "src/a.py", "helper");
		expect(binding.alias).toBe("h");
		expect(binding.boundName).toBe("h");
		expect(binding.target).toBe("src/app/b.py");
	});

	test("a plain import binds its first component", async () => {
		const graph = await buildModuleGraph([
			py("src/app/__init__.py", ""),
			py("src/app/b.py", ""),
			py("src/a.py", "import app.b\n"),
		]);
		expect(bindingIn(graph, "src/a.py", "app.b").boundName).toBe("app");
	});
});

describe("rule 8 — re-exports", () => {
	test("a re-export chain is followed to the defining module", async () => {
		const graph = await buildModuleGraph([
			py("src/rpkg/__init__.py", "from .impl import Widget\n"),
			py("src/rpkg/impl.py", "class Widget:\n    pass\n"),
			py("src/use.py", "from rpkg import Widget\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "Widget").target).toBe("src/rpkg/impl.py");
	});

	test("a re-export cycle is unresolved with import-cycle, counted", async () => {
		const graph = await buildModuleGraph([
			py("src/p/__init__.py", "from .x import y\n"),
			py("src/p/x.py", "from .y import y\n"),
			py("src/p/y.py", "from .x import y\n"),
		]);
		expect(bindingIn(graph, "src/p/__init__.py", "y").reason).toBe("import-cycle");
		expect(graph.counts.unresolvedFirstParty).toBe(3);
	});

	test("a re-export chain past the depth cap is depth-limit, not import-cycle", async () => {
		const files: PythonModuleInput[] = [];
		const depth = 66;
		for (let index = 0; index < depth - 1; index++) {
			files.push(py(`src/m${index}.py`, `from m${index + 1} import x\n`));
		}
		files.push(py(`src/m${depth - 1}.py`, "def x():\n    pass\n"));
		files.push(py("src/use.py", "from m0 import x\n"));
		const graph = await buildModuleGraph(files);
		expect(bindingIn(graph, "src/use.py", "x").reason).toBe("depth-limit");
	});

	test("a re-export of a plain dotted import resolves to the top package, not the leaf", async () => {
		const graph = await buildModuleGraph([
			py("src/a/__init__.py", ""),
			py("src/a/b.py", ""),
			py("src/a/c.py", ""),
			py("src/m.py", "import a.b\nimport a.c\n"),
			py("src/use.py", "from m import a\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "a");
		expect(binding.target).toBe("src/a/__init__.py");
		expect(binding.reason).toBeNull();
	});
});

describe("rule 9 — star imports", () => {
	test("a literal __all__ list, including += literals, selects the exported names", async () => {
		const graph = await buildModuleGraph([
			py("src/m.py", "__all__ = ['a']\n__all__ += ['b']\ndef a():\n    pass\ndef b():\n    pass\ndef c():\n    pass\n"),
			py("src/use.py", "from m import *\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "*").starNames).toEqual(["a", "b"]);
	});

	test("a tuple __all__ is literal, and a relative star import resolves", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/m.py", "__all__ = ('a', 'b')\ndef a():\n    pass\ndef b():\n    pass\n"),
			py("src/pkg/use.py", "from .m import *\n"),
		]);
		const binding = bindingIn(graph, "src/pkg/use.py", "*");
		expect(binding.target).toBe("src/pkg/m.py");
		expect(binding.starNames).toEqual(["a", "b"]);
	});

	test("without __all__, public module-level names are exported", async () => {
		const graph = await buildModuleGraph([
			py("src/m.py", "def pub():\n    pass\ndef _priv():\n    pass\nclass Pub:\n    pass\nCONST = 1\n"),
			py("src/use.py", "from m import *\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "*").starNames).toEqual(["CONST", "Pub", "pub"]);
	});

	test("a non-literal __all__ is unresolved with non-literal-all, counted", async () => {
		const graph = await buildModuleGraph([
			py("src/m.py", "__all__ = make_list()\ndef pub():\n    pass\n"),
			py("src/use.py", "from m import *\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "*");
		expect(binding.reason).toBe("non-literal-all");
		expect(graph.counts.unresolvedFirstParty).toBe(1);
	});

	test("a star import from a non-first-party module is the star-import bin", async () => {
		const graph = await buildModuleGraph([py("src/use.py", "from os import *\n")]);
		const binding = bindingIn(graph, "src/use.py", "*");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("star-import");
		expect(graph.unresolved[0]?.firstParty).toBe(false);
	});

	test("a literal __all__.append and __all__.extend add names to the export set", async () => {
		const graph = await buildModuleGraph([
			py(
				"src/m.py",
				"__all__ = ['a']\n__all__.append('b')\n__all__.extend(['c', 'd'])\ndef a():\n    pass\ndef b():\n    pass\ndef c():\n    pass\ndef d():\n    pass\n",
			),
			py("src/use.py", "from m import *\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "*").starNames).toEqual(["a", "b", "c", "d"]);
	});

	test("a nested star import from an external module is carried as a partial set", async () => {
		const graph = await buildModuleGraph([
			py("src/m.py", "from os import *\ndef f():\n    pass\n"),
			py("src/use.py", "from m import *\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "*");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("star-import");
		expect(binding.starNames).toEqual(["f"]);
		expect(graph.counts.unresolvedFirstParty).toBe(0);
	});

	test("a non-literal __all__ two hops away is carried as a partial set", async () => {
		const graph = await buildModuleGraph([
			py("src/n.py", "__all__ = make_list()\ndef pub():\n    pass\n"),
			py("src/m.py", "from n import *\n"),
			py("src/use.py", "from m import *\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "*");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("non-literal-all");
	});

	test("a from-import name that could come from a partial star reports the star's reason", async () => {
		const graph = await buildModuleGraph([
			py("src/m.py", "from os import *\ndef f():\n    pass\n"),
			py("src/use.py", "from m import g\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "g");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("star-import");
	});
});

describe("rule 10 — conditional imports", () => {
	test("try/except arms are both recorded with their conditions", async () => {
		const graph = await buildModuleGraph([
			py("src/c.py", "try:\n    import fast as impl\nexcept ImportError:\n    import slow as impl\n"),
		]);
		const bindings = graph.bindings.filter((binding) => binding.boundName === "impl");
		expect(bindings).toHaveLength(2);
		expect(bindings.map((binding) => binding.condition)).toEqual(["try", "except ImportError"]);
	});

	test("two first-party bindings of one name are both kept with their conditions", async () => {
		const graph = await buildModuleGraph([
			py("src/fast.py", ""),
			py("src/slow.py", ""),
			py("src/c.py", "try:\n    import fast as impl\nexcept ImportError:\n    import slow as impl\n"),
		]);
		const bindings = graph.bindings.filter((binding) => binding.boundName === "impl");
		expect(bindings.map((binding) => [binding.condition, binding.target])).toEqual([
			["try", "src/fast.py"],
			["except ImportError", "src/slow.py"],
		]);
	});

	test("TYPE_CHECKING and platform arms are all recorded and reachable", async () => {
		const graph = await buildModuleGraph([
			py(
				"src/c.py",
				"if TYPE_CHECKING:\n    from x import Y\nif sys.platform == 'win32':\n    import win\nelse:\n    import posix\n",
			),
			py("src/win.py", ""),
			py("src/posix.py", ""),
		]);
		const byBound = new Map(graph.bindings.map((binding) => [binding.boundName, binding]));
		expect(byBound.get("Y")?.condition).toContain("TYPE_CHECKING");
		expect(byBound.get("win")?.target).toBe("src/win.py");
		expect(byBound.get("posix")?.target).toBe("src/posix.py");
		expect(byBound.get("posix")?.condition).toBe("else");
	});

	test("elif and else branches carry their own condition text", async () => {
		const graph = await buildModuleGraph([
			py("src/c.py", "if x:\n    import a\nelif y:\n    import b\nelse:\n    import c\n"),
			py("src/a.py", ""),
			py("src/b.py", ""),
		]);
		const byBound = new Map(graph.bindings.map((binding) => [binding.boundName, binding]));
		expect(byBound.get("a")?.condition).toBe("x");
		expect(byBound.get("b")?.condition).toBe("elif y");
		expect(byBound.get("c")?.condition).toBe("else");
	});

	test("a name re-exported from both try/except arms is multiply-bound with alternatives", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "try:\n    from .fast import f\nexcept ImportError:\n    from .slow import f\n"),
			py("src/pkg/fast.py", "def f():\n    pass\n"),
			py("src/pkg/slow.py", "def f():\n    pass\n"),
			py("src/use.py", "from pkg import f\n"),
		]);
		const binding = bindingIn(graph, "src/use.py", "f");
		expect(binding.outcome).toBe("resolved");
		expect(binding.reason).toBe("multiply-bound");
		expect(binding.target).toBe("src/pkg/fast.py");
		expect(binding.alternatives).toEqual(["src/pkg/slow.py"]);
	});
});

describe("rule 11 — external", () => {
	test("a first component naming no first-party package is external, with no stdlib list", async () => {
		const graph = await buildModuleGraph([py("src/a.py", "import os\nimport requests\nfrom json import loads\n")]);
		expect(graph.bindings.map((binding) => binding.outcome)).toEqual(["external", "external", "external"]);
		expect(graph.counts.external).toBe(3);
	});

	test("a __future__ import is external by binding", async () => {
		const graph = await buildModuleGraph([py("src/a.py", "from __future__ import annotations\n")]);
		expect(graph.bindings[0]?.outcome).toBe("external");
		expect(graph.bindings[0]?.boundName).toBe("annotations");
	});
});

describe("rule 12 — exit 7", () => {
	test("an import binding a first-party package root no root resolves is an indeterminate trigger", async () => {
		const graph = await buildModuleGraph([py("tools/other/__init__.py", ""), py("src/a.py", "import other.thing\n")]);
		expect(graph.exit7).toEqual([
			{ path: "src/a.py", line: 1, name: "other", original: "other.thing", directories: ["tools/other"] },
		]);
		const binding = bindingIn(graph, "src/a.py", "other.thing");
		expect(binding.reason).toBe("unresolved-package-root");
	});

	test("a missing submodule is not exit 7; it stays a counted, named unresolved import", async () => {
		const graph = await buildModuleGraph([py("src/app/__init__.py", ""), py("src/a.py", "import app.gone\n")]);
		expect(graph.exit7).toEqual([]);
		expect(graph.counts.unresolvedFirstParty).toBe(1);
		expect(graph.unresolved[0]?.reason).toBe("module-not-found");
	});

	test("a nested subpackage's basename does not make an external import exit 7 (DEC-303 (a6))", async () => {
		// src/app/json is a subpackage, not a topmost package root, so `import json`
		// is external even though a directory basenamed "json" exists (rule 11).
		const graph = await buildModuleGraph([
			py("src/app/__init__.py", ""),
			py("src/app/json/__init__.py", ""),
			py("src/a.py", "import json\n"),
		]);
		expect(graph.exit7).toEqual([]);
		expect(bindingIn(graph, "src/a.py", "json").outcome).toBe("external");
		expect(graph.counts.unresolvedFirstParty).toBe(0);
	});

	test("declared roots do not switch off the guard for a first-party package outside them", async () => {
		const graph = await buildModuleGraph([py("lib/foo/__init__.py", ""), py("src/a.py", "import foo\n")], {
			roots: ["src"],
		});
		// The file is outside the declared roots: still parsed and indexed (ruling
		// 10), but not resolvable through them, and the guard's first-party set
		// still knows lib/foo, so it must not go external.
		expect(graph.modules.map((module) => module.path)).toContain("lib/foo/__init__.py");
		expect(graph.ignored).toEqual([]);
		expect(graph.exit7).toEqual([
			{ path: "src/a.py", line: 1, name: "foo", original: "foo", directories: ["lib/foo"] },
		]);
		const binding = bindingIn(graph, "src/a.py", "foo");
		expect(binding.outcome).toBe("unresolved");
		expect(binding.reason).toBe("unresolved-package-root");
	});

	test("without declared roots the same package resolves as first-party", async () => {
		const graph = await buildModuleGraph([py("lib/foo/__init__.py", ""), py("src/a.py", "import foo\n")]);
		expect(graph.exit7).toEqual([]);
		expect(bindingIn(graph, "src/a.py", "foo").target).toBe("lib/foo/__init__.py");
	});

	test("a package under a test-named directory is not a root (DEC-303 (a7))", async () => {
		const graph = await buildModuleGraph([py("tests/json/__init__.py", ""), py("src/a.py", "import json\n")]);
		expect(graph.exit7).toEqual([]);
		expect(bindingIn(graph, "src/a.py", "json").outcome).toBe("external");
	});

	test("a package under a test-named package is not a root (DEC-303 (a7))", async () => {
		const graph = await buildModuleGraph([
			py("tests/__init__.py", ""),
			py("tests/json/__init__.py", ""),
			py("src/a.py", "import json\n"),
		]);
		expect(graph.exit7).toEqual([]);
		expect(bindingIn(graph, "src/a.py", "json").outcome).toBe("external");
	});

	test("test-named directories match case-insensitively (DEC-303 (a8))", async () => {
		for (const dir of ["Tests", "Testing", "unittests"]) {
			const graph = await buildModuleGraph([py(`${dir}/json/__init__.py`, ""), py("src/a.py", "import json\n")]);
			expect(graph.exit7).toEqual([]);
			expect(bindingIn(graph, "src/a.py", "json").outcome).toBe("external");
		}
	});

	test("an absolute import of a build package under roots that leave it out is exit 7 (finding 6)", async () => {
		const graph = await buildModuleGraph([py("src/build/__init__.py", ""), py("lib/a.py", "import build\n")], {
			roots: ["lib"],
		});
		expect(graph.exit7).toEqual([
			{ path: "lib/a.py", line: 1, name: "build", original: "build", directories: ["src/build"] },
		]);
	});

	test("a package nested under a package through a namespace dir is not topmost (DEC-303 (a7))", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/inner/__init__.py", ""),
			py("src/a.py", "import inner\n"),
		]);
		expect(graph.exit7).toEqual([]);
		expect(bindingIn(graph, "src/a.py", "inner").outcome).toBe("external");
	});

	test("a repository-root __init__.py is never a parent package (DEC-303 (a7))", async () => {
		const graph = await buildModuleGraph(
			[py("__init__.py", ""), py("foo/__init__.py", ""), py("src/a.py", "import foo\n")],
			{ roots: ["src"] },
		);
		expect(graph.exit7).toEqual([{ path: "src/a.py", line: 1, name: "foo", original: "foo", directories: ["foo"] }]);
		expect(bindingIn(graph, "src/a.py", "foo").reason).toBe("unresolved-package-root");
	});

	test("a src/__init__.py makes src the topmost package under roots that leave it out (DEC-303 (a7))", async () => {
		const withSrcImport = await buildModuleGraph(
			[py("src/__init__.py", ""), py("src/foo/__init__.py", ""), py("lib/a.py", "import src\n")],
			{ roots: ["lib"] },
		);
		expect(withSrcImport.exit7).toEqual([
			{ path: "lib/a.py", line: 1, name: "src", original: "src", directories: ["src"] },
		]);
		// foo is src.foo, not a top-level package, so importing it is external.
		const withFooImport = await buildModuleGraph(
			[py("src/__init__.py", ""), py("src/foo/__init__.py", ""), py("lib/a.py", "import foo\n")],
			{ roots: ["lib"] },
		);
		expect(withFooImport.exit7).toEqual([]);
		expect(bindingIn(withFooImport, "lib/a.py", "foo").outcome).toBe("external");
	});
});

describe("rule 13 — dynamic imports", () => {
	test("importlib.import_module, __import__ and getattr are counted and named, not resolved", async () => {
		const graph = await buildModuleGraph([
			py("src/d.py", "import importlib\nimportlib.import_module('m')\n__import__('n')\ngetattr(obj, 'x')\n"),
		]);
		expect(graph.dynamic.map((entry) => entry.callee)).toEqual(["importlib.import_module", "__import__", "getattr"]);
		expect(graph.counts.dynamic).toBe(3);
	});
});

describe("rule 14 — parse errors and decode replacements", () => {
	test("a file needing a decode replacement is not exact and is named", async () => {
		const bytes = new Uint8Array([...encoder.encode("x = "), 0xff, ...encoder.encode("\n")]);
		const graph = await buildModuleGraph([{ path: "src/bad.py", bytes }]);
		expect(graph.exact).toBe(false);
		expect(graph.counts.decodeReplacementFiles).toBe(1);
		expect(graph.parseIssues[0]?.path).toBe("src/bad.py");
		expect(graph.parseIssues[0]?.exact).toBe(false);
	});

	test("imports inside an ERROR region are dropped from bindings and named", async () => {
		const graph = await buildModuleGraph([py("src/e.py", "class :\n    import os\n")]);
		expect(graph.droppedByError).toEqual([{ path: "src/e.py", line: 2, text: "import os" }]);
		expect(graph.counts.droppedImports).toBe(1);
		expect(graph.bindings).toEqual([]);
		expect(graph.exact).toBe(false);
	});
});

describe("rule 15 — self-imports and mirroring directories", () => {
	test("an import resolving to the file itself is resolved", async () => {
		const graph = await buildModuleGraph([py("src/app/__init__.py", "import app\n")]);
		expect(bindingIn(graph, "src/app/__init__.py", "app").target).toBe("src/app/__init__.py");
	});

	test("two roots providing one top-level name: the first wins, the loser is counted and named", async () => {
		const graph = await buildModuleGraph([
			py("app/__init__.py", ""),
			py("app/x.py", "import app.y\n"),
			py("src/app/__init__.py", ""),
			py("src/app/y.py", ""),
		]);
		expect(graph.collisions).toEqual([
			{ name: "app", roots: ["", "src"], winner: "", shadowedPaths: ["src/app/__init__.py", "src/app/y.py"] },
		]);
		expect(graph.counts.shadowed).toBe(2);
		expect(graph.shadowed).toEqual(["src/app/__init__.py", "src/app/y.py"]);
	});

	test("within one root a package wins over a bare module of the same name", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", "VALUE = 'package'\n"),
			py("src/pkg.py", "VALUE = 'module'\n"),
			py("src/use.py", "from pkg import VALUE\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "VALUE").target).toBe("src/pkg/__init__.py");
		const shadowed = graph.modules.find((module) => module.path === "src/pkg.py");
		expect(shadowed?.shadowed).toBe(true);
	});
});

describe("rule 16 — non-module-scope imports", () => {
	test("imports in functions and classes are local, counted and named, not module bindings", async () => {
		const graph = await buildModuleGraph([py("src/l.py", "def f():\n    import os\nclass C:\n    import sys\n")]);
		expect(graph.bindings).toEqual([]);
		expect(graph.localImports).toEqual([
			{ path: "src/l.py", line: 2, text: "import os" },
			{ path: "src/l.py", line: 4, text: "import sys" },
		]);
		expect(graph.counts.localImports).toBe(2);
	});

	test("a function-local import of an unrooted package is text only, never exit 7 (stated limit)", async () => {
		// Rule 16/10 limit: local imports are not resolved and not checked by the
		// guard, so a first-party package imported only lazily does not trigger exit 7.
		const graph = await buildModuleGraph([
			py("tools/other/__init__.py", ""),
			py("src/a.py", "def f():\n    import other.thing\n"),
		]);
		expect(graph.exit7).toEqual([]);
		expect(graph.localImports).toEqual([{ path: "src/a.py", line: 2, text: "import other.thing" }]);
	});
});

describe("rule 17 — duplicate input paths", () => {
	test("a repeated path is indexed once and the duplicate is named", async () => {
		const graph = await buildModuleGraph([py("src/a.py", "import os\n"), py("src/a.py", "import sys\n")]);
		expect(graph.counts.files).toBe(1);
		expect(graph.ignored).toEqual([{ path: "src/a.py", reason: "duplicate" }]);
		expect(graph.counts.duplicates).toBe(1);
		expect(bindingIn(graph, "src/a.py", "os").outcome).toBe("external");
	});
});

describe("never a silent empty", () => {
	test("no input yields zeroed counts and an exact answer", async () => {
		const graph = await buildModuleGraph([]);
		expect(graph.counts.files).toBe(0);
		expect(graph.counts.imports).toBe(0);
		expect(graph.exact).toBe(true);
		expect(graph.bindings).toEqual([]);
		expect(graph.modules).toEqual([]);
	});

	test("a module with no imports still appears in files", async () => {
		const graph = await buildModuleGraph([py("src/quiet.py", "x = 1\n")]);
		expect(graph.files).toEqual([{ path: "src/quiet.py", module: "quiet", imports: [] }]);
		expect(graph.counts.imports).toBe(0);
	});
});

describe("fixtures-abs — absolute imports under a src layout", () => {
	test("every first-party import resolves and matches the committed expected definitions", async () => {
		const graph = await buildModuleGraph(loadFixture(fixtureRoot));
		expect(graph.counts.unresolved).toBe(0);
		expect(graph.exit7).toEqual([]);

		const expected = JSON.parse(readFileSync(join(fixtureRoot, "expected.json"), "utf8")) as Record<string, unknown>;
		const definitions = new Set(
			Object.keys(expected)
				.filter((key) => key !== "_note")
				.map((key) => key.split(":")[0] as string),
		);
		expect([...definitions]).toEqual(["app/b.py"]);

		// Import targets are relative to fixtures-abs; expected keys are relative to fixtures-abs/src.
		const targets = new Set(
			graph.bindings
				.filter((binding) => binding.outcome === "resolved" && binding.target !== null)
				.map((binding) => (binding.target as string).replace(/^src\//, "")),
		);
		for (const definition of definitions) expect(targets.has(definition)).toBe(true);

		for (const original of ["app.b", "Box", "helper"]) {
			const binding = bindingIn(graph, "src/app/a.py", original);
			expect(binding.target).toBe("src/app/b.py");
		}
	});

	test("with only the repo root declared, the app package root is the exit-7 trigger", async () => {
		const graph = await buildModuleGraph(loadFixture(fixtureRoot), { roots: [""] });
		expect(graph.counts.exit7).toBeGreaterThan(0);
		expect(graph.exit7[0]?.name).toBe("app");
		expect(graph.exit7[0]?.directories).toEqual(["src/app"]);
		expect(graph.counts.resolved).toBe(0);
	});
});

// DEC-303 (a26) item 1: a namespace directory whose nearest regular-package ancestor
// is reached through namespace directories only has exactly one portion, so an import
// resolves THROUGH it to a real module or package file. Fixtures are written from
// Python's import semantics, not from any repository.
describe("DEC-303 (a26) — resolving through a namespace directory", () => {
	test("an absolute import through a namespace directory resolves to the module", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", "X = 1\n"),
			py("src/use.py", "import pkg.ns.mod\nfrom pkg.ns.mod import X\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "pkg.ns.mod").target).toBe("src/pkg/ns/mod.py");
		expect(bindingIn(graph, "src/use.py", "X").target).toBe("src/pkg/ns/mod.py");
	});

	test("a relative from-import through a namespace directory resolves", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", "X = 1\n"),
			py("src/pkg/use.py", "from .ns.mod import X\n"),
		]);
		expect(bindingIn(graph, "src/pkg/use.py", "X").target).toBe("src/pkg/ns/mod.py");
		expect(bindingIn(graph, "src/pkg/use.py", "X").outcome).toBe("resolved");
	});

	test("a two-level chain of namespace directories resolves", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/a/b/mod.py", "X = 1\n"),
			py("src/use.py", "from pkg.a.b.mod import X\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "X").target).toBe("src/pkg/a/b/mod.py");
	});

	test("a regular package below a namespace directory resolves to its __init__", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/inner/__init__.py", ""),
			py("src/pkg/ns/inner/leaf.py", ""),
			py("src/use.py", "import pkg.ns.inner\nimport pkg.ns.inner.leaf\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "pkg.ns.inner").target).toBe("src/pkg/ns/inner/__init__.py");
		expect(bindingIn(graph, "src/use.py", "pkg.ns.inner.leaf").target).toBe("src/pkg/ns/inner/leaf.py");
	});

	test("a missing module below a namespace directory is module-not-found", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", ""),
			py("src/use.py", "import pkg.ns.gone\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "pkg.ns.gone").reason).toBe("module-not-found");
	});

	test("a top-level namespace directory stays namespace-package (negative control)", async () => {
		const graph = await buildModuleGraph([py("src/ns/inner.py", ""), py("src/a.py", "import ns.inner\n")]);
		expect(bindingIn(graph, "src/a.py", "ns.inner").reason).toBe("namespace-package");
	});

	test("a namespace directory as the last component stays namespace-package (negative control)", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", ""),
			py("src/use.py", "import pkg.ns\nfrom pkg import ns\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "pkg.ns").reason).toBe("namespace-package");
		expect(bindingIn(graph, "src/use.py", "ns").reason).toBe("namespace-package");
	});

	const manipulations: [string, string][] = [
		["an assignment to __path__", "__path__ = [__path__[0] + '/extra']\n"],
		["an augmented assignment to __path__", "__path__ += ['/elsewhere']\n"],
		["pkgutil.extend_path", "import pkgutil\n__path__ = pkgutil.extend_path(__path__, __name__)\n"],
		["a bare extend_path", "from pkgutil import extend_path\n__path__ = extend_path(__path__, __name__)\n"],
		["pkg_resources.declare_namespace", "import pkg_resources\npkg_resources.declare_namespace(__name__)\n"],
	];
	for (const [label, init] of manipulations) {
		test(`${label} in the ancestor's __init__.py keeps the chain namespace-package (negative control)`, async () => {
			const graph = await buildModuleGraph([
				py("src/pkg/__init__.py", init),
				py("src/pkg/ns/mod.py", "X = 1\n"),
				py("src/pkg/use.py", "from .ns.mod import X\n"),
				py("src/use.py", "from pkg.ns.mod import X\n"),
			]);
			expect(bindingIn(graph, "src/use.py", "X").reason).toBe("namespace-package");
			expect(bindingIn(graph, "src/pkg/use.py", "X").reason).toBe("namespace-package");
		});
	}

	test("a module inside a namespace directory resolves a sibling relative import; `from . import x` stays namespace-package", async () => {
		const graph = await buildModuleGraph([
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/a.py", "from .b import Y\nfrom . import b\n"),
			py("src/pkg/ns/b.py", "Y = 1\n"),
		]);
		expect(bindingIn(graph, "src/pkg/ns/a.py", "Y").target).toBe("src/pkg/ns/b.py");
		expect(bindingIn(graph, "src/pkg/ns/a.py", "b").reason).toBe("namespace-package");
	});

	test("a __path__ manipulation in an unrelated package does not block the chain", async () => {
		const graph = await buildModuleGraph([
			py("src/other/__init__.py", "__path__ = []\n"),
			py("src/pkg/__init__.py", ""),
			py("src/pkg/ns/mod.py", "X = 1\n"),
			py("src/use.py", "from pkg.ns.mod import X\n"),
		]);
		expect(bindingIn(graph, "src/use.py", "X").target).toBe("src/pkg/ns/mod.py");
	});
});
