/**
 * The codec registry.
 *
 * Every format is a module that registers a decoder, an encoder, or both.
 * Nothing in the converter imports a codec directly, so adding a format is
 * adding a file and one call, and removing one cannot break the dispatcher.
 *
 * Registration is idempotent by id: registering the same id twice replaces the
 * first, which makes a module safe to import more than once and lets a host
 * application override a built-in codec with a better one without having to
 * unregister anything first.
 */

import type { Capabilities, Decoder, Encoder, FormatId } from './types.js';

const decoders = new Map<string, Decoder>();
const encoders = new Map<string, Encoder>();

/** Cleared whenever the registry changes, because a new codec changes the answer. */
let availability = new WeakMap<Capabilities, Map<string, Promise<boolean>>>();

export function registerDecoder(decoder: Decoder): void {
	decoders.set(decoder.id, decoder);
	availability = new WeakMap();
}

export function registerEncoder(encoder: Encoder): void {
	encoders.set(encoder.id, encoder);
	availability = new WeakMap();
}

export function unregisterDecoder(id: string): boolean {
	const had = decoders.delete(id);
	if (had) availability = new WeakMap();
	return had;
}

export function unregisterEncoder(id: string): boolean {
	const had = encoders.delete(id);
	if (had) availability = new WeakMap();
	return had;
}

export function registeredDecoders(): readonly Decoder[] {
	return [...decoders.values()];
}

export function registeredEncoders(): readonly Encoder[] {
	return [...encoders.values()];
}

function memoisedAvailable(
	capabilities: Capabilities,
	id: string,
	probe: () => Promise<boolean>,
): Promise<boolean> {
	let byId = availability.get(capabilities);
	if (!byId) {
		byId = new Map();
		availability.set(capabilities, byId);
	}
	let answer = byId.get(id);
	if (!answer) {
		// A probe that rejects counts as unavailable rather than propagating.
		// A codec whose availability check throws is a codec that cannot run.
		answer = probe().catch(() => false);
		byId.set(id, answer);
	}
	return answer;
}

/**
 * Decoders that can read `format` here, cheapest first.
 *
 * Ties break on registration order, which puts a host application's override
 * after the built-in it shares a priority with. Give an override a lower
 * priority number if it should win outright.
 */
export async function decodersFor(
	format: FormatId,
	capabilities: Capabilities,
): Promise<readonly Decoder[]> {
	const candidates = [...decoders.values()]
		.filter((decoder) => decoder.formats.includes(format))
		.sort((a, b) => a.priority - b.priority);

	const usable: Decoder[] = [];
	for (const decoder of candidates) {
		if (
			await memoisedAvailable(capabilities, `d:${decoder.id}`, () =>
				decoder.available(capabilities),
			)
		) {
			usable.push(decoder);
		}
	}
	return usable;
}

export async function encodersFor(
	format: FormatId,
	capabilities: Capabilities,
): Promise<readonly Encoder[]> {
	const candidates = [...encoders.values()]
		.filter((encoder) => encoder.format === format)
		.sort((a, b) => a.priority - b.priority);

	const usable: Encoder[] = [];
	for (const encoder of candidates) {
		if (
			await memoisedAvailable(capabilities, `e:${encoder.id}`, () =>
				encoder.available(capabilities),
			)
		) {
			usable.push(encoder);
		}
	}
	return usable;
}

/** Every format something registered here can read, given these capabilities. */
export async function readableFormats(capabilities: Capabilities): Promise<Set<FormatId>> {
	const out = new Set<FormatId>();
	for (const decoder of decoders.values()) {
		if (
			await memoisedAvailable(capabilities, `d:${decoder.id}`, () =>
				decoder.available(capabilities),
			)
		) {
			for (const format of decoder.formats) out.add(format);
		}
	}
	return out;
}

export async function writableFormats(capabilities: Capabilities): Promise<Set<FormatId>> {
	const out = new Set<FormatId>();
	for (const encoder of encoders.values()) {
		if (
			await memoisedAvailable(capabilities, `e:${encoder.id}`, () =>
				encoder.available(capabilities),
			)
		) {
			out.add(encoder.format);
		}
	}
	return out;
}

/** Drop every registration. Tests use this; nothing else should need it. */
export function clearRegistry(): void {
	decoders.clear();
	encoders.clear();
	availability = new WeakMap();
}
