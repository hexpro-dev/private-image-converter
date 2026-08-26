# private-image-converter

Convert images in the browser, including HEIC from an iPhone, without uploading
them anywhere. Twenty-six formats, including the awkward ones: TIFF, Photoshop,
DDS, OpenEXR, Radiance HDR, Apple icon suites and the preview inside a camera
raw file.

An HDR photograph off a phone stays an HDR photograph when it becomes an AVIF,
and an OpenEXR keeps its full range when it becomes a Radiance file. Both are
usually the first thing a converter throws away.

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

Keeping it is a choice somebody makes rather than the default. The Metadata
section below says which output formats can carry a block and what the report
says when the one you chose cannot.

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

The rungs are tried in order, and they also decline to each other. The
browser's own decoder returns an `ImageBitmap`, and the only way to get pixels
out of one is to draw it onto a canvas, which on a phone will not hold a 24
megapixel photograph. So that rung declines with `codec/surface-too-large`, and
the container reader below it assembles the same photograph into a plain array
with no canvas anywhere. That is the difference between a recent iPhone
photograph converting and being refused: while the decline shared an error
class with the tool's own size ceiling it stopped the ladder instead, and the
rung that would have worked was never asked.

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

Transparency is a second picture. A HEIC keeps its alpha as a separate
monochrome image tied to the photograph by an `auxl` reference, so a sticker,
an exported logo or a screenshot with rounded corners has two coded images in
it. Both are decoded and the alpha is applied to the picture. A plane that is
malformed, or a different size from the photograph, is let go of rather than
allowed to refuse the file, and `report.droppedAlpha` says that happened.
Safari's own decoder composites the alpha itself, so on that rung there is
nothing left to do.

## What it supports

|                       | Reads                                                      | Writes                                |
| --------------------- | ---------------------------------------------------------- | ------------------------------------- |
| Everyday              | PNG, JPEG, WebP, AVIF, GIF, BMP, TIFF                      | PNG, JPEG, WebP, AVIF, GIF, BMP, TIFF |
| Phone and camera      | HEIC, JPEG XL, camera raw                                  |                                       |
| Animated              | GIF, APNG, animated WebP and AVIF                          | GIF, APNG, WebP                       |
| Icons                 | ICO, CUR, Apple icon suites                                | ICO, Apple icon suites                |
| Design and games      | Photoshop PSD and PSB, DDS                                 |                                       |
| High dynamic range    | Radiance HDR, OpenEXR                                      | Radiance HDR, OpenEXR                 |
| Exchange and archival | QOI, TGA, PNM and PAM, farbfeld, PCX, Sun raster, XBM, XPM | the same list                         |
| Vector                | SVG, rasterised by the browser                             |                                       |

Most of that is pure TypeScript over bytes and runs with no browser at all. The
exceptions are the ones that have to be: JPEG, WebP, AVIF and JPEG XL are the
browser's own decoders, SVG is the browser's renderer, and HEIC is the device's
video decoder driven by a container parser here.

Writing AVIF is the same arrangement in reverse. An AVIF is one AV1 keyframe in
a HEIF container, so the container is written here and the frame comes from the
browser's `VideoEncoder`. It needs a browser with an AV1 encoder, which Chrome
and Edge have and Safari and Firefox do not yet, and `report.encodePath` says
`webcodecs` when it ran.

PNG is written by this package rather than by a canvas, which means 24 bit
output when there is no alpha to carry, an indexed palette when the picture has
few enough colours for that to be lossless, the source ICC profile embedded so
a wide gamut photograph survives, an `eXIf` chunk when metadata was asked for,
and no canvas size ceiling. On a phone photograph it comes out smaller than the
canvas manages.

### Animation

An animated GIF converted to APNG keeps every frame, and so does the reverse.
Frames arrive already composited, so the disposal and blend rules the two
formats disagree about are settled once in the reader rather than in every
encoder.

```ts
const result = await convert(gifBytes, { to: 'apng' });
result.report.frames; // 12
```

Animated WebP is written as well, and the cost of it is worth knowing before
somebody compares the output with `cwebp`'s. No browser writes an animated WebP
from a canvas, so each frame is encoded here as an ordinary still and the
container is assembled around them. Every frame is therefore a keyframe, where
a purpose-built encoder stores most frames as the difference from the one
before, and on a mostly static animation that difference is large. The file is
still a fraction of the GIF it usually came from, because even a keyframe-only
WebP is a modern lossy codec against 256 colours and LZW. It needs a browser
whose canvas writes WebP, which Chromium and Firefox do and Safari does not,
and on Safari no WebP comes out at all, animated or still.

