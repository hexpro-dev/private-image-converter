# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Never commit somebody's photographs

This repository is public and git history is permanent. A phone photograph
carries the coordinates of where it was taken, the second it was taken, the
camera's identifiers and, usually, a person. The EXIF reader in this package
exists precisely because all of that is in there.

So, without exception:

- No real photograph in any file, test, fixture, issue or pull request.
- No screenshot that contains one.
- No "temporary" commit that is reverted later. The reflog keeps it.

Every fixture is synthetic. There are no binary fixture files at all: every
test buffer is built in code from the format's own specification, so the suite
runs on a clean checkout and a wrong expectation shows up in the diff rather
than hiding inside a file nobody can read. `tests/helpers/heif.ts` assembles
HEIF containers byte by byte from two small constants. The only compressed
payloads in the repository are the four capability probes in
`src/detect/probes.ts`, each a 16 by 16 gradient encoded once by the reference
implementation of its format, with the commands recorded above them. Nothing
under `tests/` came out of a camera.

Checking this package against ImageMagick or ffmpeg is the right thing to do
and the way most of the codecs here were verified. Do it in `scratch/`.

Real photographs used for measurement belong in `scratch/`, which is
gitignored, along with `real-*.heic` and friends. Work against a real camera
roll happens there or outside the repository entirely.

Error messages must never interpolate a file name. Somebody's photograph is
called `IMG_2059.HEIC`, but it is just as often called something they would not
want on a screen, and an error message is the one string that gets screenshot
into a bug report.

## What this is

A zero-runtime-dependency package that converts images entirely in the browser,
including HEIC from an iPhone, with no upload.

It ships three things: a library, a browser adapter layer, and a single file
offline HTML application that runs from `file://` with the network off.

The offline application is the flagship deliverable, not a demo. It is what
makes the privacy claim checkable rather than something a reader has to believe.

## Commands

```bash
pnpm typecheck        # tsc --noEmit && tsc -p tsconfig.test.json
pnpm lint             # eslint .
pnpm format:check     # prettier --check
pnpm test             # vitest run
pnpm test:coverage    # with thresholds enforced
pnpm build            # tsc -> dist/
pnpm build:html       # single file offline app -> dist/
pnpm build:all        # both
```

## How HEIC works here, because it is the whole point

A HEIC is HEVC video, intra coded, inside an ISOBMFF container. Writing an HEVC
decoder is a multi-month project and a bad idea. So this package does not have
one. It parses the container, which is ordinary byte reading, and hands the
compressed picture to the decoder the device already has:

| Rung             | What runs                          | Where it works                     |
| ---------------- | ---------------------------------- | ---------------------------------- |
| `heic-native`    | `createImageBitmap`                | Safari 17 and later                |
| `heic-webcodecs` | our parser plus `VideoDecoder`     | Chromium with HEVC decode hardware |
| a host plugin    | whatever the application registers | everywhere else                    |

The first two need no dependency. The third is why Firefox still works, and it
is registered from outside this package because a software HEVC decoder cannot
be written without one.

`ConvertReport.decodePath` says which ran. Surface it. Somebody on the plugin
path is waiting several times longer than somebody on the hardware path, and
telling them why is the difference between a slow tool and a broken one.

## Rules that are not obvious from the code

**Zero runtime dependencies.** `"dependencies": {}` is written out explicitly so
an accidental addition shows in a diff, and CI asserts the count is zero.
devDependencies are fine.

**A decoder returns an image that is already the right way up.** This is a
contract, not a convention. The alternative, where a decoder reports an
orientation for the caller to apply, was tried and produced exactly the bug it
was meant to prevent: the HEIF path applies `irot` while assembling the tile
grid, the converter applied it a second time, and every portrait photograph
came out rotated by 540 degrees. Both halves looked correct in isolation, and
it only showed in a real browser. `DecodeOutput.orientation` reports what was
already done. Never re-apply it.

