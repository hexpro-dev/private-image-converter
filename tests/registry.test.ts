/**
 * Registry and default codec set tests.
 *
 * The registry decides which rung of the ladder is allowed to run here; it
 * never runs one. The fakes below therefore refuse to decode or encode at all,
 * so a test that somehow reached one fails loudly rather than passing on a code
 * path it was never meant to touch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Every codec this package ships, in the order `installDefaultCodecs` adds
 * them, with the priority and the path each one is published as.
 *
 * Written out rather than derived, because that is the whole value of it. A
 * codec that changes rung, loses its availability gate or starts reporting the
 * wrong path is invisible to every ordering assertion in this file, and all
 * three are changes somebody has to look at on purpose.
 *
 * Priority is a cost rather than a preference, and a host registers against
 * these numbers, so they are a contract:
 *
 *      8  the platform's frame decoder, the only native path that returns an
 *         animation rather than its first picture
 *     10  the platform's own decoder
 *     20  our own reader, where it knows something the platform's does not:
 *         HEVC tiles, an animation, a picture buried in a container
 *     30  the platform's own decoder standing in behind one of those
 *     40  a pure TypeScript implementation
 *     45  a last resort that pulls a picture out of a file nothing here decodes
 *     50+ left free for a host application's plugin
 */
const SHIPPED_DECODERS = [
	['heic-native', 10, 'native-image'],
	['heic-webcodecs', 20, 'webcodecs'],
	['webp-frames', 8, 'native-image'],
	['avif-frames', 8, 'native-image'],
	['gif-frames', 8, 'native-image'],
	['png-native', 10, 'native-image'],
	['jpeg-native', 10, 'native-image'],
	['jxl-native', 10, 'native-image'],
	['webp-native', 10, 'native-image'],
	['avif-native', 10, 'native-image'],
	['bmp-native', 10, 'native-image'],
	['svg-native', 10, 'native-image'],
	['apng-pure', 20, 'pure'],
	['apng-fallback', 30, 'native-image'],
	['gif-pure', 20, 'pure'],
	['gif-fallback', 30, 'native-image'],
	['png-pure', 40, 'pure'],
	['tiff-pure', 40, 'pure'],
	['raw-preview', 20, 'native-image'],
	['tiff-preview', 45, 'native-image'],
	['qoi-pure', 40, 'pure'],
	['bmp-pure', 40, 'pure'],
	['tga-pure', 40, 'pure'],
	['pnm-pure', 40, 'pure'],
	['farbfeld-pure', 40, 'pure'],
	['ico-pure', 40, 'pure'],
	['psd-pure', 40, 'pure'],
	['dds-pure', 40, 'pure'],
	['hdr-pure', 40, 'pure'],
	['exr-pure', 40, 'pure'],
	['pcx-pure', 40, 'pure'],
	['icns-pure', 40, 'pure'],
	['ras-pure', 40, 'pure'],
	['xbm-pure', 40, 'pure'],
	['xpm-pure', 40, 'pure'],
] as const;

/**
 * An encoder is either the browser's canvas or our own code.
 *
 * There is no third entry, because nothing here writes through WebCodecs.
 * Writing HEIC is a refusal rather than a gap: nothing in a browser encodes
 * HEVC, and doing it ourselves carries patent obligations a free tool has no
 * way to meet. The fourth column is whether the encoder writes an animation
 * rather than ignoring one it is handed, which decides whether `convert`
 * bothers preparing the frames at all.
 */
const SHIPPED_ENCODERS = [
	['png-native', 20, 'canvas', false],
	['jpeg-native', 10, 'canvas', false],
	['webp-native', 10, 'canvas', false],
	['avif-native', 10, 'canvas', false],
	['png-pure', 10, 'pure', false],
	['apng-pure', 10, 'pure', true],
	['gif-pure', 10, 'pure', true],
	['qoi-pure', 10, 'pure', false],
	['bmp-pure', 10, 'pure', false],
	['tga-pure', 10, 'pure', false],
	['pnm-pure', 10, 'pure', false],
	['farbfeld-pure', 10, 'pure', false],
	['tiff-pure', 10, 'pure', false],
	['hdr-pure', 10, 'pure', false],
	['pcx-pure', 10, 'pure', false],
	['ras-pure', 10, 'pure', false],
	['xbm-pure', 10, 'pure', false],
	['xpm-pure', 10, 'pure', false],
	['ico-pure', 10, 'pure', false],
	['icns-pure', 10, 'pure', false],
] as const;

