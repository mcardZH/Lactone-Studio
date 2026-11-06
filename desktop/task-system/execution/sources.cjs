"use strict";
const crypto = require("node:crypto");
const { fail, abort } = require("./common.cjs");
const CHUNK_BYTES = 1024 * 1024;
function byteView(value) {
	if (!ArrayBuffer.isView(value)) fail("BYTE_SOURCE_REQUIRED");
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
async function* chunks(source, io) {
	abort(io?.signal);
	if (source?.verifyIdentity && (await source.verifyIdentity()) === false)
		fail("INPUT_SOURCE_IDENTITY_CHANGED");
	const data = source?.materialized || source;
	if (ArrayBuffer.isView(data)) {
		const view = byteView(data);
		for (let offset = 0; offset < view.length; offset += CHUNK_BYTES) {
			abort(io?.signal);
			yield view.subarray(offset, offset + CHUNK_BYTES);
		}
	} else if (typeof data?.readRange === "function") {
		if (!Number.isSafeInteger(data.byteSize) || data.byteSize < 0)
			fail("INPUT_SOURCE_SIZE_REQUIRED");
		for (let offset = 0; offset < data.byteSize; offset += CHUNK_BYTES) {
			abort(io?.signal);
			const length = Math.min(CHUNK_BYTES, data.byteSize - offset),
				range = await data.readRange({ offset, length, signal: io?.signal });
			const bytes = byteView(range?.bytes || range);
			if (bytes.length !== length) fail("INPUT_SOURCE_SHORT_READ");
			yield bytes;
		}
	} else {
		const iterable =
			typeof data?.openStream === "function" ? await data.openStream({ signal: io?.signal }) : data;
		if (!iterable?.[Symbol.asyncIterator] && !iterable?.[Symbol.iterator])
			fail("INPUT_STREAM_REQUIRED");
		for await (const value of iterable) {
			const bytes = byteView(value);
			if (bytes.length > CHUNK_BYTES) fail("INPUT_STREAM_CHUNK_TOO_LARGE");
			abort(io?.signal);
			yield bytes;
		}
	}
	if (source?.verifyIdentity && (await source.verifyIdentity()) === false)
		fail("INPUT_SOURCE_IDENTITY_CHANGED");
}
async function* verifiedChunks(source, { byteSize, sha256 }, io) {
	const hash = crypto.createHash("sha256");
	let size = 0;
	for await (const bytes of chunks(source, io)) {
		size += bytes.length;
		if (size > byteSize) fail("UPLOAD_CONTENT_MISMATCH");
		hash.update(bytes);
		yield bytes;
	}
	if (size !== byteSize || hash.digest("hex") !== sha256) fail("UPLOAD_CONTENT_MISMATCH");
}
async function writeStream(writable, source, io) {
	const controller = new AbortController(),
		stop = () => controller.abort();
	io?.signal?.addEventListener("abort", stop, { once: true });
	writable.once("close", stop);
	const streamIO = {
		...io,
		signal: io?.signal ? AbortSignal.any([io.signal, controller.signal]) : controller.signal
	};
	try {
		for await (const bytes of chunks(source, streamIO)) {
			abort(streamIO.signal);
			if (writable.destroyed) fail("UPLOAD_CHANNEL_CLOSED");
			if (!writable.write(bytes))
				await new Promise((resolve, reject) => {
					const cleanup = () => {
						writable.removeListener("drain", ready);
						writable.removeListener("error", failed);
						writable.removeListener("close", closed);
						streamIO.signal.removeEventListener("abort", closed);
					};
					const ready = () => {
							cleanup();
							resolve();
						},
						failed = (error) => {
							cleanup();
							reject(error);
						},
						closed = () =>
							failed(
								Object.assign(new Error("UPLOAD_CHANNEL_CLOSED"), { code: "UPLOAD_CHANNEL_CLOSED" })
							);
					writable.once("drain", ready);
					writable.once("error", failed);
					writable.once("close", closed);
					streamIO.signal.addEventListener("abort", closed, { once: true });
					if (streamIO.signal.aborted || writable.destroyed) closed();
				});
		}
		writable.end();
	} finally {
		io?.signal?.removeEventListener("abort", stop);
		writable.removeListener("close", stop);
	}
}
async function materializePrimary(source, descriptor, io) {
	if (ArrayBuffer.isView(source)) return byteView(source);
	if (source?.materialized) return source.materialized;
	const blocks = [];
	let size = 0;
	for await (const bytes of chunks(source, io)) {
		size += bytes.length;
		if (size > descriptor.byteSize) fail("INPUT_SOURCE_SIZE_CHANGED");
		blocks.push(bytes);
	}
	if (size !== descriptor.byteSize) fail("INPUT_SOURCE_SIZE_CHANGED");
	source.materialized = Buffer.concat(blocks);
	return source.materialized;
}
module.exports = { CHUNK_BYTES, byteView, chunks, verifiedChunks, writeStream, materializePrimary };
