// LSP measurement harness (GCLI-66, DEC-303). Drives pyright-langserver --stdio over JSON-RPC.
// usage: PYRIGHT_LANGSERVER=<path to pyright-langserver> node harness.mjs <rootDir> <targets.json> <allcalls.json|-> <symbols.json> <openMode: all|none> <out.json> [srcSubdir]
// OUT_ALL=1 adds the per-symbol outgoingCalls pass. Exits non-zero if no request was answered, if any request errored,
// or if every prepareCallHierarchy returned null (the stated controls).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const [root0, targetsPath, allcallsPath, symbolsPath, openMode, outPath, srcSub = ""] = process.argv.slice(2);
const root = resolve(root0);
const srcDir = isAbsolute(srcSub) ? srcSub : join(root, srcSub);
const BIN = process.env.PYRIGHT_LANGSERVER;
if (!BIN) throw new Error("set PYRIGHT_LANGSERVER to the pyright-langserver executable");

function listPy(dir, base = dir) {
	let out = [];
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out = out.concat(listPy(p, base));
		else if (name.endsWith(".py")) out.push(relative(base, p));
	}
	return out;
}
const files = listPy(srcDir);
const uriOf = (rel) => pathToFileURL(join(srcDir, rel)).href;
const relOf = (uri) => {
	const abs = fileURLToPath(uri);
	return abs.startsWith(srcDir + "/") ? relative(srcDir, abs) : "EXTERNAL:" + abs;
};

