// ESLint 9 flat config. Mirrors the shape of the other Hex Pro packages.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'coverage/**',
			'tests/fixtures/**',
			// Measurement rigs and real photographs. Gitignored and never
			// shipped, so linting them only makes a working tree disagree with a
			// clean checkout about whether the gate passes.
			'scratch/**',
			'**/*.config.js',
			'**/*.config.ts',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/ban-ts-comment': 'error',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
		},
	},
	{
		// The HEIF reader is a container parser for a published ISO standard and
		// has nothing to do with image conversion as such. Keeping its imports
		// inside `src/heif/` means it stays liftable into its own package, and
		// it also stops the parser quietly acquiring a dependency on the raster
		// layer, which would make it impossible to test box parsing on its own.
		files: ['src/heif/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							// Named rather than "anything above this directory",
							// because `errors.js`, `result.js` and `types.js` do
							// live above it and are the sanctioned exceptions.
							group: [
								'**/codecs/**',
								'**/detect/**',
								'**/dom/**',
								'**/app/**',
								'**/metadata/**',
								'**/registry*',
							],
							message:
								'src/heif must not import from outside src/heif, except ../errors.js, ../result.js, ../types.js and ../raster/. See eslint.config.js.',
						},
					],
				},
			],
		},
	},
	{
		// A codec is a leaf. It receives bytes and returns a raster, or the
		// reverse, and it must not reach upward into the registry that
		// dispatches to it. This is what makes "adding a format is adding a
		// file" true rather than aspirational: a codec that imported the
		// registry would make the registry's import graph cyclic and the
		// plug-and-play claim false.
		//
		// `src/heif/` is deliberately not on this list. It is a container
		// reader rather than a codec, in the same category as `src/raster/`,
		// and the HEIC decoder is exactly the caller it exists for.
		files: ['src/codecs/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/dom/**', '**/app/**', '**/registry*'],
							message:
								'A codec must not import the registry, the DOM layer or the app. It takes bytes and returns a raster. See eslint.config.js.',
						},
					],
				},
			],
		},
	},
	{
		// The standalone offline app is the one place allowed to touch the DOM
		// directly and to log, because it is an application rather than a
		// library.
		files: ['src/app/**/*.ts'],
		rules: {
			'no-restricted-imports': 'off',
		},
	},
);
