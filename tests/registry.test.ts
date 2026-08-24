/**
 * Registry and default codec set tests.
 *
 * The registry decides which rung of the ladder is allowed to run here; it
 * never runs one. The fakes below therefore refuse to decode or encode at all,
 * so a test that somehow reached one fails loudly rather than passing on a code
 * path it was never meant to touch.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installDefaultCodecs, resetDefaultCodecs } from '../src/defaults.js';
import { emptyCapabilities } from '../src/detect/capabilities.js';
import {
	clearRegistry,
	decodersFor,
	encodersFor,
	readableFormats,
	registerDecoder,
	registerEncoder,
	registeredDecoders,
	registeredEncoders,
	unregisterDecoder,
	unregisterEncoder,
	writableFormats,
} from '../src/registry.js';
import type { Capabilities, Decoder, Encoder, FormatId } from '../src/types.js';

/** What a fake codec's availability probe does when the registry calls it. */
type ProbeResult = 'yes' | 'no' | 'throws';

interface FakeDecoderOptions {
	readonly formats?: readonly FormatId[];
	readonly priority?: number;
	readonly probe?: ProbeResult;
}

interface FakeEncoderOptions {
	readonly format?: FormatId;
	readonly priority?: number;
	readonly probe?: ProbeResult;
}

/** A decoder that records every capability set its probe was handed. */
interface RecordingDecoder extends Decoder {
	readonly seen: Capabilities[];
}

interface RecordingEncoder extends Encoder {
	readonly seen: Capabilities[];
}

function fakeDecoder(id: string, options: FakeDecoderOptions = {}): RecordingDecoder {
	const seen: Capabilities[] = [];
	return {
		id,
		formats: options.formats ?? ['png'],
		path: 'pure',
		priority: options.priority ?? 40,
		seen,
		async available(capabilities) {
			seen.push(capabilities);
			if (options.probe === 'throws') throw new Error(`the ${id} probe blew up`);
			return options.probe !== 'no';
		},
		async decode() {
			throw new Error('the registry picks decoders, it must never run one');
		},
	};
}

function fakeEncoder(id: string, options: FakeEncoderOptions = {}): RecordingEncoder {
	const seen: Capabilities[] = [];
	return {
		id,
		format: options.format ?? 'png',
		path: 'pure',
		priority: options.priority ?? 40,
		seen,
		async available(capabilities) {
			seen.push(capabilities);
			if (options.probe === 'throws') throw new Error(`the ${id} probe blew up`);
			return options.probe !== 'no';
		},
		async encode() {
			throw new Error('the registry picks encoders, it must never run one');
		},
	};
}

function ids(codecs: readonly { readonly id: string }[]): string[] {
	return codecs.map((codec) => codec.id);
}

function priorityOf(
	codecs: readonly { readonly id: string; readonly priority: number }[],
	id: string,
): number {
	const found = codecs.find((codec) => codec.id === id);
	if (!found) throw new Error(`nothing is registered as ${id}`);
	return found.priority;
}

/** The codecs this package ships, in the order `installDefaultCodecs` adds them. */
const DEFAULT_DECODER_IDS = [
	'heic-native',
	'heic-webcodecs',
	'png-native',
	'jpeg-native',
	'gif-native',
	'webp-native',
	'avif-native',
	'bmp-native',
	'png-pure',
	'qoi-pure',
	'bmp-pure',
	'tga-pure',
	'pnm-pure',
	'farbfeld-pure',
];

const DEFAULT_ENCODER_IDS = [
	'png-native',
	'jpeg-native',
	'webp-native',
	'avif-native',
	'png-pure',
	'qoi-pure',
	'bmp-pure',
	'tga-pure',
	'pnm-pure',
	'farbfeld-pure',
];

beforeEach(() => {
	clearRegistry();
	// clearRegistry leaves the defaults still believing they are installed, so
	// this has to go with it. Without it the first test to install them wins and
	// every later one sees an empty registry.
	resetDefaultCodecs();
});