Converting to a format that cannot animate keeps the first frame and says so
with `report.droppedFrames`, rather than dropping eleven frames in silence.
Pass `frames: 'first'` to ask for a still on purpose.

### Camera raw

A raw file holds sensor data that has to be demosaiced, white balanced and tone
mapped before it is a photograph, and none of that happens here. What this does
is find the full size JPEG the camera itself embedded and hand it over, which
is what somebody asking to turn a CR2 into a JPEG actually wants. It covers
DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF and SRW, and it falls back to
scanning for the largest complete JPEG in the file, so an unusual one still
works.

### High dynamic range

There are two unrelated things called HDR here and they are kept apart.

**Radiance and OpenEXR** store linear light with no ceiling, and that light is
carried as light for as long as anything downstream can use it. Converting an
EXR to a Radiance file, or the reverse, keeps the range: a sample at 12000 is
still 12000 at the other end, within what the destination's own precision can
hold.

```ts
const radiance = await convert(exrBytes, { to: 'hdr' });
radiance.report.highDynamicRange; // true
radiance.report.toneMapped; // undefined, nothing was reduced
```

Reducing it only happens when the destination cannot hold it. Clipping at white
turns every window into a flat shape and scaling by the maximum turns the
picture black, so the exposure is metered off the image the way a camera meters
one and the highlights roll off rather than clipping. Because that now happens
at the encoder rather than inside the reader, the exposure is yours to set:

```ts
const png = await convert(exrBytes, { to: 'png', tone: { stops: -2 } });
png.report.toneMapped; // true
png.report.exposureStops; // -2
```

A floating point TIFF is read as light as well, and only when its samples
actually pass 1. A float TIFF bounded by 1 is a display picture that happens to
be stored in floats, which is what a compositor writes out as a final frame,
and metering one of those against middle grey hands back a photograph several
stops too bright. It is read the ordinary way instead.

**An HDR photograph from a phone** is a different thing: an ordinary picture
plus a second, smaller one saying how much brighter each part of it should get,
and a short parameter block saying how to read the second against the headroom
of whatever screen is showing it. Converting one to AVIF keeps all three, so
the photograph still displays as HDR:

```ts
const avif = await convert(heicBytes, { to: 'avif' });
avif.report.gainMap; // 'kept'
```

The parameter block is copied across unread. Every value that defines the
photograph lives in it, so carrying the bytes unchanged reproduces the picture
exactly, while parsing them in order to write them back could only introduce
error. Converting the same file to PNG reports `gainMap: 'dropped'` and hands
back the standard range base, which is a complete photograph rather than a
broken one.

Deliberately not supported, as decisions rather than gaps:

- **Writing HEIC.** No browser can, and encoding HEVC carries patent
  obligations a free tool cannot meet.
- **Writing PSD or DDS.** Reading one is a service. Writing one badly is a
  file somebody discovers is wrong a month later.
- **Ten bit AVIF**, and so PQ and HLG output. Every Chromium tested refuses a
  ten bit AV1 configuration under all three acceleration preferences, so the
  AVIF written here is eight bit. A gain map does not need more than that,
  which is why the photograph above survives anyway.
- **BC6H and BC7 in DDS**, JPEG 2000 entries in an Apple icon, tiled and deep
  OpenEXR, BigTIFF, YCbCr and Lab TIFF, and the 1, 4 and 8 bit indexed entries
  in an old Apple icon. Each is refused by name rather than approximated.
- **Interlaced PNG**, HEIF overlays and identity derivations, RLE compressed
  BMP. Each is refused by name.

## Metadata

EXIF is read from JPEG, PNG, TIFF and HEIC. It is stripped by default, which is
what somebody converting a photograph to put on the internet wants, and
`report.metadata` says what was in the file so an interface can name it instead
of saying "metadata". A WebP's block is read by the same code, but a browser
with `ImageDecoder` sends every WebP to its frame decoder, which does not hand
the block over, so do not count on WebP metadata in Chromium.

Ask for it back with `metadata: 'preserve'`:

```ts
const result = await convert(jpegBytes, { to: 'png', metadata: 'preserve' });
result.report.metadataKept; // 'kept'
```

