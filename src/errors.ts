/**
 * Error type carrying Glyph's machine-stable exit code.
 *
 * Exit codes (v0): 0 ok · 1 internal/unexpected · 2 usage (including an
 * ambiguous symbol) · 3 not found (no such symbol, ref, or sources).
 * Callers branch on the code, never on the message.
 */
export type GlyphErrorType = "usage" | "not_found" | "internal";

export class GlyphError extends Error {
	readonly errorType: GlyphErrorType;
	readonly code: number;

	constructor(errorType: GlyphErrorType, message: string) {
		super(message);
		this.name = "GlyphError";
		this.errorType = errorType;
		this.code = errorType === "usage" ? 2 : errorType === "not_found" ? 3 : 1;
	}
}

export function usageError(message: string): GlyphError {
	return new GlyphError("usage", message);
}

export function notFoundError(message: string): GlyphError {
	return new GlyphError("not_found", message);
}
