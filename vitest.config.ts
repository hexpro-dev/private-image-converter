import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: ['src/**/*.ts'],
			exclude: [
				// The offline application is browser UI. It is verified by the
				// integrity test over the built file and by opening it, which is
				// what the manual list in RELEASING.md is for.
				'src/app/**',
				// Types only, and barrels. Both compile to `export {}` or to
				// re-exports, so v8 scores them 0 of 0 and reports zero percent,
				// which drags a whole directory down for no signal.
				'src/types.ts',
				'src/**/index.ts',
				// Everything below needs a browser to run at all: a canvas, an
				// ImageBitmap, or a VideoDecoder. None of it can be covered under
				// Node, and faking those APIs well enough to cover it would be
				// testing the fake. It is exercised by the browser checklist in
				// RELEASING.md instead, which is honest about being manual.
				'src/codecs/native/**',
				'src/codecs/heic/webcodecs.ts',
				'src/detect/capabilities.ts',
				'src/detect/probes.ts',
				'src/raster/canvas.ts',
				'src/dom/index.ts',
			],
			// Every threshold below sits just under what the suite actually
			// reaches, so a real regression trips it. Setting one lower would
			// gate nothing; setting one higher would leave a gate that has never
			// been green, which teaches everybody to ignore it. Raise them when
			// the coverage rises rather than leaving slack.
			thresholds: {
				statements: 96,
				branches: 95,
				functions: 96,
				lines: 96,
				// The codecs read untrusted bytes from a stranger's file, so they
				// are held near the top and a new branch arrives with a test.
				'src/codecs/png/**': {
					statements: 96,
					branches: 95,
					functions: 100,
					lines: 96,
				},
				'src/codecs/qoi/**': {
					statements: 95,
					branches: 96,
					functions: 100,
					lines: 95,
				},
				'src/codecs/bmp/**': {
					statements: 97,
					branches: 97,
					functions: 100,
					lines: 97,
				},
				'src/codecs/tga/**': {
					statements: 97,
					branches: 98,
					functions: 100,
					lines: 97,
				},
				'src/codecs/pnm/**': {
					statements: 97,
					branches: 95,
					functions: 100,
					lines: 97,
				},
				// The container reader is the part that has to be right, and it
				// runs entirely under Node, so there is no excuse for a gap.
				'src/heif/**': {
					statements: 96,
					branches: 91,
					functions: 100,
					lines: 96,
				},
				'src/detect/sniff.ts': {
					statements: 100,
					branches: 96,
					functions: 100,
					lines: 100,
				},
				// Nothing in these is uncovered and nothing in them needs a
				// browser, so the gate is the full hundred and a new branch has
				// to arrive with a test.
				'src/raster/image.ts': {
					statements: 100,
					branches: 98,
					functions: 100,
					lines: 100,
				},
				'src/metadata/**': {
					statements: 99,
					branches: 96,
					functions: 100,
					lines: 99,
				},
				'src/registry.ts': {
					statements: 100,
					branches: 100,
					functions: 100,
					lines: 100,
				},
			},
		},
	},
});
