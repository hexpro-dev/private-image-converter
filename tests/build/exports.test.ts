import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Manifest {
	readonly exports: Record<string, string | Record<string, string>>;
	readonly files: readonly string[];
	readonly dependencies: Record<string, string>;
	readonly main: string;
	readonly types: string;
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest;

/** Every target in the exports map, flattened out of its condition objects. */
function targets(): { subpath: string; target: string }[] {
	const out: { subpath: string; target: string }[] = [];
	for (const [subpath, value] of Object.entries(manifest.exports)) {
		if (typeof value === 'string') out.push({ subpath, target: value });
		else for (const target of Object.values(value)) out.push({ subpath, target });
	}
	return out;
}

/**
 * The source file a built target comes from.
 *
 * `dist/heif/index.js` and `dist/heif/index.d.ts` both come from
 * `src/heif/index.ts`, and checking the source rather than the build is what
 * lets this run on a clean checkout with nothing compiled.
 */
function sourceOf(target: string): string | undefined {
	const match = /^\.\/dist\/(.+?)\.(js|d\.ts)$/.exec(target);
	if (!match?.[1]) return undefined;
	return resolve(root, 'src', `${match[1]}.ts`);
}

describe('the exports map', () => {
	it('points every subpath at a file that exists', () => {
		// This is not hypothetical. The `./codecs` subpath was declared in the
		// manifest before the barrel behind it was written, so anybody importing
		// it got a resolution failure, and nothing in the build, the tests or
		// `pnpm pack` noticed: the pack only checks which files are included,
		// not whether the map points at any of them.
		const missing = targets()
			.map(({ subpath, target }) => ({ subpath, target, source: sourceOf(target) }))
			.filter((entry) => entry.source !== undefined && !existsSync(entry.source));
		expect(missing).toEqual([]);
	});

	it('ships types alongside every importable subpath', () => {
		// A subpath that resolves at runtime and not at compile time is worse
		// than one that does neither, because it fails only for the consumer.
		for (const [subpath, value] of Object.entries(manifest.exports)) {
			if (typeof value === 'string') continue;
			expect(Object.keys(value), `${subpath} declares its conditions`).toContain('types');
			expect(Object.keys(value), `${subpath} declares its conditions`).toContain('import');
		}
	});

	it('includes dist in the published files', () => {
		expect(manifest.files).toContain('dist');
	});

	it('declares no runtime dependencies', () => {
		// CI asserts this too. It is here as well so it fails in a second on a
		// laptop rather than in a minute on a runner, and because the whole
		// claim of this package rests on it.
		expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
	});

	it('points main and types at the root subpath', () => {
		const root_ = manifest.exports['.'];
		expect(typeof root_).toBe('object');
		if (typeof root_ === 'object') {
			expect(manifest.main).toBe(root_.import);
			expect(manifest.types).toBe(root_.types);
		}
	});
});
