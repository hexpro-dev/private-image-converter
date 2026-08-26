/**
 * What every decoder has to do with a file that is wrong, whichever decoder it is.
 *
 * The per-codec files already test refusals, carefully and by hand: QOI has
 * about sixteen of them, TGA nine, APNG twenty, each naming the field that is
 * wrong and the sentence the reader is supposed to say about it. Nothing here
 * improves on that and nothing here should be read as replacing it.
 *
 * What those lists cannot do is cover a codec nobody has written yet. Each one
 * was assembled by somebody with that format's specification open, so a format
 * added next year arrives with its own list and with none of the properties
 * that are true of all of them, and no assertion anywhere is made over the
 * whole registered set. This file makes four, over every decoder
 * `installDefaultCodecs` registers that can run outside a browser:
 *
 *   1. Nothing escapes but a `ConverterError`. A `RangeError` out of a typed
 *      array or a `TypeError` from reading a property of `undefined` is a
 *      reader that walked off the end of its buffer, and it reaches the
 *      application as an exception with nothing useful in it.
 *   2. No unhandled rejection, ever. See `setup.ts` for why that one is first.
 *   3. Nothing allocates for a size the file cannot possibly hold. The header
 *      is four bytes of width and four of height; the file is a kilobyte.
 *   4. Every decode finishes. See `watchdog.ts` for how that is caught, since
 *      a loop with no exit cannot be interrupted from the thread it is on.
 *
 * The interesting assertion is not any of the four. It is that the list of
 * decoders is read off the registry rather than written out here, so a codec
 * registered tomorrow is covered the day it is registered, and the corpus is
 * grown from a seed per format, so a format with no seed fails this file
 * rather than quietly getting nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emptyCapabilities } from '../../src/detect/capabilities.js';
import { installDefaultCodecs } from '../../src/defaults.js';
import { DecodeFailedError, isConverterError } from '../../src/errors.js';
import { createRaster } from '../../src/raster/image.js';
import { registeredDecoders } from '../../src/registry.js';
import type { DecodeContext, DecodeOutput, Decoder } from '../../src/types.js';
import type { MalformedInput, Seed } from '../helpers/malformed.js';
import { buildSeeds, corpusFor, enormousFor } from '../helpers/malformed.js';
import {
	guardUnhandledRejections,
	settleRejections,
	takeUnhandledRejections,
	unhandledRejectionListener,
} from './setup.js';
import type { Watchdog } from './watchdog.js';
import { startWatchdog } from './watchdog.js';

guardUnhandledRejections();

const capabilities = emptyCapabilities();

/**
 * The ceiling handed to every decode here.
 *
 * A million rather than the eighty million `convert` defaults to, because the
 * point of the number is to be provably above the seeds (32 by 32) and
 * provably below what a mutated header claims. A decoder that hands back more
 * pixels than this was given has ignored the budget it was handed, whatever
 * its own internal ceiling says.
 */
const MAX_PIXELS = 1_000_000;

const context: DecodeContext = { capabilities, maxPixels: MAX_PIXELS };

/**
 * How long one input is allowed to take.
 *
 * A smoke alarm rather than a stopwatch. Every input here is a few kilobytes
 * and the whole corpus averages one to two milliseconds an input, so this sits
 * two orders of magnitude above anything legitimate. It has to: a fuzz suite
 * that fails on a busy machine gets marked flaky and then deleted, and the
 * failure it is really watching for is a reader whose cost has gone quadratic
 * in a field a mutation just set to two billion, which does not take 500
 * milliseconds, it takes minutes. A loop that never finishes at all is the
 * watchdog's problem rather than this one's.
 */
const BUDGET_MS = 500;

installDefaultCodecs();

const registered = registeredDecoders();

/**
 * The decoders that can run here.
 *
 * Read off the registry and filtered by each decoder's own availability probe
 * rather than listed, which is the whole point: adding a codec adds it here.
 * Under Node the probes rule out everything that needs a canvas, an
 * `ImageBitmap` or a `VideoDecoder`, which is the same set `vitest.config.ts`
 * excludes from coverage for the same reason. `installs every pure decoder`
 * below is what stops that filter quietly emptying out.
 */
const runnable: Decoder[] = [];
for (const decoder of registered) {
	if (await decoder.available(capabilities)) runnable.push(decoder);
}

const seeds = await buildSeeds();
const seedFor = new Map<string, Seed>(seeds.map((seed) => [seed.format, seed]));

let watchdog: Watchdog;

beforeAll(() => {
	watchdog = startWatchdog();
});

afterAll(async () => {
	await watchdog.stop();
});

interface Attempt {
	/** Absent when the decode returned. Wrapped, because `undefined` is throwable. */
	readonly caught?: { readonly value: unknown };
	readonly pixels?: number;
	readonly ms: number;
}

