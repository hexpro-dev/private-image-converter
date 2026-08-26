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
that the tag and `package.json` agree, publishes, and attaches the offline build
to the GitHub release with a `SHA256SUMS` file beside it.

## Publishing

`npm publish --provenance` against npm's trusted publishing, using the OIDC
token GitHub Actions issues. There is no `NPM_TOKEN` anywhere and there should
never be one.

The trusted publisher is configured on the package at npmjs.com and names this
repository and this workflow filename. Renaming the workflow file or moving the
repository invalidates it, and that is the intended behaviour. Job names are not
part of that configuration.

`npm` is installed explicitly in that job because trusted publishing needs npm
11.5.1 or later and Node 22 ships with 10.

The workflow is two jobs. `publish` can read the repository and mint the OIDC
token. `release` can write to the repository and has neither the token nor a
checkout: the offline build reaches it as a workflow artifact. The release is
written by a third party action, and this is how that action ends up in the job
that holds nothing worth taking. Every `uses:` in both workflows names a commit
sha rather than a tag, because a tag is a pointer its owner can move, and
`.github/dependabot.yml` opens a weekly pull request to move the pins forward.

## What a downloader can check

Every release carries two files: `private-image-converter.html` and
`SHA256SUMS`. The second is one line in the format `sha256sum -c` reads. Put
both in the same directory and:

```bash
sha256sum -c SHA256SUMS
```

The same digest and the byte count are also in the release notes, so they
survive somewhere a person reads rather than only in a file they have to
download.

Neither of those is proof on its own, because anybody with write access here can
replace a release asset and edit the notes. The attestation is the part that
does not rest on trusting this repository. GitHub signs it against the workflow
run and the commit that produced the file:

```bash
gh attestation verify private-image-converter.html \
  --repo hexpro-dev/private-image-converter
```

### Rebuilding the offline app

The build is deterministic, so a third party can produce the artefact and check
the digest themselves. `scripts/build-html.ts` reads the source, the stylesheet
and the template, bundles with esbuild, and stamps the version from
`package.json` into the bundle. Nothing else goes in: no timestamp, no build
path, no set whose order depends on the machine. The case named "builds the same
bytes twice" in `tests/build/standalone-html.test.ts` holds it to that by
building twice in one run and comparing the document and both digests, so a
change that reached for the clock fails the suite rather than the release.

From a clean directory:

```bash
git clone https://github.com/hexpro-dev/private-image-converter
cd private-image-converter
git checkout v1.0.0
pnpm install --frozen-lockfile
pnpm run build:all
```

`build:html` prints the path, the byte count and the sha256 of what it wrote, so
there is nothing to dig out of a log. Against the release:

```bash
curl -LO https://github.com/hexpro-dev/private-image-converter/releases/download/v1.0.0/SHA256SUMS
(cd dist && sha256sum -c ../SHA256SUMS)
```

Two things a rebuild gets wrong. `--frozen-lockfile` is not optional: esbuild's
output changes between esbuild versions, and a rebuild that resolved a newer one
produces a different file and proves nothing. And the tag has to be checked out
rather than `main`, because the version string is compiled into the bundle.
Nothing in the build reads the Node version, but the release runs on Node 22, so
match it before assuming a mismatch means something worse.

## Never in a release

A real photograph, in the package, in a fixture, in the changelog, or in a
screenshot attached to the release. See the top of `CLAUDE.md`.
