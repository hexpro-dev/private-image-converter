import { describe, expect, it } from 'vitest';
import { hevcCodecString, parseProperty } from '../../src/heif/properties.js';
import type { HevcConfigProperty } from '../../src/heif/properties.js';
import { walkBoxes } from '../../src/heif/boxes.js';
import { HeifMalformedError } from '../../src/errors.js';
import { SAMPLE_HVCC, ascii, box, fullBox, u16, u32, u8 } from '../helpers/heif.js';

/** Parse a single property box built here, the way `ipco` holds them. */
function parseOne(bytes: Uint8Array) {
	const [first] = [...walkBoxes(bytes, 0, bytes.length, 'item-properties')];
	if (!first) throw new Error('the fixture is not a box');
	return parseProperty(bytes, first);
}

describe('spatial extent', () => {
	it('reads the width and height a FullBox carries after its version', () => {
		// ispe is a FullBox, so the two dimensions start four bytes in. Reading
		// them from the payload start yields the version and flags as a width.
		const property = parseOne(fullBox('ispe', 0, 0, u32(4032), u32(3024)));
		expect(property).toEqual({ kind: 'ispe', width: 4032, height: 3024 });
	});
});

describe('rotation', () => {
	it.each([
		[0, 0],
		[1, 90],
		[2, 180],
		[3, 270],
	])('reads a stored value of %i as %i degrees anticlockwise', (stored, degrees) => {
		// irot counts anticlockwise, which is the opposite of EXIF. Getting the
		// direction wrong turns a portrait photograph the wrong way and looks
		// exactly as wrong as not turning it at all.
		const property = parseOne(box('irot', u8(stored)));
		expect(property).toEqual({ kind: 'irot', rotation: degrees });
	});

	it('ignores the reserved bits above the angle', () => {
		expect(parseOne(box('irot', u8(0xfe)))).toEqual({ kind: 'irot', rotation: 180 });
	});
});

describe('mirroring', () => {
	it('reads axis 0 as a flip about a vertical axis, which is left to right', () => {
		// The specification names the axis, not the direction of travel, and the
		// two read as opposites in English.
		expect(parseOne(box('imir', u8(0)))).toEqual({ kind: 'imir', mirror: 'horizontal' });
	});

	it('reads axis 1 as a flip about a horizontal axis', () => {
		expect(parseOne(box('imir', u8(1)))).toEqual({ kind: 'imir', mirror: 'vertical' });
	});
});

describe('the HEVC decoder configuration', () => {
	it('keeps the record verbatim, because WebCodecs takes it as it is', () => {
		// Rebuilding it from the parsed fields would mean round tripping every
		// field correctly, including the ones this parser ignores, for nothing.
		const property = parseOne(box('hvcC', SAMPLE_HVCC));
		expect(property.kind).toBe('hvcC');
		if (property.kind !== 'hvcC') return;
		expect(property.raw).toEqual(SAMPLE_HVCC);
	});

	it('finds the NAL length prefix size eight bytes after the level', () => {
		// The fixed fields between the level indicator and this byte are eight
		// long, not six. Miscounting lands the length size on the average frame
		// rate, which reads as a one byte prefix and no parameter sets at all,
		// so a perfectly good file looks like it carries no configuration.
		const property = parseOne(box('hvcC', SAMPLE_HVCC));
		expect(property.kind).toBe('hvcC');
		if (property.kind !== 'hvcC') return;
		expect(property.lengthSize).toBe(4);
		expect(property.parameterSets).toHaveLength(3);
	});

	it('reads the profile, tier and level out of their packed bits', () => {
		const property = parseOne(box('hvcC', SAMPLE_HVCC));
		expect(property.kind).toBe('hvcC');
		if (property.kind !== 'hvcC') return;
		// Apple writes Main Still Picture, which is profile 3.
		expect(property.profileIdc).toBe(3);
		expect(property.profileSpace).toBe(0);
		expect(property.tierFlag).toBe(0);
		expect(property.constraintFlags).toHaveLength(6);
	});
});

describe('colour', () => {
	it('reads an nclx block, where 12 is Display P3', () => {
		// ITU-T H.273 table 2. This is the number that decides whether an
		// iPhone photograph keeps its colour or comes out flat.
		const property = parseOne(box('colr', ascii('nclx'), u16(12), u16(13), u16(6), u8(0x80)));
		expect(property).toEqual({
			kind: 'colr',
			type: 'nclx',
			primaries: 12,
			transfer: 13,
			matrix: 6,
			fullRange: true,
		});
	});

	it('reads the full range flag from the top bit and nothing else', () => {
		const property = parseOne(box('colr', ascii('nclx'), u16(1), u16(13), u16(6), u8(0x7f)));
		expect(property.kind === 'colr' && property.fullRange).toBe(false);
	});

	it('keeps an ICC profile whole, under either of its two type codes', () => {
		const profile = Uint8Array.from([1, 2, 3, 4, 5]);
		for (const type of ['prof', 'rICC']) {
			const property = parseOne(box('colr', ascii(type), profile));
			expect(property.kind).toBe('colr');
			if (property.kind !== 'colr') continue;
			expect(property.type).toBe('icc');
			expect(property.iccProfile).toEqual(profile);
		}
	});

	it('refuses a colour type it does not know rather than guessing', () => {
		// Guessing here would mean deciding a gamut from nothing, and both
		// possible wrong answers change how the picture looks.
		expect(() => parseOne(box('colr', ascii('zzzz'), u8(0)))).toThrow(HeifMalformedError);
	});
});