describe('registering a codec', () => {
	it('leaves one entry when the same id is registered twice', () => {
		registerDecoder(fakeDecoder('png-x', { priority: 10 }));
		registerDecoder(fakeDecoder('png-x', { priority: 20 }));
		expect(registeredDecoders()).toHaveLength(1);
		expect(priorityOf(registeredDecoders(), 'png-x')).toBe(20);
	});

	it('keeps the second registration and discards the first', () => {
		const first = fakeDecoder('png-x');
		const second = fakeDecoder('png-x');
		registerDecoder(first);
		registerDecoder(second);
		expect(registeredDecoders()[0]).toBe(second);
	});

	it('gives the replacement the slot the first registration held', () => {
		// The ladder breaks priority ties on registration order, so overriding a
		// built-in must not quietly move it behind everything registered since.
		// A host that overrides the PNG decoder is not asking to be demoted.
		registerDecoder(fakeDecoder('first', { priority: 40 }));
		registerDecoder(fakeDecoder('second', { priority: 40 }));
		registerDecoder(fakeDecoder('first', { priority: 40 }));
		expect(ids(registeredDecoders())).toEqual(['first', 'second']);
	});

	it('leaves one encoder entry when the same id is registered twice', () => {
		registerEncoder(fakeEncoder('png-x', { priority: 10 }));
		registerEncoder(fakeEncoder('png-x', { priority: 20 }));
		expect(registeredEncoders()).toHaveLength(1);
		expect(priorityOf(registeredEncoders(), 'png-x')).toBe(20);
	});

	it('keeps decoder ids and encoder ids in separate namespaces', () => {
		// The built-ins deliberately reuse one id across both: png-pure is a
		// decoder and an encoder, and neither may evict the other.
		registerDecoder(fakeDecoder('png-pure'));
		registerEncoder(fakeEncoder('png-pure'));
		expect(registeredDecoders()).toHaveLength(1);
		expect(registeredEncoders()).toHaveLength(1);
	});
});

describe('choosing a decoder', () => {
	it('returns only the decoders whose probe said yes', async () => {
		registerDecoder(fakeDecoder('yes-one', { priority: 10 }));
		registerDecoder(fakeDecoder('no-one', { priority: 20, probe: 'no' }));
		registerDecoder(fakeDecoder('yes-two', { priority: 30 }));
		expect(ids(await decodersFor('png', emptyCapabilities()))).toEqual(['yes-one', 'yes-two']);
	});

	it('puts the cheapest rung first, whatever order they were registered in', async () => {
		registerDecoder(fakeDecoder('slow', { priority: 40 }));
		registerDecoder(fakeDecoder('fast', { priority: 10 }));
		registerDecoder(fakeDecoder('middling', { priority: 20 }));
		expect(ids(await decodersFor('png', emptyCapabilities()))).toEqual([
			'fast',
			'middling',
			'slow',
		]);
	});

	it('breaks a priority tie on registration order', async () => {
		// This is what lets a host register an override at the same priority as
		// the built-in and have it tried second rather than at random.
		registerDecoder(fakeDecoder('built-in', { priority: 10 }));
		registerDecoder(fakeDecoder('override', { priority: 10 }));
		expect(ids(await decodersFor('png', emptyCapabilities()))).toEqual(['built-in', 'override']);
	});

	it('ignores a decoder registered for another format', async () => {
		registerDecoder(fakeDecoder('png-x', { formats: ['png'] }));
		registerDecoder(fakeDecoder('heic-x', { formats: ['heic'] }));
		expect(ids(await decodersFor('heic', emptyCapabilities()))).toEqual(['heic-x']);
	});

	it('offers a multi-format decoder for each format it lists', async () => {
		registerDecoder(fakeDecoder('many', { formats: ['png', 'jpeg', 'gif'] }));
		expect(ids(await decodersFor('jpeg', emptyCapabilities()))).toEqual(['many']);
		expect(ids(await decodersFor('gif', emptyCapabilities()))).toEqual(['many']);
		expect(ids(await decodersFor('webp', emptyCapabilities()))).toEqual([]);
	});

	it('treats a probe that rejects as a no rather than failing the lookup', async () => {
		// A probe that throws is a codec that cannot run. Letting the rejection
		// escape would mean one broken optional plugin takes down every
		// conversion, including the formats it has nothing to do with.
		registerDecoder(fakeDecoder('broken', { priority: 10, probe: 'throws' }));
		registerDecoder(fakeDecoder('working', { priority: 20 }));
		expect(ids(await decodersFor('png', emptyCapabilities()))).toEqual(['working']);
	});

	it('returns an empty list when nothing is registered at all', async () => {
		expect(await decodersFor('png', emptyCapabilities())).toEqual([]);
	});

	it('hands the probe the capability set it was asked about', async () => {
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		const capabilities = emptyCapabilities({ compressionStream: true });
		await decodersFor('png', capabilities);
		expect(decoder.seen).toEqual([capabilities]);
	});
});