const DEFAULT_DECODER_IDS = SHIPPED_DECODERS.map(([id]) => id);
const DEFAULT_ENCODER_IDS = SHIPPED_ENCODERS.map(([id]) => id);

/**
 * The mechanism each id suffix names, and the path it has to report.
 *
 * `ConvertReport.decodePath` reaches the interface and is shown to the person
 * waiting, because somebody on a software plugin waits several times longer
 * than somebody on the hardware path and saying so is the difference between a
 * slow tool and a broken one.
 */
const MECHANISM_PATHS = {
	native: 'native-image',
	fallback: 'native-image',
	frames: 'native-image',
	preview: 'native-image',
	webcodecs: 'webcodecs',
	pure: 'pure',
} as const;

/** The lowest priority left free for a host application's plugin. */
const PLUGIN_BAND = 50;

/** The mechanism an id names, which is whatever follows the format it handles. */
function mechanismOf(id: string): keyof typeof MECHANISM_PATHS {
	const suffix = id.slice(id.indexOf('-') + 1);
	if (suffix in MECHANISM_PATHS) return suffix as keyof typeof MECHANISM_PATHS;
	throw new Error(`${id} does not name a mechanism this package publishes`);
}

beforeEach(() => {
	clearRegistry();
	// clearRegistry leaves the defaults still believing they are installed, so
	// this has to go with it. Without it the first test to install them wins and
	// every later one sees an empty registry.
	resetDefaultCodecs();
});

