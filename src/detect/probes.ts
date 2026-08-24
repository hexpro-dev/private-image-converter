/**
 * Tiny probe images, used to ask a browser what it can actually decode.
 *
 * Feature detection for image formats has no honest shortcut. There is no
 * `supports()` call for HEIC, the user agent string does not distinguish a
 * Chromium build with HEVC decode hardware from one without, and
 * `ImageDecoder.isTypeSupported` does not exist in Safari, which is the one
 * browser that decodes HEIC natively. So the probe is the real thing: decode a
 * sixteen pixel image and see whether it worked.
 *
 * Provenance, so these are reproducible rather than magic:
 *
 *   probe16.png  a 16x16 RGB gradient, written by hand with zlib
 *   PROBE_HEIC   heif-enc -q 50 -o probe.heic probe16.png     (libheif)
 *   PROBE_AVIF   heif-enc -A -q 50 -o probe.avif probe16.png  (libheif)
 *   PROBE_WEBP   cwebp -q 50 probe16.png -o probe.webp        (libwebp)
 *
 * Base64 rather than byte arrays because it is a third of the size in the
 * bundle, and these ship inside a single file offline build where every
 * kilobyte is one the reader has to download.
 */

export const PROBE_HEIC =
	'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAXxtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoAABAAAAAAAAAFoAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/GlwcnAAAADcaXBjbwAAAHVodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQApQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqrprm4CGgwIAAAAyAAAADAIRiAAEABkQBwXPBiQAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAABAAAAAQAAAAChjbGFwAAAAEAAAAAEAAAAQAAAAAf///9AAAAAC////0AAAAAIAAAAQcGl4aQAAAAADCAgIAAAAGGlwbWEAAAAAAAAAAQABBYECAwWEAAAAYm1kYXQAAABWKAGvEyF3x0D1IZ+DTCv83A9+bLOCobCW26dGnIvmL7Jg7idAzph5vprAnL26mg2mlJl8Pul3AXj44WCsW1Q9q5TTpRI56inXYfYsktkq3dCvHABBDng=';

export const PROBE_AVIF =
	'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAOptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABDgABAAAAAAAAADQAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAamlwcnAAAABLaXBjbwAAAAxhdjFDgQAMAAAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAAAQAAAAEAAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgQIDBAAAADxtZGF0EgAKCRgM/9ogIaDQgDIlGUeHhiGHnnnmhQAAdX+ieVEiyjZPfg/+9YYt+lcTcJo+P+56MA==';

export const PROBE_WEBP =
	'UklGRkoAAABXRUJQVlA4ID4AAAAQAgCdASoQABAAAsBMJbACdH8AGBwAWlbYAP724pGseY2xGEUnWctf9yZPWdx6HWBAG+L/pivz/tml5a6AAA==';

/** The 16 by 16 gradient every probe above encodes. */
export const PROBE_SIZE = 16;

/**
 * Decode base64 without `atob`.
 *
 * `atob` is a DOM global. This module is imported by the capability probes,
 * which are the first thing a host runs, and a host that runs them in Node to
 * pre-compute a capability set should not fail on a missing global.
 */
export function fromBase64(text: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const out: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const character of text) {
		if (character === '=') break;
		const value = alphabet.indexOf(character);
		if (value < 0) continue;
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((buffer >> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
}
