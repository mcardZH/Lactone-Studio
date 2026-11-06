"use strict";
const crypto = require("node:crypto");
const { fail } = require("./platform/global-settings.cjs");
function previewSourceIdentity(value) {
	return {
		taskId: value.artifact?.taskId || value.run?.taskId || null,
		artifactId: value.artifact.artifactId,
		environmentId: value.location.environmentId,
		path: value.location.path,
		fileId: value.identity.fileId || null,
		sourceGeneration: value.sourceGeneration || value.sourceKey || null
	};
}
function assertPreviewSourceIdentity(value, expected) {
	const actual = previewSourceIdentity(value);
	if (
		expected &&
		["taskId", "artifactId", "environmentId", "path", "fileId", "sourceGeneration"].some(
			(key) =>
				expected[key] !== undefined && expected[key] !== null && expected[key] !== actual[key]
		)
	)
		throw fail("PREVIEW_SOURCE_CHANGED", "原文件身份或位置已改变，请重新打开预览。");
	return actual;
}
/** Bounded independent text reader, byte offsets stay byte offsets. No scientific parser. */
function createPreviewService({
	store,
	transportFor,
	resolveSource,
	maxChunkBytes = 256 * 1024,
	maxSearchBytes = 8 * 1024 * 1024
}) {
	const requests = new Map(),
		pins = new Map(), searches = new Map();
	const revision = identity => JSON.stringify([identity.environmentId, identity.path, identity.fileId,
		identity.byteSize, identity.modifiedAt, identity.changeToken]);
	function begin(ownerId, artifactId) {
		const previous = requests.get(ownerId);
		previous?.abort();
		const controller = new AbortController();
		controller.artifactId = artifactId;
		requests.set(ownerId, controller);
		return controller;
	}
	async function source(artifactId, signal) {
		const artifact = store.read("artifact", artifactId);
		if (!artifact) throw fail("ARTIFACT_NOT_FOUND");
		if (artifact.representation !== "text") throw fail("BINARY_PREVIEW_UNSUPPORTED");
		if (resolveSource) return resolveSource({ artifactId, signal });
		const location =
			artifact.locations?.find((x) => x.role === "archive") ||
			artifact.locations?.find((x) => x.role === "original") ||
			artifact.locations?.[0];
		if (!location) throw fail("ARTIFACT_LOCATION_UNAVAILABLE");
		const transport = await transportFor(location.environmentId),
			identity = await transport.stat(location.path, { signal });
		return { artifact, location, transport, identity };
	}
	async function range(value, offset, length, signal, frozen = false) {
		const result = await (value.transport.readObservedRange || value.transport.readRange)(
			{ path: value.location.path, identity: value.identity, offset, length },
			{ signal }
		);
		if (frozen && (revision(result.before) !== revision(value.identity) || revision(result.after) !== revision(value.identity)))
			throw fail("PREVIEW_SOURCE_CHANGED");
		return Buffer.from(result.bytes || result);
	}
	async function pin(value, ownerId, expected, signal) {
		const identity = assertPreviewSourceIdentity(value, expected),
			previous = pins.get(ownerId);
		if (previous) {
			assertPreviewSourceIdentity(value, previous.identity);
			if (value.identity.byteSize < previous.minimumSize) throw fail("PREVIEW_SOURCE_CHANGED");
		}
		const length = previous?.prefixLength ?? Math.min(128, value.identity.byteSize),
			bytes = await range(value, 0, length, signal),
			prefixHash = crypto.createHash("sha256").update(bytes).digest("hex");
		if (previous && previous.prefixHash !== prefixHash) throw fail("PREVIEW_SOURCE_CHANGED");
		if (signal.aborted) throw fail("PREVIEW_CANCELLED");
		pins.set(ownerId, {
			identity,
			prefixHash,
			prefixLength: length,
			minimumSize: value.identity.byteSize
		});
		return identity;
	}
	function align(bytes, byteStart, byteEnd, totalBytes) {
		let first = 0,
			last = bytes.length;
		while (first < last && (bytes[first] & 0xc0) === 0x80) first++;
		if (byteEnd < totalBytes) {
			let start = last - 1;
			while (start >= first && (bytes[start] & 0xc0) === 0x80) start--;
			if (start >= first) {
				const n = bytes[start] < 0x80 ? 1 : bytes[start] < 0xe0 ? 2 : bytes[start] < 0xf0 ? 3 : 4;
				if (last - start < n) last = start;
			}
		}
		return { bytes: bytes.subarray(first, last), start: byteStart + first, end: byteStart + last };
	}
	return {
		async read({ ownerId, artifactId, anchor, maxBytes, expectedSourceIdentity }) {
			const controller = begin(ownerId, artifactId);
			searches.delete(ownerId);
			try {
				const value = await source(artifactId, controller.signal),
					size = value.identity.byteSize;
				const sourceIdentity = await pin(value, ownerId, expectedSourceIdentity, controller.signal);
				const length = Math.min(
						maxChunkBytes,
						Math.max(1, Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : maxChunkBytes)
					),
					offset =
						anchor === "tail"
							? Math.max(0, size - length)
							: Math.min(size, Math.max(0, Number.isSafeInteger(anchor) ? anchor : 0));
				const raw = await range(value, offset, Math.min(length, size - offset), controller.signal);
				if (controller.signal.aborted) throw fail("PREVIEW_CANCELLED");
				const aligned = align(raw, offset, offset + raw.length, size);
				if (aligned.bytes.includes(0)) throw fail("BINARY_PREVIEW_UNSUPPORTED");
				const text = new TextDecoder("utf-8", { fatal: true }).decode(aligned.bytes),
					digest = crypto.createHash("sha256").update(raw).digest("hex");
				return {
					sourceIdentity,
					artifactId,
					version: `${value.identity.fileId}:${value.identity.changeToken || value.identity.byteSize}:${digest}`,
					byteStart: aligned.start,
					byteEnd: aligned.end,
					lineStart: aligned.start === 0 ? 1 : null,
					lines: text.split(/\r\n|\n|\r/),
					hasBefore: aligned.start > 0,
					hasAfter: aligned.end < size,
					totalBytes: size
				};
			} finally {
				if (requests.get(ownerId) === controller) requests.delete(ownerId);
			}
		},
		async find({ ownerId, artifactId, query, fromByte, direction, expectedSourceIdentity, searchEndByte }) {
			if (typeof query !== "string" || !query || Buffer.byteLength(query) > 4096)
				throw fail("PREVIEW_QUERY_INVALID");
			if (!["next", "previous"].includes(direction)) throw fail("PREVIEW_DIRECTION_INVALID");
			const controller = begin(ownerId, artifactId);
			try {
				const value = await source(artifactId, controller.signal), needle = Buffer.from(query);
				await pin(value, ownerId, expectedSourceIdentity, controller.signal);
				let search = searches.get(ownerId);
				if (searchEndByte === undefined) {
					search = { artifactId, query, direction, revision: revision(value.identity),
						end: value.identity.byteSize, start: fromByte, nextByte: fromByte };
					searches.set(ownerId, search);
				} else if (!search || search.end !== searchEndByte || search.nextByte !== fromByte ||
					search.artifactId !== artifactId || search.query !== query || search.direction !== direction ||
					search.revision !== revision(value.identity)) throw fail("PREVIEW_SOURCE_CHANGED");
				const size = search.end;
				if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > size)
					throw fail("PREVIEW_OFFSET_INVALID");
				let position = fromByte,
					consumed = 0,
					overlap = Buffer.alloc(0);
				const windowBytes = Math.max(maxSearchBytes, needle.length);
				while (
					consumed < windowBytes &&
					(direction === "next" ? position < size : position > 0)
				) {
					const length = Math.min(
							maxChunkBytes,
							direction === "next" ? size - position : position,
							windowBytes - consumed
						),
						offset = direction === "next" ? position : position - length,
						chunk = await range(value, offset, length, controller.signal, true);
					if (controller.signal.aborted) throw fail("PREVIEW_CANCELLED");
					const combined =
							direction === "next"
								? Buffer.concat([overlap, chunk])
								: Buffer.concat([chunk, overlap]),
						match = direction === "next" ? combined.indexOf(needle) : combined.lastIndexOf(needle);
					if (match >= 0) {
						searches.delete(ownerId);
						return {
							byteOffset: (direction === "next" ? offset - overlap.length : offset) + match,
							lineNumber: null,
							length: needle.length
						};
					}
					overlap =
						direction === "next"
							? combined.subarray(Math.max(0, combined.length - needle.length + 1))
							: combined.subarray(0, needle.length - 1);
					consumed += length;
					position = direction === "next" ? offset + length : offset;
				}
				if ((direction === "next" ? position < size : position > 0) && consumed >= windowBytes) {
					// Replay only the overlap so a match spanning continuation windows
					// is checked. The stream never skips bytes or claims an early miss.
					search.nextByte = direction === "next" ? Math.max(fromByte + 1, position - needle.length + 1)
						: Math.min(fromByte - 1, position + needle.length - 1);
					return { kind: "continue", nextByte: search.nextByte, searchEndByte: size,
						completedBytes: Math.abs(position - search.start),
						totalBytes: direction === "next" ? size - search.start : search.start };
				}
				searches.delete(ownerId);
				return null;
			} catch (error) {
				if (requests.get(ownerId) === controller) searches.delete(ownerId);
				throw error;
			} finally {
				if (requests.get(ownerId) === controller) requests.delete(ownerId);
			}
		},
		release(ownerId) {
			requests.get(ownerId)?.abort();
			requests.delete(ownerId);
			pins.delete(ownerId);
			searches.delete(ownerId);
		},
		dispose() {
			for (const controller of requests.values()) controller.abort();
			requests.clear();
			pins.clear();
			searches.clear();
		},
		active: () => requests.size,
		uses: (artifactIds) =>
			[...requests.values()].some((value) => artifactIds.includes(value.artifactId))
	};
}
module.exports = { createPreviewService, previewSourceIdentity, assertPreviewSourceIdentity };
