# Changelog

## 0.1.0

First release of `@opum-ai/glyph`, Opum's software-intelligence CLI.

- `callers`, `impact`, `diff` and `code-map` for TypeScript/JavaScript and, through a native in-process indexer (ADR 0008), Python, one repository at a time, with `--ref` for a commit's tree and `--stream` for NDJSON output.
- One JSON envelope per command on stdout, the failure on stderr, and the frozen exit-code family (ADR 0002).
- A disposable local cache; glyph writes nothing into the repository it analyzes.
- Runs under Node >= 24 as one bundled `dist/glyph.js` with `typescript`, `commander` and `@vscode/tree-sitter-wasm` as runtime dependencies (ADR 0007).

### Known limits

- **Python recall is below the project's gate.** Measured once on 2026-11-25 against the held-out gate (DEC-303 (a2), (a5): recall >= 0.9 with Wilson lower >= 0.8, precision >= 0.95): click 7.1.2 recall 68/80 = 0.8500, precision 68/69 = 0.9855; requests 3c7baaa recall 57/65 = 0.8769, precision 57/57 = 1.0000. Both FAIL the recall bar; precision passes. A Python answer can miss real callers. Shipping with these numbers is the operator's release-scope decision (DEC-303 (a20)). A later pass claim needs a fresh blind sample.
- See the README's Limits section for the TypeScript and code-map limits.