Three output formats here can hold an EXIF block: PNG in an `eXIf` chunk, TIFF
in its own directories, and AVIF as an `Exif` item with a `cdsc` reference back
to the picture. Everything else writes the picture and nothing beside it. JPEG
and WebP go out through the browser's canvas encoder, which strips metadata
whether you meant it to or not, so `metadata: 'preserve'` into a JPEG reports
`metadataKept: 'stripped'`. It is reported from what the encoder that actually
ran declared it can carry, not from what was asked for, because a setting that
quietly does nothing is worse than one that says so.

The orientation tag is rewritten to 1 on the way out. Every decoder here hands
back pixels that are already upright, so carrying the source's orientation
across would tell the next reader to rotate a photograph that has already been
rotated. Nothing else in the block is touched, and a block with no orientation
tag in it is copied as it came.

An ICC colour profile is not metadata for this purpose and is carried
regardless of the setting. It describes how to read the pixels rather than who
took them, and dropping it would change how the picture looks. That is the
next section.

## Colour

An iPhone photograph is in Display P3, not sRGB. Writing those numbers into an
untagged file makes the picture flat, and running the conversion the other way
on something already sRGB oversaturates it by about as much. So the colour
space is detected per image, from the file, and the source ICC profile is
carried into the output where the format can hold one.

The test for a wide gamut profile checks all three colourants rather than red
alone. Adobe RGB, ProPhoto and Rec.2020 all have a red primary further out than
Display P3's, so a threshold on red admits them too, and an Adobe RGB
photograph then gets a P3 readback and its own profile written verbatim beside
the new numbers: P3 pixels tagged Adobe RGB. Every colour-managed viewer
honours that tag and pulls the picture towards a gamut it was never in, and
anything that ignores profiles shows it correctly, which is what lets the file
past a review.

By default a wide gamut image stays wide where the target can express it. Pass
`colour: 'srgb'` to narrow it deliberately.

## Sizes

`convert` refuses anything above 80 megapixels by default. Raise or lower that
with `maxPixels`. Where a format states its dimensions in a header sitting in
front of a decompressor, the claim is checked before the decompressor is handed
a budget shaped by it, so a four kilobyte PNG whose header declares 20000 by
15000 is a sentence rather than a gigabyte allocation. PNG, GIF, PSD and PCX
read their headers that way. The formats that store pixels plainly do not need
to, because a file cannot declare an image its own length will not back up.

Under that ceiling the binding limit is the drawing surface, and it is not a
constant. iOS Safari holds far less than desktop Chrome, and what it holds is a
budget across every live canvas rather than a fixed area, so it moves with
whatever else the tab is doing. Nothing here guesses at it. A path that needs a
canvas allocates one, paints a pixel and reads it back, because iOS does not
throw when it runs out: it hands back a canvas of the size you asked for whose
pixels are all zero, and accepts every drawing call onto it in silence.

A path that cannot get the surface it needs declines with
`codec/surface-too-large` and the ladder walks past it to a path that needs no
canvas. The HEIC container reader composites its tiles into a plain array and
the PNG encoder writes from that array, so a 24 megapixel iPhone photograph
converts on the phone that took it even though a canvas there could not hold
it. That code only reaches a caller when nothing else could run either, and
even then it is a decline rather than a verdict on the file. Convert it again
with `resize`, which is what the message says.

### Resizing

`resize` caps the longest side and keeps the aspect ratio. It never upscales:
asking for a longer side than the picture has leaves it alone.

```ts
const result = await convert(bytes, { to: 'jpeg', resize: { longestSide: 2048 } });
result.report.width; // 2048
result.report.resizedFrom; // { width: 8064, height: 6048 }
```

One number rather than a width and a height, because a portrait photograph and
a landscape one both want "no bigger than this" and asking for both invites the
stretch nobody wants. It runs before the alpha flatten and the gamut narrow so
those walk the smaller picture, and it runs per frame for an animation.
`report.resizedFrom` is absent when nothing moved, so an interface tests for
the field rather than comparing two pairs of numbers to find there is nothing
to say.

A 48 megapixel photograph is a 195 MB buffer before anything else happens, and
that is the number `resize` exists for. Probing the canvas hands a desktop
browser back the headroom a constant was taking off it, and the container
reader gets a phone photograph past a surface that could not hold it. Neither
of those makes a 48 megapixel picture cheap on a phone. Making it smaller does.

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
