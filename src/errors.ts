/**
 * Error type carrying Glyph's machine-stable exit code.
 *
 * The family is the frozen Opum command contract's:
 * 0 ok · 1 uncaught · 2 usage · 3 not_found · 4 denied · 5 conflict ·
 * 6 validation/drift · 7 indeterminate. `uncaught` is not a classifiable
 * type — a bug maps to it — and `validation` and `drift` share code 6 by
 * design. Callers branch on the code, never on the message.
 */
export type GlyphErrorType = "usage" | "not_found" | "denied" | "conflict" | "validation" | "drift" | "indeterminate";

export const EXIT_OK = 0;
export const EXIT_UNCAUGHT = 1;

/** The one frozen `GlyphErrorType -> code` map; no command invents its own. */
export const EXIT_CODES: Readonly<Record<GlyphErrorType, number>> = Object.freeze({
	usage: 2,
	not_found: 3,
	denied: 4,
	conflict: 5,
	validation: 6,
	drift: 6,
	indeterminate: 7,
});

export class GlyphError extends Error {
	readonly errorType: GlyphErrorType;
	readonly code: number;

	constructor(errorType: GlyphErrorType, message: string) {
		super(message);
		this.name = "GlyphError";
		this.errorType = errorType;
		this.code = EXIT_CODES[errorType];
	}
}

/** The one function that maps any thrown value to its contract exit code. */
export function exitCodeFor(error: unknown): number {
	return error instanceof GlyphError ? error.code : EXIT_UNCAUGHT;
}

export function usageError(message: string): GlyphError {
	return new GlyphError("usage", message);
}

export function notFoundError(message: string): GlyphError {
	return new GlyphError("not_found", message);
}

export function deniedError(message: string): GlyphError {
	return new GlyphError("denied", message);
}

export function conflictError(message: string): GlyphError {
	return new GlyphError("conflict", message);
}

export function validationError(message: string): GlyphError {
	return new GlyphError("validation", message);
}

export function driftError(message: string): GlyphError {
	return new GlyphError("drift", message);
}

export function indeterminateError(message: string): GlyphError {
	return new GlyphError("indeterminate", message);
}