describe('choosing an encoder', () => {
	it('matches the format exactly', async () => {
		registerEncoder(fakeEncoder('png-x', { format: 'png' }));
		registerEncoder(fakeEncoder('jpeg-x', { format: 'jpeg' }));
		expect(ids(await encodersFor('png', emptyCapabilities()))).toEqual(['png-x']);
		expect(ids(await encodersFor('avif', emptyCapabilities()))).toEqual([]);
	});

	it('puts the cheapest encoder first', async () => {
		registerEncoder(fakeEncoder('canvas', { priority: 20 }));
		registerEncoder(fakeEncoder('ours', { priority: 10 }));
		expect(ids(await encodersFor('png', emptyCapabilities()))).toEqual(['ours', 'canvas']);
	});

	it('drops an encoder whose probe said no', async () => {
		registerEncoder(fakeEncoder('present', { priority: 10 }));
		registerEncoder(fakeEncoder('absent', { priority: 20, probe: 'no' }));
		expect(ids(await encodersFor('png', emptyCapabilities()))).toEqual(['present']);
	});

	it('treats a rejecting encoder probe as a no as well', async () => {
		registerEncoder(fakeEncoder('broken', { priority: 10, probe: 'throws' }));
		registerEncoder(fakeEncoder('working', { priority: 20 }));
		expect(ids(await encodersFor('png', emptyCapabilities()))).toEqual(['working']);
	});
});