afterEach(() => {
	// Two tests stand a browser global up to reach the half of the shipped
	// availability checks that Node cannot otherwise get to. Left in place it
	// would change what the rest of the file measures.
	vi.unstubAllGlobals();
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

	it('hands back a snapshot rather than the map it is still using', () => {
		// The return type says readonly, which is a compile-time promise and no
		// help at all to the host application calling this from JavaScript. What
		// matters is that a list already handed out cannot change underneath its
		// owner, so a caller can hold one while registering a plugin.
		registerDecoder(fakeDecoder('png-x'));
		const taken = registeredDecoders();
		registerDecoder(fakeDecoder('png-y'));
		expect(ids(taken)).toEqual(['png-x']);
		expect(ids(registeredDecoders())).toEqual(['png-x', 'png-y']);
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

	it('orders on the number and not on how the number reads', async () => {
		// The shipped ladder is 10, 20 and 40, which happen to sort into the same
		// order as text, so nothing else in this file can tell a numeric compare
		// from a lexicographic one. These cannot: as text, 9 lands after 100.
		// Both ends are legal. A host is told to go below the built-ins to win
		// outright, and 50 upwards is the band left free for its plugins, so a
		// WebAssembly decoder at 100 must be tried last rather than second.
		registerDecoder(fakeDecoder('hundred', { priority: 100 }));
		registerDecoder(fakeDecoder('nine', { priority: 9 }));
		registerDecoder(fakeDecoder('below-everything', { priority: -5 }));
		registerDecoder(fakeDecoder('ten', { priority: 10 }));
		registerDecoder(fakeDecoder('zero', { priority: 0 }));
		expect(ids(await decodersFor('png', emptyCapabilities()))).toEqual([
			'below-everything',
			'zero',
			'nine',
			'ten',
			'hundred',
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

	it('never asks a decoder for another format whether it can run', async () => {
		// Filtering before probing rather than after. A host's plugin probe is
		// the expensive one, since it typically has to fetch and instantiate a
		// WebAssembly module to answer, and converting a QOI must not pay for the
		// HEIC decoder's answer. Asserting the result alone cannot see this: the
		// wrong order returns exactly the same list.
		const other = fakeDecoder('heic-x', { formats: ['heic'] });
		registerDecoder(other);
		registerDecoder(fakeDecoder('png-x', { formats: ['png'] }));
		await decodersFor('png', emptyCapabilities());
		expect(other.seen).toEqual([]);
	});

	it('ignores a decoder that lists no formats at all', async () => {
		// A host that works its format list out at runtime can hand over an empty
		// one, and the honest reading of that is a decoder that reads nothing.
		// It stays registered, so unregistering it still works, and it is never
		// offered and never probed.
		const nothing = fakeDecoder('reads-nothing', { formats: [] });
		registerDecoder(nothing);
		expect(ids(registeredDecoders())).toEqual(['reads-nothing']);
		expect(await decodersFor('png', emptyCapabilities())).toEqual([]);
		expect(nothing.seen).toEqual([]);
		expect(await readableFormats(emptyCapabilities())).toEqual(new Set());
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

	it('never asks an encoder for another format whether it can run', async () => {
		const other = fakeEncoder('avif-x', { format: 'avif' });
		registerEncoder(other);
		registerEncoder(fakeEncoder('png-x', { format: 'png' }));
		await encodersFor('png', emptyCapabilities());
		expect(other.seen).toEqual([]);
	});

	it('orders encoders on the number and not on how the number reads', async () => {
		registerEncoder(fakeEncoder('hundred', { priority: 100 }));
		registerEncoder(fakeEncoder('nine', { priority: 9 }));
		registerEncoder(fakeEncoder('ten', { priority: 10 }));
		expect(ids(await encodersFor('png', emptyCapabilities()))).toEqual(['nine', 'ten', 'hundred']);
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

	it('probes once when two lookups are in flight together', async () => {
		// The answer is cached as the promise, before it settles, so the second
		// caller waits on the first probe rather than starting another. An
		// implementation that awaited the probe and then cached the boolean
		// returns all the same answers and quietly probes twice, which on the
		// real ladder means decoding and encoding the sample images twice.
		// Converting several files at once is the ordinary case, not a corner.
		const decoder = fakeDecoder('png-x');
		registerDecoder(decoder);
		const capabilities = emptyCapabilities();
		await Promise.all([
			decodersFor('png', capabilities),
			decodersFor('png', capabilities),
			readableFormats(capabilities),
		]);
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

	it('forgets the old answer when an id is registered over', async () => {
		// The override case, and the one where a stale answer does real damage.
		// A host replaces our PNG decoder with its own, its own says it cannot
		// run here, and a cache still holding the first decoder's yes puts the
		// replacement on the ladder anyway. Registering a different id, which is
		// the other test above, cannot see this: only the id already in the map
		// has a cached answer to go stale.
		const capabilities = emptyCapabilities();
		registerDecoder(fakeDecoder('png-x'));
		expect(ids(await decodersFor('png', capabilities))).toEqual(['png-x']);
		registerDecoder(fakeDecoder('png-x', { probe: 'no' }));
		expect(ids(await decodersFor('png', capabilities))).toEqual([]);
	});

	it('forgets the old encoder answer when an id is registered over', async () => {
		const capabilities = emptyCapabilities();
		registerEncoder(fakeEncoder('png-x', { probe: 'no' }));
		expect(ids(await encodersFor('png', capabilities))).toEqual([]);
		registerEncoder(fakeEncoder('png-x'));
		expect(ids(await encodersFor('png', capabilities))).toEqual(['png-x']);
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

	it('numbers each rung the way the ladder is published', () => {
		// Relative ordering on its own cannot hold this. Moving the pure rung
		// from 40 to 60 keeps every ordering assertion in this file green and
		// silently takes away the band a host was told it could register in, so
		// its WebAssembly HEIC decoder at 50 starts running ahead of ours.
		installDefaultCodecs();
		const decoders = registeredDecoders();
		for (const [id, priority] of SHIPPED_DECODERS) {
			expect(priorityOf(decoders, id), id).toBe(priority);
		}
		const encoders = registeredEncoders();
		for (const [id, priority] of SHIPPED_ENCODERS) {
			expect(priorityOf(encoders, id), id).toBe(priority);
		}
		for (const codec of [...decoders, ...encoders]) {
			expect(codec.priority, `${codec.id} stays out of the plugin band`).toBeLessThan(PLUGIN_BAND);
		}
	});

	it('labels each rung with the path it really runs on', () => {
		// A rung that reports the wrong path tells the person waiting the wrong
		// story about why their file took as long as it did, and every id and
		// priority assertion in this file passes while it does.
		installDefaultCodecs();
		const byId = new Map(registeredDecoders().map((decoder) => [decoder.id, decoder]));
		for (const [id, , path] of SHIPPED_DECODERS) {
			expect(byId.get(id)?.path, id).toBe(path);
			// Said twice on purpose: the table above is what somebody reads, and
			// this is what makes the suffix mean something rather than being a
			// naming habit.
			expect(MECHANISM_PATHS[mechanismOf(id)], id).toBe(path);
		}
		const encoders = new Map(registeredEncoders().map((encoder) => [encoder.id, encoder]));
		for (const [id, , path, animates] of SHIPPED_ENCODERS) {
			expect(encoders.get(id)?.path, id).toBe(path);
			expect(mechanismOf(id), `${id} does not encode through WebCodecs`).not.toBe('webcodecs');
			// `animates` decides whether `convert` prepares every frame before
			// encoding. An encoder that claimed it and then wrote one frame
			// would report a frame count that is not in the file.
			expect(encoders.get(id)?.animates === true, `${id} animates`).toBe(animates);
		}
	});

	it('tries our own reader before the browser for the formats that animate', () => {
		// The browser decodes a GIF and an APNG perfectly well and hands back
		// one picture, silently. Letting it go first would drop the animation
		// from every conversion on a browser without a frame decoder, and
		// nothing about the result would say so.
		installDefaultCodecs();
		const decoders = registeredDecoders();
		for (const format of ['gif', 'apng'] as const) {
			expect(priorityOf(decoders, `${format}-pure`), format).toBeLessThan(
				priorityOf(decoders, `${format}-fallback`),
			);
		}
		// GIF is the one of the two with a frame decoder in front of it as
		// well. There is no apng-frames: the platform decoder that returns
		// frames is asked for a type, and no browser offers image/apng as one.
		expect(priorityOf(decoders, 'gif-frames')).toBeLessThan(priorityOf(decoders, 'gif-pure'));
		expect(registeredDecoders().some((decoder) => decoder.id === 'apng-frames')).toBe(false);
	});

	it('keeps the embedded preview behind the reader that actually decodes a TIFF', () => {
		// A TIFF with JPEG strips is refused by name by the pure reader, and
		// this rung is what turns that refusal into a picture. Ahead of it, it
		// would hand back a thumbnail for every ordinary TIFF that has one.
		installDefaultCodecs();
		const decoders = registeredDecoders();
		expect(priorityOf(decoders, 'tiff-pure')).toBeLessThan(priorityOf(decoders, 'tiff-preview'));
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

	it('offers the WebCodecs rung to a browser whose video decoder does HEVC', async () => {
		// The counterpart to the test above, and the reason it means anything.
		// Every negative assertion in this file would still pass if each shipped
		// probe simply returned false, which is one edit away in a file where
		// most of the checks read `capabilities.something`. This is Chromium on
		// a machine with a decode block: no HEIC decoder of its own, so our
		// reader drives the video decoder instead.
		installDefaultCodecs();
		const chromium = emptyCapabilities({ hevcVideoDecoder: true });
		expect(ids(await decodersFor('heic', chromium))).toEqual(['heic-webcodecs']);
		expect(await readableFormats(chromium)).toContain('heic');
	});

	it('offers a canvas encoder only for the types the canvas really wrote', async () => {
		// Safari has never written WebP and does not say so: asked for one it
		// returns a PNG with the wrong type on it. The capability set is the
		// result of sniffing what actually came back, so a format missing from
		// it is missing because the probe caught the lie, and the registry has
		// to honour that rather than offering the canvas for everything it
		// nominally supports.
		installDefaultCodecs();
		const safari = emptyCapabilities({ canvasEncode: new Set(['image/png', 'image/jpeg']) });
		expect(ids(await encodersFor('jpeg', safari))).toEqual(['jpeg-native']);
		expect(ids(await encodersFor('webp', safari))).toEqual([]);
		expect(await writableFormats(safari)).not.toContain('webp');
	});

	it('asks the browser only for the types it said it could decode', async () => {
		// The other half of the native availability check, which no capability
		// set alone can reach: Node has no createImageBitmap, so under this
		// suite every native rung is unavailable for that reason rather than for
		// the one being tested, and a check reading `||` instead of `&&` passes
		// everything. Where it matters, an older Safari offers png-native for a
		// PNG and must not offer bmp-native for a BMP it cannot read, or the
		// interface lists a format that then fails at decode time.
		vi.stubGlobal('createImageBitmap', () => {
			throw new Error('the registry picks decoders, it must never run one');
		});
		installDefaultCodecs();
		const older = emptyCapabilities({ nativeDecode: new Set(['image/png']) });
		// png-pure rides on CompressionStream, which is an environment fact
		// rather than a package one, so only the first rung is asserted here.
		expect(ids(await decodersFor('png', older))[0]).toBe('png-native');
		expect(ids(await decodersFor('bmp', older))).toEqual(['bmp-pure']);

		// A fresh capability object, because the answers above are memoised
		// against the old one and pulling the global would not disturb them.
		vi.stubGlobal('createImageBitmap', undefined);
		const noDecoder = emptyCapabilities({ nativeDecode: new Set(['image/png']) });
		expect(ids(await decodersFor('png', noDecoder))).not.toContain('png-native');
	});

	it('writes no HEIC however capable the browser is', async () => {
		// A deliberate refusal rather than a gap. Nothing in a browser encodes
		// HEVC, and doing it ourselves would carry patent obligations a free
		// tool has no way to meet. HEIC is read-only and always will be, so it
		// must never appear on the writable list even with everything switched
		// on, and a format arriving in the union later must not quietly acquire
		// an encoder either.
		installDefaultCodecs();
		const everything = emptyCapabilities({
			nativeDecode: new Set(['image/heic', 'image/png', 'image/jpeg', 'image/webp', 'image/avif']),
			canvasEncode: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']),
			hevcVideoDecoder: true,
			compressionStream: true,
		});
		expect(await encodersFor('heic', everything)).toEqual([]);
		expect([...(await writableFormats(everything))].sort()).toEqual([
			'apng',
			'avif',
			'bmp',
			'farbfeld',
			'gif',
			'hdr',
			'icns',
			'ico',
			'jpeg',
			'pcx',
			'png',
			'pnm',
			'qoi',
			'ras',
			'tga',
			'tiff',
			'webp',
			'xbm',
			'xpm',
		]);
	});

	it('still reads and writes the pure formats with no browser capability at all', async () => {
		// PNG is left out of both lists on purpose: its pure rungs depend on
		// CompressionStream, which the Node test environment happens to have and
		// an older browser does not, so it is not this test's to assert.
		installDefaultCodecs();
		const capabilities = emptyCapabilities();
		const readable = await readableFormats(capabilities);
		const writable = await writableFormats(capabilities);
		for (const format of [
			'qoi',
			'bmp',
			'tga',
			'pnm',
			'farbfeld',
			'gif',
			'pcx',
			'ras',
			'xbm',
			'xpm',
		] as const) {
			expect(readable.has(format), `${format} readable`).toBe(true);
			expect(writable.has(format), `${format} writable`).toBe(true);
		}
		// Read only by design, and every one of them with no browser involved.
		for (const format of ['psd', 'dds', 'hdr', 'exr', 'icns', 'ico', 'tiff'] as const) {
			expect(readable.has(format), `${format} readable`).toBe(true);
		}
		// Every one of these needs something from the browser and gets nothing.
		// SVG is here because rendering one is the browser's job by definition,
		// and raw is because its preview is a JPEG somebody else has to decode.
		for (const format of ['heic', 'jpeg', 'jxl', 'webp', 'avif', 'svg', 'raw'] as const) {
			expect(readable.has(format), `${format} readable`).toBe(false);
		}
		for (const format of ['jpeg', 'webp', 'avif', 'heic', 'jxl'] as const) {
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
