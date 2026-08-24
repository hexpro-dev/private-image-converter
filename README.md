# private-image-converter

Convert images in the browser, including HEIC from an iPhone, without uploading
them anywhere.

Zero runtime dependencies. There is no server, no upload, and no network call
of any kind. The conversion happens in the tab, and the file the browser saves
was built there.

```bash
pnpm add @hexpro/private-image-converter
```

## Why this exists

An iPhone writes HEIC by default. Most of the web cannot read it. So people
search for a converter, find one that wants an upload, and hand a stranger a
photograph that carries the coordinates of their house and the second they were
standing in it.

Nothing about that conversion requires a server. The browser already has an
HEVC decoder, because it plays video. What is missing is the code to read the
container and hand the picture over, which is what this is.

## Privacy

There is no call to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or
`sendBeacon` anywhere in this package, and nothing is written to
`localStorage`, `sessionStorage`, `indexedDB` or a cookie. The offline build is
checked for all of that by a test that fails the release if any of it appears.

Camera metadata is stripped by default, and the result tells you what was in
there so you can decide:

```ts
result.report.metadata;
// { orientation: 6, hasLocation: true, capturedAt: '2026:08:24 12:30:33',
//   cameraMake: 'Apple', cameraModel: 'iPhone 16 Pro Max', tagCount: 59 }
```

That is a property of the code rather than a promise about intent. The check
worth doing yourself is the simplest one. Turn your connection off and use it
anyway.

## Converting

```ts
import { convert } from '@hexpro/private-image-converter';

const bytes = new Uint8Array(await file.arrayBuffer());
const result = await convert(bytes, { to: 'png' });

result.bytes; // Uint8Array
result.mime; // 'image/png'
result.report.decodePath; // 'webcodecs'
result.report.width; // 3024
```

Failures are typed and carry a message written to be shown to a person as it
is:

```ts
import { isConverterError } from '@hexpro/private-image-converter';

try {
	await convert(bytes, { to: 'webp' });
} catch (error) {
	if (isConverterError(error)) {
		error.code; // 'encode/unsupported'
		error.message; // 'This browser cannot write WebP files. Safari has never supported it...'
	}
}
```

From a `File`, with the output name worked out for you:

```ts
import { convertFile, downloadBlob } from '@hexpro/private-image-converter/dom';

const converted = await convertFile(file, { to: 'jpeg', quality: 0.9 });
downloadBlob(converted.blob, converted.filename); // IMG_2059.jpg
```

## HEIC

A HEIC is HEVC video, intra coded, inside an ISOBMFF container. This package
parses the container itself and hands the compressed picture to whatever can
decode HEVC on the platform, in this order:

| How                                      | Where it works                                             |
| ---------------------------------------- | ---------------------------------------------------------- |
| The browser's own HEIC decoder           | Safari 17 and later                                        |
| Our container reader plus `VideoDecoder` | Chromium with HEVC decode hardware, which is most machines |
| A decoder you register yourself          | Everywhere else                                            |

The first two need nothing installed. Chromium exposes HEVC only where the
hardware exists, which covers roughly 97% of Macs, 86% of Windows machines and
81% of Android devices, and Firefox does not expose it at all. On those,
`convert` throws `UnsupportedHereError` unless a decoder has been registered:

```ts
import { registerDecoder } from '@hexpro/private-image-converter';

registerDecoder({
	id: 'heic-wasm',
	formats: ['heic'],
	path: 'plugin',
	priority: 50, // behind the two built-in rungs
	available: async () => true,
	decode: async (bytes) => ({
		image: await myWasmDecoder(bytes),
		orientation: { rotation: 0, mirror: 'none', source: 'decoder' },
	}),
});
```

`result.report.decodePath` is `'plugin'` when that ran. Say so in your
interface. It is several times slower than the hardware path, and somebody who
is told why is not looking at a tool that seems broken.

A decoder must return an image that is already the right way up. That is the
contract, and it exists because doing it the other way rotated every portrait
photograph twice.

## What it supports

Reading: HEIC, PNG, JPEG, WebP, AVIF, GIF, BMP, ICO, QOI, TGA, PNM, farbfeld.

Writing: PNG, JPEG, WebP, QOI, BMP, TGA, PNM, farbfeld. AVIF where a browser
can, which today is none of them.

PNG is written by this package rather than by a canvas, which means 24 bit
output when there is no alpha to carry, the source ICC profile embedded so a
wide gamut photograph survives, and no canvas size ceiling. On a phone
photograph it comes out smaller than the canvas manages.

Deliberately not supported, as decisions rather than gaps:

- **Writing HEIC.** No browser can, and encoding HEVC carries patent
  obligations a free tool cannot meet.
- **HDR gain maps.** An HDR photograph decodes to its standard range base and
  the report says the gain map was dropped.
- **Interlaced PNG**, HEIF overlays and identity derivations, RLE compressed
  BMP. Each is refused by name.
- **Animation.** Frames are read where a browser reads them. Nothing here
  writes an animated file.

## Colour

An iPhone photograph is in Display P3, not sRGB. Writing those numbers into an
untagged file makes the picture flat, and running the conversion the other way
on something already sRGB oversaturates it by about as much. So the colour
space is detected per image, from the file, and the source ICC profile is
carried into the output where the format can hold one.

By default a wide gamut image stays wide where the target can express it. Pass
`colour: 'srgb'` to narrow it deliberately.

## Sizes

A 48 megapixel photograph is a 195 MB buffer before anything else happens, and
iOS Safari refuses a single canvas above about 16.7 million pixels. The HEIC
path composites its tiles into a plain array and the PNG encoder writes from
that array, so neither needs a canvas and neither hits that ceiling. Paths that
do need one decline rather than fail, so the ladder falls through to one that
does not.

`convert` refuses anything above 80 megapixels by default. Raise it with
`maxPixels` if you know what your users are converting.

## The offline app

`dist/private-image-converter.html` is the whole tool in one file. Open it from
your own disc with the network off. It is built with a Content-Security-Policy
naming the sha256 of its own script and stylesheet, `default-src 'none'` and
`connect-src 'none'`, so the browser refuses to run anything added afterwards
and refuses to let it talk to anything.

## Development

```bash
pnpm install
pnpm test
pnpm build:all
```

The tests use no browser. HEIF containers are assembled byte by byte in
`tests/helpers/heif.ts` and the platform decoder is faked, because what needs
testing is the container reading, the grid assembly and the orientation, none
of which need a codec to be wrong. The codecs are anchored against known-good
bytes from their specifications rather than only against themselves: an encoder
and a decoder written from one misreading agree with each other perfectly.

## Licence

MIT. See `LICENSE`.