describe('memoised availability', () => {
	it('probes a decoder once however often the ladder is asked for', async () => {
		// The real probes decode and encode sample images. Asking twice per
		// conversion would double the cost of the most expensive thing the
		// package does before it has touched the file at all.
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		const capabilities = emptyCapabilities();
		await decodersFor('png', capabilities);
		await decodersFor('png', capabilities);
		await readableFormats(capabilities);
		expect(decoder.seen).toHaveLength(1);
	});

	it('probes again for a different capability object', async () => {
		// The cache is keyed on the capability set itself, because an answer only
		// belongs to the environment it was measured in.
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		await decodersFor('png', emptyCapabilities());
		await decodersFor('png', emptyCapabilities());
		expect(decoder.seen).toHaveLength(2);
	});

	it('remembers a rejected probe as a no instead of retrying it', async () => {
		const decoder = fakeDecoder('png-x', { probe: 'throws' });
		registerDecoder(decoder);
		const capabilities = emptyCapabilities();
		expect(ids(await decodersFor('png', capabilities))).toEqual([]);
		expect(ids(await decodersFor('png', capabilities))).toEqual([]);
		expect(decoder.seen).toHaveLength(1);
	});

	it('re-probes once a new decoder is registered', async () => {
		// A new codec can change which rung is the right one, so the cached
		// answers are thrown away rather than reasoned about.
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		const capabilities = emptyCapabilities();
		await decodersFor('png', capabilities);
		registerDecoder(fakeDecoder('png-y'));
		await decodersFor('png', capabilities);
		expect(decoder.seen).toHaveLength(2);
	});

	it('re-probes once a new encoder is registered', async () => {
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		const capabilities = emptyCapabilities();
		await decodersFor('png', capabilities);
		registerEncoder(fakeEncoder('png-out'));
		await decodersFor('png', capabilities);
		expect(decoder.seen).toHaveLength(2);
	});

	it('re-probes once a registration is removed', async () => {
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		registerDecoder(fakeDecoder('png-y'));
		const capabilities = emptyCapabilities();
		await decodersFor('png', capabilities);
		expect(unregisterDecoder('png-y')).toBe(true);
		await decodersFor('png', capabilities);
		expect(decoder.seen).toHaveLength(2);
	});

	it('keeps the cached answers when an unregister removed nothing', async () => {
		// Only a real change invalidates. Throwing the cache away on a caller's
		// typo would re-run every probe for nothing.
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		const capabilities = emptyCapabilities();
		await decodersFor('png', capabilities);
		expect(unregisterDecoder('nobody-registered-this')).toBe(false);
		await decodersFor('png', capabilities);
		expect(decoder.seen).toHaveLength(1);
	});

	it('does not let a decoder and an encoder sharing an id share an answer', async () => {
		// png-pure really is both, so a cache keyed on the bare id would hand the
		// second lookup whatever the first one decided.
		registerDecoder(fakeDecoder('png-pure', { probe: 'no' }));
		registerEncoder(fakeEncoder('png-pure', { probe: 'yes' }));
		const capabilities = emptyCapabilities();
		expect(ids(await decodersFor('png', capabilities))).toEqual([]);
		expect(ids(await encodersFor('png', capabilities))).toEqual(['png-pure']);
	});
});

describe('unregistering', () => {
	it('reports whether it removed a decoder', () => {
		registerDecoder(fakeDecoder('png-x'));
		expect(unregisterDecoder('png-x')).toBe(true);
		expect(unregisterDecoder('png-x')).toBe(false);
	});

	it('reports whether it removed an encoder', () => {
		registerEncoder(fakeEncoder('png-x'));
		expect(unregisterEncoder('png-x')).toBe(true);
		expect(unregisterEncoder('png-x')).toBe(false);
	});

	it('takes the decoder off the ladder', async () => {
		registerDecoder(fakeDecoder('keep', { priority: 10 }));
		registerDecoder(fakeDecoder('drop', { priority: 20 }));
		unregisterDecoder('drop');
		expect(ids(await decodersFor('png', emptyCapabilities()))).toEqual(['keep']);
	});

	it('does not let an encoder id remove the decoder that shares it', () => {
		registerDecoder(fakeDecoder('png-pure'));
		registerEncoder(fakeEncoder('png-pure'));
		expect(unregisterEncoder('png-pure')).toBe(true);
		expect(ids(registeredDecoders())).toEqual(['png-pure']);
		expect(registeredEncoders()).toHaveLength(0);
	});

	it('empties both maps when the whole registry is cleared', () => {
		registerDecoder(fakeDecoder('png-x'));
		registerEncoder(fakeEncoder('png-x'));
		clearRegistry();
		expect(registeredDecoders()).toEqual([]);
		expect(registeredEncoders()).toEqual([]);
	});
});

