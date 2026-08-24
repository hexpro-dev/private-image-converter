/**
 * Build the single file offline application.
 *
 * Everything ends up inside one HTML document: the script bundled and
 * minified, the stylesheet minified, and a Content-Security-Policy naming the
 * sha256 of each so the browser refuses to run anything that was added
 * afterwards.
 *
 * Exported as a function rather than only run as a script, so the test can
 * build it in memory and assert its properties without a build step having run
 * first, and so that `pnpm test` cannot pass against a stale artefact.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export const OUTPUT_NAME = 'private-image-converter.html';

export interface StandaloneBuildResult {
	readonly html: string;
	readonly scriptSha256: string;
	readonly styleSha256: string;
	readonly bytes: number;
}

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** The exact text between a tag's open and close, as the browser will hash it. */
function elementContent(html: string, tag: 'script' | 'style'): string {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html);
	if (!match?.[1]) throw new Error(`the built document has no ${tag} element`);
	return match[1];
}

export async function buildStandaloneHtml(): Promise<StandaloneBuildResult> {
	const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
		version: string;
	};

	const bundle = await esbuild.build({
		entryPoints: [resolve(root, 'src/app/main.ts')],
		bundle: true,
		minify: true,
		format: 'iife',
		write: false,
		legalComments: 'none',
		target: ['es2022', 'safari16', 'firefox115', 'chrome110'],
		define: { __VERSION__: JSON.stringify(manifest.version) },
	});
	const script = bundle.outputFiles[0]?.text;
	if (!script) throw new Error('esbuild produced no output');

	const css = await readFile(resolve(root, 'src/app/styles.css'), 'utf8');
	const style = (await esbuild.transform(css, { loader: 'css', minify: true })).code;

	const template = await readFile(resolve(root, 'src/app/index.html'), 'utf8');

	// Replacements are functions, not strings. `String.replace` expands `$&`
	// and friends inside a string replacement, and a minifier reliably emits
	// `$&&` somewhere in a bundle this size. The first time this was written
	// with a plain string it re-injected the placeholder into the middle of the
	// script and produced a file that parsed as HTML and not as a program.
	let html = template.replace('<!--STYLE-->', () => style).replace('<!--SCRIPT-->', () => script);

	// Hashed from what actually landed in the document, not from the bundle.
	//
	// This is not a theoretical distinction. Running the formatter over the
	// template put each placeholder on its own indented line, so the script
	// element's content gained a leading newline and two tabs, the hash in the
	// policy no longer described it, and the browser refused to run the file.
	// Every other assertion in the build test still passed. Read the element
	// back out of the finished document and there is nothing left to get wrong.
	const scriptSha256 = sha256(elementContent(html, 'script'));
	const styleSha256 = sha256(elementContent(html, 'style'));

	const csp = [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`script-src 'sha256-${scriptSha256}'`,
		`style-src 'sha256-${styleSha256}'`,
		// blob: is what the converted file's preview and its save both use.
		// There is no remote scheme here at all.
		"img-src 'self' data: blob:",
		"connect-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
	].join('; ');

	html = html.replace(
		'<!--CSP-->',
		() => `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
	);

	return { html, scriptSha256, styleSha256, bytes: Buffer.byteLength(html, 'utf8') };
}

async function main(): Promise<void> {
	const result = await buildStandaloneHtml();
	const out = resolve(root, 'dist', OUTPUT_NAME);
	await writeFile(out, result.html, 'utf8');
	const digest = createHash('sha256').update(result.html, 'utf8').digest('hex');
	process.stdout.write(`${out}\n${result.bytes} bytes\nsha256 ${digest}\n`);
}

// Only writes a file when run as a script. Importing it from a test builds in
// memory and touches nothing.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