**A grid is not an optional feature.** Every photograph an iPhone takes is
stored as a grid of 512 by 512 HEVC tiles, padded out to whole tiles and
cropped back by the grid descriptor. A reader that handles only a single `hvc1`
item fails on every real file while passing every naive test.

**The grid descriptor lives in `idat`, not `mdat`.** Its `iloc` entry uses
construction method 1, which means the extent is an offset into the `idat` box
rather than into the file. A reader that assumes method 0 reads eight bytes
from the front of the file and concludes the image is zero by zero tiles.

**`irot` changes the output dimensions.** A quarter turn swaps width and height.
`IMG_2061` in the test notes is stored 4032 by 3024 and must come out 3024 by 4032. This is the regression that catches a dropped rotation.

**EXIF orientation and `irot` are counted in opposite directions.** EXIF counts
clockwise, this package counts anticlockwise, so EXIF value 6 is 270 here and
not 90. Also, every browser applies EXIF orientation while decoding, so
applying it again after a native decode double-rotates. Both mistakes only show
on photographs taken sideways, which is most of them.

**EXIF goes out through `withUprightOrientation`, never straight.** The decoder
contract at the top of this section says the pixels arrive already the right
way up, so the orientation tag that came off the file describes a rotation
which has already happened. Copy the block across unchanged and every
reader honouring that tag rotates the photograph a second time: every portrait
photograph comes out sideways in most viewers and correct in the few that
ignore EXIF, which is the combination nobody catches. `convert` rewrites the
tag to 1 before handing the block to an encoder. It is a two byte overwrite in
place rather than a rebuild, because an EXIF block holds offsets into itself
from directories this reader deliberately does not parse.

**A canvas asked for a format it cannot write returns a PNG.** It does not
throw and it does not return null. Safari has never written WebP and does
exactly this, so somebody clicks convert, gets `photo.webp`, and it is a PNG.
Every canvas encode here sniffs the bytes that came back. Do not "simplify"
that away.

**A canvas cannot be asked with a constant, and cannot be asked once.**
`MAX_CANVAS_AREA` is iOS Safari's 16,777,216 and it is now only the floor below
which no browser is worth asking. Applied everywhere, as the gate on both
ladders, it refused 6000 by 4000 JPEGs on desktop machines with sixteen times
the headroom, and it refused the 24 megapixel photographs recent iPhones shoot
on the phone that shot them. A one-off probe at startup is no better: the
iOS limit is a budget measured across every live surface rather than a fixed
area, so the answer moves with whatever else the tab is holding. `openCanvas`
and `canvasHolds` therefore allocate the real surface, paint one pixel and read
it back. `openCanvas` then hands that surface to the caller and `canvasHolds`
releases it, because the budget counts live canvases and waiting for the
collector would charge the probe against the allocation it was probing for. The
readback is the load bearing part of both. iOS does not throw when it runs out;
it hands back a canvas of exactly the requested size whose pixels are all zero
and accepts every drawing call onto it in silence, so without the readback the
failure is a file full of transparent black rather than an error.

**`SurfaceTooLargeError` is a decline. `ImageTooLargeError` is a refusal.**
Both ladders in `convert` walk past the first and stop on the second, and the
difference is why an iPhone photograph converts at all. Safari's own HEIC
decoder is the top rung and it has to draw the `ImageBitmap` onto a canvas to
read pixels back; the container reader on the rung below never needs one. While
the decline shared a class with the hard ceiling, the ladder stopped on it, the
rung that would have worked was never asked, and the tool refused the exact
file it is named after. Merging the two classes puts that back, and so does
catching `SurfaceTooLargeError` alongside `ImageTooLargeError` in either loop.
Its message says "something else may be able to read it" for the same reason,
since the error only reaches a caller when nothing else could run.

**`Decoder.measure` is for the formats with a decompressor in the middle.**
`maxPixels` checked against the image that came back is not a defence: a four
kilobyte PNG whose IHDR claims 20000 by 15000 has already been handed a
gigabyte-shaped inflate budget by the time anything measures it. PNG, GIF, PSD
and PCX read their headers first through `measure`, before the decompressor is
given a size to work to. The uncompressed readers deliberately do not have one,
and adding it to them is work for nothing: a file cannot declare an image its
own length will not back up, and each of those readers already refuses a header
its own byte count contradicts.

