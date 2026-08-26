/**
 * Fail the test that left a promise rejection with nobody holding it.
 *
 * This is here because it has already happened. `pump` in
 * `src/codecs/png/deflate.ts` writes, closes and reads a compression stream as
 * three separate promises and awaits only the read, which is deliberate:
 * awaiting the write deadlocks on anything larger than the stream's queue. A
 * corrupt stream rejects all three, and the two nobody was holding became
 * unhandled rejections. In Node that ends the process; in a browser it fires
 * at the page. A decoder that had correctly noticed a damaged file took the
 * tab with it, on roughly one malformed input in twenty. Both now carry a
 * `.catch`, and this exists so that the next one is a failing test rather than
 * a bug report from somebody whose photograph is gone.
 *
 * Vitest does notice an unhandled rejection on its own and exits non-zero for
 * it, which is worth knowing before deciding this is redundant. What it does
 * not do is attribute it: every test is reported as passing and the failure
 * arrives as a loose error at the bottom of the run, so a suite of three
 * thousand tests says only that one of them did something wrong somewhere.
 * Recording the rejection and throwing it out of `afterEach` names the test.
 *
 * Wire it as a `setupFiles` entry so it covers the whole suite. A test file
 * can also import `guardUnhandledRejections` and call it, which is what
 * `contract.test.ts` does so that the fuzz corpus is covered whether or not
 * the configuration entry is in place.
 */

import { afterEach } from 'vitest';

const pending: unknown[] = [];
let installed = false;

function record(reason: unknown): void {
	pending.push(reason);
}

/**
 * Give Node the turns it needs to decide nobody is going to catch a rejection.
 *
 * The event fires once the microtask queue has drained, so awaiting a promise
 * is not enough: it has to be a macrotask, and two of them rather than one
 * because a rejection created inside a stream's own callback is a turn further
 * back than one created in a test.
 */
export async function settleRejections(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

/** Everything recorded so far, leaving the record empty. */
export function takeUnhandledRejections(): readonly unknown[] {
	return pending.splice(0, pending.length);
}

/** The listener itself, so a test can prove this file works. */
export function unhandledRejectionListener(): (reason: unknown) => void {
	return record;
}

export function guardUnhandledRejections(): void {
	if (installed) return;
	installed = true;
	process.on('unhandledRejection', record);
	afterEach(async () => {
		await settleRejections();
		const seen = takeUnhandledRejections();
		if (seen.length === 0) return;
		const first = seen[0];
		const detail = first instanceof Error ? `${first.name}: ${first.message}` : String(first);
		throw new Error(
			`this test left ${seen.length} promise rejection(s) with nothing holding them. The first was ${detail}`,
		);
	});
}

guardUnhandledRejections();