async function attempt(decoder: Decoder, input: MalformedInput, light = false): Promise<Attempt> {
	// Before the call, not after: if it never comes back, this is the last
	// thing the watchdog will have seen.
	watchdog.beat(`${decoder.id} ${input.label}`);
	const started = performance.now();
	try {
		const output = light
			? await (decoder.decodeFloat as NonNullable<Decoder['decodeFloat']>)(input.bytes, context)
			: await decoder.decode(input.bytes, context);
		const { width, height } = output.image;
		return { pixels: width * height, ms: performance.now() - started };
	} catch (error) {
		return { caught: { value: error }, ms: performance.now() - started };
	}
}

function nameOf(thrown: unknown): string {
	if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
	return `a bare ${typeof thrown}: ${String(thrown)}`;
}

/** Everything wrong with one attempt, as sentences, so a failure reads as a report. */
function complaints(input: MalformedInput, outcome: Attempt): string[] {
	const out: string[] = [];
	if (outcome.caught && !isConverterError(outcome.caught.value)) {
		out.push(`${input.label} threw ${nameOf(outcome.caught.value)}, which is not a ConverterError`);
	}
	if (outcome.ms > BUDGET_MS) {
		out.push(`${input.label} took ${Math.round(outcome.ms)}ms, past the ${BUDGET_MS}ms budget`);
	}
	if (outcome.pixels !== undefined && outcome.pixels > MAX_PIXELS) {
		out.push(`${input.label} returned ${outcome.pixels} pixels, past the ${MAX_PIXELS} allowed`);
	}
	return out;
}