**Detect the colour space per image, never in a batch.** An iPhone photograph
decodes to Display P3. Writing those numbers untagged makes the picture flat,
and running the same conversion over something already sRGB oversaturates it by
about as much. On a wide gamut display both mistakes look plausible, so the
check is measurement rather than eye. The source profile is carried through to
the output where the format can hold one.

**`iccIsWideGamut` exists twice, and that is deliberate.** One copy is in
`src/metadata/icc.ts`, one in `src/heif/image.ts`, because `eslint.config.js`
forbids `src/heif/**` from importing `src/metadata/**` so the container reader
stays liftable into a package of its own. Nine numbers duplicated is cheaper
than taking that fence down. The two must answer identically, and
`tests/metadata/icc.test.ts` imports both and compares them across a table of
profiles, so neither is edited without the other. Both test all three
colourants rather than red alone: any threshold on red that admits Display P3
also admits Adobe RGB, ProPhoto and Rec.2020, whose reds sit further out again,
and those files were then given a Display P3 readback and had their own profile
written verbatim beside the new numbers. P3 pixels tagged Adobe RGB renders
wrong in every colour managed viewer and right in everything that ignores
profiles, which is what got it past a review.

**`src/heif/**` imports nothing outside itself** except the shared errors,
result and types modules and `src/raster/`. It is a reader for a published ISO
standard and has nothing to do with image conversion, so it stays liftable.
Enforced by ESLint.

**A codec never imports the registry, the DOM layer or the app.** That is what
makes "adding a format is adding a file" true rather than aspirational: a codec
that reached into the registry would make the dispatcher's import graph cyclic.
Enforced by ESLint. Importing another codec's pure function is fine and several
do it: an Apple icon suite and a modern ICO both hold PNG entries and unpack
them with `../png/decode.js`, and a Deflate compressed TIFF or PSD inflates
with `../png/deflate.js`. Refusing those imports is what left `decodeIco`
rejecting every favicon written since Vista, including the ones this package
writes.

**No Web Worker in this package.** Converting a large image is genuinely CPU
bound and belongs off the main thread, which is the opposite of what the
sibling QR package concluded about its own work. It is still not here, for two
reasons: a worker created inside this package starts with an empty registry and
would silently lose a host's plugin decoder, which is exactly the browser where
it was needed; and a blob worker is blocked under `file://` in Chrome, where the
offline build has to run. Applications wrap the pure functions themselves.

**Claim the rejections from a compression stream.** `pump` in
`src/codecs/png/deflate.ts` writes, closes and reads three separate promises
and only awaits the read, which is deliberate: awaiting the write deadlocks on
anything larger than the stream's queue. A corrupt stream rejects all three,
and the two nobody holds became unhandled rejections, which in Node ends the
process and in a browser fires at the page. A decoder that correctly reported a
damaged file used to take the tab with it, on about one malformed input in
twenty. Both now carry a `.catch`.

**TIFF's LZW widens its codes one step early.** The switch to ten bits happens
at 511 rather than 512, unlike every other LZW in this repository. Getting it
wrong produces plausible garbage rather than an error. GIF's LZW is the other
convention and is also least-significant-bit first, where TIFF's is most
significant. Two LZW implementations, deliberately.

**EXR stores its channels in alphabetical order.** A comes before B comes
before G comes before R, whatever order you wanted them in. Then RLE, ZIPS and
ZIP all end with the same two step postprocess: undo a byte level delta
predictor, then undo an interleave where the first half of the buffer holds the
even output bytes. Both steps, in that order, for all three. These are the two
most common EXR bugs and neither produces an error.

**A Photoshop composite is already matted onto white.** The flattened image in
a PSD stores colour that has been composited against the matte, with the alpha
beside it, so reading those bytes as straight alpha lightens every soft edge.
`unmatte` in the PSD decoder undoes it. This was found by measuring a real file
rather than by reading the specification, which does not say so.