describe('the formats on offer', () => {
	it('collects every format an available decoder covers', async () => {
		registerDecoder(fakeDecoder('many', { formats: ['png', 'jpeg'] }));
		registerDecoder(fakeDecoder('qoi-x', { formats: ['qoi'] }));
		const readable = await readableFormats(emptyCapabilities());
		expect([...readable].sort()).toEqual(['jpeg', 'png', 'qoi']);
	});

	it('leaves out a format only an unavailable decoder covers', async () => {
		registerDecoder(fakeDecoder('png-x', { formats: ['png'] }));
		registerDecoder(fakeDecoder('heic-x', { formats: ['heic'], probe: 'no' }));
		registerDecoder(fakeDecoder('tga-x', { formats: ['tga'], probe: 'throws' }));
		expect([...(await readableFormats(emptyCapabilities()))]).toEqual(['png']);
	});

	it('still lists a format a second decoder covers when the first is unavailable', async () => {
		// One rung being missing here is the normal case, not the broken one:
		// Firefox has no HEIC decoder and no HEVC, and the format is still
		// readable there through whatever the host registered.
		registerDecoder(fakeDecoder('heic-native-x', { formats: ['heic'], probe: 'no' }));
		registerDecoder(fakeDecoder('heic-plugin-x', { formats: ['heic'] }));
		expect([...(await readableFormats(emptyCapabilities()))]).toEqual(['heic']);
	});

	it('collects the format of each available encoder', async () => {
		registerEncoder(fakeEncoder('png-x', { format: 'png' }));
		registerEncoder(fakeEncoder('qoi-x', { format: 'qoi' }));
		registerEncoder(fakeEncoder('heic-x', { format: 'heic', probe: 'no' }));
		registerEncoder(fakeEncoder('tga-x', { format: 'tga', probe: 'throws' }));
		expect([...(await writableFormats(emptyCapabilities()))].sort()).toEqual(['png', 'qoi']);
	});

	it('counts a format once when two encoders write it', async () => {
		registerEncoder(fakeEncoder('png-a', { format: 'png', priority: 10 }));
		registerEncoder(fakeEncoder('png-b', { format: 'png', priority: 20 }));
		expect([...(await writableFormats(emptyCapabilities()))]).toEqual(['png']);
	});

	it('offers nothing when nothing is registered', async () => {
		expect(await readableFormats(emptyCapabilities())).toEqual(new Set());
		expect(await writableFormats(emptyCapabilities())).toEqual(new Set());
	});
});

