/**
 * The offline document reaches nothing and keeps nothing.
 *
 * This is the artefact the claim is about. Somebody downloads one HTML file,
 * opens it with the network off, converts a photograph, and the promise printed
 * on the page is that neither the picture nor anything about it goes anywhere.
 * `eslint.config.js` forbids the names that would break that inside `src/`,
 * which is the gate a patch has to pass on the way in. This file checks the
 * other end: the built document, assembled in memory from source on every run
 * by the same build function `standalone-html.test.ts` uses, so nothing sitting
 * in `dist/` from weeks ago can satisfy it.
 *
 * The list of names is read back out of the lint configuration, so the two
 * halves cannot drift apart. A name added to the rule and not to the scan fails
 * here, and so does the reverse.
 *
 * What this cannot see, said plainly. It reads text and looks for names, which
 * is how a request really gets added: somebody writes `fetch(` and means well.
 * A name assembled at runtime is invisible to it, and would be invisible to any
 * scan of this kind. `globalThis['fet' + 'ch']` is the whole trick. Two things
 * sit behind the scan for that case and neither of them cares how the call is
 * spelled: the document carries `default-src 'none'` and `connect-src 'none'`,
 * so a browser that honours the policy refuses the connection whatever reached
 * for it, and the program contains no `eval` and no `Function` constructor,
 * which are the general purpose ways to turn a string into code. None of that
 * defeats somebody determined to hide one. It defeats the accident, and it
 * means the deliberate version has to be written to look like something else,
 * in a public repository, and still get past a policy that refuses the
 * connection.
 *
 * The hook below builds the document with esbuild rather than reading one off
 * disk, which is why it is given a long timeout.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildStandaloneHtml } from '../../scripts/build-html.js';

/**
 * Every name `eslint.config.js` forbids inside `src/`.
 *
 * Ten of the twelve are also globals. `sendBeacon` and `cookie` can only ever
 * be reached as a property, which is why the rule carries a property entry for
 * all twelve and a global entry for the ten.
 */
const FORBIDDEN = [
	'fetch',
	'XMLHttpRequest',
	'WebSocket',
	'EventSource',
	'Request',
	'Response',
	'sendBeacon',
	'localStorage',
	'sessionStorage',
	'indexedDB',
	'caches',
	'cookie',
] as const;

/**
 * The ways a program can acquire code, or a name, after it has started.
 *
 * `import(` is the one the lint rule covers in the source. `eval(` and
 * `Function(` are here because the scan above reads names and those two are how
 * a name gets built out of pieces instead of written. `importScripts` exists
 * only inside a worker, and `src/dom/index.ts` explains at length why there is
 * no worker in this package, so finding it would mean both a worker and a
 * second file to load into it.
 */
const RUNTIME_LOADERS = ['import(', 'eval(', 'Function(', 'importScripts'] as const;

let html = '';
/** The contents of the one script element, without its tags. */
let script = '';
/** The contents of the one style element, without its tags. */
let style = '';
/**
 * The document with the program and the stylesheet lifted out of it.
 *
 * Split the same way, and for the same reason, as in `standalone-html.test.ts`:
 * the markup is prose and the program is not, and a search that mixes them
 * answers a question nobody asked. That file is not imported to get the split,
 * because importing a test file from a test file runs its suite twice.
 */
let markup = '';
let csp = '';
/** The lint configuration, read as text, for the list it forbids. */
let config = '';

function part(pattern: RegExp, what: string): string {
	const found = pattern.exec(html);
	if (!found?.[1]) throw new Error(`the built document has no ${what}`);
	return found[1];
}

beforeAll(async () => {
	html = (await buildStandaloneHtml()).html;
	script = part(/<script>([\s\S]*)<\/script>/, 'script element');
	style = part(/<style>([\s\S]*?)<\/style>/, 'style element');
	markup = html.replace(script, '').replace(style, '');
	csp = part(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/, 'security policy');
	config = await readFile(
		fileURLToPath(new URL('../../eslint.config.js', import.meta.url)),
		'utf8',
	);
}, 120_000);

