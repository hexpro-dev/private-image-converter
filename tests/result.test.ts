import { describe, expect, it } from 'vitest';
import { attempt, err, isConverterError, ok, unwrap } from '../src/index.js';
import { ConverterError, EmptyInputError, UnknownFormatError } from '../src/errors.js';
import { outputName } from '../src/dom/download.js';

describe('Result', () => {
	it('carries a value on success and an error on failure', () => {
		expect(ok(3)).toEqual({ ok: true, value: 3 });
		const failure = new EmptyInputError();
		expect(err(failure)).toEqual({ ok: false, error: failure });
	});

	it('unwraps a success and rethrows a failure', () => {
		expect(unwrap(ok('x'))).toBe('x');
		expect(() => unwrap(err(new EmptyInputError()))).toThrow(EmptyInputError);
	});

	it('converts a thrown converter error into a failed result', async () => {
		const result = await attempt(() => {
			throw new EmptyInputError();
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('input/empty');
	});

	it('lets anything that is not a converter error escape', async () => {
		// A TypeError here is a bug in the caller. Wrapping it into a Result
		// would hide a programming mistake behind a message about images, which
		// is the failure mode this distinction exists to prevent.
		await expect(
			attempt(() => {
				throw new TypeError('called wrongly');
			}),
		).rejects.toThrow(TypeError);
	});

	it('awaits an asynchronous function', async () => {
		const result = await attempt(async () => 7);
		expect(result).toEqual({ ok: true, value: 7 });
	});
});

describe('the error taxonomy', () => {
	it('names each subclass after itself without repeating the name', () => {
		expect(new EmptyInputError().name).toBe('EmptyInputError');
		expect(new UnknownFormatError(new Uint8Array(2)).name).toBe('UnknownFormatError');
	});

	it('recognises its own errors and nothing else', () => {
		expect(isConverterError(new EmptyInputError())).toBe(true);
		expect(isConverterError(new Error('no'))).toBe(false);
		expect(isConverterError(undefined)).toBe(false);
		expect(isConverterError({ code: 'input/empty' })).toBe(false);
	});

	it('keeps the offending bytes off the message', () => {
		// The head of a file somebody dropped is not something to print. It is
		// on a field for a caller that wants it, and the message says nothing
		// about it.
		const head = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
		const error = new UnknownFormatError(head);
		expect(error.head).toEqual(head);
		// The message does name PNG, because it lists what the tool reads. What
		// it must not do is echo the bytes back.
		expect(error.head).toEqual(head);
		expect(error.message).not.toMatch(/0x89|\\x89|137,\s*80/);
	});

	it('is an Error, so an unhandled one still reports usefully', () => {
		expect(new EmptyInputError()).toBeInstanceOf(Error);
		expect(new EmptyInputError()).toBeInstanceOf(ConverterError);
	});
});

describe('outputName', () => {
	it('swaps the extension and keeps the stem recognisable', () => {
		// Somebody who converts forty photographs needs to be able to pair each
		// result with its original at a glance.
		expect(outputName('IMG_2059.HEIC', 'png')).toBe('IMG_2059.png');
		expect(outputName('holiday.jpeg', 'webp')).toBe('holiday.webp');
	});

	it('adds an extension to a name that has none', () => {
		expect(outputName('scan', 'png')).toBe('scan.png');
	});

	it('keeps every dot but the last', () => {
		expect(outputName('report.final.v2.tiff', 'png')).toBe('report.final.v2.png');
	});

	it('leaves a leading dot alone rather than treating it as an extension', () => {
		expect(outputName('.gitignore', 'png')).toBe('.gitignore.png');
	});

	it('strips path separators out of a name', () => {
		// A file name is not a path, and a download attribute carrying one is a
		// browser's problem rather than something to pass on.
		expect(outputName('../../etc/passwd', 'png')).toBe('image.png');
		expect(outputName('a/b/c.heic', 'png')).toBe('abc.png');
	});

	it('falls back when there is no usable name at all', () => {
		expect(outputName('', 'png')).toBe('image.png');
		expect(outputName('   ', 'png')).toBe('image.png');
	});
});
