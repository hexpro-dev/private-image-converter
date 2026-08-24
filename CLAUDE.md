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

Every fixture is synthetic. `tests/helpers/heif.ts` assembles HEIF containers
byte by byte from two small constants, and the only compressed payload in the
repository is a 64 by 64 gradient encoded once with `heif-enc`. Nothing under
`tests/` came out of a camera.

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

**A canvas asked for a format it cannot write returns a PNG.** It does not
throw and it does not return null. Safari has never written WebP and does
exactly this, so somebody clicks convert, gets `photo.webp`, and it is a PNG.
Every canvas encode here sniffs the bytes that came back. Do not "simplify"
that away.

**Detect the colour space per image, never in a batch.** An iPhone photograph
decodes to Display P3. Writing those numbers untagged makes the picture flat,
and running the same conversion over something already sRGB oversaturates it by
about as much. On a wide gamut display both mistakes look plausible, so the
check is measurement rather than eye. The source profile is carried through to
the output where the format can hold one.

**`src/heif/**` imports nothing outside itself** except the shared errors,
result and types modules and `src/raster/`. It is a reader for a published ISO
standard and has nothing to do with image conversion, so it stays liftable.
Enforced by ESLint.

**A codec imports no other codec and never the registry.** That is what makes
"adding a format is adding a file" true rather than aspirational. Also enforced
by ESLint.

**No Web Worker in this package.** Converting a large image is genuinely CPU
bound and belongs off the main thread, which is the opposite of what the
sibling QR package concluded about its own work. It is still not here, for two
reasons: a worker created inside this package starts with an empty registry and
would silently lose a host's plugin decoder, which is exactly the browser where
it was needed; and a blob worker is blocked under `file://` in Chrome, where the
offline build has to run. Applications wrap the pure functions themselves.

**`CompressionStream` is the zlib.** It is what makes a real PNG encoder
possible with no dependency. It offers no level control, so the output is a few
percent larger than zopfli would manage and still smaller than the canvas
manages, because the filters are chosen adaptively. That trade is deliberate.

## Adding a format

1. `src/codecs/<name>/encode.ts` and `decode.ts`, importing only `../../types.js`,
   `../../errors.js` and `../../raster/image.js`.
2. Register it in `src/defaults.ts`. Priority is a cost, not a preference: 10
   for the platform's own, 20 for our reader driving the platform, 40 for pure
   TypeScript, 50 and above left free for a host's plugin.
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
- **HDR gain maps.** The standard range base is decoded and the result says the
  gain map was dropped. Silently returning the base of an HDR photograph is
  correct behaviour and the wrong surprise.
- **Animated output.** Frames are read where the browser reads them; nothing
  here writes an animation.

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
