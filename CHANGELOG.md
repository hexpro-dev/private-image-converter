# Changelog

## Unreleased

First working version. Nothing has been published yet.

### The HEIC path

Reads the ISOBMFF container in TypeScript and hands the compressed picture to
the platform's own HEVC decoder, so an iPhone photograph converts with no
runtime dependency at all. Three rungs, tried in order of what they cost the
person waiting: Safari's own HEIC decoder, our reader driving `VideoDecoder`
where the machine has HEVC decode hardware, and a decoder the host application
registers. `ConvertReport.decodePath` says which one ran.

Verified against a real camera roll during development: the assembled output
matched the reference exports produced by the phone itself to a maximum
difference of 1 in 255, with every pixel within 2.

### Photographs a canvas cannot hold

**A 24 megapixel iPhone photograph converts on Safari.** Recent iPhones shoot
24 megapixels by default and a canvas on iOS holds about 16.7. That number was
applied to every browser as a constant and used as the gate on both the decode
and the encode side. Safari's own HEIC decoder is the top rung of the ladder
and it needs a canvas, because drawing the `ImageBitmap` is the only way to get
pixels back out of one. It declined by throwing `ImageTooLargeError`, which
`convert` treats as fatal, since an image past the tool's own ceiling is past
it on every rung. So the container reader below it, which needs no canvas at
all, was never asked, and the tool refused the exact file it exists to open.
The decline now has a class of its own, `SurfaceTooLargeError`, carrying the
code `codec/surface-too-large`, and the ladder walks past it.

**Desktop browsers got their headroom back.** The constant was iOS Safari's,
the smallest of any browser, and desktop Chrome holds roughly sixteen times as
much, so 6000 by 4000 JPEGs were being refused on machines with 64 gigabytes of
memory. The browser is asked now instead of assumed: `openCanvas` allocates the
surface, paints one pixel and reads it back. That round trip is not caution for
its own sake. iOS does not throw when it runs out, it hands back a canvas of
the size you asked for whose pixels are all zero and accepts every drawing call
onto it in silence.

**`ConvertOptions.resize` caps the longest side.** Neither of the above makes a
48 megapixel photograph cheap on a phone, so there is now a way to ask for a
smaller one. It never upscales, it runs before the alpha flatten and the gamut
narrow so both of those walk the smaller picture, and it runs per frame for an
animation. `report.resizedFrom` carries the size it started at. The resampler
underneath was written for icons and premultiplied the entire source into a
float copy first, which for a 48 megapixel photograph somebody asked to shrink
is 768 megabytes; the premultiply is folded into the horizontal pass now, so
the largest allocation is the intermediate at the target width.

**Stopping a conversion stops it.** An abort escaping the WebCodecs rung
arrives as a bare `AbortError` `DOMException` that never passed through this
package, so it read as an ordinary failure and the ladder walked on to the next
rung, which is the slow software decoder. Pressing stop made the work take
longer. Both ladders treat it as fatal now.

### What the file was carrying

**The keep-metadata setting keeps metadata.** `EncodeOptions` had no `exif`
field, no encoder wrote one, and `metadata: 'preserve'` gated exactly one
thing, whether a caller-supplied ICC profile survived. It failed safe, so
nothing private was ever leaked by it, and the setting still said something
untrue. EXIF is now read from JPEG, PNG, TIFF and HEIC, and written into PNG as
an `eXIf` chunk, into TIFF as its own directories, and into AVIF as an `Exif`
item with a `cdsc` reference back to the picture. The orientation tag is
rewritten to 1 on the way out, because every decoder here hands back upright
pixels and copying the tag across turns portrait photographs sideways.
`report.metadataKept` says `kept` only when the encoder that actually ran
declared it can carry a block, so a conversion to JPEG reports `stripped`
rather than implying otherwise.

**A HEIC keeps its transparency.** A sticker, an exported logo or a screenshot
with rounded corners stores its alpha as a separate auxiliary image, and this
read the picture and ignored it, so the result came out opaque with no warning
anywhere. It is applied now. A plane that is malformed or a different size from
the photograph is let go of rather than allowed to refuse the file, which is
the rule a damaged gain map already followed, and `report.droppedAlpha` says it
happened.

