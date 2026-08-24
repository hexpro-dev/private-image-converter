/**
 * CRC-32 as PNG specifies it, and the Adler-32 the zlib wrapper needs.
 *
 * The table is built once at module load: 256 entries, and building it costs
 * less than the first chunk it checksums.
 */

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
	let c = n;
	for (let k = 0; k < 8; k += 1) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	TABLE[n] = c >>> 0;
}

export function crc32(bytes: Uint8Array, seed = 0): number {
	let c = (seed ^ 0xffffffff) >>> 0;
	for (let i = 0; i < bytes.length; i += 1) {
		c = ((TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)) >>> 0;
	}
	return (c ^ 0xffffffff) >>> 0;
}

export function adler32(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	// 5552 is the largest run that cannot overflow a 32 bit accumulator, so the
	// modulo happens once per block rather than once per byte.
	for (let i = 0; i < bytes.length;) {
		const end = Math.min(i + 5552, bytes.length);
		for (; i < end; i += 1) {
			a += bytes[i] as number;
			b += a;
		}
		a %= 65521;
		b %= 65521;
	}
	return ((b << 16) | a) >>> 0;
}
