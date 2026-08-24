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
