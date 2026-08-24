/**
 * The result type used by every attempt-shaped operation in this package.
 *
 * The rule, which is the same one the sibling package uses: pure parsers and
 * programmer-error guards throw, and attempt-shaped operations return a
 * `Result`. Deciding whether a given browser can decode HEIC is attempt-shaped
 * and runs on every conversion, so it must not allocate a stack trace to say
 * no. Discovering that a HEIF box claims a length of four gigabytes is a parse
 * failure and throws.
 */

import { ConverterError } from './errors.js';

export type Result<T, E = ConverterError> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

/** Unwrap or rethrow. For callers that would rather have the exception. */
export function unwrap<T>(result: Result<T, ConverterError>): T {
	if (result.ok) return result.value;
	throw result.error;
}

/**
 * Run `fn` and convert a thrown `ConverterError` into a failed result.
 *
 * Anything that is not a `ConverterError` is rethrown rather than wrapped. A
 * `TypeError` from calling this wrongly is a bug in the caller, and swallowing
 * it into a `Result` would hide it behind a message about images.
 */
export async function attempt<T>(fn: () => T | Promise<T>): Promise<Result<T, ConverterError>> {
	try {
		return ok(await fn());
	} catch (error) {
		if (error instanceof ConverterError) return err(error);
		throw error;
	}
}