describe('the remaining properties', () => {
	it('reads the bit depth of each channel', () => {
		expect(parseOne(fullBox('pixi', 0, 0, u8(3), u8(8, 8, 8)))).toEqual({
			kind: 'pixi',
			bitsPerChannel: [8, 8, 8],
		});
	});

	it('reads an auxiliary type, which is how an alpha plane announces itself', () => {
		const urn = 'urn:mpeg:hevc:2015:auxid:1';
		const property = parseOne(fullBox('auxC', 0, 0, ascii(urn), u8(0)));
		expect(property).toEqual({ kind: 'auxC', auxType: urn });
	});

	it('reads a clean aperture as four rationals', () => {
		const property = parseOne(
			box('clap', u32(4032), u32(1), u32(3024), u32(1), u32(0), u32(1), u32(0), u32(1)),
		);
		expect(property).toEqual({
			kind: 'clap',
			width: 4032,
			height: 3024,
			horizontalOffset: 0,
			verticalOffset: 0,
		});
	});

	it('refuses a clean aperture that divides by zero', () => {
		expect(() =>
			parseOne(box('clap', u32(4032), u32(0), u32(3024), u32(1), u32(0), u32(1), u32(0), u32(1))),
		).toThrow(HeifMalformedError);
	});

	it('reads content light level, which is how an HDR file announces itself', () => {
		expect(parseOne(box('clli', u16(203), u16(64)))).toEqual({
			kind: 'clli',
			maxContentLightLevel: 203,
			maxPictureAverageLightLevel: 64,
		});
	});

	it('keeps an unknown property as a placeholder rather than dropping it', () => {
		// ipma indexes into the property list by position, so a property this
		// reader does not understand still has to occupy its slot. Dropping it
		// shifts every later index and hands items somebody else's rotation.
		expect(parseOne(box('zzzz', u8(1, 2, 3)))).toEqual({ kind: 'other', type: 'zzzz' });
	});
});

describe('the codec string', () => {
	function config(overrides: Partial<HevcConfigProperty> = {}): HevcConfigProperty {
		return {
			kind: 'hvcC',
			raw: new Uint8Array(0),
			profileSpace: 0,
			tierFlag: 0,
			profileIdc: 1,
			profileCompatibilityFlags: 0x60000000,
			constraintFlags: Uint8Array.from([0xb0, 0, 0, 0, 0, 0]),
			levelIdc: 93,
			lengthSize: 4,
			parameterSets: [],
			...overrides,
		};
	}

	it('matches the form a browser accepts', () => {
		// hvc1.1.6.L93.B0 is the string in every WebCodecs example, and it is
		// what this configuration has to produce for the check to mean anything.
		expect(hevcCodecString(config())).toBe('hvc1.1.6.L93.B0');
	});

	it('reverses the compatibility bits, as ISO/IEC 14496-15 Annex E requires', () => {
		// Written most significant bit first the same input gives 60000000
		// rather than 6. A browser rejects that, which reads as "this machine
		// has no HEVC support" rather than as the bug it is.
		expect(hevcCodecString(config({ profileCompatibilityFlags: 0x80000000 }))).toBe(
			'hvc1.1.1.L93.B0',
		);
	});

	it.each([
		[1, 'A'],
		[2, 'B'],
		[3, 'C'],
	])('prefixes profile space %i with %s', (space, letter) => {
		expect(hevcCodecString(config({ profileSpace: space }))).toContain(`.${letter}1.`);
	});

	it('marks the high tier with H rather than L', () => {
		expect(hevcCodecString(config({ tierFlag: 1, levelIdc: 120 }))).toContain('.H120');
	});

	it('drops trailing zero constraint bytes and keeps interior ones', () => {
		// The specification says trailing zeroes are omitted. A zero between two
		// set bytes is not trailing and has to survive.
		expect(hevcCodecString(config({ constraintFlags: new Uint8Array(6) }))).toBe('hvc1.1.6.L93');
		expect(
			hevcCodecString(config({ constraintFlags: Uint8Array.from([0xb0, 0, 0x0c, 0, 0, 0]) })),
		).toBe('hvc1.1.6.L93.B0.0.C');
	});

	it('writes Apple Main Still Picture the way the probe expects', () => {
		// The capability probe asks about this exact profile, so the two have to
		// agree or a machine that can decode reports that it cannot.
		expect(
			hevcCodecString(
				config({ profileIdc: 3, profileCompatibilityFlags: 0x70000000, levelIdc: 90 }),
			),
		).toBe('hvc1.3.e.L90.B0');
	});
});

describe('property boxes as they arrive from a file', () => {
	it('parses each child of an ipco in order', () => {
		const ipco = box(
			'ipco',
			fullBox('ispe', 0, 0, u32(64), u32(64)),
			box('hvcC', SAMPLE_HVCC),
			box('irot', u8(1)),
		);
		const [container] = [...walkBoxes(ipco, 0, ipco.length, 'item-properties')];
		const kinds = [...walkBoxes(ipco, container!.bodyStart, container!.end, 'item-properties')].map(
			(child) => parseProperty(ipco, child).kind,
		);
		expect(kinds).toEqual(['ispe', 'hvcC', 'irot']);
	});
});
