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
		// "The picture never leaves the tab" is the whole product. Until now it
		// was true only because nobody had written the line that breaks it. A
		// reader can check it by searching the source, and the build test checks
		// it over the finished offline file, but neither stops a patch on the way
		// in: the search has to be remembered, and the offline file is only built
		// at release. These rules are the gate. Each message says what the ban is
		// about rather than which rule fired, because somebody who hits one is
		// being told something about the product and not about style.
		//
		// `src/app/` is covered rather than exempt. That was checked before it
		// was decided: the offline application opens no connection and reads no
		// storage today, and it is the one file a stranger downloads and opens,
		// so it is the last place an exception would belong.
		//
		// The property list repeats most of the global list deliberately.
		// `no-restricted-globals` sees a bare `fetch` and nothing else, and this
		// tree reads optional globals as members, `(globalThis as { VideoDecoder?:
		// typeof VideoDecoder }).VideoDecoder`, in four files. So the member form
		// is both the one that would get written here and the one that is hardest
		// to see, because a cast in front of the object hides it from any rule
		// that matches on the object's name. An entry with no `object` matches
		// the property wherever it hangs.
		files: ['src/**/*.ts'],
		rules: {
			'no-restricted-globals': [
				'error',
				{
					name: 'fetch',
					message:
						'Nothing here makes a request. The picture is read from the file the user picked, converted in the tab and handed back, and there is no server at the other end of this. See eslint.config.js.',
				},
				{
					name: 'XMLHttpRequest',
					message:
						'The older spelling of fetch, and the same answer: nothing in this package sends anything anywhere. See eslint.config.js.',
				},
				{
					name: 'WebSocket',
					message:
						'No connection is opened from this package. A socket with image bytes on it is the exact thing the offline file promises is not in there. See eslint.config.js.',
				},
				{
					name: 'EventSource',
					message:
						'No connection is opened from this package, including one that only listens. See eslint.config.js.',
				},
				{
					name: 'Request',
					message:
						'Request is the fetch API, and nothing here is addressed to a server. See eslint.config.js.',
				},
				{
					name: 'Response',
					message:
						'Response is the fetch API. If this is `new Response(blob).arrayBuffer()` to read a Blob, `blob.arrayBuffer()` does the same thing without reaching for a network type. See eslint.config.js.',
				},
				{
					name: 'localStorage',
					message:
						'Nothing this package touches outlives the tab. The offline file tells the reader it stores nothing, so not even a remembered setting goes here. See eslint.config.js.',
				},
				{
					name: 'sessionStorage',
					message:
						'Same as localStorage. A shorter life is still a copy of the picture, or of its name, left behind on the machine. See eslint.config.js.',
				},
				{
					name: 'indexedDB',
					message:
						'A database on disk is the largest thing this package could leave behind, and it takes Blobs. Nothing is written outside the tab. See eslint.config.js.',
				},
				{
					name: 'caches',
					message:
						'The Cache API stores responses on disk and exists to serve requests. There are neither of those here. See eslint.config.js.',
				},
			],
			'no-restricted-properties': [
				'error',
				{
					property: 'fetch',
					message:
						'Reached through an object rather than as a bare name, and still a request. Nothing in this package makes one. See eslint.config.js.',
				},
				{
					property: 'sendBeacon',
					message:
						'navigator.sendBeacon is the one call built to leave as the page does, which is why it is worth naming on its own. This package reports nothing, anywhere, ever. See eslint.config.js.',
				},
				{
					property: 'XMLHttpRequest',
					message:
						'Nothing in this package sends anything anywhere, whichever object the constructor is read off. See eslint.config.js.',
				},
				{
					property: 'WebSocket',
					message:
						'No connection is opened from this package, whichever object the constructor is read off. See eslint.config.js.',
				},
				{
					property: 'EventSource',
					message:
						'No connection is opened from this package, whichever object the constructor is read off. See eslint.config.js.',
				},
				{
					property: 'Request',
					message:
						'Request is the fetch API, and nothing here is addressed to a server. See eslint.config.js.',
				},
				{
					property: 'Response',
					message:
						'Response is the fetch API. `blob.arrayBuffer()` reads a Blob without it. See eslint.config.js.',
				},
				{
					property: 'cookie',
					message:
						'document.cookie is storage that travels with a request. This package writes neither. See eslint.config.js.',
				},
				{
					property: 'localStorage',
					message:
						'Nothing this package touches outlives the tab, whichever object the store is read off. See eslint.config.js.',
				},
				{
					property: 'sessionStorage',
					message:
						'Nothing this package touches outlives the tab, whichever object the store is read off. See eslint.config.js.',
				},
				{
					property: 'indexedDB',
					message:
						'Nothing is written outside the tab, whichever object the factory is read off. See eslint.config.js.',
				},
				{
					property: 'caches',
					message:
						'The Cache API stores responses on disk and exists to serve requests. There are neither of those here. See eslint.config.js.',
				},
			],
			'no-restricted-syntax': [
				'error',
				{
					// Neither rule above can see this one: the specifier is a
					// string, not a name. A remote specifier is a request the
					// bundler cannot inline and the offline file cannot contain,
					// so it would break the single file build as well as the
					// promise.
					selector:
						"ImportExpression[source.type='Literal'][source.value=/^([A-Za-z][A-Za-z0-9+.-]*:)?\\/\\//]",
					message:
						'A dynamic import of a URL fetches code from somewhere else at runtime. Everything this package runs is in the file the user already has. See eslint.config.js.',
				},
				{
					// A computed specifier cannot be read at all, so there is
					// nothing to allow. This package loads nothing lazily: the
					// offline build is one document, and a split point in it
					// would produce a second file that nobody downloads.
					selector: "ImportExpression:not([source.type='Literal'])",
					message:
						'A dynamic import whose specifier is worked out at runtime cannot be checked, and nothing here is loaded lazily. Import the module at the top of the file. See eslint.config.js.',
				},
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