describe('the program inside the built document', () => {
	it('names nothing that opens a connection or writes a store', () => {
		// Whole substrings rather than whole words. The program is minified, so
		// every identifier in it that survives is either a property name or a
		// string, and an accidental collision with a name this long does not
		// happen. A substring search is the stricter of the two here: it also
		// catches the name buried inside a longer one.
		for (const name of FORBIDDEN) {
			expect(script, `${name} in the program`).not.toContain(name);
			expect(style, `${name} in the stylesheet`).not.toContain(name);
		}
	});

	it('names nowhere to send anything', () => {
		// A scheme with an authority after it, which is what a destination looks
		// like. Searching for a bare `//` instead finds eight, and not one of
		// them means anything: seven are inside the base64 codec probes from
		// `src/detect/probes.ts`, which is what base64 looks like, and the
		// eighth is the end of a regular expression in the XPM reader.
		expect(script, 'a scheme and host in the program').not.toContain('://');
		expect(style, 'a scheme and host in the stylesheet').not.toContain('://');
	});

	it('acquires no code once it is running', () => {
		// Stricter here than the lint rule can be in the source. The rule allows
		// a dynamic import of a relative module, because that is a legitimate
		// thing to write even though nothing here does it. By this point the
		// bundler has flattened every module into one scope, so an `import(` in
		// the built program is not a module boundary any more. It is a fetch.
		for (const loader of RUNTIME_LOADERS) {
			expect(script, `${loader} in the program`).not.toContain(loader);
		}
	});
});

describe('the markup inside the built document', () => {
	it('uses these names only in the prose that promises they are absent', () => {
		// The page tells the reader there is no fetch, XMLHttpRequest, WebSocket,
		// EventSource or sendBeacon in the file, and that it stores no cookies.
		// So the words are in the document, in the description list under "What
		// this does", and nowhere else. Cutting those descriptions out is what
		// keeps the check honest rather than loosening it to fit them: a
		// `dd` holds text, and the sibling suite establishes separately that no
		// element in this document carries an attribute that loads or sends
		// anything, so prose sitting there cannot turn into a request.
		const facts = [...markup.matchAll(/<dd\b[^>]*>[\s\S]*?<\/dd>/g)].map((found) => found[0]);
		expect(facts.length, 'the facts list is missing from the page').toBeGreaterThan(0);
		let rest = markup;
		for (const fact of facts) rest = rest.replace(fact, '');
		for (const name of FORBIDDEN) {
			expect(rest, `${name} in the markup outside the facts list`).not.toContain(name);
		}
	});
});

describe('what the scan cannot see', () => {
	it('is refused by the policy the document carries anyway', () => {
		// A name put together at runtime passes every check above. It does not
		// pass this one. `connect-src 'none'` refuses the connection without
		// caring what the call was spelled as, and `default-src 'none'` covers
		// the fetches that have a directive of their own.
		//
		// With its limits stated. A policy is only enforced by a browser that
		// reads it, it governs connections rather than navigations, and the
		// absence of `unsafe-eval` narrows how a name can be built rather than
		// ruling it out. The sibling suite checks the navigation half.
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("connect-src 'none'");
		expect(csp).not.toContain('unsafe-eval');
	});
});

describe('the lint rule and this file', () => {
	it('forbid the same names', () => {
		// Without this the two drift. Somebody adds a name to the rule, the
		// source stays clean because the rule stopped it, and the artefact scan
		// keeps checking the shorter list for years without anybody noticing.
		expect(config).toContain("'no-restricted-globals'");
		expect(config).toContain("'no-restricted-properties'");
		// Blunt on purpose. `name:` and `property:` appear in that file only in
		// these two rules, and if a third use ever turns up this fails and says
		// which name it found, which is a better failure than a scan that
		// quietly narrows.
		const banned = new Set<string>();
		for (const found of config.matchAll(/\b(?:name|property): '([^']+)'/g)) banned.add(found[1]);
		expect([...banned].sort()).toEqual([...FORBIDDEN].sort());
	});
});