**Animation frames are whole pictures, not patches.** GIF and APNG both store a
dirty rectangle with a disposal rule and a blend rule, and the two disagree
about what restoring to background means. The disagreement is settled once, in
each reader, and `Animation.frames` carries composited full frames. An encoder
that received patches would have to reimplement both rule sets.

**WebCodecs and this package disagree about what zero loops means.**
`ImageTrack.repetitionCount` counts repeats: `0` is a file that plays once and
`Infinity` is one that plays forever. `Animation.loopCount` counts plays and
spells forever as `0`, because every container on disk does, which is why the
pure GIF reader returns 1 for a file with no `NETSCAPE` extension in it. The
two agree on 5 and mean opposite things at 0, and `loopCountFrom` in
`src/codecs/native/animated.ts` is the single place the translation happens.
Copying the number straight across is what the code used to do, and a play-once
GIF looped forever in Chrome while the pure reader beside it, which runs
wherever `ImageDecoder` is missing, returned 1 for the same bytes. Nothing
threw and every frame was correct, which is why it survived. `loopCountFrom` is
exported purely so the translation can be tested; the rung around it needs a
browser and is excluded from coverage, so those tests are the only thing
holding it.

**`CompressionStream` is the zlib.** It is what makes a real PNG encoder
possible with no dependency. It offers no level control, so the output is a few
percent larger than zopfli would manage and still smaller than the canvas
manages, because the filters are chosen adaptively. That trade is deliberate.

**A `write()` that has resolved has not read your buffer yet.** Node's
compression stream queues the chunk and reads it when it gets round to it, so a
caller that fills one scratch buffer, writes it, and refills it for the next
batch hands the compressor whatever the buffer happened to hold at that moment.
The PNG encoder allocates a fresh buffer per batch for exactly this reason, and
"reuse the buffer, it is about to be overwritten anyway" is the tidy-up that
corrupts the middle of a file with no error anywhere. It passes every round
trip test whose image fits in a single batch, which is all of the small ones.

**Tone mapping belongs to the encoder, never the decoder.** Radiance and
OpenEXR readers hand back `FloatImage`, and `convert` reduces it only when the
destination cannot hold it. This was the other way round once, and the cost was
that an EXR going to a Radiance file went through eight bits in the middle,
losing the range both formats exist for, while `tone` had nothing to act on
because the exposure had already been chosen inside the reader. A decoder that
calls `toneMap` is reintroducing that bug.

**`decodeTiffFloat` refuses on sight, and both refusals earn their place.**
`convert` runs the light ladder ahead of the ordinary one for every decoder
that offers a `decodeFloat`, so every TIFF of any kind passes through this
function first. The sample format test therefore sits above `readPage` and
`readSamples` rather than inside them: moved down, an ordinary integer TIFF is
parsed twice on its way to being decoded once, on the commonest job this reader
has. The second refusal is the one that looks removable. A float TIFF whose
samples never pass 1 is a display picture that happens to be stored in floats,
which is what a compositor writes as a final frame, and handing that on as
light meters it against 0.18 and brings it back several stops too bright.
Neither refusal reaches a user, because `convert` catches it and falls through
to `decode`.

**A gain map's parameter block is bytes, never fields.** `GainMap.metadata` is
the ISO 21496-1 block exactly as the source stored it, and it is copied into
the output without being parsed. Every value that defines how the photograph
displays lives in there, so carrying it unchanged reproduces it exactly, and
reading it in order to write it back could only introduce error. Do not add a
parser for it. If a future format needs different fields, transcode at that
boundary and leave this one alone.

**Ten bit AV1 is refused by every browser tested.** `av01.0.04M.10` reports
unsupported under `no-preference`, `prefer-software` and `prefer-hardware`
alike, so the AVIF written here is eight bit and there is no PQ or HLG output.
Probe for eight bit only: asking for ten concludes AVIF cannot be written at
all, when it can. A gain map does not need more than eight bits, which is why
an HDR photograph still survives.