const proc = spawn(BIN, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const stats = { requests: 0, answered: 0, errors: 0, latencies: {}, serverStderr: "" };
proc.stderr.on("data", (d) => (stats.serverStderr += d.toString().slice(0, 2000)));
proc.stdout.on("data", (d) => {
	buf = Buffer.concat([buf, d]);
	for (;;) {
		const headerEnd = buf.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const m = /Content-Length: (\d+)/i.exec(buf.slice(0, headerEnd).toString());
		const len = Number(m[1]);
		if (buf.length < headerEnd + 4 + len) return;
		const body = JSON.parse(buf.slice(headerEnd + 4, headerEnd + 4 + len).toString());
		buf = buf.slice(headerEnd + 4 + len);
		if (body.id !== undefined && pending.has(body.id) && body.method === undefined) {
			const { resolve: ok, t0, method } = pending.get(body.id);
			pending.delete(body.id);
			const dt = performance.now() - t0;
			(stats.latencies[method] ??= []).push(dt);
			if (body.error) stats.errors++;
			else stats.answered++;
			ok(body);
		} else if (body.id !== undefined && body.method) {
			// server->client request (configuration, registerCapability): answer minimally
			const result = body.method === "workspace/configuration" ? (body.params.items || []).map(() => (process.env.CONFIG_RESPONSE ? JSON.parse(process.env.CONFIG_RESPONSE) : {})) : null;
			send({ jsonrpc: "2.0", id: body.id, result });
		}
	}
});
function send(msg) {
	const s = JSON.stringify(msg);
	proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
function request(method, params, timeoutMs = 120000) {
	const id = nextId++;
	stats.requests++;
	return new Promise((ok, fail) => {
		const t = setTimeout(() => {
			pending.delete(id);
			fail(new Error(`timeout ${method}`));
		}, timeoutMs);
		pending.set(id, { resolve: (b) => { clearTimeout(t); ok(b); }, t0: performance.now(), method });
		send({ jsonrpc: "2.0", id, method, params });
	});
}
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const t0 = performance.now();
const init = await request("initialize", {
	processId: process.pid,
	rootUri: pathToFileURL(root).href,
	...(process.env.INIT_OPTIONS ? { initializationOptions: JSON.parse(process.env.INIT_OPTIONS) } : {}),
	workspaceFolders: [{ uri: pathToFileURL(root).href, name: "w" }],
	capabilities: {
		textDocument: {
			callHierarchy: { dynamicRegistration: false },
			documentSymbol: { hierarchicalDocumentSymbolSupport: true },
			references: {},
			definition: { linkSupport: false },
		},
		workspace: { symbol: {}, configuration: true },
	},
});
notify("initialized", {});
const tInit = performance.now() - t0;

const textOf = (rel) => readFileSync(join(srcDir, rel), "utf8");
if (openMode === "all") {
	for (const f of files) notify("textDocument/didOpen", { textDocument: { uri: uriOf(f), languageId: "python", version: 1, text: textOf(f) } });
}

const out = { pyrightCapabilities: Object.keys(init.result.capabilities).sort(), openMode, files: files.length, symbols: {}, targets: {}, definitions: [], workspaceSymbol: {} };
const at = (rel, line, col) => ({ textDocument: { uri: uriOf(rel) }, position: { line: line - 1, character: col } });

// symbols
const tSym0 = performance.now();
for (const f of files) {
	if (openMode === "none") notify("textDocument/didOpen", { textDocument: { uri: uriOf(f), languageId: "python", version: 1, text: textOf(f) } });
	const r = await request("textDocument/documentSymbol", { textDocument: { uri: uriOf(f) } });
	const flat = [];
	const walk = (items, prefix) => {
		for (const s of items ?? []) {
			const sel = s.selectionRange ?? s.location?.range;
			flat.push({ name: s.name, kind: s.kind, line: sel.start.line + 1, col: sel.start.character, container: prefix });
			if (s.children) walk(s.children, (prefix ? prefix + "." : "") + s.name);
		}
	};
	walk(r.result, "");
	out.symbols[f] = flat;
	if (openMode === "none") notify("textDocument/didClose", { textDocument: { uri: uriOf(f) } });
}
out.timing = { initMs: tInit, firstAllDocumentSymbolsMs: performance.now() - tSym0 };

const symbols = JSON.parse(readFileSync(symbolsPath, "utf8"));
for (const name of [...new Set(symbols.map((s) => s.name))]) {
	const r = await request("workspace/symbol", { query: name });
	out.workspaceSymbol[name] = (r.result ?? []).map((s) => ({ name: s.name, kind: s.kind, file: relOf(s.location.uri), line: s.location.range.start.line + 1 }));
}

const targets = JSON.parse(readFileSync(targetsPath, "utf8"));
for (const t of targets) {
	if (openMode === "none") notify("textDocument/didOpen", { textDocument: { uri: uriOf(t.file), languageId: "python", version: 1, text: textOf(t.file) } });
	const rec = { prepared: null, incoming: [], outgoingCount: null, references: null };
	const prep = await request("textDocument/prepareCallHierarchy", at(t.file, t.line, t.col));
	rec.prepared = prep.result ?? null;
	rec.prepareError = prep.error?.message ?? null;
	for (const item of rec.prepared ?? []) {
		const inc = await request("callHierarchy/incomingCalls", { item });
		for (const c of inc.result ?? []) {
			for (const fr of c.fromRanges) rec.incoming.push({ file: relOf(c.from.uri), line: fr.start.line + 1, col: fr.start.character, fromName: c.from.name });
		}
		const outg = await request("callHierarchy/outgoingCalls", { item });
		rec.outgoingCount = (outg.result ?? []).reduce((n, c) => n + c.fromRanges.length, 0);
	}
	const refs = await request("textDocument/references", { ...at(t.file, t.line, t.col), context: { includeDeclaration: false } });
	rec.references = (refs.result ?? []).map((l) => ({ file: relOf(l.uri), line: l.range.start.line + 1, col: l.range.start.character }));
	out.targets[`${t.file}:${t.line} ${t.qualname}`] = rec;
}

if (process.env.OUT_ALL === "1") {
	out.outgoing = [];
	for (const sym of symbols) {
		if (sym.kind === "class") continue;
		const prep = await request("textDocument/prepareCallHierarchy", at(sym.file, sym.line, sym.col));
		for (const item of prep.result ?? []) {
			const o = await request("callHierarchy/outgoingCalls", { item });
			for (const c of o.result ?? []) {
				for (const fr of c.fromRanges) out.outgoing.push({ from: `${sym.file}:${sym.line} ${sym.qualname}`, toName: c.to.name, toFile: relOf(c.to.uri), toLine: c.to.range.start.line + 1, file: sym.file, line: fr.start.line + 1, col: fr.start.character });
			}
		}
	}
}

if (allcallsPath !== "-") {
	const allcalls = JSON.parse(readFileSync(allcallsPath, "utf8"));
	for (const c of allcalls) {
		if (!c.name) continue;
		const r = await request("textDocument/definition", at(c.file, c.line, c.col));
		const res = r.result ? (Array.isArray(r.result) ? r.result : [r.result]) : [];
		out.definitions.push({ file: c.file, line: c.line, col: c.col, name: c.name, form: c.form, targets: res.map((l) => ({ file: relOf(l.uri ?? l.targetUri), line: (l.range ?? l.targetSelectionRange).start.line + 1 })) });
	}
}

out.timing.totalMs = performance.now() - t0;
out.stats = { requests: stats.requests, answered: stats.answered, errors: stats.errors, serverStderr: stats.serverStderr };
const summarize = (a) => (a.length ? { n: a.length, meanMs: a.reduce((x, y) => x + y, 0) / a.length, maxMs: Math.max(...a) } : null);
out.latency = Object.fromEntries(Object.entries(stats.latencies).map(([k, v]) => [k, summarize(v)]));
writeFileSync(outPath, JSON.stringify(out, null, 1));
await request("shutdown", null).catch(() => {});
notify("exit", null);
const prepNull = Object.values(out.targets).filter((t) => !t.prepared).length;
const nTargets = Object.keys(out.targets).length;
const failed = stats.answered === 0 || stats.errors > 0 || (nTargets > 0 && prepNull === nTargets);
console.log(`${failed ? "FAILED" : "ok"} ${outPath} requests=${stats.requests} answered=${stats.answered} errors=${stats.errors} prepareNull=${prepNull}/${nTargets} totalMs=${Math.round(out.timing.totalMs)}`);
setTimeout(() => process.exit(failed ? 1 : 0), 200);
