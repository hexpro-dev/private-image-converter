# Releasing

## Before tagging

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build:all
pnpm pack --dry-run
```

## The checks a machine cannot do

CI proves the code compiles, passes its tests and carries no runtime
dependency. It cannot prove the tool converts a photograph correctly, because
there is no photograph in this repository and there never will be. So before a
release, with a real camera roll and outside version control:

1. Open `dist/private-image-converter.html` from your own disc, with the
   network off, in Chrome, Firefox and Safari.
2. Convert a portrait photograph taken on a phone. **Check it is not sideways.**
   This is the failure that has actually happened, it only shows on photographs
   taken in portrait, and both halves of the code looked correct in isolation.
3. Convert a landscape one and a square one.
4. Open the result beside the original in a viewer that manages colour. A result
   that looks flat means the profile was lost; one that looks lurid means it was
   applied twice. Do not judge this on a wide gamut display by eye alone,
   because both mistakes look plausible there. Compare mean saturation if in
   doubt.
5. Convert to JPEG and to WebP. In Safari, WebP must be refused with a sentence,
   not silently produce a PNG named `.webp`.
6. Check the metadata line names what was actually in the file.
7. In Firefox, HEIC must fail with a message that explains why rather than with
   a stack trace. Then load the site build, which registers a fallback decoder,
   and confirm it converts and that the result is marked as having used it.
8. Convert a 48 megapixel photograph on a phone. This is where canvas limits
   bite and nowhere else.

## Tagging

1. Bump `version` in `package.json`.
2. Write the entry in `CHANGELOG.md`.
3. Commit both.
4. Tag from `main`:

```bash
git tag -a v1.0.0 -m "1.0.0

<one paragraph on what changed>"
git push origin main --tags
```

The publish workflow runs on a tag matching `v*.*.*`. It re-runs the whole gate,
because a tag ref does not match the branch filter that `ci.yml` uses, checks
that the tag and `package.json` agree, records the sha256 of the offline build
in the run summary so a downloader can verify what they got, and publishes.

## Publishing

`npm publish --provenance` against npm's trusted publishing, using the OIDC
token GitHub Actions issues. There is no `NPM_TOKEN` anywhere and there should
never be one.

The trusted publisher is configured on the package at npmjs.com and names this
repository and this workflow filename. Renaming the workflow file or moving the
repository invalidates it, and that is the intended behaviour.

`npm` is installed explicitly in that job because trusted publishing needs npm
11.5.1 or later and Node 22 ships with 10.

## Never in a release

A real photograph, in the package, in a fixture, in the changelog, or in a
screenshot attached to the release. See the top of `CLAUDE.md`.