describe('the default codec set', () => {
	it('registers the shipped decoders and encoders', () => {
		installDefaultCodecs();
		expect(ids(registeredDecoders())).toEqual(DEFAULT_DECODER_IDS);
		expect(ids(registeredEncoders())).toEqual(DEFAULT_ENCODER_IDS);
	});

	it('adds nothing on a second call', () => {
		installDefaultCodecs();
		installDefaultCodecs();
		installDefaultCodecs();
		expect(ids(registeredDecoders())).toEqual(DEFAULT_DECODER_IDS);
		expect(ids(registeredEncoders())).toEqual(DEFAULT_ENCODER_IDS);
	});

	it('does not reinstall into a registry that was cleared underneath it', () => {
		// The installed flag lives in defaults.ts and clearRegistry knows nothing
		// about it, so clearing the registry on its own leaves a permanently
		// empty one. This is why resetDefaultCodecs exists and why it belongs
		// beside every clearRegistry in a test.
		installDefaultCodecs();
		clearRegistry();
		installDefaultCodecs();
		expect(registeredDecoders()).toEqual([]);
		resetDefaultCodecs();
		installDefaultCodecs();
		expect(ids(registeredDecoders())).toEqual(DEFAULT_DECODER_IDS);
	});

	it('does not disturb a codec registered before it ran', () => {
		registerDecoder(fakeDecoder('plugin-x', { formats: ['heic'], priority: 50 }));
		installDefaultCodecs();
		expect(ids(registeredDecoders())).toEqual(['plugin-x', ...DEFAULT_DECODER_IDS]);
	});

	it('names each shipped codec after the format it handles', () => {
		installDefaultCodecs();
		for (const decoder of registeredDecoders()) {
			expect(decoder.formats, decoder.id).toEqual([decoder.id.split('-')[0]]);
		}
		for (const encoder of registeredEncoders()) {
			expect(encoder.format, encoder.id).toBe(encoder.id.split('-')[0]);
		}
	});

	it('tries the browser HEIC decoder before driving the video decoder itself', () => {
		installDefaultCodecs();
		const decoders = registeredDecoders();
		expect(priorityOf(decoders, 'heic-native')).toBeLessThan(
			priorityOf(decoders, 'heic-webcodecs'),
		);
	});

	it('tries every browser decoder before the pure one for the same format', () => {
		installDefaultCodecs();
		const decoders = registeredDecoders();
		expect(priorityOf(decoders, 'png-native')).toBeLessThan(priorityOf(decoders, 'png-pure'));
		expect(priorityOf(decoders, 'bmp-native')).toBeLessThan(priorityOf(decoders, 'bmp-pure'));
	});

	it('puts our own PNG encoder ahead of the canvas, and only PNG that way round', () => {
		// PNG is the one inversion. Ours writes 24 bit where there is no alpha,
		// carries the source ICC profile so a wide gamut photograph survives, and
		// has no canvas size ceiling. For every other format the canvas is the
		// only encoder there is.
		installDefaultCodecs();
		const encoders = registeredEncoders();
		expect(priorityOf(encoders, 'png-pure')).toBeLessThan(priorityOf(encoders, 'png-native'));
		expect(priorityOf(encoders, 'jpeg-native')).toBeLessThan(priorityOf(encoders, 'png-native'));
	});

	it('offers no HEIC decoder to a browser with neither HEIC nor HEVC', async () => {
		installDefaultCodecs();
		expect(await decodersFor('heic', emptyCapabilities())).toEqual([]);
	});

	it('offers no native encoder to a browser whose canvas writes nothing', async () => {
		installDefaultCodecs();
		expect(ids(await encodersFor('jpeg', emptyCapabilities()))).toEqual([]);
		expect(ids(await encodersFor('avif', emptyCapabilities()))).toEqual([]);
	});

	it('still reads and writes the pure formats with no browser capability at all', async () => {
		// PNG is left out of both lists on purpose: its pure rungs depend on
		// CompressionStream, which the Node test environment happens to have and
		// an older browser does not, so it is not this test's to assert.
		installDefaultCodecs();
		const capabilities = emptyCapabilities();
		const readable = await readableFormats(capabilities);
		const writable = await writableFormats(capabilities);
		for (const format of ['qoi', 'bmp', 'tga', 'pnm', 'farbfeld'] as const) {
			expect(readable.has(format), `${format} readable`).toBe(true);
			expect(writable.has(format), `${format} writable`).toBe(true);
		}
		for (const format of ['heic', 'jpeg', 'gif', 'webp', 'avif'] as const) {
			expect(readable.has(format), `${format} readable`).toBe(false);
		}
		for (const format of ['jpeg', 'webp', 'avif'] as const) {
			expect(writable.has(format), `${format} writable`).toBe(false);
		}
	});

	it('picks the pure rung for QOI, which needs nothing from the browser', async () => {
		installDefaultCodecs();
		expect(ids(await decodersFor('qoi', emptyCapabilities()))).toEqual(['qoi-pure']);
	});

	it('lets a host override a built-in by reusing its id', async () => {
		// The reason registration is idempotent by id at all: a host with a
		// WebAssembly PNG decoder should be able to replace ours without having
		// to know it existed or unregister it first.
		installDefaultCodecs();
		registerDecoder(fakeDecoder('png-pure', { formats: ['png'], priority: 40 }));
		expect(ids(registeredDecoders())).toEqual(DEFAULT_DECODER_IDS);
		const chosen = await decodersFor('png', emptyCapabilities());
		expect(ids(chosen)).toEqual(['png-pure']);
	});
});
