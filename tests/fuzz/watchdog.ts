/**
 * Turn a decoder that never finishes into a failure rather than a hung run.
 *
 * Every other property this suite asserts is measured after the call comes
 * back, which is no use at all for the one failure where it does not. A reader
 * whose cursor stops advancing sits in a `while` loop on this thread, and
 * nothing on this thread can interrupt it: a promise race never resolves
 * because the microtask queue is not being served, and Vitest's own per-test
 * timeout is a timer, so it does not fire either. The run stops, CI waits out
 * its own limit, and the log says nothing about which of a thousand inputs did
 * it.
 *
 * So the watchdog lives on another thread. The corpus loop bumps a counter in
 * shared memory before each decode and writes the label beside it; a worker
 * with nothing else to do watches the counter and, if it stops moving for long
 * enough that no legitimate decode of a few kilobytes could explain it,
 * prints the label and kills the process. Killing is blunt and it is the only
 * signal available: a worker cannot fail a test on a thread that is not
 * running, and `process.exit` inside a worker ends only the worker.
 *
 * The stall budget is deliberately far above anything real. These inputs are a
 * few kilobytes each and the slowest legitimate one measures in single-digit
 * milliseconds, so twenty seconds of no movement is not a slow machine, it is
 * a loop with no exit.
 *
 * Two details in the worker are load bearing and both look like something to
 * tidy away. The diagnostic goes out through `fs.writeSync` on file descriptor
 * 2 rather than `process.stderr.write`, because a worker's `process.stderr` is
 * proxied through its parent thread and its parent thread is the one stuck in
 * the loop, so nothing written that way is ever forwarded. And the kill is a
 * quarter of a second later rather than immediate, because Vitest runs the
 * suite in a forked child and reads its output through a pipe: killing in the
 * same turn as the write loses the message, which leaves a dead run with no
 * explanation, which is the situation this file exists to prevent.
 */

import { Worker } from 'node:worker_threads';

const STALL_MS = 20_000;
const POLL_MS = 500;
const LABEL_BYTES = 160;

/**
 * Counter, label length, then the label.
 *
 * Two `Int32Array` slots first, because `Atomics` needs the alignment, and the
 * label as plain bytes after them. The label is written before the counter
 * moves, so the counter is what makes it visible: a reader that sees a new
 * count is looking at the label that goes with it.
 */
const HEADER_BYTES = 8;

const WATCHER = `
const { workerData } = require('node:worker_threads');
const counters = new Int32Array(workerData.shared, 0, 2);
const label = new Uint8Array(workerData.shared, ${HEADER_BYTES}, ${LABEL_BYTES});
let last = -1;
let stalled = 0;
setInterval(() => {
	const now = Atomics.load(counters, 0);
	if (now !== last) {
		last = now;
		stalled = 0;
		return;
	}
	stalled += ${POLL_MS};
	if (stalled < ${STALL_MS}) return;
	const length = Atomics.load(counters, 1);
	let text = '';
	for (let i = 0; i < length; i += 1) text += String.fromCharCode(label[i]);
	require('node:fs').writeSync(
		2,
		'\\nThe malformed-input corpus stopped making progress on ' + text +
		', so that decode is not going to finish. Killing the run: the thread it is' +
		' on is held by a loop with no exit, and no timer on that thread can fire.\\n',
	);
	setTimeout(() => process.kill(process.pid, 'SIGKILL'), 250);
}, ${POLL_MS});
`;

export interface Watchdog {
	/** Called before each decode, with something that identifies the input. */
	readonly beat: (label: string) => void;
	readonly stop: () => Promise<void>;
}

export function startWatchdog(): Watchdog {
	const shared = new SharedArrayBuffer(HEADER_BYTES + LABEL_BYTES);
	const counters = new Int32Array(shared, 0, 2);
	const label = new Uint8Array(shared, HEADER_BYTES, LABEL_BYTES);
	const worker = new Worker(WATCHER, { eval: true, workerData: { shared } });
	// The parent must not wait for a thread whose whole job is to wait.
	worker.unref();

	let count = 0;
	return {
		beat(text: string): void {
			const length = Math.min(text.length, LABEL_BYTES);
			for (let i = 0; i < length; i += 1) label[i] = text.charCodeAt(i) & 0x7f;
			Atomics.store(counters, 1, length);
			count += 1;
			Atomics.store(counters, 0, count);
		},
		async stop(): Promise<void> {
			await worker.terminate();
		},
	};
}