**Adobe RGB, ProPhoto and Rec.2020 photographs stopped being mislabelled.** The
wide gamut test read the red colourant alone, and all three of those pass any
threshold that admits Display P3. Those files were given a Display P3 readback,
so their pixels genuinely became P3, and then the source's own profile went
into the output verbatim: P3 numbers tagged Adobe RGB. Every colour managed
viewer renders that wrong and everything that ignores profiles renders it
right, which is what let it past a review. All three colourants are checked
now, in both copies of the predicate, with a test that fails if they ever
disagree.

**A floating point TIFF is read as light.** One on its way to OpenEXR or
Radiance keeps its range instead of going through eight bits in the middle. A
float TIFF whose samples never pass 1 is refused by that path on purpose: it is
a display picture that happens to be stored in floats, and metering one against
middle grey brings it back several stops too bright.

### Animation

**Animated WebP is written.** The format table has always said WebP animates
and no canvas will write an animated one, so a GIF converted to WebP came out
as its first frame with `droppedFrames` set on a report nobody reads. Each
frame is encoded as a still by the browser now and the container is assembled
here. Every frame is therefore a keyframe, which makes the file larger than a
purpose-built encoder would write and still a fraction of the GIF it came from.
It needs a browser whose canvas writes WebP, so not Safari.

**A GIF that plays once no longer loops forever.** WebCodecs counts the
repeats after the first pass, so a GIF carrying no `NETSCAPE` extension reports
zero and means "play once". This package counts plays and spells forever as
zero, because every container on disk does. The number was copied straight
across, so the one file that most explicitly asked to play once was the one
that looped without end, in every browser with an `ImageDecoder` and not in
Firefox, which has none. Nothing threw and every frame was correct.

**A truncated animation says so.** The frame reader has a cap, and a five
hundred frame GIF that came back with three hundred was reported as "all 300
frames kept", which is true about the result and false about the file.
`ConvertReport.truncatedFrames` is the difference.

### Refused sooner, allocated less

**A header's claim is tested before a decompressor is handed a budget shaped by
it.** `maxPixels` was checked against the image that came back, by which time a
four kilobyte PNG declaring 20000 by 15000 had already asked for a gigabyte.
Decoders can now offer a `measure` that reads the header on its own, and PNG,
GIF, PSD and PCX do. The readers that store pixels plainly deliberately do not,
because a file cannot declare an image its own length will not back up.

**PNG writes faster and holds less while doing it.** The adaptive filter is
fused into a single read pass, measured at 3.3 times on a gradient and 2.5
times on a photograph, with byte-identical output, and its intermediate is
streamed to the compressor rather than assembled whole, which takes peak
allocation on a 48 megapixel image from 210 MB to 80 MB. A HEIC tile grid is
allocated once at its final size rather than padded out to whole tiles and
cropped back afterwards.

**Malformed input has a suite of its own.** Truncated, contradictory and
hostile files are fed to every reader, and an unhandled rejection guard is
installed for every test file, so a decoder that reports a damaged file
correctly and leaves a rejected promise behind it fails the run instead of
ending the process.

### Fixed before it shipped

**Portrait photographs came out rotated by 540 degrees.** The HEIF path applies
`irot` while assembling the tile grid, and the converter applied it a second
time. Each half was correct on its own and the tests passed, because the fake
tile decoder and the assembled expectations agreed with each other. It only
appeared in a real browser, against a real photograph, where a file stored 4032
by 3024 came out 4032 by 3024 instead of 3024 by 4032. The contract is now that
a decoder returns an image already the right way up and the orientation on the
result is a report rather than an instruction.

**`hvcC` was parsed eight bytes short.** The fixed fields between the level
indicator and the NAL length size are eight bytes, not six. Miscounting put the
length prefix size on the average frame rate, which yielded a NAL length of one
byte and a parameter set count of zero, so a perfectly good file looked like it
carried no decoder configuration at all.

**Every image was being converted to Display P3.** The native decode path asked
for a wide gamut readback unconditionally. For a genuinely wide gamut source
that is preservation; for an ordinary sRGB one it is a conversion that nothing
asked for, and if anything downstream drops the tag the picture renders
oversaturated. The source's own bytes now decide, read from `cICP`, `iCCP`,
WebP's `ICCP` chunk or JPEG's `ICC_PROFILE` segments.

**The decoded ICC profile never reached the encoder.** A HEIC decoded to P3
numbers and was then written with nothing to say so, which renders flat
everywhere. The profile the camera embedded is now carried through to the
output whenever the image is still wide gamut.