**The gain map goes out as three channels.** `VideoEncoder` has no way to ask
for monochrome AV1, so a gain map is encoded as a grey 4:2:0 picture while its
parameter block still says single channel. Chroma subsampling is lossless on a
grey image, so the luma plane is the gain map exactly, and a reader taking the
first channel gets what it expects. It costs some bytes and no accuracy.

**An OpenEXR dataWindow is inclusive at both ends.** A 4 by 3 image has
`xMax` 3 and `yMax` 2. Writing the width there produces a file every reader
rejects, and it is the first thing to check when one does.

**Verifying a float format against ffmpeg needs care.** ffmpeg's swscale
clamps to 0 to 1 when it converts between float pixel formats, so reading a
half float EXR out as `gbrpf32le` shows every value above white pinned at 1
and looks exactly like an encoder bug. Ask for `gbrpf16le`, which is the
decoder's native output and involves no conversion. The Radiance path decodes
straight to `gbrpf32le` and is not affected.

## Adding a format

1. `src/codecs/<name>/encode.ts` and `decode.ts`, importing only `../../types.js`,
   `../../errors.js` and `../../raster/image.js`.
2. Register it in `src/defaults.ts`. Priority is a cost, not a preference: 8
   for the platform's frame decoder, 10 for the platform's own decoder, 20 for
   our reader where it knows something the platform's does not, 30 for the
   platform standing in behind one of those, 40 for pure TypeScript, 45 for a
   last resort that pulls a picture out of a container nothing here decodes,
   and 50 and above left free for a host's plugin. `tests/registry.test.ts`
   carries the whole inventory written out, so a new codec is a line there too,
   which is the moment to say what rung it is on and why.
3. Add it to `FORMATS` in `src/formats.ts` and to the `FormatId` union, which
   will produce compile errors everywhere a decision has to be made about it.
   That is the point.
4. Add a signature to `src/detect/sniff.ts` unless the format has none.
5. Tests in `tests/codecs/<name>.test.ts`, with at least one assertion against
   known-good bytes rather than only a round trip through your own code.

Deliberate refusals, which are decisions rather than gaps waiting to be filled:

- **Writing HEIC.** Nothing in a browser can, and encoding HEVC carries patent
  obligations that a free tool has no way to meet.
- **Interlaced PNG**, overlay and identity derived HEIF images, and RLE
  compressed BMP. Each is refused by name with a message saying so.
- **Rewriting a gain map's parameters.** The block is copied into AVIF, which
  uses the same specification, and is not parsed on the way. Anywhere else the
  standard range base is written and the report says the gain map was dropped,
  which is a complete photograph rather than a broken one and still the wrong
  surprise to leave unannounced.
- **Writing PSD or DDS.** Reading one is a service to somebody who has the
  file. Writing one badly is a file they discover is wrong a month later.
  Radiance and OpenEXR are written, because both are simple enough to write
  correctly and because losing the range on the way out is the failure this
  package exists to avoid.
- **Developing a camera raw.** The embedded preview is extracted, which is the
  camera's own rendering. Demosaicing, white balancing and profiling a sensor
  is a different project and the module comment says so.
- **BC6H and BC7 in DDS**, JPEG 2000 entries in an Apple icon suite, tiled,
  deep and multi-part OpenEXR, BigTIFF, YCbCr and Lab TIFF, and the 1, 4 and 8
  bit indexed entries in an old Apple icon. Each is refused by name.

Widening the scope widens the surface of a tool that reads untrusted files from
strangers. Make the case before writing the code.

## Style

Tabs. Single quotes. Named exports, no default exports. `.js` extensions on
relative imports (NodeNext). Explicit `import type`. Comments explain why, not
what. Australian English in prose and in identifiers, so `colour` and
`binarise` rather than the American spellings.

No em dashes or en dashes as prose punctuation, no decorative emoji, and none
of the usual marketing register ("unlock", "seamless", "robust", "empower",
"effortless", "leverage" as a verb). This applies to the README, the offline
application's copy and every error message, which are all user facing.