describe('the set this suite covers', () => {
	it('is every decoder that does not need a browser to run', () => {
		// A pure decoder that cannot run under Node is either broken or has
		// acquired a platform dependency it should not have, and either way it
		// would drop out of this suite without a word.
		const sidelined = registered
			.filter((decoder) => decoder.path === 'pure' && !runnable.includes(decoder))
			.map((decoder) => decoder.id);
		expect(sidelined).toEqual([]);
		expect(runnable.length).toBeGreaterThan(0);
	});

	it('has a corpus for every format one of them can read', () => {
		// The gate that makes this file self-extending. Registering a decoder
		// for a format with no seed fails here, which is the moment to write
		// the seed rather than six months later.
		const formats = [...new Set(runnable.flatMap((decoder) => decoder.formats))];
		expect(formats.filter((format) => !seedFor.has(format))).toEqual([]);
	});

	it('grows every corpus from a file that really decodes', async () => {
		// A corpus mutated from a seed the reader already rejects tests the
		// first bounds check and nothing behind it, and it would look exactly
		// like a healthy corpus from out here.
		const failures: string[] = [];
		for (const seed of seeds) {
			for (const decoder of runnable.filter((one) => one.formats.includes(seed.format))) {
				const outcome = await attempt(decoder, {
					format: seed.format,
					label: 'seed',
					bytes: seed.bytes,
				});
				if (outcome.caught) {
					failures.push(`${decoder.id} refused its own seed: ${nameOf(outcome.caught.value)}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it('builds enough inputs per format to be worth running', () => {
		const thin = seeds
			.filter((seed) => corpusFor(seed).length < 30)
			.map((seed) => `${seed.format} has ${corpusFor(seed).length}`);
		expect(thin).toEqual([]);
	});
});

/**
 * A decoder that fails in each of the ways this file exists to notice.
 *
 * Here because a suite of green assertions over well behaved code proves
 * nothing about the assertions. Every check below is run against a decoder
 * that really does the thing, so a later tidy-up that weakens one of them
 * fails immediately rather than the next time somebody adds a codec.
 *
 * The three are the three real failures. `walks-off-the-end` is a reader
 * reading past its buffer, which surfaces as a `RangeError` with nothing in it
 * an application can act on. `oversize` is a reader that ignored the pixel
 * budget it was handed. `loose-rejection` is the one that has actually
 * happened here: a decoder that correctly reports a damaged file and leaves a
 * rejected promise behind while doing it.
 */
type Misbehaviour = 'walks-off-the-end' | 'oversize' | 'loose-rejection';

function hostile(kind: Misbehaviour): Decoder {
	return {
		id: `hostile-${kind}`,
		formats: ['qoi'],
		path: 'pure',
		priority: 99,
		async available() {
			return true;
		},
		async decode(): Promise<DecodeOutput> {
			if (kind === 'walks-off-the-end') {
				new DataView(new ArrayBuffer(4)).getUint32(8);
			}
			if (kind === 'loose-rejection') {
				void Promise.reject(new Error('a decoder dropped this'));
				throw new DecodeFailedError('qoi', 'hostile', 'it is damaged, which we noticed.');
			}
			return {
				image: createRaster(2000, 2000, 'srgb', false),
				orientation: { rotation: 0, mirror: 'none', source: 'none' },
			};
		},
	};
}

const probe: MalformedInput = { format: 'qoi', label: 'probe', bytes: Uint8Array.from([1, 2, 3]) };

describe('the harness itself', () => {
	it('reports a decoder that throws something other than a ConverterError', async () => {
		const outcome = await attempt(hostile('walks-off-the-end'), probe);
		const reported = complaints(probe, outcome);
		// Matched rather than compared. The sentence after the colon is the
		// engine's, and pinning it here would make this fail on a Node release
		// that reworded it, which says nothing about this package.
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatch(/^probe threw RangeError: .+, which is not a ConverterError$/);
	});

	it('reports a decoder that hands back more pixels than it was allowed', async () => {
		const outcome = await attempt(hostile('oversize'), probe);
		expect(complaints(probe, outcome)).toEqual([
			`probe returned 4000000 pixels, past the ${MAX_PIXELS} allowed`,
		]);
	});

	it('reports a decode that runs past the budget', () => {
		// Synthesised rather than timed. A decoder that really sat there for a
		// quarter of a second would cost the suite a quarter of a second on
		// every run to prove one comparison.
		expect(complaints(probe, { ms: BUDGET_MS + 1 })).toEqual([
			`probe took ${BUDGET_MS + 1}ms, past the ${BUDGET_MS}ms budget`,
		]);
	});
});

describe('the unhandled rejection guard', () => {
	it('records a rejection a decoder left behind', async () => {
		// The field failure, reproduced: the decoder does the right thing with
		// a damaged file and drops a rejected promise on the way out. Vitest's
		// own listeners step aside for the same reason as in the test below.
		const others = process.listeners('unhandledRejection');
		process.removeAllListeners('unhandledRejection');
		process.on('unhandledRejection', unhandledRejectionListener());
		try {
			const outcome = await attempt(hostile('loose-rejection'), probe);
			expect(complaints(probe, outcome)).toEqual([]);
			await settleRejections();
			const seen = takeUnhandledRejections();
			expect(seen).toHaveLength(1);
			expect((seen[0] as Error).message).toBe('a decoder dropped this');
		} finally {
			process.removeAllListeners('unhandledRejection');
			for (const listener of others) process.on('unhandledRejection', listener);
		}
	});

	it('records a rejection that nothing is holding', async () => {
		// Vitest installs its own listener and reports whatever it sees as a
		// loose error, which fails the run. That is the behaviour we want
		// everywhere except here, where the rejection is deliberate, so its
		// listeners step aside for the length of this test and are put back
		// afterwards, leaving ours as the only answer.
		const others = process.listeners('unhandledRejection');
		process.removeAllListeners('unhandledRejection');
		process.on('unhandledRejection', unhandledRejectionListener());
		try {
			void Promise.reject(new Error('nothing is holding this'));
			await settleRejections();
			const seen = takeUnhandledRejections();
			expect(seen).toHaveLength(1);
			expect((seen[0] as Error).message).toBe('nothing is holding this');
		} finally {
			process.removeAllListeners('unhandledRejection');
			for (const listener of others) process.on('unhandledRejection', listener);
		}
	});
});

for (const decoder of runnable) {
	for (const format of decoder.formats) {
		const seed = seedFor.get(format);
		// Absent is a failure of `has a corpus for every format` above rather
		// than a reason to invent an empty describe block here.
		if (!seed) continue;
		const corpus = corpusFor(seed);
		const enormous = enormousFor(seed);

		describe(`${decoder.id} on a broken ${format}`, () => {
			it('answers every input with a picture or a ConverterError', async () => {
				const failures: string[] = [];
				for (const input of corpus) {
					failures.push(...complaints(input, await attempt(decoder, input)));
				}
				expect(failures).toEqual([]);
			});

			it('refuses a header that declares an image the file cannot hold', async () => {
				const failures: string[] = [];
				for (const input of enormous) {
					const outcome = await attempt(decoder, input);
					failures.push(...complaints(input, outcome));
					if (!outcome.caught) {
						failures.push(`${input.label} was accepted rather than refused`);
					}
				}
				expect(failures).toEqual([]);
			});

			if (decoder.decodeFloat) {
				it('answers the same way when it is asked for light instead', async () => {
					// A second entry point is a second reader over the same bytes,
					// and on both formats that have one it is the reader that does
					// the interesting work. Testing only `decode` would cover the
					// tone mapper's input and leave the parse untested.
					const failures: string[] = [];
					for (const input of [...corpus, ...enormous]) {
						failures.push(...complaints(input, await attempt(decoder, input, true)));
					}
					expect(failures).toEqual([]);
				});
			}
		});
	}
}
